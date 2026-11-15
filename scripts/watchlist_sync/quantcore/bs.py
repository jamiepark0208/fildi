"""One home for Black-Scholes math (Jamie 11-15: 17 pricers, 20 normal-CDF copies, 5 argument orders).

Keyword-only arguments so spot/strike/iv/time can never be swapped silently, and unit guards:
  * iv is a FRACTION (0.35 = 35 %). iv > 5 raises — that is a percent passed by mistake.
  * years is a year fraction. Use `years_from_days(days)` (calendar days / 365) or
    `years_from_sessions(n)` (trading sessions / 252). Never mix the two.
Scalars or numpy arrays (broadcast). r = risk-free, q = dividend yield, both continuous.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.special import ndtr

__all__ = [
    "norm_cdf", "years_from_days", "years_from_sessions", "bs_put", "bs_call",
    "put_delta", "call_delta", "implied_vol", "check_iv", "iv_fraction",
]

MIN_YEARS = 1.0 / (365.0 * 24 * 60)   # one minute


def norm_cdf(x):
    return ndtr(x)


def years_from_days(days):
    """Calendar days → years (option DTE convention)."""
    return np.maximum(np.asarray(days, dtype=float), 0.0) / 365.0


def years_from_sessions(n):
    """Trading sessions → years."""
    return np.maximum(np.asarray(n, dtype=float), 0.0) / 252.0


def check_iv(iv) -> None:
    a = np.asarray(iv, dtype=float)
    fin = a[np.isfinite(a)]
    if fin.size and (fin.max() > 5.0 or fin.min() < 0):
        raise ValueError(f"iv must be a fraction in [0, 5] (got max {fin.max():.3g}); percent passed by mistake?")


def _d1d2(spot, strike, iv, years, r, q):
    check_iv(iv)
    S = np.asarray(spot, dtype=float)
    K = np.asarray(strike, dtype=float)
    v = np.asarray(iv, dtype=float)
    t = np.maximum(np.asarray(years, dtype=float), MIN_YEARS)
    sq = v * np.sqrt(t)
    with np.errstate(divide="ignore", invalid="ignore"):
        d1 = (np.log(S / K) + (r - q + 0.5 * v * v) * t) / sq
    return S, K, v, t, d1, d1 - sq


def _out(x):
    a = np.asarray(x, dtype=float)
    return float(a) if a.ndim == 0 else a


def bs_put(*, spot, strike, iv, years, r: float = 0.0, q: float = 0.0):
    """European put value per share. iv ≤ 0 or years ≤ 0 → intrinsic."""
    S, K, v, t, d1, d2 = _d1d2(spot, strike, iv, years, r, q)
    px = K * np.exp(-r * t) * ndtr(-d2) - S * np.exp(-q * t) * ndtr(-d1)
    intrinsic = np.maximum(K - S, 0.0)
    dead = (v <= 0) | (np.asarray(years, dtype=float) <= 0) | ~np.isfinite(px)
    return _out(np.where(dead, intrinsic, np.maximum(px, 0.0)))


def bs_call(*, spot, strike, iv, years, r: float = 0.0, q: float = 0.0):
    S, K, v, t, d1, d2 = _d1d2(spot, strike, iv, years, r, q)
    px = S * np.exp(-q * t) * ndtr(d1) - K * np.exp(-r * t) * ndtr(d2)
    intrinsic = np.maximum(S - K, 0.0)
    dead = (v <= 0) | (np.asarray(years, dtype=float) <= 0) | ~np.isfinite(px)
    return _out(np.where(dead, intrinsic, px))


def put_delta(*, spot, strike, iv, years, r: float = 0.0, q: float = 0.0):
    """Negative number (−0.20 for a 20-delta put)."""
    S, K, v, t, d1, _ = _d1d2(spot, strike, iv, years, r, q)
    dl = np.exp(-q * t) * (ndtr(d1) - 1.0)
    dead = (v <= 0) | (np.asarray(years, dtype=float) <= 0)
    return _out(np.where(dead, np.where(S < K, -1.0, 0.0), dl))


def call_delta(*, spot, strike, iv, years, r: float = 0.0, q: float = 0.0):
    S, K, v, t, d1, _ = _d1d2(spot, strike, iv, years, r, q)
    dl = np.exp(-q * t) * ndtr(d1)
    dead = (v <= 0) | (np.asarray(years, dtype=float) <= 0)
    return _out(np.where(dead, np.where(S > K, 1.0, 0.0), dl))


def implied_vol(*, price: float, spot: float, strike: float, years: float, side: str = "put",
                r: float = 0.0, q: float = 0.0, lo: float = 1e-4, hi: float = 5.0) -> float | None:
    """Bisection IV. None when the price is outside no-arbitrage bounds."""
    f = bs_put if side == "put" else bs_call
    if not (price > 0 and spot > 0 and strike > 0 and years > 0):
        return None
    p_lo = f(spot=spot, strike=strike, iv=lo, years=years, r=r, q=q)
    p_hi = f(spot=spot, strike=strike, iv=hi, years=years, r=r, q=q)
    if not (p_lo - 1e-9 <= price <= p_hi + 1e-9):
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if f(spot=spot, strike=strike, iv=mid, years=years, r=r, q=q) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-6:
            break
    v = 0.5 * (lo + hi)
    return v if math.isfinite(v) else None


def iv_fraction(iv, *, unit: str = "auto"):
    """Normalise IV to a fraction. unit='pct' (Schwab, LSEG: 45.3) or 'frac' (Robinhood, OPRA greeks: 0.453).
    'auto' (mixed feeds only): > 5 → percent. An IV of 5 % quoted in percent is below anything we trade."""
    if iv is None:
        return None
    v = float(iv)
    if unit == "pct":
        return v / 100.0
    if unit == "frac":
        return v
    return v / 100.0 if v > 5 else v
