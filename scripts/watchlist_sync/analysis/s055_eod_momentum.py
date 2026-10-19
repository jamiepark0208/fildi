"""S055 / A188 #2 — end-of-day hedging momentum on SPY (Baltussen, Da, Lammers & Martens 2021; LETF rebalancing).
Pre-registered 2026-10-19: one run, no re-tuning.

Signal at 15:30 ET: r = SPY 15:30 close ÷ prior session's 15:59 close − 1; σ = prior day's LSEG iv30_put ÷ √252.
|r| ≥ 1σ → trade SPY in r's direction from 15:30 to the 15:59 close. Outcome = signed last-30-min return − 1 bp cost.
Comparison: all days, signed by r's direction (any size). Halves: 2024-10 → 2025-09 / 2025-10 → latest.
Pre-declared cut: SPY vol regime (iv30 > 18.5 = stressed, conditions_grid tercile). Pass: mean > 0, day t ≥ 2,
same sign both halves. Minute CLOSES only (Polygon h/l carry bad ticks, S052).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s055_eod_momentum.py [--smoke]
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s052_0dte_winners as W  # noqa: E402  (cached SPY minute loader)

COST = 0.0001
K = 1.0
STRESSED = 18.5
MID = date(2025, 10, 1)
OUT = HERE.parent / "out" / "opt" / "S055.md"


def build(bars, iv):
    days = sorted(bars)
    out = []
    for k in range(1, len(days)):
        d, p = days[k], days[k - 1]
        b, pb = bars[d], bars[p]
        c1530 = next((x[3] for x in b if x[0] >= time(15, 30)), None)
        close = next((x[3] for x in reversed(b) if x[0] <= time(15, 59)), None)
        pclose = next((x[3] for x in reversed(pb) if x[0] <= time(15, 59)), None)
        prior_iv = iv.get(max((x for x in iv if x < d), default=None))
        if not (c1530 and close and pclose and prior_iv) or len(b) < 350:
            continue
        r = c1530 / pclose - 1
        sig = prior_iv / 100 / math.sqrt(252)
        last30 = close / c1530 - 1
        out.append(dict(d=d, r=r, z=r / sig, signed=math.copysign(1, r) * last30, iv=prior_iv))
    return out


def summ(x):
    v = np.array([r["signed"] for r in x]) - COST
    if len(v) < 2:
        return len(v), float("nan"), float("nan"), float("nan")
    return len(v), v.mean(), v.mean() / (v.std(ddof=1) / math.sqrt(len(v))), np.mean(v > 0)


def main():
    conn = connect()
    bars, iv = W.load(conn)
    rows = build(bars, iv)
    if "--smoke" in sys.argv:
        for r in rows[-8:]:
            print(f"{r['d']} day→15:30 {r['r']:+.2%} ({r['z']:+.2f}σ, IV {r['iv']:.1f}) last 30m signed {r['signed']:+.3%}")
        return
    sig = [r for r in rows if abs(r["z"]) >= K]
    L = ["# S055 — end-of-day hedging momentum on SPY (A188 #2)", "",
         f"{len(rows)} days ({rows[0]['d']} → {rows[-1]['d']}); signal |prior close → 15:30| ≥ {K}σ; trade 15:30 → close; "
         f"cost {COST:.2%}.", "", "| slice | n | mean (after cost) | t | win % |", "|---|---|---|---|---|"]
    for lab, xs in (("all days (signed by direction)", rows), ("signal ≥ 1σ", sig),
                    ("signal · 1st half", [r for r in sig if r["d"] < MID]), ("signal · 2nd half", [r for r in sig if r["d"] >= MID]),
                    ("signal · stressed vol", [r for r in sig if r["iv"] > STRESSED]),
                    ("signal · calm/normal vol", [r for r in sig if r["iv"] <= STRESSED]),
                    ("signal · up days", [r for r in sig if r["r"] > 0]), ("signal · down days", [r for r in sig if r["r"] < 0])):
        n, m, t, w = summ(xs)
        L.append(f"| {lab} | {n} | {m:+.3%} | {t:+.2f} | {w:.0%} |")
    n, m, t, _ = summ(sig)
    h1, h2 = summ([r for r in sig if r["d"] < MID])[1], summ([r for r in sig if r["d"] >= MID])[1]
    ok = m > 0 and t >= 2 and h1 > 0 and h2 > 0
    L += ["", f"**Verdict: {'PASS' if ok else 'FAIL'}** (mean {m:+.3%} after cost, t {t:+.2f}, halves {h1:+.3%} / {h2:+.3%})."]
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))
    return sig


if __name__ == "__main__":
    main()
