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


def _pnl_series(df: pd.DataFrame) -> str:
    if "pnl_coll_frac_fill" in df.columns and df["pnl_coll_frac_fill"].notna().any():
        return "pnl_coll_frac_fill"
    return "pnl_coll_frac_cross"


def leak_from_trade_frames(
    cond: pd.DataFrame,
    base: pd.DataFrame,
    rng: np.random.Generator,
    *,
    n_placebo: int = 200,
) -> dict[str, Any]:
    """Shift-one-bar (base bar+1) + base-draw placebo on a frontier cond cell."""
    if cond is None or cond.empty:
        return {
            "shift_bp": float("nan"),
            "shift_coverage": float("nan"),
            "shift_note": "",
            "placebo_p": float("nan"),
            "leak_flag": False,
        }
    pnl_col = _pnl_series(cond)
    cross = cond[pnl_col].to_numpy(dtype=float)
    clean_mean = float(np.nanmean(cross))
    b_mean = float(np.nanmean(base[pnl_col])) if base is not None and len(base) else 0.0
    lift = clean_mean - b_mean

    shifted_pnls: list[float] = []
    base_idx = None
    if base is not None and len(base):
        base_idx = base.set_index(["ticker", "session", "signal_bar"], drop=False)
    for _, t in cond.iterrows():
        if base_idx is None:
            break
        key = (t["ticker"], t["session"], int(t["signal_bar"]) + 1)
        if key in base_idx.index:
            row = base_idx.loc[key]
            val = row[pnl_col] if pnl_col in row.index else row.get("pnl_coll_frac_cross", float("nan"))
            if isinstance(val, pd.Series):
                val = float(val.iloc[0])
            shifted_pnls.append(float(val))

    shift_coverage = len(shifted_pnls) / len(cond) if len(cond) else 0.0
    shift_note = ""
    if shift_coverage < 0.80:
        shift_bp = float("nan")
        shift_note = f"shift coverage {shift_coverage:.1%}<80%"
        shifted_mean = float("nan")
    else:
        shifted_mean = float(np.nanmean(shifted_pnls))
        shift_bp = (clean_mean - shifted_mean) * 1e4 if np.isfinite(shifted_mean) else float("nan")

    months = cond["session"].astype(str).str[:7]
    hits = 0
    n_draws = 0
    target = max(int(n_placebo), 200)
    if base is not None and len(base):
        for mo in months.unique():
            cond_m = cond[months == mo]
            n_m = len(cond_m)
            if n_m < 3:
                continue
            tickers_m = set(cond_m["ticker"])
            pool = base.loc[base["ticker"].isin(tickers_m), pnl_col].dropna().to_numpy(dtype=float)
            if pool.size < n_m:
                continue
            per_mo = max(1, target // max(1, len(months.unique())))
            for _ in range(per_mo):
                if n_draws >= target:
                    break
                pick = rng.choice(pool, size=n_m, replace=False)
                n_draws += 1
                if float(np.mean(pick)) >= clean_mean:
                    hits += 1
            if n_draws >= target:
                break
    placebo_p = hits / n_draws if n_draws else float("nan")

    shift_kill = False
    if np.isfinite(lift) and lift > 1e-4 and np.isfinite(shifted_mean):
        shifted_lift = shifted_mean - b_mean
        if shifted_lift >= 0:
            shift_kill = bool(shifted_lift < 0.2 * lift)
    leak_flag = bool(shift_kill)
    return {
        "shift_bp": shift_bp,
        "shift_coverage": float(shift_coverage),
        "shift_note": shift_note,
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
