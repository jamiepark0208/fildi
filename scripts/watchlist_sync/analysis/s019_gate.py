"""S019 validation gate (Claude, 2026-10-15): does Fildi's IV-from-Polygon-closes match Schwab's IV on the same contract?
Schwab chain history has 15–50 DTE puts only on 10-08 (expiry 10-23, DTE 15): for each name, the Schwab put nearest spot →
its Polygon daily close that day → Black-Scholes IV (option_derive.put_iv, same spot) vs Schwab IV.
Pass (pre-registered): correlation ≥ 0.9 and median abs error ≤ 3 vol pts.
    .venv/bin/python analysis/s019_gate.py
"""
from __future__ import annotations

import math
import statistics as st
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
import option_history as oh  # noqa: E402
from option_derive import put_iv  # noqa: E402

DAY = date(2026, 10, 8)


def occ(t: str, exp: date, k: float) -> str:
    return f"O:{t}{exp:%y%m%d}P{int(round(k * 1000)):08d}"


def main() -> list[tuple]:
    conn = connect()
    rows = conn.execute("""SELECT DISTINCT ON (ticker) ticker, expiry, strike, spot, iv, bid, ask, dte FROM option_chain_history
                           WHERE as_of = %s AND side = 'put' AND dte BETWEEN 15 AND 50 AND iv > 0 AND spot > 0
                           ORDER BY ticker, abs(strike / spot - 1)""", (DAY,)).fetchall()
    out = []
    for t, exp, k, s, iv, bid, ask, dte in rows:
        o = occ(t, exp, float(k))
        b = conn.execute("SELECT c FROM optlab.bars WHERE occ = %s AND date = %s", (o, DAY)).fetchone()
        if not b and not conn.execute("SELECT 1 FROM optlab.bars_fetched WHERE occ = %s", (o,)).fetchone():
            oh.fetch_bars(conn, o, exp)
            b = conn.execute("SELECT c FROM optlab.bars WHERE occ = %s AND date = %s", (o, DAY)).fetchone()
        if not b or not b[0]:
            continue
        mine = put_iv(float(b[0]), float(s), float(k), (exp - DAY).days / 365)
        if mine:
            sch = float(iv) / 100 if float(iv) > 3 else float(iv)  # Schwab stores IV in percent
            out.append((t, float(k), float(s), float(b[0]), (float(bid) + float(ask)) / 2, mine, sch))
    oh.flush_usage(conn)
    return out


def corr(a, b):
    ma, mb = st.mean(a), st.mean(b)
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))


if __name__ == "__main__":
    r = main()
    mine, sch = [x[5] for x in r], [x[6] for x in r]
    err = [abs(a - b) * 100 for a, b in zip(mine, sch)]
    print(f"n {len(r)}  corr {corr(mine, sch):.3f}  median abs err {st.median(err):.1f} vol pts  "
          f"median Polygon close vs Schwab mid {st.median([x[3] / x[4] - 1 for x in r if x[4] > 0]):+.1%}")
    for x in sorted(r, key=lambda x: -abs(x[5] - x[6]))[:6]:
        print(f"  {x[0]} K{x[1]:g} S{x[2]:.2f} close {x[3]:.2f} mid {x[4]:.2f}  mine {x[5]:.0%} schwab {x[6]:.0%}")
    # diagnostic only (verdict unchanged): same formula on Schwab's own mid → isolates math error from price-source error
    dm = [abs(put_iv(x[4], x[2], x[1], 15 / 365) - x[6]) * 100 for x in r if x[4] > 0 and put_iv(x[4], x[2], x[1], 15 / 365)]
    print(f"diagnostic: formula on Schwab mid vs Schwab IV, median abs err {st.median(dm):.1f} vol pts (n {len(dm)})")
