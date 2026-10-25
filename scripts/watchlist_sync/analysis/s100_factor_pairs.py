#!/usr/bin/env python3
"""S100 — which TWO inputs together best explain option-strategy returns? (Jamie 10-24: "for each angle understand the strategy,
identify other factors; do any two-variable combinations better explain higher returns — sell and buy options").

Four strategies, each on its existing harness (no new pricing engine):
  sell put    S059 events: weekly ~1σ put, pnl per $ collateral net of fills (bid + 23 % of spread)
  sell call   S061 events: weekly ~1σ covered call, overwrite pnl per $ stock (no fill haircut, as S061)
  buy call    S086 panel + S081 pricer: 0.50Δ ~45 DTE call held to expiry, return per $ debit, weekly entries
  buy put     same, puts
Candidates: every input the harness already carries (IV/RV, IV rank, vol of vol, term slope, idio vol, 12-1 momentum,
1-month / 1-week reversal, 52-week-high proximity, trend, volume, oversold, SUE, estimate revisions, …).

Pre-registered (no look-ahead): FIT = entry weeks < 2024-07-01, HOLDOUT = 2024-07-01 →.
  1. Each input's direction = sign of its FIT top-minus-bottom group return, except IV inputs on bought options, which are
     fixed to "cheaper is better" (Jamie's rule, not fitted).
  2. Pair score = mean of the two signed within-week ranks. Group = top quintile (sold, ≥ 30 names a week) or top 10 (bought).
  3. On FIT only, rank all pairs by their gain over the better of their two inputs alone (paired weekly mean); keep the top 3
     per strategy.
  4. HOLDOUT verdict for those 3: PASS = gain over the better single input > 0 with t ≥ 2 (month blocks for 45-DTE trades,
     weekly for weekly trades) and positive in both holdout halves. Also reported: vs the live / board baseline and vs all trades.
Bought options also get the 'cheap gate' (Jamie 10-24 "cheapest is required"): angle top 10 among names with IV rank below the
week's median, vs the plain angle — a gate, not a blend.

Run: cd scripts/watchlist_sync && .venv/bin/python analysis/s100_factor_pairs.py   (→ out/opt/S100.md, ~20–30 min, pricing cached)
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from itertools import combinations
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

SPLIT = date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S100.md"
TOPN = 10
KEEP = 3

LABEL = {
    "iv_rv": "IV ÷ realized vol", "iv_rv20": "IV ÷ realized vol", "iv_pct": "IV rank (1y)", "iv_rank252": "IV rank (1y)",
    "vol_of_vol": "vol of vol", "term_slope": "term slope (30d − 60d IV)", "idio_vol": "idiosyncratic vol",
    "mom_12_1": "12-1 momentum", "rev_1m": "1-month return", "rev_5d": "1-week drop", "ret5": "1-week return",
    "prox_52w": "near 52-week high", "tech_trendContext": "trend (vs 200-day)", "tech_volumeConfirm": "volume confirm",
    "tech_oversoldDepth": "oversold depth", "tech_relativePressure": "relative strength", "sue": "earnings surprise",
    "ibes_sue": "earnings surprise", "ibes_drift": "estimate revisions", "ibes_breadth": "revision breadth",
    "har_iv": "forecast vol ÷ IV", "ret60": "60-day return", "ext50": "stretch above 50-day", "rsi2": "2-day RSI",
    "dd60": "drop from 60-day high", "iv_chg5": "5-day IV change", "put_tech": "put tech (trend − volume)",
    "tech_v4call_total": "Fildi tech call score", "tech_v2_total": "Fildi tech score",
}
lab = lambda f: LABEL.get(f, f)  # noqa: E731


def rank(x):
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort")
    r = np.empty(len(x))
    r[o] = np.arange(len(x))
    return r / max(1, len(x) - 1)


def tstat(v):
    v = np.asarray([x for x in v if x == x], float)
    return (v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))) if len(v) > 2 and v.std(ddof=1) > 0 else float("nan")


def block_t(series):
    """Month-block t (45-DTE entries overlap week to week)."""
    by = defaultdict(list)
    for d, v in series:
        if v == v:
            by[(d.year, d.month)].append(v)
    return tstat([np.mean(v) for v in by.values()])


# ---------------------------------------------------------------- sold options (weekly harness)

def add_common(conn, ev):
    """IV rank (1y pctile of iv30 put), 52-week-high proximity, IBES drift/breadth — known at the entry close."""
    tick = sorted({e["t"] for e in ev})
    iv, cl = defaultdict(list), defaultdict(list)
    for t, d, p, c in conn.execute("""SELECT ticker, date, iv30_put::float8, close::float8 FROM lseg_research.daily_history
                                      WHERE ticker = ANY(%s) AND close > 0 ORDER BY ticker, date""", (tick,)).fetchall():
        cl[t].append((d, c))
        if p and p > 0:
            iv[t].append((d, p))
    fund = {(t, d): f for t, d, f in conn.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_fund").fetchall()}
    ivd = {t: [d for d, _ in v] for t, v in iv.items()}
    cld = {t: [d for d, _ in v] for t, v in cl.items()}
    for e in ev:
        t, d = e["t"], e["d"]
        if t in iv:
            i = bisect_right(ivd[t], d) - 1
            if i >= 120:
                h = [v for _, v in iv[t][max(0, i - 251): i]]
                e["iv_pct"] = sum(1 for v in h if v <= iv[t][i][1]) / len(h)
        if t in cl:
            i = bisect_right(cld[t], d) - 1
            if i >= 252:
                e["prox_52w"] = cl[t][i][1] / max(c for _, c in cl[t][i - 251: i + 1]) - 1
        f = fund.get((t, d)) or {}
        for k in ("ibes_drift", "ibes_breadth"):
            if isinstance(f.get(k), (int, float)):
                e[k] = float(f[k])


SELL_FACTORS = ["iv_rv", "iv_pct", "vol_of_vol", "term_slope", "idio_vol", "mom_12_1", "rev_1m", "ret5", "prox_52w",
                "tech_trendContext", "tech_volumeConfirm", "tech_oversoldDepth", "tech_relativePressure", "sue",
                "ibes_drift", "har_iv"]


def weekly_groups(ev, feats):
    by = defaultdict(list)
    for e in ev:
        if all(e.get(f) is not None and e[f] == e[f] for f in feats):
            by[e["d"]].append(e)
    return {d: g for d, g in by.items() if len(g) >= 30}


def top_q(g, score):
    q = len(g) // 5
    o = np.argsort(score)[-q:]
    return float(np.mean([g[k]["pnl"] for k in o]))


def sold_study(ev, baseline):
    """baseline = (name, [(feat, sign)]) = the live ranker for this strategy."""
    fit = [e for e in ev if e["d"] < SPLIT]
    feats = [f for f in SELL_FACTORS if sum(e.get(f) is not None for e in fit) > 0.5 * len(fit)]
    sign, single = {}, {}
    for f in feats:
        G = weekly_groups(fit, [f])
        hi = [top_q(g, rank([e[f] for e in g])) for g in G.values()]
        lo = [top_q(g, -rank([e[f] for e in g])) for g in G.values()]
        sign[f] = 1 if np.mean(hi) >= np.mean(lo) else -1
        single[f] = (np.mean(hi if sign[f] > 0 else lo), tstat(np.array(hi) - np.array(lo)) * sign[f])

    def series(sub, fs):
        """{week: (pair top-q, best-single top-q of the pair's own inputs, all)}."""
        G = weekly_groups(sub, list(fs))
        out = {}
        for d, g in G.items():
            r = {f: sign[f] * rank([e[f] for e in g]) for f in fs}
            out[d] = (top_q(g, sum(r.values())), {f: top_q(g, r[f]) for f in fs}, float(np.mean([e["pnl"] for e in g])))
        return out

    scored = []
    for a, b in combinations(feats, 2):
        s = series(fit, (a, b))
        if len(s) < 40:
            continue
        best = max((a, b), key=lambda f: np.mean([v[1][f] for v in s.values()]))
        gain = [v[0] - v[1][best] for v in s.values()]
        scored.append((float(np.mean(gain)), tstat(gain), a, b, best))
    scored.sort(reverse=True)
    res = []
    for gain_fit, t_fit, a, b, best in scored[:KEEP]:
        s = series([e for e in ev if e["d"] >= SPLIT], (a, b))
        ws = sorted(s)
        g = [s[d][0] - s[d][1][best] for d in ws]
        h = len(g) // 2
        bf, bs = baseline[1], None
        G = weekly_groups([e for e in ev if e["d"] >= SPLIT], [a, b] + [f for f, _ in bf])
        vs_live = [top_q(gr, sum(sign[f] * rank([e[f] for e in gr]) for f in (a, b)))
                   - top_q(gr, sum(sg * rank([e[f] for e in gr]) for f, sg in bf)) for gr in G.values()]
        res.append({"pair": (a, b), "best": best, "fit_gain": gain_fit, "fit_t": t_fit,
                    "ho_pair": np.mean([s[d][0] for d in ws]), "ho_best": np.mean([s[d][1][best] for d in ws]),
                    "ho_all": np.mean([s[d][2] for d in ws]), "ho_gain": float(np.mean(g)), "ho_t": tstat(g),
                    "halves": (float(np.mean(g[:h])), float(np.mean(g[h:]))), "weeks": len(ws),
                    "vs_live": float(np.mean(vs_live)), "vs_live_t": tstat(vs_live), "live": baseline[0]})
    return sign, single, res, len(scored)


# ---------------------------------------------------------------- bought options (S086 panel + S081 pricer)

LONG_FACTORS = ["iv_rv20", "iv_rank252", "prox_52w", "mom_12_1", "rev_5d", "ret60", "ext50", "rsi2", "dd60", "iv_chg5",
                "ibes_drift", "ibes_breadth", "ibes_sue", "tech_v4call_total", "tech_v2_total"]
IV_FIXED = {"iv_rv20": -1, "iv_rank252": -1}   # buy cheap (Jamie's rule): not fitted


def long_study(conn):
    import s085_regime_analog as e
    import s086_strategy_board as B
    e.DIGEST = B.pick_digest(conn)
    px = e.load_prices(conn)
    universe = sorted(t for t in px if t not in e.BENCH)
    tech, fund, tgt, _ = e.load_lab(conn, set(universe))
    weeks = sorted(d for d in set(tech) | set(fund) if tgt.get(d))
    panel = e.build_panel(px, universe, weeks, tech, fund)
    for row in panel.values():
        for t, f in row.items():
            f.update(B.extras(px[t], f["_i"]))
    avail = set(e.factor_names(panel)) | {"rsi2", "dd60", "ext50", "ret60", "iv_chg5"}
    feats = [f for f in LONG_FACTORS if f in avail]
    print(f"long panel: {len(weeks)} weeks · factors {feats}", flush=True)
    pricer, tb = e.Pricer(conn), e.tbill_map(conn)
    cache = {}

    def opt(t, d, side):
        k = (t, d, side)
        if k not in cache:
            tr = e.price_long(pricer, px[t], panel[d][t]["_i"], side, e.tbill_at(tb, d))
            cache[k] = tr["expiry"] if tr else None
        return cache[k]

    def val(row, t, f):
        v = row[t].get(f)
        return v if isinstance(v, (int, float)) and v == v else None

    def picks(row, fs, sg, gate=False):
        names = [t for t in row if all(val(row, t, f) is not None for f in fs)]
        if gate:
            ivs = [val(row, t, "iv_rank252") for t in names]
            med = np.median([v for v in ivs if v is not None]) if any(v is not None for v in ivs) else None
            names = [t for t in names if med is not None and (val(row, t, "iv_rank252") or 1) < med]
        if len(names) < 40 // (2 if gate else 1):
            return []
        sc = sum(sg[f] * rank([val(row, t, f) for t in names]) for f in fs)
        return [names[k] for k in np.argsort(sc)[-TOPN:]]

    def week_ret(d, ts, side):
        v = [x for t in ts if (x := opt(t, d, side)) is not None]
        return float(np.mean(v)) if len(v) >= 5 else float("nan")

    out = {}
    for side in ("call", "put"):
        fitw = [d for d in weeks if d < SPLIT and len(panel.get(d, {})) >= 40]
        how = [d for d in weeks if d >= SPLIT and len(panel.get(d, {})) >= 40]
        # direction: IV fixed cheap; others = sign of the stock-relative edge on FIT (rel_21; calls +, puts −)
        sg = {}
        for f in feats:
            if f in IV_FIXED:
                sg[f] = IV_FIXED[f]
                continue
            ics = []
            for d in fitw:
                ts = [t for t in panel[d] if val(panel[d], t, f) is not None and t in tgt[d]]
                if len(ts) >= 40:
                    ics.append(np.corrcoef(rank([panel[d][t][f] for t in ts]), rank([tgt[d][t] for t in ts]))[0, 1])
            s = 1 if np.nanmean(ics) >= 0 else -1
            sg[f] = s if side == "call" else -s
        allw = {d: week_ret(d, list(panel[d]), side) for d in fitw[::4] + how}   # every name: FIT sampled 1 in 4 (cost)
        single = {f: {d: week_ret(d, picks(panel[d], [f], sg), side) for d in fitw} for f in feats}
        print(f"{side}: singles done ({len(cache)} priced)", flush=True)
        scored = []
        for a, b in combinations(feats, 2):
            pr = {d: week_ret(d, picks(panel[d], [a, b], sg), side) for d in fitw}
            best = max((a, b), key=lambda f: np.nanmean(list(single[f].values())))
            gain = [(d, pr[d] - single[best][d]) for d in fitw]
            scored.append((float(np.nanmean([g for _, g in gain])), block_t(gain), a, b, best))
        scored.sort(key=lambda z: -z[0] if z[0] == z[0] else 1e9)
        print(f"{side}: {len(scored)} pairs scored on FIT ({len(cache)} priced)", flush=True)
        res = []
        for gain_fit, t_fit, a, b, best in scored[:KEEP]:
            pr = [(d, week_ret(d, picks(panel[d], [a, b], sg), side)) for d in how]
            bs = [(d, week_ret(d, picks(panel[d], [best], sg), side)) for d in how]
            g = [(d, p - q) for (d, p), (_, q) in zip(pr, bs)]
            h = len(g) // 2
            res.append({"pair": (a, b), "best": best, "fit_gain": gain_fit, "fit_t": t_fit,
                        "ho_pair": np.nanmean([v for _, v in pr]), "ho_best": np.nanmean([v for _, v in bs]),
                        "ho_all": np.nanmean([allw[d] for d in how]), "ho_gain": float(np.nanmean([v for _, v in g])),
                        "ho_t": block_t(g), "halves": (float(np.nanmean([v for _, v in g[:h]])), float(np.nanmean([v for _, v in g[h:]]))),
                        "weeks": len(how)})
        # cheap gate (a requirement, not a blend) on every single angle, all weeks
        gate = []
        for f in feats:
            if f in IV_FIXED:
                continue
            plain = [(d, week_ret(d, picks(panel[d], [f], sg), side)) for d in fitw + how]
            gated = [(d, week_ret(d, picks(panel[d], [f], sg, gate=True), side)) for d in fitw + how]
            diff = [(d, p - q) for (d, p), (_, q) in zip(gated, plain)]
            gate.append((f, np.nanmean([v for _, v in plain]), np.nanmean([v for _, v in gated]),
                         np.nanmean([v for d, v in diff if d >= SPLIT]), block_t(diff)))
        out[side] = {"sign": sg, "single": {f: (np.nanmean([single[f][d] for d in fitw]),) for f in feats},
                     "all_fit": np.nanmean([allw[d] for d in fitw[::4]]), "res": res, "n_pairs": len(scored), "gate": gate}
    return out


# ---------------------------------------------------------------- main

def main():
    import s045_put_retest as S
    import s046_calls_avoid as C
    import s059_option_factors as F
    L = ["# S100 — two-input combinations for sold and bought options", "",
         f"FIT weeks < {SPLIT}, HOLDOUT {SPLIT} →. Top 3 pairs per strategy chosen on FIT by gain over the better single input; "
         "PASS = holdout gain t ≥ 2 and both holdout halves > 0.", ""]
    with connect() as conn:
        puts = F.aligned_events(conn)
        add_common(conn, puts)
        rows, tech, fund, px = S.load(conn)
        calls = C.build(rows, tech, fund, px)
        C.attach_call_tech(conn, calls)
        F.add_features(conn, calls)
        add_common(conn, calls)
        for e in calls:
            e["pnl"] = e["call_pnl"]
        print(f"sold: {len(puts)} puts · {len(calls)} calls", flush=True)
        sold = {"Sell puts": (puts, ("live put edge (IV/RV + vol of vol + put tech)", [("iv_rv", 1), ("vol_of_vol", 1), ("put_tech", 1)])),
                "Sell calls": (calls, ("live call tech (low volume, not stretched)", [("call_volume", -1), ("call_trend_ext", -1)]))}
        for name, (ev, base) in sold.items():
            sign, single, res, n = sold_study(ev, base)
            L += [f"## {name} ({len(ev)} trades; bp per week of collateral)", "",
                  "Singles on FIT (top quintile, direction): " + " · ".join(
                      f"{lab(f)} {'↑' if sign[f] > 0 else '↓'} {1e4 * v[0]:+.1f} (t {v[1]:+.1f})"
                      for f, v in sorted(single.items(), key=lambda kv: -kv[1][0])), "",
                  f"{n} pairs tested on FIT. Top {KEEP} on the holdout:", "",
                  "| pair | FIT gain vs better single | HOLDOUT pair | better single | all trades | gain (t) | halves | vs live | verdict |",
                  "|---|---|---|---|---|---|---|---|---|"]
            for r in res:
                ok = r["ho_t"] >= 2 and min(r["halves"]) > 0
                L.append(f"| {lab(r['pair'][0])} {'↑' if sign[r['pair'][0]] > 0 else '↓'} + {lab(r['pair'][1])} {'↑' if sign[r['pair'][1]] > 0 else '↓'} "
                         f"| {1e4 * r['fit_gain']:+.1f} (t {r['fit_t']:+.1f}) | {1e4 * r['ho_pair']:+.1f} | {1e4 * r['ho_best']:+.1f} ({lab(r['best'])}) "
                         f"| {1e4 * r['ho_all']:+.1f} | {1e4 * r['ho_gain']:+.1f} ({r['ho_t']:+.1f}) | {1e4 * r['halves'][0]:+.1f} / {1e4 * r['halves'][1]:+.1f} "
                         f"| {1e4 * r['vs_live']:+.1f} (t {r['vs_live_t']:+.1f}) | {'PASS' if ok else 'fail'} |")
            L.append("")
            print("\n".join(L[-(KEEP + 3):]), flush=True)
        lo = long_study(conn)
    for side, o in lo.items():
        L += [f"## Buy {side}s (0.50Δ ~45 DTE held to expiry; return per $ debit; FIT all names {o['all_fit']:+.1%})", "",
              "Singles on FIT (top 10): " + " · ".join(f"{lab(f)} {'↑' if o['sign'][f] > 0 else '↓'} {v[0]:+.1%}"
                                                    for f, v in sorted(o["single"].items(), key=lambda kv: -kv[1][0])), "",
              f"{o['n_pairs']} pairs tested on FIT. Top {KEEP} on the holdout:", "",
              "| pair | FIT gain | HOLDOUT pair | better single | all names | gain (t) | halves | verdict |", "|---|---|---|---|---|---|---|---|"]
        for r in o["res"]:
            ok = r["ho_t"] >= 2 and min(r["halves"]) > 0
            L.append(f"| {lab(r['pair'][0])} {'↑' if o['sign'][r['pair'][0]] > 0 else '↓'} + {lab(r['pair'][1])} {'↑' if o['sign'][r['pair'][1]] > 0 else '↓'} "
                     f"| {r['fit_gain']:+.1%} (t {r['fit_t']:+.1f}) | {r['ho_pair']:+.1%} | {r['ho_best']:+.1%} ({lab(r['best'])}) | {r['ho_all']:+.1%} "
                     f"| {r['ho_gain']:+.1%} ({r['ho_t']:+.1f}) | {r['halves'][0]:+.1%} / {r['halves'][1]:+.1%} | {'PASS' if ok else 'fail'} |")
        L += ["", "Cheap gate (top 10 among names with IV rank below the week's median) vs the plain angle, all weeks:", "",
              "| angle | plain | cheap-gated | holdout gain | t (all weeks) |", "|---|---|---|---|---|"]
        for f, p, g, hg, t in sorted(o["gate"], key=lambda z: -z[2]):
            L.append(f"| {lab(f)} {'↑' if o['sign'][f] > 0 else '↓'} | {p:+.1%} | {g:+.1%} | {hg:+.1%} | {t:+.1f} |")
        L.append("")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
