"""S056 / A184 #1 — opening range breakout on SPY (Zarattini & Aziz 2023, 5-min ORB). Pre-registered 2026-10-19: one run.

Rule (minute CLOSES only — Polygon h/l carry bad ticks, S052): first candle = 09:30 → 09:34 closes. Up (09:34 > 09:30) → long,
down → short, flat → no trade. Enter at the 09:35 close. Stop = the first candle's opposite extreme (min / max of its closes),
checked on minute closes; else exit at the 15:59 close. Outcome = signed return − 1 bp cost.
Secondary (labelled): 15-min candle (09:30 → 09:44, enter 09:45). Comparison: always-long 09:35 → close (SPY drift).
Halves: 2024-10 → 2025-09 / 2025-10 → latest. Cut: SPY vol regime (prior-day iv30 > 18.5 = stressed).
Pass (5-min only): mean > 0, day t ≥ 2, same sign both halves, mean > always-long.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s056_orb.py [--smoke]
"""
from __future__ import annotations

import math
import sys
from datetime import date, time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s052_0dte_winners as W  # noqa: E402  (cached SPY minute loader)

COST = 0.0001
STRESSED = 18.5
MID = date(2025, 10, 1)
OUT = HERE.parent / "out" / "opt" / "S056.md"


def orb(b, end: time):
    first = [x[3] for x in b if x[0] <= end]
    rest = [x for x in b if x[0] > end]
    if len(first) < 3 or not rest:
        return None
    side = (first[-1] > first[0]) - (first[-1] < first[0])
    if not side:
        return None
    entry, stop = rest[0][3], (min(first) if side > 0 else max(first))
    ex, stopped = rest[-1][3], False
    for x in rest[1:]:
        if (x[3] - stop) * side <= 0:
            ex, stopped = x[3], True
            break
    return dict(side=side, ret=side * (ex / entry - 1) - COST, stopped=stopped, long=rest[-1][3] / entry - 1)


def build(bars, iv):
    out = []
    for d in sorted(bars):
        b = bars[d]
        piv = iv.get(max((x for x in iv if x < d), default=None))
        if len(b) < 350 or not piv:
            continue
        r5, r15 = orb(b, time(9, 34)), orb(b, time(9, 44))
        if r5:
            out.append(dict(d=d, iv=piv, r5=r5, r15=r15))
    return out


def summ(v):
    v = np.array(v)
    if len(v) < 2:
        return len(v), float("nan"), float("nan"), float("nan")
    return len(v), v.mean(), v.mean() / (v.std(ddof=1) / math.sqrt(len(v))), np.mean(v > 0)


def main():
    rows = build(*W.load(connect()))
    if "--smoke" in sys.argv:
        for r in rows[-8:]:
            x = r["r5"]
            print(f"{r['d']} {'long' if x['side'] > 0 else 'short'} ret {x['ret']:+.3%} stopped {x['stopped']} "
                  f"(always-long {x['long']:+.3%})")
        return
    r5 = lambda xs: [r["r5"]["ret"] for r in xs]
    L = ["# S056 — opening range breakout on SPY (A184 #1)", "",
         f"{len(rows)} trade days ({rows[0]['d']} → {rows[-1]['d']}); 5-min candle direction, stop at its other side, exit "
         f"15:59; cost {COST:.2%}; minute closes.", "", "| slice | n | mean | t | win % |", "|---|---|---|---|---|"]
    for lab, v in (("5-min ORB · all", r5(rows)),
                   ("always-long 09:35 → close", [r["r5"]["long"] for r in rows]),
                   ("5-min · 1st half", r5([r for r in rows if r["d"] < MID])),
                   ("5-min · 2nd half", r5([r for r in rows if r["d"] >= MID])),
                   ("5-min · stressed vol", r5([r for r in rows if r["iv"] > STRESSED])),
                   ("5-min · calm/normal vol", r5([r for r in rows if r["iv"] <= STRESSED])),
                   ("5-min · longs", [r["r5"]["ret"] for r in rows if r["r5"]["side"] > 0]),
                   ("5-min · shorts", [r["r5"]["ret"] for r in rows if r["r5"]["side"] < 0]),
                   ("15-min ORB (secondary)", [r["r15"]["ret"] for r in rows if r["r15"]])):
        n, m, t, w = summ(v)
        L.append(f"| {lab} | {n} | {m:+.3%} | {t:+.2f} | {w:.0%} |")
    _, m, t, _ = summ(r5(rows))
    ml = np.mean([r["r5"]["long"] for r in rows])
    h1, h2 = summ(r5([r for r in rows if r["d"] < MID]))[1], summ(r5([r for r in rows if r["d"] >= MID]))[1]
    ok = m > 0 and t >= 2 and h1 > 0 and h2 > 0 and m > ml
    stop_rate = np.mean([r["r5"]["stopped"] for r in rows])
    L += ["", f"Stopped out {stop_rate:.0%} of days.", "",
          f"**Verdict: {'PASS' if ok else 'FAIL'}** (mean {m:+.3%}, t {t:+.2f}, halves {h1:+.3%} / {h2:+.3%}, "
          f"always-long {ml:+.3%})."]
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))


if __name__ == "__main__":
    main()
