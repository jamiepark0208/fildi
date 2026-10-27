#!/usr/bin/env python3
"""T1 (A281, pre-registered by Grok): intraday order timing for the weekly sold put — on a week the engine already chose, does waiting
for a 15-min UT Bot turn up or a 1-hour swing-low sweep-and-reclaim (strike under the swept low) sell the same put for more?

Data: optlab.bars_5m (Polygon, regular hours 9:30–16:00 ET only) → 15-min and 1-hour bars; indicators.compute on each (author
defaults; the guides are tuned for these timeframes). Per name-week (first session of the week):
  strike   K fixed at the open: listed put nearest 0.11Δ (band 0.10–0.12) on that morning's iv30_put, Friday expiry
  open     sell K at the first 5-min bar's open
  ut15     sell K at the next bar's open after the first 15-min UT direction flip up (−1 → +1) in sessions 1–2
  sweep1h  sell K at the next bar's open after the first 1-hour sweep-and-reclaim (sweep_age = 0) in sessions 1–2 with K < swept low
  placebo  for each signal arm: a random 5-min bar in the same window, fired with the same frequency (seeded)
Arms that never print earn the T-bill for the week. Premium at time τ = Black-Scholes(S_τ, K, iv30_put, T_τ) × seller fill (S076
relative spread at that DTE); intraday IV held at the morning value (understates the dip's IV bump → conservative for waiting).
Outcome: (credit − max(K − S_Friday, 0)) ÷ K per collateral-week (the collateral is tied up for the week either way).
Pass (indicators.md T1): more bp per collateral-week than the open, breach no worse, same sign both halves, week-cluster t ≥ 2.5,
placebo ≈ 0.

    .venv/bin/python analysis/t1_intraday_timing.py [--tickers=A,B]   → out/opt/T1.md
"""
from __future__ import annotations

import math
import random
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import FILL_K, Pricer, bs_put  # noqa: E402
from s088_sr_zones import listed_strike  # noqa: E402
from t2_cc_timing import DELTAS  # noqa: E402,F401  (same Δ → z table style)

ET = ZoneInfo("America/New_York")
Z11 = 1.2265   # N⁻¹(1 − 0.11)
ARMS = ("open", "ut15", "sweep1h", "ut15_placebo", "sweep1h_placebo")
rng = random.Random(281)


def tbill_week() -> dict[date, float]:
    rf = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        d, v = line.split(",")
        if v not in ("", "."):
            rf[date.fromisoformat(d)] = float(v) / 100 / 52
    return rf


def resample(ts, o, h, l, c, minutes):
    """Regular-hours bars grouped into `minutes` buckets from 9:30 ET (each session separately)."""
    out = defaultdict(lambda: [None, None, -1e18, 1e18, None])
    for t, a, b, x, y in zip(ts, o, h, l, c):
        m = (t.hour * 60 + t.minute) - 570
        k = (t.date(), m // minutes)
        r = out[k]
        if r[0] is None:
            r[0], r[1] = t, a
        r[2], r[3], r[4] = max(r[2], b), min(r[3], x), y
    ks = sorted(out)
    end = [out[k][0] + timedelta(minutes=minutes - (((out[k][0].hour * 60 + out[k][0].minute) - 570) % minutes)) for k in ks]
    return ([out[k][0] for k in ks], end, np.array([out[k][1] for k in ks]), np.array([out[k][2] for k in ks]),
            np.array([out[k][3] for k in ks]), np.array([out[k][4] for k in ks]))


def main():
    only = [x for a in sys.argv[1:] if a.startswith("--tickers=") for x in a[10:].upper().split(",")]
    rf = tbill_week()
    res = defaultdict(lambda: defaultdict(list))    # arm → week → [bp]
    breach = defaultdict(list)
    with connect() as conn:
        pricer = Pricer(conn)
        names = only or [t for (t,) in conn.execute("SELECT DISTINCT ticker FROM optlab.bars_5m")]
        for t in names:
            daily = {d: (c, iv / 100 if iv and iv > 3 else iv) for d, c, iv in conn.execute(
                "SELECT date, close::float8, iv30_put::float8 FROM lseg_research.daily_history WHERE ticker = %s", (t,))}
            raw = conn.execute("SELECT ts, o, h, l, c FROM optlab.bars_5m WHERE ticker = %s ORDER BY ts", (t,)).fetchall()
            bars = [(ts.astimezone(ET), o, h, l, c) for ts, o, h, l, c in raw]
            bars = [b for b in bars if time(9, 30) <= b[0].time() < time(16, 0)]
            if len(bars) < 2000:
                continue
            ts, o, h, l, c = zip(*bars)
            o, h, l, c = map(np.array, (o, h, l, c))
            s15 = resample(ts, o, h, l, c, 15)
            s60 = resample(ts, o, h, l, c, 60)
            ind15 = IND.compute(list(range(len(s15[5]))), s15[3], s15[4], s15[5], None, s15[2])
            ind60 = IND.compute(list(range(len(s60[5]))), s60[3], s60[4], s60[5], None, s60[2])
            flip_up = [s15[1][i] for i in range(1, len(s15[5])) if ind15["ut_dir"][i] > 0 and ind15["ut_dir"][i - 1] < 0]
            sweeps = [(s60[1][i], ind60["sweep_low"][i]) for i in range(len(s60[5])) if ind60["sweep_age"][i] == 0]
            first = {}
            for k, b in enumerate(bars):
                wk = b[0].date().isocalendar()[:2]
                first.setdefault(wk, k)
            days = sorted({b[0].date() for b in bars})
            for wk, k0 in first.items():
                d0 = bars[k0][0].date()
                if d0.isocalendar()[1] == date.today().isocalendar()[1] or d0 < days[0] + timedelta(days=30):
                    continue
                fri = d0 + timedelta(days=4 - d0.weekday())
                wdays = [d for d in days if d0 <= d <= fri]
                if len(wdays) < 3 or wdays[-1] not in daily:
                    continue
                prev = max((d for d in daily if d < d0), default=None)
                iv = daily[prev][1] if prev else None
                if not iv:
                    continue
                exp_close = daily[wdays[-1]][0]
                win_end = datetime.combine(wdays[1], time(16, 0), ET)
                close_t = datetime.combine(fri, time(16, 0), ET)
                S0 = bars[k0][1]
                T0 = (close_t - bars[k0][0]).total_seconds() / (365 * 86400)
                sd = iv * math.sqrt(T0)
                K = listed_strike(S0 * math.exp(-Z11 * sd - 0.5 * sd * sd), S0, "put")

                def sell(at):
                    j = next((k for k in range(k0, len(bars)) if bars[k][0] >= at), None)
                    if j is None:
                        return None
                    S, tt = bars[j][1], bars[j][0]
                    T = (close_t - tt).total_seconds() / (365 * 86400)
                    _, spread = pricer.mid("put", S, K, iv, max(1, (fri - tt.date()).days), tt.date())
                    cr = bs_put(S, K, iv, T) * (1 - FILL_K * spread)
                    return (cr - max(K - exp_close, 0.0)) / K
                week_rf = rf.get(max((d for d in rf if d <= d0), default=d0), 0.0)
                p_open = sell(bars[k0][0])
                if p_open is None or (p_open + max(K - exp_close, 0) / K) * K < 0.05:   # credit < $0.05 → not tradable
                    continue
                res["open"][wk].append(1e4 * p_open)
                breach["open"].append(exp_close < K)
                win = [b[0] for b in bars[k0:] if b[0] < win_end]
                u = next((x for x in flip_up if bars[k0][0] <= x < win_end), None)
                sw = next((x for x, low in sweeps if bars[k0][0] <= x < win_end and K < low), None)
                for arm, at in (("ut15", u), ("sweep1h", sw)):
                    p = sell(at) if at else None
                    res[arm][wk].append(1e4 * (p if p is not None else week_rf))
                    if p is not None:
                        breach[arm].append(exp_close < K)
                    pa = sell(rng.choice(win)) if at and win else None   # placebo fires on the same weeks, random time
                    res[arm + "_placebo"][wk].append(1e4 * (pa if pa is not None else week_rf))
    split = (2025, 27)
    L = [f"# T1 — intraday order timing for the weekly sold put ({date.today()})", "",
         f"{len(names)} names · weeks {min(res['open'])} → {max(res['open'])} · strike 0.11Δ fixed at the Monday open; "
         "window = first two sessions; no print → T-bill.", "",
         "| arm | name-weeks | fired | breach % | bp/collateral-wk | vs open bp (t) H1 | vs open bp (t) H2 | vs open all (t) |",
         "|---|---|---|---|---|---|---|---|"]
    def wk_diff(arm, lo, hi):
        ws = [w for w in res["open"] if lo <= w < hi and w in res[arm]]
        dd = np.array([np.mean(res[arm][w]) - np.mean(res["open"][w]) for w in ws])
        return dd.mean(), dd.mean() / (dd.std(ddof=1) / math.sqrt(len(dd))) if len(dd) > 2 and dd.std() > 0 else float("nan")
    verdict = {}
    for arm in ARMS:
        n = sum(len(v) for v in res[arm].values())
        allv = [x for v in res[arm].values() for x in v]
        h1, h2, al = wk_diff(arm, (0, 0), split), wk_diff(arm, split, (9999, 0)), wk_diff(arm, (0, 0), (9999, 0))
        L.append(f"| {arm} | {n} | {len(breach[arm])} | {100 * np.mean(breach[arm]) if breach[arm] else float('nan'):.1f} | "
                 f"{np.mean(allv):+.1f} | {h1[0]:+.1f} ({h1[1]:+.1f}) | {h2[0]:+.1f} ({h2[1]:+.1f}) | {al[0]:+.1f} ({al[1]:+.1f}) |")
        verdict[arm] = (h1, h2, al)
    oks = []
    for arm in ("ut15", "sweep1h"):
        h1, h2, al = verdict[arm]
        pl = verdict[arm + "_placebo"][2]
        br = np.mean(breach[arm]) <= np.mean(breach["open"]) if breach[arm] else False
        if h1[0] > 0 and h2[0] > 0 and al[1] >= 2.5 and br and abs(pl[1]) < 2 and al[0] > pl[0]:
            oks.append(arm)
    L.append(f"\nWeeks split at 2025-W27. **Verdict: {'PASS — ' + ', '.join(oks) if oks else 'FAIL'}** "
             "(bar: beats the open both halves, week-cluster t ≥ 2.5, breach no worse, placebo ≈ 0 and below the signal).")
    txt = "\n".join(L)
    if not only:
        (HERE.parent / "out" / "opt" / "T1.md").write_text(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
