#!/usr/bin/env python3
"""S086 — strategy board: 11 long-call / long-put angles, top 10 each for TODAY, overlap (A244, Jamie 10-22).

Jamie 10-22: "test multiple different angles and strategies, top 10 per strategy, see if tickers overlap. No
results = exclusion error, fix it." Reuses the S085 engine (panel, pick_analogs, select_factors, S081 pricer).

Judged RELATIVELY (memory relative-not-absolute): per week, top-10 picks' rel_21 minus the week's mean rel_21
(calls) or the week's mean minus the picks' (puts) → positive = picks beat the cross-section. Plus option pnl of
the picks vs buying every name the same weeks (S081 engine, hold to expiry). Analog weeks = S085's 15 % nearest.

No look-ahead in the analog numbers: the revisions factor set is re-selected per leave-one-analog-cluster-out fold
(S085 rule), so the weeks that score an angle never chose its factors. All-weeks numbers for revision angles are
in-sample (labelled). Today's factor set = the full analog selection, re-run every day (learns as weeks accrue).

Freshness (10-22 exclusion bugs): tech = newest `-ivhist` digest spanning ≥ 300 weeks, refreshed here
(lab-replay-technicals, 7-day top-up, full replay ≈ 35 s when the engine digest changes); IBES (monthly) carried
per field ≤ 45 days; tech ≤ 14 days. Stale beyond that → the name has no score that day (printed, not silent).

Reflection loop: picks go to forecast_ledger weekly (same cadence as the backtest), plus a `S086:buy-all` baseline
arm on every name. Once an arm has ≥ 30 graded forward trades and its forward mean return per $ is below the
baseline's, it stops being logged and the tab shows it as failing forward.

Run: cd scripts/watchlist_sync && .venv/bin/python analysis/s086_strategy_board.py [--no-refresh] [--force-log]
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import s085_regime_analog as e  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S086.md"
FLAGS = HERE.parent / "out" / "opt" / "S086_flags.json"
API = HERE.parent.parent.parent / "artifacts" / "api-server"
TOPN = 10
MIN_WEEKS = 300                     # a tech digest must span the panel to be backtestable
LOG_EVERY = 7                       # days between ledger entries (the backtest is weekly)
DEMOTE_N = 30                       # graded forward trades before an arm can be demoted
BASE_ARM = "S086:buy-all"


def refresh_tech(conn):
    """Top up the -ivhist tech panel for the current engine; full replay if the engine digest is new."""
    def run(frm):
        cmd = ["pnpm", "exec", "tsx", "src/scripts/lab-replay-technicals.ts", "--variant=ivhist", "--freq=week",
               f"--from={frm}"]
        env = {**os.environ, "PATH": f"/opt/homebrew/bin:{os.environ.get('PATH', '')}"}
        out = subprocess.run(cmd, cwd=API, env=env, capture_output=True, text=True, timeout=900).stdout
        m = re.search(r"engine (\S+-ivhist)", out)
        return m.group(1) if m else None
    from datetime import date
    dg = run((date.today() - timedelta(days=10)).isoformat())
    if dg:
        n = conn.execute("SELECT count(DISTINCT as_of) FROM watchlist_sync.lab_tech WHERE engine_digest = %s",
                         (dg,)).fetchone()[0]
        if n < MIN_WEEKS:
            print(f"tech engine {dg} has {n} weeks → full replay", flush=True)
            run("2020-02-01")
    return dg


def pick_digest(conn):
    """Newest -ivhist digest spanning the panel (S085 pinned one that froze at 10-05 when the engine changed)."""
    row = conn.execute("""SELECT engine_digest FROM watchlist_sync.lab_tech WHERE engine_digest LIKE '%%-ivhist'
                          GROUP BY 1 HAVING count(DISTINCT as_of) >= %s ORDER BY max(as_of) DESC, max(computed_at) DESC
                          LIMIT 1""", (MIN_WEEKS,)).fetchone()
    return row[0] if row else e.DIGEST


def extras(rows, i):
    """Trailing-only extras for the S082 / S083 angles."""
    c = np.array([r[1] for r in rows[max(0, i - 260): i + 1]], float)
    if len(c) < 70:
        return {}
    d = np.diff(c[-3:])
    up, dn = d[d > 0].sum(), -d[d < 0].sum()
    rsi2 = 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)
    iv_now, iv5 = rows[i][2], rows[i - 5][2] if i >= 5 else None
    return {"rsi2": float(rsi2),
            "dd60": float(c[-1] / c[-60:].max() - 1),
            "ext50": float(c[-1] / c[-50:].mean() - 1),
            "ret60": float(c[-1] / c[-61] - 1),
            "iv_chg5": (iv_now - iv5) if (iv_now and iv5) else float("nan")}


def combo(row, parts):
    """Mean of sign-weighted cross-sectional z over parts; a name needs ≥ 60 % coverage."""
    tick = sorted(row)
    zs = [dict(zip(tick, s * e.zscore([row[t].get(f, float("nan")) for t in tick]))) for f, s in parts.items()]
    need = max(1, math.ceil(0.6 * len(parts)))
    out = {}
    for t in tick:
        vs = [z[t] for z in zs if z[t] == z[t]]
        if len(vs) >= need:
            out[t] = float(np.mean(vs))
    return out


def make_strats(rev):
    """name → (call_parts, put_parts); put_parts None = mirror of calls. `rev` = selected revision factors."""
    return {
        "Estimate revisions (S085)": (rev, None),
        "Fildi tech call score": ({"tech_v4call_total": 1}, None),
        "12-1 momentum": ({"mom_12_1": 1}, None),
        "52-week-high proximity": ({"prox_52w": 1}, None),
        "1-week reversal": ({"rev_5d": 1}, None),
        "Earnings surprise (SUE)": ({"ibes_sue": 1}, None),
        # S083 Part A winner states (calls: cheap IV near highs after a dip; puts: IV below RV, falling, above 50d)
        "Cheap-vol winner state (S083)": ({"prox_52w": 1, "iv_rank252": -1, "ret60": -1},
                                          {"iv_rv20": -1, "iv_chg5": -1, "ext50": 1}),
        # S082 swing extrema (calls: 2-day RSI washed out in a drawdown; puts: RSI pinned, stretched above 50d)
        "Swing low / high (S082)": ({"rsi2": -1, "dd60": -1}, {"rsi2": 1, "ext50": 1}),
        # Jamie 10-22: are the worst names (put lists) actually the best calls?
        "Laggard calls: weakest 12-1": ({"mom_12_1": -1}, {"mom_12_1": 1}),
        "Laggard calls: furthest below 52w high": ({"prox_52w": -1}, {"prox_52w": 1}),
        "Laggard + revisions up": ({"mom_12_1": -1, **rev}, None) if rev else ({"mom_12_1": -1}, None),
        # S100 (10-24) the one pair that passed its holdout for long calls: revisions + 60-day return
        # (holdout +69.6 % vs revisions alone +43.1 %, all calls +34.1 %; gain t 2.0, halves +10.5 / +42.4 %)
        "Revisions + 60-day strength (S100)": ({**rev, "ret60": 1}, None) if rev else ({"ret60": 1}, None),
    }


REV_ANGLES = {"Estimate revisions (S085)", "Laggard + revisions up", "Revisions + 60-day strength (S100)"}


CHEAP_GATE = True   # Jamie 10-24 "buying → cheapest options is a requirement": every angle picks only names whose 1y IV rank is
                    # below that week's median. S100 (all weeks, top 10 calls): gate raised 10 of 13 angles (revisions +32 → +44 %,
                    # holdout +24 pts, t 2.1); the buy-all comparator stays ungated.


def scores(row, parts):
    cp, pp = parts
    call = combo(row, cp) if cp else {}
    put = combo(row, pp) if pp else {t: -v for t, v in call.items()}
    if CHEAP_GATE:
        ivr = [f["iv_rank252"] for f in row.values() if f.get("iv_rank252") == f.get("iv_rank252") and f.get("iv_rank252") is not None]
        if ivr:
            med = float(np.median(ivr))
            cheap = {t for t, f in row.items() if f.get("iv_rank252") is not None and f["iv_rank252"] == f["iv_rank252"] and f["iv_rank252"] < med}
            call = {t: v for t, v in call.items() if t in cheap}
            put = {t: v for t, v in put.items() if t in cheap}
    return call, put


def picks(sc, n=TOPN):
    return [t for t, _ in sorted(sc.items(), key=lambda z: -z[1])[:n]]


def forward_record(conn):
    """Forward trades per S086 arm: open, graded n, wins, mean return per $ debit (pnl_per_share ÷ debit)."""
    rows = conn.execute("""SELECT forecaster, outcome, (meta->>'pnl_per_share')::float, -(meta->>'credit')::float
                           FROM watchlist_sync.forecast_ledger
                           WHERE qtype = 'sim_structure' AND forecaster LIKE 'S086:%%'""")
    by, open_ = defaultdict(list), Counter()
    for arm, win, pnl, debit in rows:
        if win is None:
            open_[arm] += 1
        elif pnl is not None and debit and debit > 0:
            by[arm].append((bool(win), pnl / debit))
    return {a: {"open": open_[a], "n": len(by[a]), "wins": sum(w for w, _ in by[a]),
                "mean": float(np.mean([r for _, r in by[a]])) if by[a] else None}
            for a in set(by) | set(open_)}


BUY_ALL_DTE: dict = {}


def main():
    global CHEAP_GATE, BUY_ALL_DTE
    args = sys.argv[1:]
    conn = connect()
    dg = None if "--no-refresh" in args else refresh_tech(conn)
    e.DIGEST = pick_digest(conn)
    print(f"tech digest {e.DIGEST} (replay engine {dg or 'not refreshed'})", flush=True)

    px = e.load_prices(conn)
    universe = sorted(t for t in px if t not in e.BENCH)
    tech, fund, tgt, _ = e.load_lab(conn, set(universe))
    weeks = sorted(set(tech) | set(fund))
    macro = e.macro_state(px, universe, weeks)
    today = max(px["SPY"])[0]
    analog, _, all_weeks, _ = e.pick_analogs(macro, weeks, tgt, e.macro_state(px, universe, [today])[today])
    print(f"{len(universe)} names · {len(all_weeks)} weeks · {len(analog)} analogs · today {today}", flush=True)

    tech[today], tw = e.carry_forward(tech, today, e.CARRY_TECH)
    # live row only: estimates dated after the last price bar (Mon LSEG snapshot vs Fri close) still count — the
    # backtest weeks never read fund[today]
    fund[today], fw = e.carry_forward(fund, max(today, date.today()), e.CARRY_FUND)
    panel = e.build_panel(px, universe, all_weeks + [today], tech, fund)
    for row in panel.values():
        for t, f in row.items():
            f.update(extras(px[t], f["_i"]))
    print(f"today row: {len(panel[today])} names; tech {len(tech[today])} from {tw}, "
          f"IBES {sum('ibes_drift' in r for r in fund[today].values())} from {fw}", flush=True)

    # revision factors: full analog selection for today; leave-one-cluster-out for each analog week
    ibes_tech = [f for f in e.factor_names(panel) if f.startswith(("ibes_", "tech_v4"))]
    rev_full = e.select_factors(panel, tgt, ibes_tech, analog, all_weeks)
    strats_full = make_strats(rev_full)
    strats_wk = {}
    for held in e.clusters(analog):
        s = make_strats(e.select_factors(panel, tgt, ibes_tech, [d for d in analog if d not in set(held)], all_weeks))
        strats_wk.update({d: s for d in held})
    print(f"revision factors today: {rev_full}", flush=True)

    pricer, tb = e.Pricer(conn), e.tbill_map(conn)
    cache = {}

    def opt(t, d, side):
        k = (t, d, side, e.DTE)
        if k not in cache:
            tr = e.price_long(pricer, px[t], panel[d][t]["_i"], side, e.tbill_at(tb, d))
            cache[k] = tr["expiry"] if tr else None
        return cache[k]

    base = {s: [v for d in analog for t in panel.get(d, {}) if (v := opt(t, d, s)) is not None]
            for s in ("call", "put")}
    buy_all = {s: float(np.mean(v)) for s, v in base.items()}
    buy_all_dte = {"45": buy_all["call"]}   # call buy-all per horizon (comparator for optionByDte)
    for dte in (30, 90):
        e.DTE = dte
        v = [x for d in analog for t in panel.get(d, {}) if (x := opt(t, d, "call")) is not None]
        buy_all_dte[str(dte)] = float(np.mean(v)) if v else float("nan")
    e.DTE = 45
    print(f"buy-all calls by DTE: {buy_all_dte}", flush=True)
    BUY_ALL_DTE = {k: (None if v != v else round(v, 5)) for k, v in buy_all_dte.items()}
    print(f"buy-all analog: call {buy_all['call']:+.1%} put {buy_all['put']:+.1%}", flush=True)

    res, today_picks = [], {}
    for name in strats_full:
        r = {"name": name, "insample_all": name in REV_ANGLES}
        for si, side in enumerate(("call", "put")):
            for label, wk in (("an", analog), ("all", all_weeks)):
                ex = []
                for d in wk:
                    row, tg = panel.get(d, {}), tgt.get(d, {})
                    if len(row) < 40:
                        continue
                    parts = (strats_wk.get(d, strats_full) if label == "an" else strats_full)[name]
                    p = [t for t in picks(scores(row, parts)[si]) if t in tg]
                    if len(p) < 5:
                        continue
                    wmean, pm = statistics.mean(tg.values()), statistics.mean(tg[t] for t in p)
                    ex.append((d, (pm - wmean) if side == "call" else (wmean - pm)))
                t_ = e.month_block_t(ex)[0] if len(ex) >= 6 else float("nan")
                r[f"{side}_{label}"] = (statistics.mean(v for _, v in ex) if ex else float("nan"), t_,
                                        sum(v > 0 for _, v in ex) / len(ex) if ex else float("nan"))
            pnl = [v for d in analog if len(panel.get(d, {})) >= 40
                   for t in picks(scores(panel[d], strats_wk.get(d, strats_full)[name])[si])
                   if (v := opt(t, d, side)) is not None]
            r[f"{side}_opt"] = (float(np.mean(pnl)) if pnl else float("nan"), len(pnl))
            CHEAP_GATE = False   # same angle without the cheap-IV gate, shown beside it (Jamie: compare, don't pin)
            pu = [v for d in analog if len(panel.get(d, {})) >= 40
                  for t in picks(scores(panel[d], strats_wk.get(d, strats_full)[name])[si])
                  if (v := opt(t, d, side)) is not None]
            CHEAP_GATE = True
            r[f"{side}_opt_ungated"] = float(np.mean(pu)) if pu else float("nan")
            # horizons side by side (Jamie 10-24: no single cutoff) — same picks bought at ~30 / ~90 DTE, held to expiry
            r[f"{side}_by_dte"] = {"45": r[f"{side}_opt"][0]}
            if side == "call":
                for dte in (30, 90):
                    e.DTE = dte
                    pv = [v for d in analog if len(panel.get(d, {})) >= 40
                          for t in picks(scores(panel[d], strats_wk.get(d, strats_full)[name])[si])
                          if (v := opt(t, d, side)) is not None]
                    r[f"{side}_by_dte"][str(dte)] = float(np.mean(pv)) if pv else float("nan")
                e.DTE = 45
        c, p = scores(panel[today], strats_full[name])
        today_picks[name] = {"call": picks(c), "put": picks(p)}
        res.append(r)
        print(f"{name}: call an {r['call_an'][0]:+.2%} t{r['call_an'][1]:.1f} opt {r['call_opt'][0]:+.1%} (ungated {r['call_opt_ungated']:+.1%}) | "
              f"put an {r['put_an'][0]:+.2%} t{r['put_an'][1]:.1f} opt {r['put_opt'][0]:+.1%}", flush=True)

    fwd = forward_record(conn)
    publish(conn, res, today_picks, buy_all, analog, today, tw, fw, panel[today], px, pricer, fwd, rev_full,
            force_log="--force-log" in args)
    write_md(res, today_picks, buy_all, analog, today, tw, fw, panel[today], px, rev_full)
    print(f"wrote {OUT}")


def publish(conn, res, tp, buy_all, analog, today, tw, fw, row, px, pricer, fwd, rev, force_log=False):
    """Ledger flags (weekly) + the Rankings › Long options board row."""
    from s076_structures_backtest import fill, strike_for
    exp = today + timedelta(days=e.DTE)
    exp += timedelta(days=(4 - exp.weekday()) % 7)        # next Friday
    days = (exp - today).days
    every = {t for n in tp for s in tp[n] for t in tp[n][s]} | set(row)
    schwab = e.today_costs(conn, every)

    def quote(t, side):
        c = schwab.get((t, side))
        S = row[t]["_spot"]
        if c and abs(c["K"] / S - 1) <= 0.05:              # real Schwab ask near the money
            K, debit, ex, dte, src = c["K"], float(c["ask"]), c["expiry"], c["dte"], "schwab ask"
            iv = c["iv"] or px[t][row[t]["_i"]][2]
        else:
            iv = px[t][row[t]["_i"]][4 if side == "call" else 3] or px[t][row[t]["_i"]][2]
            if not iv:
                return None
            K = strike_for(S, iv, days / 365, e.DELTA, side)
            m, sp = pricer.mid(side, S, K, iv, days, today)
            debit, ex, dte, src = fill(m, sp, 1), exp, days, "model"
        iv = iv / 100 if iv and iv > 3 else iv
        be = (K + debit) / S - 1 if side == "call" else 1 - (K - debit) / S
        return {"spot": S, "strike": K, "debit": debit, "iv30": iv, "breakeven": be, "expiry": str(ex),
                "dte": int(dte), "src": src}

    def beats(r):
        return r["call_an"][1] >= 2 and r["call_opt"][0] > buy_all["call"]

    base_fwd = fwd.get(BASE_ARM)
    status = {}
    for r in res:
        f = fwd.get(f"S086:{r['name']}")
        failing = bool(f and base_fwd and f["n"] >= DEMOTE_N and base_fwd["mean"] is not None
                       and f["mean"] < base_fwd["mean"])
        status[r["name"]] = "failing forward" if failing else ("ledger" if beats(r) else "")
    ok = [n for n, s in status.items() if s == "ledger"]

    last = conn.execute("""SELECT max(made_on) FROM watchlist_sync.forecast_ledger
                           WHERE forecaster LIKE 'S086:%%'""").fetchone()[0]
    due = force_log or last is None or (today - last).days >= LOG_EVERY
    entries = []
    if due:
        arms = [(f"S086:{n}", tp[n]["call"]) for n in ok] + [(BASE_ARM, sorted(row))]
        for arm, names in arms:
            for t in names:
                q = quote(t, "call")
                if q and q["debit"] > 0.05:
                    entries.append({"arm": arm, "ticker": t, "date": str(today), "side": "call", "spot": q["spot"],
                                    "strike": q["strike"], "expiry": q["expiry"], "dte": q["dte"],
                                    "model_debit": q["debit"], "iv30": q["iv30"]})
    FLAGS.write_text(json.dumps({"as_of": str(today), "arms": ok, "entries": entries}, indent=1, default=str))
    print(f"flags: {len(entries)} entries ({'due' if due else f'next log {last + timedelta(days=LOG_EVERY)}'}) "
          f"arms {ok}", flush=True)

    sec = e.sectors(conn)
    cnt = {s: Counter(t for n in tp for t in tp[n][s]) for s in ("call", "put")}
    nn = lambda x: None if x is None or x != x else round(float(x), 5)  # noqa: E731
    strategies = []
    for r in res:
        n = r["name"]
        sides = {}
        for s in ("call", "put"):
            names = []
            for t in tp[n][s]:
                q = quote(t, s) or {}
                names.append({"ticker": t, "sector": sec.get(t), "beta": nn(e.beta_at(px, t, today)),
                              "overlap": cnt[s][t], "strike": nn(q.get("strike")), "debit": nn(q.get("debit")),
                              "breakeven": nn(q.get("breakeven")), "spot": nn(row[t]["_spot"]),
                              "src": q.get("src")})
            sides[s] = {"edgeAnalog": [nn(v) for v in r[f"{s}_an"]], "edgeAll": [nn(v) for v in r[f"{s}_all"]],
                        "option": [nn(r[f"{s}_opt"][0]), r[f"{s}_opt"][1]], "optionUngated": nn(r.get(f"{s}_opt_ungated")),
                        "optionByDte": {k: nn(v) for k, v in (r.get(f"{s}_by_dte") or {}).items()},
                        "names": names}
        f = fwd.get(f"S086:{n}")
        strategies.append({"name": n, "status": status[n], "insampleAll": r["insample_all"],
                           "forward": f, **sides})
    payload = {"asOf": str(today), "expiry": str(exp), "analogWeeks": len(analog), "cheapGate": CHEAP_GATE, "buyAllCallByDte": BUY_ALL_DTE,
               "buyAll": {s: nn(v) for s, v in buy_all.items()}, "forwardBuyAll": base_fwd,
               "techAsOf": str(tw), "ibesAsOf": str(fw), "revisionFactors": rev, "strategies": strategies,
               "overlap": {s: [[t, k] for t, k in cnt[s].most_common() if k > 1] for s in cnt}}
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.long_option_board
                    (as_of date PRIMARY KEY, payload jsonb NOT NULL, computed_at timestamptz DEFAULT now())""")
    conn.execute("""INSERT INTO watchlist_sync.long_option_board (as_of, payload) VALUES (%s, %s)
                    ON CONFLICT (as_of) DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()""",
                 (today, json.dumps(payload, default=str)))
    conn.commit()
    print("board → watchlist_sync.long_option_board", flush=True)


def write_md(res, tp, buy_all, analog, today, tw, fw, row_today, px, rev):
    sec = e.sectors(connect())
    L = [f"# S086 — strategy board, top {TOPN} long calls / long puts ({today})", "",
         f"Universe {len(row_today)} names. Analog weeks {len(analog)} (S085 rule). Tech digest `{e.DIGEST}` "
         f"carried from {tw}, IBES from {fw}; price/IV fresh {today}. Revision factors today: {rev}. "
         f"Edge = picks' 21-day peer-relative return vs the week's average (calls: picks − avg; puts: avg − picks; "
         f"+ = good). Analog numbers are out-of-sample (revision factors re-selected per left-out cluster); "
         f"all-weeks numbers for revision angles (†) are in-sample. Option = S081 engine, 0.50Δ ~45 DTE, held to "
         f"expiry, per $ debit, analog weeks. Buy-all same weeks: call {buy_all['call']:+.1%}, "
         f"put {buy_all['put']:+.1%}.", "",
         "| strategy | call edge analog (t, hit) | call edge all wks (t) | call option | "
         "put edge analog (t, hit) | put edge all wks (t) | put option |", "|---|---|---|---|---|---|---|"]
    f = lambda x: f"{x[0]:+.2%} ({x[1]:.1f}, {x[2]:.0%})"  # noqa: E731
    g = lambda x: f"{x[0]:+.2%} ({x[1]:.1f})"  # noqa: E731
    for r in res:
        dag = " †" if r["insample_all"] else ""
        L.append(f"| {r['name']} | {f(r['call_an'])} | {g(r['call_all'])}{dag} | {r['call_opt'][0]:+.1%} "
                 f"(n {r['call_opt'][1]}) | {f(r['put_an'])} | {g(r['put_all'])}{dag} | {r['put_opt'][0]:+.1%} "
                 f"(n {r['put_opt'][1]}) |")
    for side in ("call", "put"):
        cnt = Counter(t for n in tp for t in tp[n][side])
        L += ["", f"## Top {TOPN} long {side}s per strategy", ""]
        for n in tp:
            L.append(f"- **{n}:** " + ", ".join(f"{t}{'*' if cnt[t] > 1 else ''}" for t in tp[n][side]))
        L += ["", f"**Overlap (long {side}s, ≥ 2 strategies):** " + ", ".join(
            f"{t} ×{k} ({sec.get(t, '?')}, β {e.beta_at(px, t, today):.1f})" for t, k in cnt.most_common() if k > 1)]
    both = set().union(*(tp[n]["call"] for n in tp)) & set().union(*(tp[n]["put"] for n in tp))
    L += ["", f"**On both a call and a put list (conflict):** {', '.join(sorted(both)) or 'none'}"]
    OUT.write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
