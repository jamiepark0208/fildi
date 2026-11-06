"""Shared vectorized bar signals (A341) — one home for fast_screen + strategy_signals."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma_mat(c: np.ndarray, n: int) -> np.ndarray:
    return pd.DataFrame(c).rolling(n, min_periods=n).mean().to_numpy()


def sig_z_variant(c: np.ndarray, win: int, thr: float) -> np.ndarray:
    """Close below SMA(win) + thr×std(win). thr is negative for dips (e.g. -2.5)."""
    m = sma_mat(c, win)
    sd = pd.DataFrame(c).rolling(win, min_periods=win).std().to_numpy()
    z = (c - m) / np.where(sd == 0, np.nan, sd)
    entry = (z < thr) & np.isfinite(z)
    entry[:win] = False
    return entry


def sig_gap_variant(o: np.ndarray, c: np.ndarray, pct: float, direction: str) -> np.ndarray:
    """Open vs prior close gap. direction 'up' → open ≥ prior×(1+pct); 'down' → open ≤ prior×(1−pct)."""
    prev = np.roll(c, 1, 0)
    if direction == "down":
        entry = (o <= prev * (1 - pct)) & np.isfinite(o) & np.isfinite(prev)
    else:
        entry = (o >= prev * (1 + pct)) & np.isfinite(o) & np.isfinite(prev)
    entry[0] = False
    return entry
