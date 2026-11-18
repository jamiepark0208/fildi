"""Per-name front-month skew history (Jamie 11-18 #6 step 2: "relative ranking" — is this name's put skew rich vs its own
past and vs its sector today?). Source = option_chain_history (Schwab, ~450 names/day, OTM band, DTE ≤ ~45).

Per (ticker, as_of): the expiry in 14–45 DTE nearest 30; IV linearly interpolated in delta at put Δ −0.25, call Δ +0.25
and |Δ| 0.50 (same method as lib/risk-reversal.ts ivAtDelta) → rr25 = P25 − C25 (vol, + = puts rich), atm_iv.
Writes watchlist_sync.rr_skew_daily. Tail from the watermark; --backfill recomputes every stored day.
"""
from __future__ import annotations

import sys
from collections import defaultdict

from build_plan import connect

DTE_LO, DTE_HI, DTE_AIM = 7, 45, 30


def clean(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Drop a quote whose IV is > 25 % off both neighbours while they agree within 15 % (RGTI 7P 11-17: IV 1.82 between
    0.99 and 1.11 → fake 70-pt skew)."""
    out = []
    for i, (d, v) in enumerate(pts):
        if 0 < i < len(pts) - 1:
            a, b = pts[i - 1][1], pts[i + 1][1]
            if abs(a / b - 1) < 0.15 and abs(v / ((a + b) / 2) - 1) > 0.25:
                continue
        out.append((d, v))
    return out


def iv_at(rows: list[tuple[float, float]], target: float) -> float | None:
    """rows = (|delta|, iv); linear between the two bracketing deltas, else nearest within 0.08."""
    pts = clean(sorted((d, v) for d, v in rows if 0.02 < d < 0.98 and v and 0.01 < v < 5))
    if not pts:
        return None
    for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
        if d0 <= target <= d1 and d1 > d0:
            return v0 + (v1 - v0) * (target - d0) / (d1 - d0)
    near = min(pts, key=lambda p: abs(p[0] - target))
    return near[1] if abs(near[0] - target) <= 0.08 else None


def main() -> int:
    backfill = "--backfill" in sys.argv
    conn = connect()
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.rr_skew_daily (
        ticker text NOT NULL, as_of date NOT NULL, expiry date NOT NULL, dte int NOT NULL,
        rr25 double precision, atm_iv double precision, p25 double precision, c25 double precision,
        computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, as_of))""")
    wm = None if backfill else conn.execute("SELECT MAX(as_of) FROM watchlist_sync.rr_skew_daily").fetchone()[0]
    # Re-do the watermark day too (today's chain fills in over the session)
    rows = conn.execute("""SELECT ticker, as_of, expiry, dte, side, ABS(delta)::float8, iv::float8
        FROM option_chain_history WHERE dte BETWEEN %s AND %s AND iv > 0 AND bid > 0 AND delta IS NOT NULL
          AND (%s::date IS NULL OR as_of >= %s::date)""", (DTE_LO, DTE_HI, wm, wm)).fetchall()
    by: dict[tuple, dict] = defaultdict(lambda: {"put": [], "call": []})
    for t, a, e, dte, side, d, iv in rows:
        by[(t, a, e, dte)][side].append((d, iv))
    best: dict[tuple, tuple] = {}
    for (t, a, e, dte), legs in by.items():
        p25, c25 = iv_at(legs["put"], 0.25), iv_at(legs["call"], 0.25)
        if p25 is None or c25 is None:
            continue
        ap, ac = iv_at(legs["put"], 0.5), iv_at(legs["call"], 0.5)
        atm = (ap + ac) / 2 if ap and ac else (ap or ac)
        k = (t, a)
        if k not in best or abs(dte - DTE_AIM) < abs(best[k][1] - DTE_AIM):
            best[k] = (e, dte, p25 - c25, atm, p25, c25)
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.rr_skew_daily (ticker, as_of, expiry, dte, rr25, atm_iv, p25, c25)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (ticker, as_of) DO UPDATE SET expiry = EXCLUDED.expiry,
            dte = EXCLUDED.dte, rr25 = EXCLUDED.rr25, atm_iv = EXCLUDED.atm_iv, p25 = EXCLUDED.p25, c25 = EXCLUDED.c25,
            computed_at = now()""", [(t, a, *v) for (t, a), v in best.items()])
    conn.commit()
    days = len({a for _, a in best})
    print(f"rr_skew: {len(best)} name-days over {days} day(s) from {len(rows)} quotes (watermark {wm})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
