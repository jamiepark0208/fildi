"""S068 — which strike distance pays for weekly short puts: 0.10 / 0.15 / 0.20 / 0.25 / 0.30 Δ? (Jamie 10-20: Model List picks sit at ~0.29Δ,
put-edge evidence S059 is for ~1σ ≈ 0.16Δ.)

Weekly puts, first → last session of each week, 2020 →, LSEG names (funds excluded). Strike at each |Δ| target (BS at that day's iv30_put),
premium = BS × skew ratio (S064 fit on 152 real LSEG fills: 1.20 below 0.20Δ, 1.02 for 0.20–0.30, 0.98 above) − fill cost
(bid + 23 % of spread, put_edge.fill_cost). pnl per $ collateral at expiry. Book view: equal-weight all puts each week → weekly
book return; Sharpe = mean/sd of weekly book returns; tail = worst 1 % / 5 % weeks. Optional: only put-edge Q4–Q5 weeks are not
available historically for every name, so the whole universe is used (live picks are a subset).
Decision: the Δ target for the Model List put lane. Pre-registered: pick the Δ with the best weekly Sharpe in BOTH halves (split 2023-04)
and holdout ≥ 2024-07; if two are within 0.02 Sharpe, the farther-OTM one (smaller tail) wins.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s068_strike_delta.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from put_edge import fill_cost  # noqa: E402
from s045_put_retest import bs_put  # noqa: E402
from s049_panic_puts import FUNDS, put_delta  # noqa: E402

TARGETS = (0.10, 0.15, 0.20, 0.25, 0.30)
RATIO = ((0.20, 1.20), (0.30, 1.02), (1.0, 0.98))
MID, HOLDOUT = date(2023, 4, 1), date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S068.md"


def strike_for(S, v, T, target):
    lo, hi = S * 0.3, S
    for _ in range(40):
        k = (lo + hi) / 2
        lo, hi = (k, hi) if put_delta(S, k, v, T) > -target else (lo, k)
    return (lo + hi) / 2


def main():
    conn = connect()
    rows = defaultdict(list)
    for t, d, c, iv in conn.execute("SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history "
                                    "WHERE close > 0 AND date >= '2020-01-01' ORDER BY ticker, date").fetchall():
        if t not in FUNDS:
            rows[t].append((d, c, iv))
    book = defaultdict(lambda: defaultdict(list))  # target → week → [pnl]
    for t, r in rows.items():
        wk = defaultdict(list)
        for x in r:
            wk[x[0].isocalendar()[:2]].append(x)
        for k, days in wk.items():
            if len(days) < 3 or not days[0][2]:
                continue
            (d0, S, iv), ST = days[0], days[-1][1]
            if ST / S < 0.3 or ST / S > 3:  # split inside the week (closes are split-adjusted, so this is a data error)
                continue
            T, v = max(1, (days[-1][0] - d0).days) / 365, iv / 100
            for tg in TARGETS:
                K = strike_for(S, v, T, tg)
                ratio = next(q for lim, q in RATIO if tg < lim)
                pk = ratio * bs_put(S, K, v, T) / K
                book[tg][d0].append(pk - fill_cost(pk) - max(0.0, K - ST) / K)
    L = ["# S068 — weekly short puts by strike Δ (book view)", "",
         "| Δ | slice | weeks | mean bp/wk | sd bp | Sharpe (wk) | worst 5 % wk | worst 1 % wk | breach-ish: share of puts losing |", "|---|---|---|---|---|---|---|---|---|"]
    best = {}
    for s, f in (("H1 < 2023-04", lambda d: d < MID), ("H2 < 2024-07", lambda d: MID <= d < HOLDOUT), ("holdout", lambda d: d >= HOLDOUT)):
        for tg in TARGETS:
            wr = sorted(sum(v) / len(v) for d, v in book[tg].items() if f(d) and len(v) >= 20)
            allp = [p for d, v in book[tg].items() if f(d) for p in v]
            m = sum(wr) / len(wr)
            sd = (sum((x - m) ** 2 for x in wr) / (len(wr) - 1)) ** 0.5
            sh = m / sd
            best.setdefault(s, []).append((sh, tg))
            L.append(f"| {tg:.2f} | {s} | {len(wr)} | {m * 1e4:+.1f} | {sd * 1e4:.0f} | {sh:.3f} | {wr[len(wr) // 20] * 1e4:+.0f} | "
                     f"{wr[len(wr) // 100] * 1e4:+.0f} | {sum(p < 0 for p in allp) / len(allp):.0%} |")
    L.append("")
    for s, v in best.items():
        top = max(v)
        pick = max(tg for sh, tg in v if sh >= top[0] - 0.02) if False else min((tg for sh, tg in v if sh >= top[0] - 0.02))
        L.append(f"- {s}: best Sharpe Δ {top[1]:.2f} ({top[0]:.3f}); within 0.02 → farthest OTM = Δ {pick:.2f}")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
