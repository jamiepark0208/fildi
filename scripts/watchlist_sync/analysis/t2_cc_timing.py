#!/usr/bin/env python3
"""T2 (A281, pre-registered by Grok): covered-call timing on shares already held — write only when greed / a bearish divergence says
the rally is stretched, vs writing every Monday, vs never writing (S088d: every always-on band lost vs holding).

Every name with daily bars + iv30_call (lseg_research.daily_history), 2021-01 → today, one entry per week (first bar of the week).
Signals on the previous bar's close (published after the close → one-bar lag), indicators.compute on author defaults:
  greed      Fear & Greed ≥ 70
  bear_div   a bearish RSI divergence (pivot 5) confirmed in the last 5 bars
  either     greed or bear_div
Call: 1 week, strike at the target |Δ| (0.10 and 0.15) from iv30_call, rounded up to the listed step; S076 Pricer mid + seller fill.
Overlay pnl per $ of stock = (credit − max(S_expiry − K, 0)) ÷ S; a week with no call = 0. The shares' own return is common to all
arms, so the comparison is the overlay. Pass (indicators.md T2): the signal arm beats both never-writing (0) and the Monday write,
both halves, week-clustered t ≥ 2.5.

    .venv/bin/python analysis/t2_cc_timing.py [--tickers=A,B]   → out/opt/T2.md
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, fill  # noqa: E402
from s088_sr_zones import listed_strike  # noqa: E402

START, SPLIT = date(2021, 1, 4), date(2023, 7, 1)
DELTAS = {0.10: 1.2816, 0.15: 1.0364}   # |Δ| → N⁻¹(1 − Δ)
SIGNALS = ("always", "greed", "bear_div", "either")


def main():
    only = {x for a in sys.argv[1:] if a.startswith("--tickers=") for x in a[10:].upper().split(",")}
    with connect() as conn:
        bars = IND.load_bars(conn, only or None)
        ivc = defaultdict(dict)
        for t, d, v in conn.execute("""SELECT ticker, date, iv30_call::float8 FROM lseg_research.daily_history
                                       WHERE iv30_call > 0 AND date >= %s""", (START,)):
            ivc[t][d] = v / 100 if v > 3 else v
        pricer = Pricer(conn)
    # overlay[(delta, signal)][week] → list of per-name overlay pnl (0 when not written)
    ov = defaultdict(lambda: defaultdict(list))
    fired = defaultdict(int)
    n_names = 0
    for t, (d, h, l, c, v, o) in bars.items():
        if t in ("SPY", "QQQ", "IWM") or len(c) < 400 or t not in ivc:
            continue
        s = IND.compute(d, h, l, c, v, o)
        c = np.asarray(c, float)
        bear = np.array([np.any(s["rsi_div"][max(0, i - 4):i + 1] < 0) for i in range(len(c))])
        last_wk, n_names = None, n_names + 1
        for i in range(320, len(c) - 5):
            if d[i] < START:
                continue
            wk = d[i].isocalendar()[:2]
            if wk == last_wk:
                continue
            last_wk = wk
            iv = ivc[t].get(d[i])
            if not iv or c[i] < 5:
                continue
            j = i + 5
            S, Se, ndays = float(c[i]), float(c[j]), (d[j] - d[i]).days
            sig = {"always": True, "greed": s["fear_greed"][i - 1] >= 70, "bear_div": bool(bear[i - 1])}
            sig["either"] = sig["greed"] or sig["bear_div"]
            sd = iv * math.sqrt(ndays / 365)
            for dl, z in DELTAS.items():
                K = listed_strike(S * math.exp(z * sd + 0.5 * sd * sd), S, "call")
                mid, spread = pricer.mid("call", S, K, iv, ndays, d[i])
                pnl = (fill(mid, spread, -1) - max(Se - K, 0.0)) / S
                for k in SIGNALS:
                    ov[(dl, k)][wk].append(pnl if sig[k] else 0.0)
                    if sig[k] and dl == 0.10:
                        fired[k] += 1
    L = [f"# T2 — covered-call timing on held shares ({date.today()})", "",
         f"{n_names} names, weekly entries {START} → now, 1-week calls; overlay bp per $ of stock per week (0 = no call that week).", "",
         "| Δ | arm | period | weeks written | overlay bp/wk (all weeks) | per written call bp | t vs never | t vs Monday write |",
         "|---|---|---|---|---|---|---|---|"]
    passes = {}
    for dl in DELTAS:
        for k in SIGNALS:
            for lab, lo, hi in (("2021→23-06", (2021, 1), SPLIT.isocalendar()[:2]), ("23-07→now", SPLIT.isocalendar()[:2], (2100, 1))):
                wks = [w for w in ov[(dl, k)] if lo <= w < hi]
                a = np.array([1e4 * np.mean(ov[(dl, k)][w]) for w in wks])
                b = np.array([1e4 * np.mean(ov[(dl, "always")][w]) for w in wks])
                diff = a - b
                t0 = a.mean() / (a.std(ddof=1) / math.sqrt(len(a))) if a.std() > 0 else 0.0
                t1 = diff.mean() / (diff.std(ddof=1) / math.sqrt(len(diff))) if diff.std() > 0 else float("nan")
                writ = [x for w in wks for x in ov[(dl, k)][w] if x != 0.0]
                L.append(f"| {dl:.2f} | {k} | {lab} | {len(writ)} | {a.mean():+.1f} | {1e4 * np.mean(writ) if writ else float('nan'):+.1f} | "
                         f"{t0:+.1f} | {t1:+.1f} |")
                passes.setdefault((dl, k), []).append(k != "always" and t0 >= 2.5 and t1 >= 2.5)
    ok = [f"{dl:.2f}Δ {k}" for (dl, k), v in passes.items() if all(v)]
    L.append(f"\nSignal fired (0.10Δ rows): " + ", ".join(f"{k} {n}" for k, n in fired.items()))
    L.append(f"\n**Verdict: {'PASS — ' + ', '.join(ok) if ok else 'FAIL'}** (bar: beats never-writing and the Monday write, both halves, t ≥ 2.5).")
    txt = "\n".join(L)
    if not only:
        (HERE.parent / "out" / "opt" / "T2.md").write_text(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
