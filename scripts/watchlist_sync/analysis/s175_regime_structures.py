"""S175 — regime × structure matrix (trade-funnel step 1, research/common/trade-funnel-plan.md; Jamie 11-09).

Question: in each market regime, which option structures (views) pay, and if the funnel checks only those, how many of the
best trades does it keep (recall)?

Trades = S076 run() unchanged (16 structures, Monday entries 2021-02 →, ~260 names, model-priced with skew + RH fills,
earnings excluded, held to expiry, excess over T-bill per $ capital). Cached to ~/.fildi/cache/s175_trades.pkl.

Pre-registered (11-09, before any run). Regime at the entry Monday close, first match wins:
  panic       VIX÷VIX3M ≥ 1                                         (S054 / S172 inverted)
  bottom      VIX÷VIX3M < 1 and an un-invert (≥ 2 inverted sessions → < 1) in the last 10 sessions   (S172)
  sharp_drop  SPY 63-session return ≤ −8 %                             (S101)
  calm_up     SPY > 200-day and VIX < 20
  other       the rest (elevated vol / chop / below 200-day)
Cell (structure × regime), all trades (not the board's fit slice — the funnel decides fit later):
  works  mean > 0, month-block t ≥ 2, mean > 0 in 2021–23 and 2024 →
  lean   mean > 0 in both eras, t < 2
  avoid  otherwise. Cells with < 4 independent episodes (runs of consecutive regime weeks) → UNDERPOWERED tag.
Comparator: the same structure on all days (does the regime help?) and T-bill (excess is already over it).
Recall: trade z = excess ÷ its structure's sd; winners = top decile of z each week; recall = share of winners whose
(structure, regime) cell is works ∪ lean; cut = share of all trades outside. Pass for the funnel: recall ≥ 80 %.
"""
from __future__ import annotations

import json
import math
import pickle
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
import s076_structures_backtest as S  # noqa: E402

CACHE = Path.home() / ".fildi/cache/s175_trades.pkl"
OUT = HERE.parent / "out/opt/S175.md"
DATA = HERE.parent.parent.parent / "research/studies/data/s175_regime_structures.json"
REGIMES = ["panic", "bottom", "sharp_drop", "calm_up", "other"]
VIEW = {"csp": "bullish", "put_spread": "bullish", "covered_call": "bullish", "jade_lizard": "bullish", "bull_call_spread": "bullish",
        "long_call": "bullish", "collar": "hedge", "call_spread": "bearish", "bear_put_spread": "bearish", "long_put": "bearish",
        "iron_condor": "neutral", "iron_fly": "neutral", "short_straddle": "neutral", "short_strangle": "neutral",
        "long_straddle": "vol_up", "long_strangle": "vol_up", "calendar": "neutral"}


def regime_map(conn):
    ix = defaultdict(dict)
    for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')"):
        ix[i][d] = c
    spy = conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close > 0 ORDER BY date").fetchall()
    sd = [d for d, _ in spy]
    vd = sorted(set(ix["VIX"]) & set(ix["VIX3M"]))
    ratio = [ix["VIX"][d] / ix["VIX3M"][d] for d in vd]
    last_uninv = {}
    run, last = 0, None
    for k, d in enumerate(vd):
        if ratio[k] >= 1:
            run += 1
        else:
            if run >= 2:
                last = k
            run = 0
        last_uninv[d] = last

    def lab(d):
        k = bisect_right(vd, d) - 1
        if k < 0:
            return "other"
        if ratio[k] >= 1:
            return "panic"
        if last_uninv[vd[k]] is not None and k - last_uninv[vd[k]] < 10:
            return "bottom"
        i = bisect_right(sd, d) - 1
        if i >= 63 and spy[i][1] / spy[i - 63][1] - 1 <= -0.08:
            return "sharp_drop"
        if i >= 200 and spy[i][1] > sum(c for _, c in spy[i - 199:i + 1]) / 200 and ix["VIX"][vd[k]] < 20:
            return "calm_up"
        return "other"
    return lab


def episodes(dates):
    ws = sorted(set(dates))
    return sum(1 for k, d in enumerate(ws) if k == 0 or (d - ws[k - 1]).days > 7)


def main():
    with connect() as conn:
        if CACHE.exists() and "--fresh" not in sys.argv:
            trades = pickle.loads(CACHE.read_bytes())
        else:
            trades = S.run(conn, None)
            CACHE.write_bytes(pickle.dumps(trades))
        lab = regime_map(conn)
    print(f"{len(trades)} trades", flush=True)
    rcache = {}
    for x in trades:
        if x["d"] not in rcache:
            rcache[x["d"]] = lab(x["d"])
        x["reg"] = rcache[x["d"]]
    wk = defaultdict(set)
    for d, r in rcache.items():
        wk[r].add(d)
    by = defaultdict(list)
    for x in trades:
        by[x["s"]].append(x)
    sdv = {s: statistics.pstdev([x["base"] for x in xs]) or 1 for s, xs in by.items()}
    cells, allm = {}, {}
    for s, xs in by.items():
        allm[s] = statistics.mean(x["base"] for x in xs)
        for r in REGIMES:
            c = [x for x in xs if x["reg"] == r]
            if len(c) < 30:
                cells[(s, r)] = {"n": len(c), "verdict": "avoid", "why": "n < 30"}
                continue
            m = statistics.mean(x["base"] for x in c)
            e1 = [x["base"] for x in c if x["d"] < S.SPLIT]
            e2 = [x["base"] for x in c if x["d"] >= S.SPLIT]
            m1 = statistics.mean(e1) if e1 else float("nan")
            m2 = statistics.mean(e2) if e2 else float("nan")
            t = S.month_t(c)
            eps = episodes([x["d"] for x in c])
            both = m1 > 0 and m2 > 0
            v = "works" if m > 0 and t >= 2 and both else ("lean" if m > 0 and both else "avoid")
            cells[(s, r)] = {"n": len(c), "weeks": len({x["d"] for x in c}), "episodes": eps, "mean": m, "all_days": allm[s],
                             "lift": m - allm[s], "t": t, "eras": (m1, m2), "win": sum(x["pnl"] > 0 for x in c) / len(c),
                             "verdict": v, "underpowered": eps < 4}
    # recall of the funnel filter
    byw = defaultdict(list)
    for x in trades:
        byw[x["d"]].append(x)
    win = tot_keep = n_all = 0
    keep_w = 0
    reg_rec = defaultdict(lambda: [0, 0])
    for d, xs in byw.items():
        zs = sorted(xs, key=lambda x: x["base"] / sdv[x["s"]])
        top = zs[-max(1, len(zs) // 10):]
        for x in top:
            ok = cells[(x["s"], x["reg"])]["verdict"] in ("works", "lean")
            win += 1
            keep_w += ok
            reg_rec[x["reg"]][0] += ok
            reg_rec[x["reg"]][1] += 1
        for x in xs:
            n_all += 1
            tot_keep += cells[(x["s"], x["reg"])]["verdict"] in ("works", "lean")
    recall, kept = keep_w / win, tot_keep / n_all
    L = ["# S175 — regime × structure matrix", "",
         f"{len(trades):,} S076 trades · weeks per regime: " + ", ".join(f"{r} {len(wk[r])} ({episodes(wk[r])} episodes)" for r in REGIMES), "",
         "Cell = mean excess per $ capital (held to expiry) · t (month-block) · eras 2021–23 / 2024→ · lift vs same structure all days.", "",
         "| Structure | View | " + " | ".join(REGIMES) + " | all days |", "|---|---|" + "---|" * (len(REGIMES) + 1)]
    for s in sorted(by, key=lambda s: (VIEW.get(s, "?"), s)):
        row = []
        for r in REGIMES:
            c = cells[(s, r)]
            if "mean" not in c:
                row.append(f"n {c['n']}")
                continue
            tag = {"works": "**W**", "lean": "L", "avoid": "·"}[c["verdict"]] + ("ᵘ" if c["underpowered"] else "")
            row.append(f"{tag} {c['mean']:+.2%} t{c['t']:.1f} ({c['eras'][0]:+.1%}/{c['eras'][1]:+.1%}) n{c['n']}")
        L.append(f"| {s} | {VIEW.get(s, '?')} | " + " | ".join(row) + f" | {allm[s]:+.2%} |")
    L += ["", f"**Funnel filter (check only works ∪ lean cells):** keeps {recall:.0%} of weekly top-decile trades (z = excess ÷ structure sd) "
          f"while checking {kept:.0%} of all trades. Pass bar recall ≥ 80 %.",
          "Recall by regime: " + ", ".join(f"{r} {a / b:.0%} (of {b:,})" for r, (a, b) in reg_rec.items() if b), ""]
    allowed = {r: sorted(s for s in by if cells[(s, r)]["verdict"] in ("works", "lean")) for r in REGIMES}
    L += ["## Allowed structures per regime (works ∪ lean)", ""] + [f"- **{r}:** {', '.join(allowed[r]) or '—'}" for r in REGIMES]
    OUT.write_text("\n".join(L) + "\n")
    DATA.write_text(json.dumps({"cells": {f"{s}|{r}": c for (s, r), c in cells.items()}, "recall": recall, "kept": kept,
                                "allowed": allowed}, default=str, indent=1))
    print("\n".join(L))


if __name__ == "__main__":
    main()
