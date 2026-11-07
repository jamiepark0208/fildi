"""A369 leak tests — shift-one-bar, shuffle placebo, planted look-ahead."""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def shift_entry_one_bar(entry: np.ndarray) -> np.ndarray:
    out = np.roll(entry, 1, axis=0)
    out[0, :] = False
    return out


def shuffle_entry_within_month(
    entry: np.ndarray,
    dates: pd.DatetimeIndex,
    rng: np.random.Generator,
) -> np.ndarray:
    """Shuffle fired (day,ticker) pairs within calendar month — destroys timing edge."""
    months = dates.to_period("M")
    out = np.zeros_like(entry)
    for mo in pd.unique(months):
        dm = months == mo
        block = entry[dm]
        if not block.any():
            continue
        flat = block.ravel()
        n_on = int(flat.sum())
        if n_on == 0:
            continue
        pos = rng.choice(flat.size, size=n_on, replace=False)
        sh = np.zeros(flat.size, dtype=bool)
        sh[pos] = True
        out[dm] = sh.reshape(block.shape)
    return out


def planted_lookahead_rsi_entry(rsi: np.ndarray, thr: float = 30.0) -> np.ndarray:
    """Uses next bar's RSI in the signal (look-ahead)."""
    nxt = np.roll(rsi, -1)
    nxt[-1] = np.nan
    level = nxt < thr
    level = level & np.isfinite(nxt)
    prev = np.roll(level, 1)
    prev[0] = False
    return level & ~prev


def planted_lookahead_entry(c: np.ndarray, thr: float = 0.0) -> np.ndarray:
    """Uses next-bar close in signal — must be flagged as look-ahead."""
    nxt = np.roll(c, -1, axis=0)
    nxt[-1, :] = np.nan
    m = sma_cross_below(nxt, thr)
    return m


def is_planted_lookahead(entry: np.ndarray, rets: np.ndarray) -> bool:
    """Planted signals align with same-bar return; one-bar shift destroys edge → flag."""
    clean = rets[entry & np.isfinite(rets)]
    shifted = rets[shift_entry_one_bar(entry) & np.isfinite(rets)]
    if clean.size < 5 or shifted.size < 5:
        return False
    mc, ms = float(np.mean(clean)), float(np.mean(shifted))
    gap = mc - ms
    return gap > 0 and (gap > 0.002 or (ms != 0 and gap / abs(ms) > 0.5))


def leak_from_trade_frames(
    cond: pd.DataFrame,
    base: pd.DataFrame,
    rng: np.random.Generator,
    *,
    n_placebo: int = 100,
) -> dict[str, Any]:
    """Shift-one-bar + within-month shuffle placebo on a frontier cond cell."""
    if cond is None or cond.empty:
        return {
            "shift_bp": float("nan"),
            "placebo_p": float("nan"),
            "leak_flag": False,
        }
    cross = cond["pnl_coll_frac_cross"].to_numpy(dtype=float)
    clean_mean = float(np.nanmean(cross))
    b_mean = float(np.nanmean(base["pnl_coll_frac_cross"])) if base is not None and len(base) else 0.0
    lift = clean_mean - b_mean

    idx = cond.set_index(["ticker", "session", "signal_bar"], drop=False)
    shifted_pnls: list[float] = []
    for _, t in cond.iterrows():
        key = (t["ticker"], t["session"], int(t["signal_bar"]) + 1)
        if key in idx.index:
            shifted_pnls.append(float(idx.loc[key, "pnl_coll_frac_cross"]))
    shifted_mean = float(np.nanmean(shifted_pnls)) if shifted_pnls else float("nan")
    shift_bp = (clean_mean - shifted_mean) * 1e4 if np.isfinite(shifted_mean) else float("nan")

    months = cond["session"].astype(str).str[:7]
    actual = clean_mean
    hits = 0
    n_ok = 0
    for mo in months.unique():
        sub = cross[months == mo]
        if sub.size < 3:
            continue
        for _ in range(max(1, n_placebo // max(1, len(months.unique())))):
            sh = rng.permutation(sub)
            n_ok += 1
            if float(np.mean(sh)) >= actual:
                hits += 1
    placebo_p = hits / n_ok if n_ok else float("nan")

    shift_kill = False
    if np.isfinite(lift) and lift > 0 and np.isfinite(shifted_mean):
        shifted_lift = shifted_mean - b_mean
        lifted_ratio = shifted_lift / lift
        shift_kill = np.isfinite(lifted_ratio) and lifted_ratio < 0.2
    leak_flag = shift_kill or (np.isfinite(placebo_p) and placebo_p > 0.10)
    return {
        "shift_bp": shift_bp,
        "placebo_p": float(placebo_p),
        "leak_flag": bool(leak_flag),
    }


def sma_cross_below(x: np.ndarray, level: float) -> np.ndarray:
    below = x < level
    prev = np.roll(below, 1, axis=0)
    prev[0, :] = False
    return below & ~prev & np.isfinite(x)


def leak_excess_bp(
    mean_trade_excess: float,
    mean_shifted_excess: float,
    *,
    tol_bp: float = 0.5,
) -> dict:
    """Flag if shifted signal improves excess vs proper signal (look-ahead)."""
    delta_bp = (mean_shifted_excess - mean_trade_excess) * 1e4
    flagged = np.isfinite(mean_shifted_excess) and np.isfinite(mean_trade_excess) and delta_bp > tol_bp
    return {
        "clean_bp": mean_trade_excess * 1e4,
        "shifted_bp": mean_shifted_excess * 1e4,
        "delta_bp": delta_bp,
        "lookahead_flag": bool(flagged),
    }


def run_leak_pair(
    dates: pd.DatetimeIndex,
    rets: np.ndarray,
    entry: np.ndarray,
    peer_mean: np.ndarray,
    *,
    side: int = 1,
    split_mask: np.ndarray | None = None,
) -> dict:
    if split_mask is None:
        split_mask = np.ones(len(dates), dtype=bool)

    def ex(ent: np.ndarray) -> float:
        finite = np.isfinite(rets) & np.isfinite(peer_mean)
        mask = ent & split_mask[:, None] & finite
        if mask.sum() < 5:
            return float("nan")
        te = side * (rets - peer_mean)
        return float(np.mean(te[mask]))

    clean = ex(entry)
    shifted = ex(shift_entry_one_bar(entry))
    return leak_excess_bp(clean, shifted)
