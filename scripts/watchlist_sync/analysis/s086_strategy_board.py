#!/usr/bin/env python3
"""S086 — strategy board: 8 long-call / long-put angles, top 10 each for TODAY, overlap (A244, Jamie 10-22).

Jamie 10-22: "test multiple different angles and strategies, top 10 per strategy, see if tickers overlap. No
results = exclusion error, fix it." Reuses the S085 engine unchanged (panel, analog weeks, S081 option pricer).

Judged RELATIVELY (memory relative-not-absolute): per week, top-10 picks' rel_21 minus the week's mean rel_21
(calls) or the week's mean minus the picks' (puts) → positive = picks beat the cross-section. Plus option pnl of
the picks vs buying every name the same weeks (S081 engine, hold to expiry). Analog weeks = S085's 15 % nearest.

Exclusion fix vs S085: S085 printed "no list" because lab_tech / lab_fund stop at 2026-10-05 and today (10-21)
had no row. Here today's row carries the latest score forward (≤ 21 days, age printed); price/IV factors are fresh.

Run: cd scripts/watchlist_sync && .venv/bin/python analysis/s086_strategy_board.py
"""
from __future__ import annotations

import math
import statistics
import sys
from collections import Counter, defaultdict
from datetime import timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import s085_regime_analog as e  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S086.md"
TOPN = 10
CARRY_DAYS = 21

# S085 full-sample selection (its LOCO backtest: calls +67 % vs +33 % buy-all, t 3.7)
REVISIONS = {"ibes_breadth": 1, "ibes_drift": 1, "ibes_drift_3m": 1,
             "tech_v4call_relativePressure": 1, "tech_v4put_relativePressure": -1}


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


def zmap(row, f, sgn=1.0):
    tick = sorted(row)
    z = e.zscore([row[t].get(f, float("nan")) for t in tick])
    return {t: sgn * v for t, v in zip(tick, z)}


def combo(row, parts):
    """Mean of sign-weighted z over parts; name needs ≥ 60 % coverage."""
    zs = [zmap(row, f, s) for f, s in parts.items()]
    need = max(1, math.ceil(0.6 * len(parts)))
    out = {}
    for t in row:
        vs = [z[t] for z in zs if z.get(t) == z.get(t) and z.get(t) is not None]
        if len(vs) >= need:
            out[t] = float(np.mean(vs))
    return out


# name → (call_parts, put_parts); put_parts None = mirror of calls
STRATS = {
    "Estimate revisions (S085)": (REVISIONS, None),
    "Fildi tech call score": ({"tech_v4call_total": 1}, None),
    "12-1 momentum": ({"mom_12_1": 1}, None),
    "52-week-high proximity": ({"prox_52w": 1}, None),
    "1-week reversal": ({"rev_5d": 1}, None),
    "Earnings surprise (SUE)": ({"ibes_sue": 1}, None),
    # S083 Part A winner states (calls: cheap IV near highs after a dip; puts: IV below RV and falling, above 50d)
    "Cheap-vol winner state (S083)": ({"prox_52w": 1, "iv_rank252": -1, "ret60": -1},
                                      {"iv_rv20": -1, "iv_chg5": -1, "ext50": 1}),
    # S082 swing extrema (calls: 2-day RSI washed out in a drawdown; puts: RSI pinned, stretched above 50d)
    "Swing low / high (S082)": ({"rsi2": -1, "dd60": -1}, {"rsi2": 1, "ext50": 1}),
}


def scores(row, name):
    cp, pp = STRATS[name]
    call = combo(row, cp)
    put = combo(row, pp) if pp else {t: -v for t, v in call.items()}
    return call, put


def picks(sc, n=TOPN):
    return [t for t, _ in sorted(sc.items(), key=lambda z: -z[1])[:n]]


def main():
    conn = connect()
    px = e.load_prices(conn)
    universe = sorted(t for t in px if t not in e.BENCH)
    tech, fund, tgt, _ = e.load_lab(conn, set(universe))
    weeks = sorted(set(tech) | set(fund))
    macro = e.macro_state(px, universe, weeks)
    today = max(px["SPY"])[0]
    mt = e.macro_state(px, universe, [today])[today]

    # analog weeks — same rule as S085 main()
    mw = [d for d in weeks if d in macro and all(macro[d][v] == macro[d][v] for v in e.MACRO_VARS)]
    M = np.array([[macro[d][v] for v in e.MACRO_VARS] for d in mw], float)
    mu, sd = M.mean(0), M.std(0, ddof=1)
    sd[sd == 0] = 1
    dist = np.linalg.norm((M - mu) / sd - (np.array([mt[v] for v in e.MACRO_VARS]) - mu) / sd, axis=1)
    cutoff = mw[-1]
    for _ in range(e.EXCLUDE_RECENT):
        cutoff = max([d for d in mw if d < cutoff], default=cutoff)
    elig = sorted(((d, x) for d, x in zip(mw, dist) if d <= cutoff and tgt.get(d)), key=lambda z: z[1])
    analog = sorted(d for d, _ in elig[: max(8, round(e.ANALOG_FRAC * len(elig)))])
    all_weeks = sorted(d for d, _ in elig)
    print(f"{len(universe)} names · {len(all_weeks)} weeks · {len(analog)} analogs · today {today}", flush=True)

    # exclusion fix: carry each field forward from its latest non-empty week (10-05 lab_fund holds ibes_sue only)
    def carry(src):
        merged = defaultdict(dict)
        for d in sorted(d for d in src if 0 <= (today - d).days <= CARRY_DAYS):
            for t, rec in src[d].items():
                merged[t].update(rec)
        return dict(merged), max(d for d in src if d <= today)
    tech[today], tw = carry(tech)
    fund[today], fw = carry(fund)
    panel = e.build_panel(px, universe, all_weeks + [today], tech, fund)
    for d, row in panel.items():
        for t, f in row.items():
            f.update(extras(px[t], f["_i"]))
    print(f"today row: {len(panel[today])} names; tech from {tw}, fund from {fw}", flush=True)

    pricer, tb = e.Pricer(conn), e.tbill_map(conn)
    cache = {}

    def opt(t, d, side):
        k = (t, d, side)
        if k not in cache:
            tr = e.price_long(pricer, px[t], panel[d][t]["_i"], side, e.tbill_at(tb, d))
            cache[k] = tr["expiry"] if tr else None
        return cache[k]

    # buy-everything comparator on the analog weeks
    base = {s: [v for d in analog for t in panel.get(d, {}) if (v := opt(t, d, s)) is not None]
            for s in ("call", "put")}
    print(f"buy-all analog: call {np.mean(base['call']):+.1%} put {np.mean(base['put']):+.1%}", flush=True)

    res, today_picks = [], {}
    for name in STRATS:
        r = {"name": name}
        for side in ("call", "put"):
            for label, wk in (("an", analog), ("all", all_weeks)):
                ex = []
                for d in wk:
                    row, tg = panel.get(d, {}), tgt.get(d, {})
                    if len(row) < 40:
                        continue
                    sc = scores(row, name)[0 if side == "call" else 1]
                    p = [t for t in picks(sc) if t in tg]
                    if len(p) < 5:
                        continue
                    wmean = statistics.mean(tg.values())
                    pm = statistics.mean(tg[t] for t in p)
                    ex.append((d, (pm - wmean) if side == "call" else (wmean - pm)))
                t_, _, _ = e.month_block_t(ex) if len(ex) >= 6 else (float("nan"), 0, 0)
                r[f"{side}_{label}"] = (statistics.mean(v for _, v in ex) if ex else float("nan"), t_,
                                        sum(v > 0 for _, v in ex) / len(ex) if ex else float("nan"))
            pnl = []
            for d in analog:
                row = panel.get(d, {})
                if len(row) < 40:
                    continue
                for t in picks(scores(row, name)[0 if side == "call" else 1]):
                    v = opt(t, d, side)
                    if v is not None:
                        pnl.append(v)
            r[f"{side}_opt"] = (np.mean(pnl) if pnl else float("nan"), len(pnl))
        c, p = scores(panel[today], name)
        today_picks[name] = {"call": picks(c), "put": picks(p)}
        res.append(r)
        print(f"{name}: call an {r['call_an'][0]:+.2%} t{r['call_an'][1]:.1f} opt {r['call_opt'][0]:+.1%} | "
              f"put an {r['put_an'][0]:+.2%} t{r['put_an'][1]:.1f} opt {r['put_opt'][0]:+.1%}", flush=True)

    write(res, today_picks, base, analog, today, tw, fw, panel[today], px)
    print(f"wrote {OUT}")


def write(res, tp, base, analog, today, tw, fw, row_today, px):
    sec = e.sectors(connect())
    L = [f"# S086 — strategy board, top {TOPN} long calls / long puts ({today})", "",
         f"Universe {len(row_today)} names. Analog weeks {len(analog)} (S085 rule). Tech scores carried from {tw}, "
         f"IBES from {fw}; price/IV fresh {today}. Edge = picks' 21-day peer-relative return vs the week's average "
         f"(calls: picks − avg; puts: avg − picks; + = good). Option = S081 engine, 0.50Δ ~45 DTE, held to expiry, "
         f"per $ debit, analog weeks. Buy-all same weeks: call {np.mean(base['call']):+.1%}, "
         f"put {np.mean(base['put']):+.1%}.", "",
         "| strategy | call edge analog (t, hit) | call edge all wks (t) | call option | "
         "put edge analog (t, hit) | put edge all wks (t) | put option |", "|---|---|---|---|---|---|---|"]
    f = lambda x: f"{x[0]:+.2%} ({x[1]:.1f}, {x[2]:.0%})"  # noqa: E731
    g = lambda x: f"{x[0]:+.2%} ({x[1]:.1f})"  # noqa: E731
    for r in res:
        L.append(f"| {r['name']} | {f(r['call_an'])} | {g(r['call_all'])} | {r['call_opt'][0]:+.1%} (n {r['call_opt'][1]}) | "
                 f"{f(r['put_an'])} | {g(r['put_all'])} | {r['put_opt'][0]:+.1%} (n {r['put_opt'][1]}) |")
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
