"""IV wall: the strike the option market prices as a 5 % one-sided breach by expiry (the edge of a 90 % two-sided band).

Display only (Jamie 10-21, A220: "don't have it block, just add a column"). Puts get a floor, calls a ceiling:
  floor   = spot · exp(−1.645 · σ · √T)      ceiling = spot · exp(+1.645 · σ · √T)      σ = 30-day ATM IV, T = DTE / 365
Strike distance in σ units (the live put band |Δ| 0.08–0.20 ≈ 0.85–1.4σ sits inside the wall, by design).
Held = how often this stock actually stayed on the safe side of its own wall over the past year (same horizon, LSEG closes
and that day's iv30 for the side) — the market prices 95 %; > 95 % means its options have over-priced the tail.
"""
from __future__ import annotations

import math
from bisect import bisect_right
from datetime import date, timedelta

Z = 1.645
_HIST: dict[str, list[tuple]] = {}


def _hist(conn, t: str) -> list[tuple]:
    if t not in _HIST:
        _HIST[t] = conn.execute("""SELECT date, close::float, iv30_put::float, iv30_call::float FROM lseg_research.daily_history
                                   WHERE ticker = %s AND close > 0 AND date >= %s ORDER BY date""",
                                (t, date.today() - timedelta(days=500))).fetchall()
    return _HIST[t]


def last_close(conn, t: str) -> float | None:
    h = _hist(conn, t)
    return h[-1][1] if h else None


def held(conn, t: str, side: str, dte: int) -> tuple[float, int] | None:
    """(share of past-year start days whose close h sessions later stayed inside the wall, n). None if < 60 days."""
    h = _hist(conn, t)
    if len(h) < 80:
        return None
    n_sess = max(1, round(dte * 252 / 365))
    lo = bisect_right([r[0] for r in h], date.today() - timedelta(days=365))
    ok = n = 0
    for i in range(lo, len(h) - n_sess):
        d, s, ivp, ivc = h[i]
        iv = ivp if side == "put" else ivc
        if not iv:
            continue
        iv = iv / 100 if iv > 3 else iv
        w = Z * iv * math.sqrt(dte / 365)
        end = h[i + n_sess][1]
        n += 1
        ok += end >= s * math.exp(-w) if side == "put" else end <= s * math.exp(w)
    return (ok / n, n) if n >= 60 else None


def wall(conn, t: str, side: str, spot: float | None, atm_iv: float | None, dte: int, strike: float) -> dict | None:
    if not spot or not atm_iv or dte <= 0:
        return None
    sd = atm_iv * math.sqrt(dte / 365)
    level = spot * math.exp(-Z * sd if side == "put" else Z * sd)
    k_sigma = (math.log(spot / strike) if side == "put" else math.log(strike / spot)) / sd
    out = {"kind": "floor" if side == "put" else "ceiling", "level": round(level, 2), "strike_sigma": round(k_sigma, 2),
           "beyond_wall": strike <= level if side == "put" else strike >= level, "priced": 0.95}
    hd = held(conn, t, side, dte)
    if hd:
        out["held"], out["held_n"] = round(hd[0], 3), hd[1]
    return out
