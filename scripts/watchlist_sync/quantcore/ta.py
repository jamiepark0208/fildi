"""One home for price indicators (Jamie 11-15: 16 RSI copies, 3 formulas → one).

TradingView-exact (Pine ta.rma / ta.ema / ta.rsi / ta.atr / ta.sma):
  * na until `n` finite inputs, seeded with their SMA, then recursive.
  * A NaN input makes that bar NaN and the series re-seeds after `n` new finite bars (no stand-in values).
  * RSI: down == 0 → 100 (flat or pure rally), up == 0 → 0.
Every value at bar i uses bars ≤ i only (`tests/test_quantcore.py` truncation test proves it).

Inputs: 1-D array (one series) or 2-D array shaped (time, names) — the 2-D path loops over time and
vectorises across names, so a 2,000-day × 900-name panel takes ~0.1 s.
"""
from __future__ import annotations

import numpy as np

__all__ = ["rma", "ema", "sma", "rsi", "rsi_last", "rsi_frame", "atr", "true_range"]


def _as2d(x) -> tuple[np.ndarray, bool]:
    a = np.asarray(x, dtype=float)
    if a.ndim == 1:
        return a[:, None], True
    if a.ndim != 2:
        raise ValueError(f"expected 1-D or 2-D (time, names), got shape {a.shape}")
    return a, False


def _seeded(x, n: int, alpha: float) -> np.ndarray:
    if n < 1:
        raise ValueError("n must be ≥ 1")
    a, flat = _as2d(x)
    T, M = a.shape
    out = np.full((T, M), np.nan)
    prev = np.full(M, np.nan)
    run = np.zeros(M, dtype=int)          # consecutive finite inputs
    csum = np.zeros((T + 1, M))
    fin = np.isfinite(a)
    csum[1:] = np.cumsum(np.where(fin, a, 0.0), axis=0)
    for t in range(T):
        f = fin[t]
        run = np.where(f, run + 1, 0)
        have = np.isfinite(prev) & f
        cur = np.full(M, np.nan)
        cur[have] = alpha * a[t, have] + (1 - alpha) * prev[have]
        seed = ~have & f & (run >= n)
        if seed.any():
            cur[seed] = (csum[t + 1, seed] - csum[t + 1 - n, seed]) / n
        out[t] = cur
        prev = cur
    return out[:, 0] if flat else out


def rma(x, n: int) -> np.ndarray:
    """Wilder smoothing (Pine ta.rma)."""
    return _seeded(x, n, 1.0 / n)


def ema(x, n: int) -> np.ndarray:
    """Pine ta.ema (SMA seed, alpha 2/(n+1))."""
    return _seeded(x, n, 2.0 / (n + 1))


def sma(x, n: int) -> np.ndarray:
    """Pine ta.sma: NaN until n finite bars in the window (never the raw price as a stand-in)."""
    a, flat = _as2d(x)
    T, M = a.shape
    out = np.full((T, M), np.nan)
    if T >= n:
        fin = np.isfinite(a)
        cs = np.vstack([np.zeros((1, M)), np.cumsum(np.where(fin, a, 0.0), axis=0)])
        cnt = np.vstack([np.zeros((1, M)), np.cumsum(fin, axis=0)])
        s = cs[n:] - cs[:-n]
        k = cnt[n:] - cnt[:-n]
        out[n - 1:] = np.where(k == n, s / n, np.nan)
    return out[:, 0] if flat else out


def rsi(close, n: int = 14) -> np.ndarray:
    """Pine ta.rsi. Bar 0 change is NaN, not 0."""
    c, flat = _as2d(close)
    d = np.full_like(c, np.nan)
    d[1:] = c[1:] - c[:-1]
    up = rma(np.where(np.isfinite(d), np.maximum(d, 0.0), np.nan), n)
    dn = rma(np.where(np.isfinite(d), np.maximum(-d, 0.0), np.nan), n)
    up, dn = np.asarray(up).reshape(c.shape), np.asarray(dn).reshape(c.shape)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(dn == 0, 100.0, np.where(up == 0, 0.0, 100.0 - 100.0 / (1.0 + up / dn)))
    out = np.where(np.isfinite(up) & np.isfinite(dn), out, np.nan)
    return out[:, 0] if flat else out


def true_range(high, low, close) -> np.ndarray:
    """Pine ta.tr(true): bar 0 = high − low."""
    h, flat = _as2d(high)
    l, _ = _as2d(low)
    c, _ = _as2d(close)
    pc = np.full_like(c, np.nan)
    pc[1:] = c[:-1]
    tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
    tr[0] = h[0] - l[0]
    return tr[:, 0] if flat else tr


def atr(high, low, close, n: int = 14) -> np.ndarray:
    """Pine ta.atr = rma(true range, n)."""
    return rma(true_range(high, low, close), n)


def rsi_last(close, n: int = 14, *, window: int | None = None) -> float | None:
    """RSI at the LAST bar of `close` (bars ≤ that bar only). Uses the trailing `window` bars
    (default max(10·n, 150): Wilder RSI converges to < 0.01 pt by then). None if not enough data."""
    c = np.asarray(close, dtype=float)
    w = window or max(10 * n, 150)
    if len(c) > w:
        c = c[-w:]
    if np.isfinite(c).sum() <= n:
        return None
    v = rsi(c, n)[-1]
    return float(v) if np.isfinite(v) else None


def rsi_frame(close, n: int = 14):
    """pandas Series / DataFrame in → same shape and index out (columns = names, rows = time)."""
    import pandas as pd

    if isinstance(close, pd.DataFrame):
        return pd.DataFrame(rsi(close.to_numpy(dtype=float), n), index=close.index, columns=close.columns)
    if isinstance(close, pd.Series):
        return pd.Series(rsi(close.to_numpy(dtype=float), n), index=close.index, name=close.name)
    return rsi(close, n)
