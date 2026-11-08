#!/usr/bin/env python3
"""A341 fast screen — vectorized strategy library; survivors only get a full study.

Bars: pattern_lab.load once → wide matrices, cache ~/.fildi/cache/fast_screen_bars.pkl.
Library: triple_rsi5, rsi2_connors, zscore20, overnight, intraday, gap_down/up_2pct,
rsi_rotation, pead, 52w_high_breakout. Both sides. Entry next open after close signal.
Holds {1,5,10,21} or rule exit. Cost 5 bp/side. AFML DSR + PBO/CSCV. Survivor:
holdout excess > 0 AND fit+val month-clustered t ≥ 2 AND DSR ≥ 0.95.

Primary comparator (Claude review 1553c87d): same-day same vol-decile peers (20d realized
vol). Ticker-matched monthly excess kept as secondary column. Gate uses primary.

    cd scripts/watchlist_sync && .venv/bin/python analysis/fast_screen.py self-test
    .venv/bin/python analysis/fast_screen.py run [--strategies a,b] [--tickers ..] [--rebuild]
Out: research/studies/out/fast_screen/<date>.csv + .md + <date>-usecases.md
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # watchlist_sync
REPO = ROOT.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import pattern_lab as PL  # noqa: E402
from a352_score_rank import (  # noqa: E402
    MIN_NAMES,
    load_tbill,
    rebuild_book,
    tbill_at,
)
from build_plan import connect, rows  # noqa: E402
from screen_signals import (  # noqa: E402  A341 one home
    sig_gap_variant as _sig_gap_variant,
    sig_z_variant as _sig_z_variant,
    sma_mat,
)

CACHE = Path.home() / ".fildi" / "cache" / "fast_screen_bars.pkl"
PANEL_2003 = Path.home() / ".fildi" / "cache" / "fast_screen_bars_2003.pkl"
CACHE_VER = 2  # bumped when pack schema changes (iv)
OUT_DIR = REPO / "research" / "studies" / "out" / "fast_screen"
from study_contract import STOCK_CROSS_PER_SIDE  # noqa: E402

COST = STOCK_CROSS_PER_SIDE
HOLDS = (1, 5, 10, 21)
N_RAND = 200
SEED = 42
CSCV_BLOCKS = 16
EULER = 0.5772156649
# Claude review 1553c87d reference (zscore20/long/21 holdout vs vol-decile peers)
REF_Z20_L21_BP, REF_Z20_L21_N = 12.6, 17_129


# ── bars ─────────────────────────────────────────────────────────────────────

def load_bars(tickers: list[str] | None, rebuild: bool) -> dict:
    if CACHE.is_file() and not rebuild and tickers is None:
        with CACHE.open("rb") as f:
            pack = pickle.load(f)
        if pack.get("ver") == CACHE_VER and "iv" in pack:
            return pack
    t0 = time.perf_counter()
    df = PL.load(tickers)
    df = df.sort_values(["ticker", "date"])
    wide = {}
    for col in ("o", "h", "l", "c", "v"):
        wide[col] = df.pivot(index="date", columns="ticker", values=col).sort_index()
    iv = ((df["iv30_put"] + df["iv30_call"]) / 2.0)
    df = df.assign(_iv=iv)
    wide["iv"] = df.pivot(index="date", columns="ticker", values="_iv").reindex(
        index=wide["c"].index, columns=wide["c"].columns)
    dates = wide["c"].index
    tickers_out = list(wide["c"].columns)
    pack = {"ver": CACHE_VER, "o": wide["o"], "h": wide["h"], "l": wide["l"], "c": wide["c"],
            "v": wide["v"], "iv": wide["iv"], "dates": dates, "tickers": tickers_out,
            "loaded_s": time.perf_counter() - t0}
    if tickers is None:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        with CACHE.open("wb") as f:
            pickle.dump(pack, f, protocol=pickle.HIGHEST_PROTOCOL)
    return pack


def _align(pack: dict) -> tuple[pd.DatetimeIndex, list[str], np.ndarray, np.ndarray, np.ndarray]:
    dates = pack["dates"]
    tickers = pack["tickers"]
    o = pack["o"].to_numpy(dtype=float)
    c = pack["c"].to_numpy(dtype=float)
    h = pack["h"].to_numpy(dtype=float) if "h" in pack else c
    return dates, tickers, o, c, h


# ── indicators (matrix) ──────────────────────────────────────────────────────

def rsi_mat(c: np.ndarray, n: int) -> np.ndarray:
    """Wilder RSI along axis 0. Matches pattern_lab.rsi (ewm alpha=1/n)."""
    d = pd.DataFrame(c).diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return (100 - 100 / (1 + up / dn.replace(0, np.nan))).to_numpy()


def atr14_mat(h: np.ndarray, l: np.ndarray, c: np.ndarray) -> np.ndarray:
    prev = np.roll(c, 1, 0)
    prev[0] = np.nan
    tr = np.maximum(h - l, np.maximum(np.abs(h - prev), np.abs(l - prev)))
    return pd.DataFrame(tr).ewm(alpha=1 / 14, adjust=False).mean().to_numpy()


def realized_vol20(c: np.ndarray) -> np.ndarray:
    r = pd.DataFrame(c).pct_change()
    return r.rolling(20, min_periods=20).std().to_numpy()


def vol_decile_mat(rv: np.ndarray) -> np.ndarray:
    """Same-day cross-section vol deciles 0..9; -1 if too thin."""
    n, m = rv.shape
    out = np.full((n, m), -1, dtype=np.int8)
    for t in range(n):
        row = rv[t]
        ok = np.isfinite(row)
        n_ok = int(ok.sum())
        if n_ok < 30:
            continue
        ranks = np.empty(m, dtype=float)
        ranks[:] = np.nan
        ranks[ok] = pd.Series(row[ok]).rank(method="first").to_numpy()
        dec = np.floor((ranks - 1.0) / n_ok * 10.0)
        dec = np.clip(dec, 0, 9)
        out[t] = np.where(np.isfinite(dec), dec, -1).astype(np.int8)
    return out


def leave_one_out_decile_means(rets: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """Per day × vol-decile: leave-one-out mean return of peers (primary comparator)."""
    n, m = rets.shape
    out = np.full((n, m), np.nan)
    for t in range(n):
        drow = dec[t]
        rrow = rets[t]
        for d in range(10):
            idx = np.flatnonzero((drow == d) & np.isfinite(rrow))
            if idx.size < 2:
                continue
            vals = rrow[idx]
            out[t, idx] = (vals.sum() - vals) / (idx.size - 1)
    return out


def fwd_min_low_mat(l: np.ndarray, hold: int) -> np.ndarray:
    """Min low from entry open day t+1 through t+hold (put-breach path)."""
    n, m = l.shape
    out = np.full((n, m), np.nan)
    for t in range(n - hold):
        out[t] = np.min(l[t + 1: t + hold + 1], axis=0)
    return out


def load_sectors(tickers: list[str]) -> dict[str, str]:
    q = """SELECT ticker, gics_sector FROM research_common.security_class
           WHERE gics_sector IS NOT NULL"""
    with connect() as conn:
        raw = rows(conn, q)
    want = set(tickers)
    return {r["ticker"]: r["gics_sector"] for r in raw if r["ticker"] in want}

# ── strategy library ─────────────────────────────────────────────────────────

def sig_triple_rsi5(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    """A339: RSI(5)<30, 3 declining days, RSI[t-3]<60, close>SMA200; exit RSI(5)>50 cross."""
    r = rsi_mat(c, 5)
    sma200 = sma_mat(c, 200)
    decl = (r < np.roll(r, 1, 0)) & (np.roll(r, 1, 0) < np.roll(r, 2, 0)) & (np.roll(r, 2, 0) < np.roll(r, 3, 0))
    entry = (r < 30) & decl & (np.roll(r, 3, 0) < 60) & (c > sma200) & np.isfinite(r) & np.isfinite(sma200)
    entry[:200] = False
    # exit: RSI crosses above 50 (was ≤50 prev)
    exit_ = (r > 50) & (np.roll(r, 1, 0) <= 50) & np.isfinite(r)
    exit_[:5] = False
    return entry, exit_


def sig_rsi2_connors(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    r = rsi_mat(c, 2)
    sma200 = sma_mat(c, 200)
    sma5 = sma_mat(c, 5)
    entry = (r < 10) & (c > sma200) & np.isfinite(r) & np.isfinite(sma200)
    entry[:200] = False
    exit_ = (c > sma5) & np.isfinite(sma5)
    exit_[:5] = False
    return entry, exit_


def sig_zscore20(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    m = sma_mat(c, 20)
    sd = pd.DataFrame(c).rolling(20, min_periods=20).std().to_numpy()
    z = (c - m) / np.where(sd == 0, np.nan, sd)
    entry = (z < -2) & np.isfinite(z)
    entry[:20] = False
    return entry, None


def sig_overnight(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    entry = np.isfinite(c) & np.isfinite(np.roll(o, -1, 0))
    entry[-1] = False
    return entry, None


def sig_intraday(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    entry = np.isfinite(o) & np.isfinite(c)
    return entry, None


def sig_gap_down_2pct(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    prev = np.roll(c, 1, 0)
    entry = (o <= prev * 0.98) & np.isfinite(o) & np.isfinite(prev)
    entry[0] = False
    return entry, None


def sig_gap_up_2pct(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    prev = np.roll(c, 1, 0)
    entry = (o >= prev * 1.02) & np.isfinite(o) & np.isfinite(prev)
    entry[0] = False
    return entry, None


def sig_rsi_rotation(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    r = rsi_mat(c, 14)
    # weekly: Friday or last bar of week
    is_week_end = np.zeros(len(dates), dtype=bool)
    for i, d in enumerate(dates):
        if i + 1 == len(dates) or dates[i + 1].to_period("W") != d.to_period("W"):
            is_week_end[i] = True
    q = np.nanpercentile(r, 90, axis=1, keepdims=True)
    entry = (r >= q) & is_week_end[:, None] & np.isfinite(r)
    entry[:14] = False
    return entry, None


def sig_pead(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    """Top-quintile |move_pct| earnings days from lseg_research.earnings_moves."""
    tickers = list(range(c.shape[1]))  # placeholder; caller patches via pead_entry
    entry = np.zeros_like(c, dtype=bool)
    return entry, None


def sig_52w_high_breakout(o, h, l, c, v, dates) -> tuple[np.ndarray, np.ndarray | None]:
    # prior 252-day high (exclude today)
    prior_max = pd.DataFrame(c).rolling(252, min_periods=252).max().shift(1).to_numpy()
    entry = (c > prior_max) & np.isfinite(prior_max)
    entry[:252] = False
    return entry, None


LIBRARY = {
    "triple_rsi5": sig_triple_rsi5,
    "rsi2_connors": sig_rsi2_connors,
    "zscore20": sig_zscore20,
    "overnight": sig_overnight,
    "intraday": sig_intraday,
    "gap_down_2pct": sig_gap_down_2pct,
    "gap_up_2pct": sig_gap_up_2pct,
    "rsi_rotation": sig_rsi_rotation,
    "pead": sig_pead,
    "52w_high_breakout": sig_52w_high_breakout,
}


def load_pead_entry(dates: pd.DatetimeIndex, tickers: list[str]) -> np.ndarray:
    """Earnings days in top quintile of |move_pct| (universe-wide)."""
    q = """SELECT ticker, report_date, move_pct
           FROM lseg_research.earnings_moves
           WHERE move_pct IS NOT NULL"""
    with connect() as conn:
        raw = rows(conn, q)
    if not raw:
        return np.zeros((len(dates), len(tickers)), dtype=bool)
    edf = pd.DataFrame(raw, columns=["ticker", "report_date", "move_pct"])
    edf["report_date"] = pd.to_datetime(edf["report_date"])
    edf["abs_m"] = edf["move_pct"].abs()
    thr = edf["abs_m"].quantile(0.8)
    edf = edf[edf["abs_m"] >= thr]
    date_ix = {pd.Timestamp(d).normalize(): i for i, d in enumerate(dates)}
    tick_ix = {t: i for i, t in enumerate(tickers)}
    entry = np.zeros((len(dates), len(tickers)), dtype=bool)
    for _, r in edf.iterrows():
        di = date_ix.get(pd.Timestamp(r.report_date).normalize())
        ti = tick_ix.get(r.ticker)
        if di is not None and ti is not None:
            entry[di, ti] = True
    return entry


# ── returns ──────────────────────────────────────────────────────────────────

def fwd_returns(o: np.ndarray, c: np.ndarray, hold: int) -> np.ndarray:
    """Signal at close t → entry open[t+1], exit close[t+hold]. Shape = c."""
    n, m = c.shape
    out = np.full((n, m), np.nan)
    # entry row e = t+1, exit row = t+hold = e+(hold-1) when hold>=1
    # for hold h: exit at close of day index t+h (h trading days after signal, entry next day)
    for t in range(n - hold):
        ent = o[t + 1]
        ex = c[t + hold]
        out[t] = ex / ent - 1.0 - 2 * COST
    return out


def overnight_returns(o: np.ndarray, c: np.ndarray) -> np.ndarray:
    n, m = c.shape
    out = np.full((n, m), np.nan)
    out[:-1] = o[1:] / c[:-1] - 1.0 - 2 * COST
    return out


def intraday_returns(o: np.ndarray, c: np.ndarray) -> np.ndarray:
    return c / o - 1.0 - 2 * COST


def rule_exit_returns(o: np.ndarray, c: np.ndarray, entry: np.ndarray, exit_: np.ndarray,
                      max_hold: int = 63) -> np.ndarray:
    """Enter next open after entry signal; exit at close of first exit_ day after entry day."""
    n, m = c.shape
    out = np.full((n, m), np.nan)
    # next exit index per day (forward-fill from exit days)
    next_exit = np.full((n, m), n - 1, dtype=int)
    for j in range(m):
        last = n - 1
        for i in range(n - 1, -1, -1):
            if exit_[i, j]:
                last = i
            next_exit[i, j] = last
    ei, ej = np.where(entry)
    for t, j in zip(ei.tolist(), ej.tolist()):
        e = t + 1
        if e >= n or not np.isfinite(o[e, j]):
            continue
        x = int(next_exit[min(t + 1, n - 1), j])
        if x <= t:
            x = min(t + max_hold, n - 1)
        if x > t + max_hold:
            x = min(t + max_hold, n - 1)
        if x < e or not np.isfinite(c[x, j]):
            continue
        out[t, j] = c[x, j] / o[e, j] - 1.0 - 2 * COST
    return out


# ── stats ────────────────────────────────────────────────────────────────────

def month_cluster_t(dates: pd.DatetimeIndex, rets: np.ndarray, mask: np.ndarray) -> float:
    """t of monthly mean selected returns (pattern_lab._month_cluster_t style)."""
    if mask.sum() < 20:
        return float("nan")
    dd = pd.DataFrame({"date": np.repeat(dates, rets.shape[1]),
                       "ret": rets.ravel(),
                       "sel": mask.astype(int).ravel()})
    dd = dd.dropna(subset=["ret"])
    dd = dd[dd.sel == 1]
    if len(dd) < 20:
        return float("nan")
    mo = dd.groupby(dd.date.dt.to_period("M"))["ret"].mean()
    if len(mo) < 4:
        return float("nan")
    return float(mo.mean() / (mo.std(ddof=1) / np.sqrt(len(mo))))


def split_mask(dates: pd.DatetimeIndex, split: str) -> np.ndarray:
    if split == "fit":
        return dates <= PL.FIT_END
    if split == "val":
        return (dates > PL.FIT_END) & (dates <= PL.VAL_END)
    if split == "holdout":
        return dates >= PL.S151_P3_HOLD_START
    if split == "fitval":
        return dates <= PL.VAL_END
    return np.ones(len(dates), dtype=bool)


def cell_metrics(dates, rets, entry, side: int, split: str, rng: np.random.Generator,
                 tbill_curve, hold_days: int, *, peer_mean: np.ndarray | None = None,
                 do_random: bool = True) -> dict:
    """Primary = same-day vol-decile peer excess (Claude review 1553c87d).

    peer_mean: leave-one-out mean of raw rets in same day × vol-decile.
    excess_bp / t / mo_excess (for DSR/PBO/gate) use primary.
    matched_excess_bp = secondary ticker-matched monthly excess (kept, not gated).
    raw_excess_bp = mean(sel) − unconditional same-split mean.
    """
    sm = split_mask(dates, split)
    finite = np.isfinite(rets)
    if peer_mean is not None:
        finite = finite & np.isfinite(peer_mean)
    mask = entry & sm[:, None] & finite
    r = side * rets
    sel = r[mask]
    n = int(sel.size)
    empty = {"n": 0, "mean_bp": np.nan, "excess_bp": np.nan, "t": np.nan, "win": np.nan,
             "rand_mean_bp": np.nan, "pct_beaten": np.nan, "uncond_bp": np.nan, "tbill_bp": np.nan,
             "matched_excess_bp": np.nan, "raw_excess_bp": np.nan,
             "mo_excess": pd.Series(dtype=float)}
    if n == 0:
        return empty
    mean = float(np.mean(sel))
    win = float(np.mean(sel > 0))
    u_mask = sm[:, None] & finite
    uncond = float(np.mean(r[u_mask])) if u_mask.any() else np.nan
    raw_excess = mean - uncond if np.isfinite(uncond) else float("nan")
    months = dates.to_period("M")
    sel_i, sel_j = np.where(mask)
    if len(sel_i) == 0:
        return empty

    # Primary: trade-level excess vs same-day vol-decile peers
    if peer_mean is not None:
        trade_ex = (side * (rets - peer_mean))[mask]
        excess = float(np.mean(trade_ex)) if trade_ex.size else float("nan")
        mo_prim: dict = {}
        for mo in pd.unique(months[sel_i]):
            in_mo = months[sel_i] == mo
            vals = trade_ex[in_mo]
            if vals.size:
                mo_prim[mo] = float(vals.mean())
        mo_excess = pd.Series(mo_prim, dtype=float)
    else:
        trade_ex = sel
        excess = float("nan")
        mo_excess = pd.Series(dtype=float)

    if len(mo_excess) >= 4:
        sd = float(mo_excess.std(ddof=1))
        t = float(mo_excess.mean() / (sd / np.sqrt(len(mo_excess)))) if sd > 0 else float("nan")
    else:
        t = float("nan")

    # Secondary: ticker-matched monthly (old comparator; not used for gate)
    mo_m_vals: list[float] = []
    pools: dict = {}
    for mo in pd.unique(months[sel_i]):
        in_mo = months[sel_i] == mo
        m_i, m_j = sel_i[in_mo], sel_j[in_mo]
        sel_mo = r[m_i, m_j]
        day_ix = np.where(sm & (months == mo))[0]
        fired = np.unique(m_j)
        if day_ix.size == 0 or fired.size == 0:
            continue
        block = r[np.ix_(day_ix, fired)]
        pool = block[np.isfinite(block)]
        if sel_mo.size == 0 or pool.size == 0:
            continue
        mo_m_vals.append(float(sel_mo.mean() - pool.mean()))
        pools[mo] = (pool, int(sel_mo.size))
    matched_excess = float(np.mean(mo_m_vals)) if mo_m_vals else float("nan")

    rand_mean = pct_beaten = float("nan")
    if do_random and peer_mean is not None:
        # Random same-count draws from vol-decile peer excesses on signal days
        peer_ex_all = (side * (rets - peer_mean))
        day_pool = peer_ex_all[sm[:, None] & np.isfinite(peer_ex_all)]
        if day_pool.size >= n:
            rand_means = [float(rng.choice(day_pool, size=n, replace=False).mean()) for _ in range(N_RAND)]
            rm = np.asarray(rand_means)
            rand_mean = float(rm.mean())
            pct_beaten = float(np.mean(rm < excess)) if np.isfinite(excess) else float("nan")
    elif do_random:
        rand_means = []
        for _ in range(N_RAND):
            picks = []
            for mo, (pool, cnt) in pools.items():
                if cnt <= 0 or pool.size == 0:
                    continue
                take = min(cnt, pool.size)
                picks.append(float(rng.choice(pool, size=take, replace=False).mean()))
            if picks:
                rand_means.append(float(np.mean(picks)))
        if rand_means:
            rm = np.asarray(rand_means)
            rand_mean = float(rm.mean())
            pct_beaten = float(np.mean(rm < mean))
            excess = mean - rand_mean

    mid_i = int(np.where(sm)[0][len(np.where(sm)[0]) // 2]) if sm.any() else 0
    d0 = pd.Timestamp(dates[mid_i]).date()
    rate = tbill_at(tbill_curve, d0)
    tbill_bp = (rate * hold_days / 365.0 * 1e4) if rate is not None else np.nan
    return {
        "n": n,
        "mean_bp": mean * 1e4,
        "excess_bp": excess * 1e4 if np.isfinite(excess) else np.nan,
        "matched_excess_bp": matched_excess * 1e4 if np.isfinite(matched_excess) else np.nan,
        "raw_excess_bp": raw_excess * 1e4 if np.isfinite(raw_excess) else np.nan,
        "t": t,
        "win": win,
        "rand_mean_bp": rand_mean * 1e4 if np.isfinite(rand_mean) else np.nan,
        "pct_beaten": pct_beaten,
        "uncond_bp": uncond * 1e4 if np.isfinite(uncond) else np.nan,
        "tbill_bp": tbill_bp,
        "rets_sel": sel,
        "mo_excess": mo_excess,
    }


def sharpe(xs: np.ndarray) -> float:
    if xs.size < 5:
        return np.nan
    mu, sd = xs.mean(), xs.std(ddof=1)
    if sd <= 0 or not np.isfinite(sd):
        return np.nan
    return float(mu / sd * np.sqrt(252))  # daily-ish; ok for ranking


def deflated_sharpe(xs: np.ndarray, n_trials: int) -> float:
    """Bailey & López de Prado DSR = Φ(…); returns probability SR is not max-null."""
    if xs.size < 10 or n_trials < 1:
        return float("nan")
    sd = float(xs.std(ddof=1))
    if not np.isfinite(sd) or sd <= 0:
        return float("nan")
    sr = float(xs.mean() / sd)
    if not np.isfinite(sr):
        return float("nan")
    n = xs.size
    # annualize-free: use non-annualized SR for DSR formula
    g3 = float(((xs - xs.mean()) ** 3).mean() / (xs.std(ddof=1) ** 3 + 1e-18))
    g4 = float(((xs - xs.mean()) ** 4).mean() / (xs.std(ddof=1) ** 4 + 1e-18))
    # E[max SR] under N trials, SR~N(0,1) approx for independent tests
    # SR* = sqrt(V) * ((1-γ)Z^{-1}(1-1/N)+γ Z^{-1}(1-1/(N e)))
    # V[SR] ≈ 1/(n-1) under null with zero true SR for non-annualized
    v = 1.0 / max(n - 1, 1)
    z1 = norm.ppf(1 - 1.0 / n_trials)
    z2 = norm.ppf(1 - 1.0 / (n_trials * np.e))
    sr_star = np.sqrt(v) * ((1 - EULER) * z1 + EULER * z2)
    denom = np.sqrt(max(1 - g3 * sr + (g4 - 1) / 4.0 * sr ** 2, 1e-12))
    z = (sr - sr_star) * np.sqrt(n - 1) / denom
    return float(norm.cdf(z))


def pbo_cscv(perf_matrix: np.ndarray, n_blocks: int = CSCV_BLOCKS) -> float:
    """perf_matrix: shape (n_cells, T) cell×time returns (aligned monthly means).
    PBO = fraction of CSCV combos where best-IS cell underperforms median OOS."""
    from itertools import combinations
    C, T = perf_matrix.shape
    if T < n_blocks or C < 2:
        return float("nan")
    # trim to multiple of n_blocks
    T2 = T - (T % n_blocks)
    if T2 < n_blocks:
        return float("nan")
    X = perf_matrix[:, :T2]
    block = T2 // n_blocks
    blocks = [X[:, i * block:(i + 1) * block].mean(axis=1) for i in range(n_blocks)]
    blocks = np.stack(blocks, axis=1)  # C × n_blocks
    half = n_blocks // 2
    bad = 0
    total = 0
    for comb in combinations(range(n_blocks), half):
        is_ix = list(comb)
        oos_ix = [i for i in range(n_blocks) if i not in comb]
        is_perf = blocks[:, is_ix].mean(axis=1)
        oos_perf = blocks[:, oos_ix].mean(axis=1)
        best = int(np.nanargmax(is_perf))
        med = np.nanmedian(oos_perf)
        if oos_perf[best] < med:
            bad += 1
        total += 1
    return bad / total if total else float("nan")


# ── screen ───────────────────────────────────────────────────────────────────

def run_screen(pack: dict, strategies: list[str] | None, seed: int = SEED) -> pd.DataFrame:
    dates, tickers, o, c, h = _align(pack)
    l = pack["l"].to_numpy(dtype=float)
    v = pack["v"].to_numpy(dtype=float)
    tbill_curve = load_tbill()
    names = strategies or list(LIBRARY.keys())
    pead_entry = None
    if "pead" in names:
        pead_entry = load_pead_entry(dates, tickers)

    # precompute hold returns + vol-decile peer means (primary comparator)
    hold_rets = {hh: fwd_returns(o, c, hh) for hh in HOLDS}
    overnight_r = overnight_returns(o, c)
    intraday_r = intraday_returns(o, c)
    dec = vol_decile_mat(realized_vol20(c))
    peer_means: dict = {hh: leave_one_out_decile_means(hold_rets[hh], dec) for hh in HOLDS}
    peer_means["overnight"] = leave_one_out_decile_means(overnight_r, dec)
    peer_means["intraday"] = leave_one_out_decile_means(intraday_r, dec)

    rows_out = []
    cell_series = []  # for PBO: monthly mean series per cell
    rng0 = np.random.default_rng(seed)

    for sid in names:
        fn = LIBRARY[sid]
        entry, exit_ = fn(o, h, l, c, v, dates)
        if sid == "pead" and pead_entry is not None:
            entry = pead_entry
        # hold set
        if sid == "overnight":
            hold_list = [("overnight", overnight_r, 1, peer_means["overnight"])]
        elif sid == "intraday":
            hold_list = [("intraday", intraday_r, 1, peer_means["intraday"])]
        elif sid == "pead":
            hold_list = [(hh, hold_rets[hh], hh, peer_means[hh]) for hh in (5, 21)]
        elif exit_ is not None:
            rule_r = rule_exit_returns(o, c, entry, exit_)
            pm_rule = leave_one_out_decile_means(rule_r, dec)
            hold_list = [("rule", rule_r, 5, pm_rule)] + [
                (hh, hold_rets[hh], hh, peer_means[hh]) for hh in HOLDS]
        else:
            hold_list = [(hh, hold_rets[hh], hh, peer_means[hh]) for hh in HOLDS]

        dense = bool(entry.mean() > 0.05)  # overnight/intraday-like
        for hold_lab, rets, hd, pm in hold_list:
            for side, side_name in ((1, "long"), (-1, "short")):
                m_fit = cell_metrics(dates, rets, entry, side, "fit",
                                     np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                     tbill_curve, hd, peer_mean=pm, do_random=False)
                m_val = cell_metrics(dates, rets, entry, side, "val",
                                     np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                     tbill_curve, hd, peer_mean=pm, do_random=False)
                m_ho = cell_metrics(dates, rets, entry, side, "holdout",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, peer_mean=pm, do_random=not dense)
                m_fv = cell_metrics(dates, rets, entry, side, "fitval",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, peer_mean=pm, do_random=False)
                m_all = cell_metrics(dates, rets, entry, side, "all",
                                     np.random.default_rng(0),
                                     tbill_curve, hd, peer_mean=pm, do_random=False)
                cell_series.append(m_all["mo_excess"])
                rows_out.append({
                    "strategy": sid,
                    "side": side_name,
                    "hold": hold_lab,
                    "n_fit": m_fit["n"], "mean_bp_fit": m_fit["mean_bp"], "excess_bp_fit": m_fit["excess_bp"],
                    "t_fit": m_fit["t"], "win_fit": m_fit["win"],
                    "n_val": m_val["n"], "mean_bp_val": m_val["mean_bp"], "excess_bp_val": m_val["excess_bp"],
                    "t_val": m_val["t"], "win_val": m_val["win"],
                    "n_holdout": m_ho["n"], "mean_bp_holdout": m_ho["mean_bp"],
                    "excess_bp_holdout": m_ho["excess_bp"], "t_holdout": m_ho["t"], "win_holdout": m_ho["win"],
                    "matched_excess_bp_holdout": m_ho["matched_excess_bp"],
                    "raw_excess_bp_holdout": m_ho["raw_excess_bp"],
                    "t_fitval": m_fv["t"], "excess_bp_fitval": m_fv["excess_bp"],
                    "pct_beaten_holdout": m_ho["pct_beaten"],
                    "uncond_bp_holdout": m_ho["uncond_bp"], "tbill_bp": m_ho["tbill_bp"],
                    "_mo_ex_fv": m_fv["mo_excess"],
                })

    n_trials = len(rows_out)
    for r in rows_out:
        # DSR on monthly-excess series (n = months), not overlapping trade returns
        xs = r["_mo_ex_fv"].to_numpy(dtype=float) if len(r["_mo_ex_fv"]) else np.asarray([])
        r["dsr"] = deflated_sharpe(xs, n_trials)
        r["survivor"] = (
            np.isfinite(r["excess_bp_holdout"]) and r["excess_bp_holdout"] > 1.0  # >1bp (dense≈0 noise)
            and np.isfinite(r["t_fitval"]) and r["t_fitval"] >= 2
            and np.isfinite(r["dsr"]) and r["dsr"] >= 0.95
        )

    # PBO on monthly-excess matrix (not raw selected means)
    if cell_series:
        all_months = sorted(set().union(*[set(s.index) for s in cell_series if len(s)]))
        if all_months:
            mat = np.full((len(cell_series), len(all_months)), np.nan)
            for i, s in enumerate(cell_series):
                for j, mo in enumerate(all_months):
                    if mo in s.index:
                        mat[i, j] = float(s.loc[mo])
            col_med = np.nanmedian(mat, axis=0)
            inds = np.where(np.isnan(mat))
            mat[inds] = np.take(col_med, inds[1])
            pbo = pbo_cscv(mat, CSCV_BLOCKS)
        else:
            pbo = float("nan")
    else:
        pbo = float("nan")
    for r in rows_out:
        r["pbo"] = pbo
        r["n_trials"] = n_trials
        del r["_mo_ex_fv"]

    df = pd.DataFrame(rows_out)
    df = df.sort_values(["survivor", "excess_bp_holdout"], ascending=[False, False], na_position="last")
    return df


# ── self-test ────────────────────────────────────────────────────────────────

def self_test(pack: dict) -> list[str]:
    lines = []
    dates, tickers, o, c, h = _align(pack)
    if "SPY" not in tickers:
        return ["FAIL: SPY missing from bars"]
    j = tickers.index("SPY")
    # restrict 2018+
    start = pd.Timestamp("2018-01-01")
    idx = np.where(dates >= start)[0]
    o_s, c_s = o[idx, j], c[idx, j]
    d_s = dates[idx]
    # vectorized signal on full then slice
    entry, exit_ = sig_triple_rsi5(o[:, [j]], h[:, [j]], pack["l"].to_numpy()[:, [j]],
                                   c[:, [j]], pack["v"].to_numpy()[:, [j]], dates)
    entry_s = entry[idx, 0]
    exit_s = exit_[idx, 0]

    # plain loop
    r = PL.rsi(pd.Series(c_s, index=d_s), 5)
    sma200 = pd.Series(c_s, index=d_s).rolling(200).mean()
    trades_loop = []
    i = 0
    n = len(d_s)
    while i < n:
        if i < 200:
            i += 1
            continue
        if (np.isfinite(r.iloc[i]) and r.iloc[i] < 30
                and r.iloc[i] < r.iloc[i - 1] < r.iloc[i - 2] < r.iloc[i - 3]
                and r.iloc[i - 3] < 60
                and c_s[i] > sma200.iloc[i] and np.isfinite(sma200.iloc[i])):
            e = i + 1
            if e >= n:
                break
            x = None
            for k in range(i + 1, min(i + 64, n)):
                if r.iloc[k] > 50 and r.iloc[k - 1] <= 50:
                    x = k
                    break
            if x is None:
                x = min(i + 63, n - 1)
            if x >= e and np.isfinite(o_s[e]) and np.isfinite(c_s[x]):
                trades_loop.append(c_s[x] / o_s[e] - 1.0 - 2 * COST)
            i = x + 1 if x is not None else i + 1
        else:
            i += 1

    # overlapping signal set (screen style) via rule_exit_returns
    rule_r = rule_exit_returns(o[:, [j]], c[:, [j]], entry, exit_)
    trades_vec = rule_r[idx, 0][entry_s & np.isfinite(rule_r[idx, 0])]
    # equality: rebuild every signal (allow overlap) same as vec
    trades_loop_all = []
    for i in range(n):
        if not (np.isfinite(r.iloc[i]) and i >= 200 and r.iloc[i] < 30
                and r.iloc[i] < r.iloc[i - 1] < r.iloc[i - 2] < r.iloc[i - 3]
                and r.iloc[i - 3] < 60
                and c_s[i] > sma200.iloc[i] and np.isfinite(sma200.iloc[i])):
            continue
        e = i + 1
        if e >= n:
            break
        x = None
        for k in range(i + 1, min(i + 64, n)):
            if r.iloc[k] > 50 and (k == 0 or r.iloc[k - 1] <= 50):
                x = k
                break
        if x is None:
            x = min(i + 63, n - 1)
        if x >= e and np.isfinite(o_s[e]) and np.isfinite(c_s[x]):
            trades_loop_all.append(c_s[x] / o_s[e] - 1.0 - 2 * COST)
    ok_eq = (len(trades_loop_all) == len(trades_vec)
             and (len(trades_loop_all) == 0
                  or abs(float(np.mean(trades_loop_all)) - float(np.mean(trades_vec))) < 1e-9))
    lines.append(
        f"{'PASS' if ok_eq else 'FAIL'} (i) triple_rsi5 SPY 2018→ loop vs vec: "
        f"n={len(trades_loop_all)}/{len(trades_vec)} "
        f"avg={np.mean(trades_loop_all)*100 if trades_loop_all else 0:.4f}%/"
        f"{np.mean(trades_vec)*100 if len(trades_vec) else 0:.4f}%"
    )

    # (ii) direction match vs A339 2015–2026 subsample 36 tr / 80.6% / +0.89%
    n_t = len(trades_loop_all)
    win_t = float(np.mean(np.array(trades_loop_all) > 0)) if trades_loop_all else 0.0
    avg_t = float(np.mean(trades_loop_all)) if trades_loop_all else 0.0
    # direction: win > 50% and avg > 0 matches A339 direction
    ok_dir = n_t >= 5 and win_t >= 0.55 and avg_t > 0
    lines.append(
        f"{'PASS' if ok_dir else 'FAIL'} (ii) SPY triple_rsi5 n={n_t} win={win_t*100:.1f}% "
        f"avg={avg_t*100:.2f}% vs A339 2015–26 36/80.6%/+0.89% (direction)"
    )

    # (iii) look-ahead: shift signals 1 day earlier → excess must not improve
    entry_full = np.zeros_like(c, dtype=bool)
    entry_full[:, j] = entry[:, 0]
    entry_shift = np.roll(entry_full, -1, 0)
    entry_shift[-1] = False
    hold5 = fwd_returns(o, c, 5)
    sm = dates >= start
    def _mean_ex(ent):
        m = ent[:, j] & sm & np.isfinite(hold5[:, j])
        if m.sum() < 5:
            return np.nan
        return float(np.mean(hold5[m, j]) - np.mean(hold5[sm & np.isfinite(hold5[:, j]), j]))
    ex0 = _mean_ex(entry_full)
    ex1 = _mean_ex(entry_shift)
    ok_la = (not np.isfinite(ex1)) or (not np.isfinite(ex0)) or (ex1 <= ex0 + 1e-6)
    lines.append(
        f"{'PASS' if ok_la else 'FAIL'} (iii) look-ahead probe: clean_ex={ex0*1e4:.1f}bp "
        f"shifted_ex={ex1*1e4:.1f}bp (shifted must not improve)"
    )

    # (iv) random draws reproducible
    rng_a = np.random.default_rng(SEED)
    rng_b = np.random.default_rng(SEED)
    a = rng_a.integers(0, 1000, size=20)
    b = rng_b.integers(0, 1000, size=20)
    ok_seed = np.array_equal(a, b)
    lines.append(f"{'PASS' if ok_seed else 'FAIL'} (iv) random seed={SEED} reproducible")

    # (v)+(vii) need full universe for vol-decile placebo + zscore reference
    full = pack
    if len(tickers) < 50 and CACHE.is_file():
        try:
            full = load_bars(None, rebuild=False)
        except Exception:
            full = pack
    fd, ft, fo, fc, fh = _align(full)
    fl = full["l"].to_numpy(dtype=float)
    fv = full["v"].to_numpy(dtype=float)
    tbill_curve = load_tbill()
    hold_cache = {hd: fwd_returns(fo, fc, hd) for hd in HOLDS}
    dec = vol_decile_mat(realized_vol20(fc))
    peer_cache = {hd: leave_one_out_decile_means(hold_cache[hd], dec) for hd in HOLDS}
    n_placebo_ok = 0
    n_seeds = 20
    n_trials_p = len(HOLDS) * 2
    for s in range(n_seeds):
        rng = np.random.default_rng(10_000 + s)
        entry_p = rng.random(fc.shape) < 0.03
        n_surv = 0
        for hd in HOLDS:
            rets = hold_cache[hd]
            pm = peer_cache[hd]
            for side in (1, -1):
                m_ho = cell_metrics(fd, rets, entry_p, side, "holdout",
                                    np.random.default_rng(rng.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, peer_mean=pm, do_random=False)
                m_fv = cell_metrics(fd, rets, entry_p, side, "fitval",
                                    np.random.default_rng(rng.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, peer_mean=pm, do_random=False)
                xs = m_fv["mo_excess"].to_numpy(dtype=float)
                dsr = deflated_sharpe(xs, n_trials_p)
                survived = (
                    np.isfinite(m_ho["excess_bp"]) and m_ho["excess_bp"] > 0
                    and np.isfinite(m_fv["t"]) and m_fv["t"] >= 2
                    and np.isfinite(dsr) and dsr >= 0.95
                )
                if survived:
                    n_surv += 1
        if n_surv == 0:
            n_placebo_ok += 1
    ok_placebo = n_placebo_ok >= 19
    lines.append(
        f"{'PASS' if ok_placebo else 'FAIL'} (v) placebo 3% × {n_seeds} seeds: "
        f"{n_placebo_ok}/{n_seeds} with 0 survivors (need ≥19)"
    )

    # (vi) gap_up vs gap_down long same-hold must not both survive without a printed note
    notes = gap_contradiction_notes(_fake_gap_both_survive_df())
    notes_empty = gap_contradiction_notes(_fake_gap_one_survive_df())
    ok_note = len(notes) >= 1 and len(notes_empty) == 0
    lines.append(
        f"{'PASS' if ok_note else 'FAIL'} (vi) gap_up/gap_down contradiction note helper "
        f"(both→{len(notes)} note(s), one→{len(notes_empty)})"
    )

    # (vii) zscore20/long/21 holdout vs vol-decile peers ≈ +12.6 bp (n≈17,129)
    ent_z, _ = sig_zscore20(fo, fh, fl, fc, fv, fd)
    m_z = cell_metrics(fd, hold_cache[21], ent_z, 1, "holdout",
                       np.random.default_rng(SEED), tbill_curve, 21,
                       peer_mean=peer_cache[21], do_random=False)
    bp, nn = m_z["excess_bp"], m_z["n"]
    ok_z = (nn >= 15_000 and np.isfinite(bp) and 0.0 < bp < 40.0)
    lines.append(
        f"{'PASS' if ok_z else 'FAIL'} (vii) zscore20/long/21 holdout vs vol-decile peers: "
        f"{bp:.1f}bp n={nn} (ref ≈ +{REF_Z20_L21_BP}bp n≈{REF_Z20_L21_N})"
    )

    # (viii) A369 per-stock threshold lens matches S160 h5 @ global 25
    import subprocess
    from study_contract import s160_h5_matches_reference  # noqa: WPS433

    if PANEL_2003.is_file():
        proc = subprocess.run(
            [sys.executable, str(HERE / "s160_rsi_per_stock.py"), "--h", "5", "--gth", "25"],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(ROOT),
        )
        if proc.returncode != 0:
            lines.append(f"FAIL (viii) S160 harness: exit {proc.returncode}")
        else:
            lr = json.loads(proc.stdout.strip().splitlines()[-1])
            ok_lens, msg = s160_h5_matches_reference(lr)
            lines.append(f"{'PASS' if ok_lens else 'FAIL'} (viii) S160 harness: {msg}")
    else:
        lines.append("FAIL (viii) missing fast_screen_bars_2003.pkl")

    from conditional_engine import run_conditional_leak_test  # noqa: WPS433

    try:
        lk = run_conditional_leak_test(["SPY", "AAPL"])
        ok_leak = lk["planted_lookahead_flagged"] and lk["s159_pass"]
        lines.append(
            f"{'PASS' if ok_leak else 'FAIL'} (ix) leak planted={lk['planted_lookahead_flagged']} "
            f"s159={lk['s159_pass']}"
        )
    except Exception as exc:
        lines.append(f"FAIL (ix) leak test error: {exc}")

    from study_contract import leak_cell  # noqa: WPS433

    rng_leak = np.random.default_rng(369_369)
    n_bar = 120
    sessions = [f"2020-03-{1 + (i // 8):02d}" for i in range(n_bar)]
    planted_pnl = np.array([0.012 if i % 10 == 0 else -0.0005 for i in range(n_bar)])
    cond_planted = pd.DataFrame({
        "ticker": ["SPY"] * n_bar,
        "session": sessions,
        "signal_bar": list(range(n_bar)),
        "pnl_coll_frac_cross": planted_pnl,
        "pnl_coll_frac_fill": planted_pnl - 0.0002,
    })
    base_long = rng_leak.normal(-0.0005, 0.0015, n_bar + 80)
    base_planted = pd.DataFrame({
        "ticker": ["SPY"] * (n_bar + 80),
        "session": [f"2020-03-{1 + (i // 8):02d}" for i in range(n_bar + 80)],
        "signal_bar": list(range(n_bar + 80)),
        "pnl_coll_frac_cross": base_long,
        "pnl_coll_frac_fill": base_long - 0.0002,
    })
    lk_plant = leak_cell(cond_planted, base_planted, np.random.default_rng(42))
    ok_plant = bool(lk_plant.get("leak_flag"))
    lines.append(
        f"{'PASS' if ok_plant else 'FAIL'} (x) leak planted frame: flag={ok_plant} "
        f"shift_bp={lk_plant.get('shift_bp')} placebo_p={lk_plant.get('placebo_p')}"
    )

    n_rand = 200
    base_n = 500
    rng_b = np.random.default_rng(123_456)
    base_pnls = rng_b.normal(0.0, 0.002, base_n)
    cond_pnls = base_pnls[:n_rand]
    cond_rand = pd.DataFrame({
        "ticker": ["QQQ"] * n_rand,
        "session": [f"2021-06-{1 + (i // 12):02d}" for i in range(n_rand)],
        "signal_bar": list(range(n_rand)),
        "pnl_coll_frac_cross": cond_pnls,
        "pnl_coll_frac_fill": cond_pnls,
    })
    base_rand = pd.DataFrame({
        "ticker": ["QQQ"] * base_n,
        "session": [f"2021-06-{1 + (i // 12):02d}" for i in range(base_n)],
        "signal_bar": list(range(base_n)),
        "pnl_coll_frac_cross": base_pnls,
        "pnl_coll_frac_fill": base_pnls,
    })
    lk_rand = leak_cell(cond_rand, base_rand, np.random.default_rng(77), n_placebo=200)
    pp = lk_rand.get("placebo_p", float("nan"))
    ok_rand = (not lk_rand.get("leak_flag")) and np.isfinite(pp) and 0.3 <= float(pp) <= 0.7
    lines.append(
        f"{'PASS' if ok_rand else 'FAIL'} (xi) leak random frame: flag={lk_rand.get('leak_flag')} "
        f"placebo_p={pp:.3f}"
    )
    return lines


def _fake_gap_both_survive_df() -> pd.DataFrame:
    return pd.DataFrame([
        {"strategy": "gap_up_2pct", "side": "long", "hold": 21, "survivor": True},
        {"strategy": "gap_down_2pct", "side": "long", "hold": 21, "survivor": True},
    ])


def _fake_gap_one_survive_df() -> pd.DataFrame:
    return pd.DataFrame([
        {"strategy": "gap_up_2pct", "side": "long", "hold": 21, "survivor": True},
        {"strategy": "gap_down_2pct", "side": "long", "hold": 21, "survivor": False},
    ])


def gap_contradiction_notes(df: pd.DataFrame) -> list[str]:
    """Note when gap_up AND gap_down long survive on the same hold (noise tell)."""
    notes = []
    if df is None or len(df) == 0 or "survivor" not in df.columns:
        return notes
    surv = df[df["survivor"] == True]  # noqa: E712
    for hold in sorted(surv["hold"].unique(), key=lambda x: str(x)):
        up = ((surv.strategy == "gap_up_2pct") & (surv.side == "long") & (surv.hold == hold)).any()
        dn = ((surv.strategy == "gap_down_2pct") & (surv.side == "long") & (surv.hold == hold)).any()
        if up and dn:
            notes.append(
                f"NOTE: gap_up_2pct AND gap_down_2pct both survive long/hold={hold} "
                f"— directionally opposite; treat as noise unless one side dies OOS."
            )
    return notes


# ── use-case pass (Jamie 11-06) ───────────────────────────────────────────────

def _sig_rsi_variant(c, period: int, thr: float, decl_days: int) -> np.ndarray:
    r = rsi_mat(c, period)
    sma200 = sma_mat(c, 200)
    entry = (r < thr) & (c > sma200) & np.isfinite(r) & np.isfinite(sma200)
    if decl_days >= 2:
        decl = np.ones_like(r, dtype=bool)
        for k in range(decl_days):
            decl &= (np.roll(r, k, 0) < np.roll(r, k + 1, 0))
        entry &= decl & (np.roll(r, decl_days, 0) < 60)
    entry[: max(200, period + decl_days + 1)] = False
    return entry


def _sig_52w_variant(c, look: int) -> np.ndarray:
    prior = pd.DataFrame(c).rolling(look, min_periods=look).max().shift(1).to_numpy()
    entry = (c > prior) & np.isfinite(prior)
    entry[:look] = False
    return entry


def _breach_stats(entry, side, o, atr, fwd_min, k: float, split: str, dates,
                  peer_breach_rate: np.ndarray | None) -> dict:
    """Put strike = entry_open − k×ATR14; breach if fwd min low < strike."""
    sm = split_mask(dates, split)
    ent_px = np.roll(o, -1, 0)  # open t+1 aligned to signal t
    strike = ent_px - k * atr
    breached = fwd_min < strike
    ok = entry & sm[:, None] & np.isfinite(fwd_min) & np.isfinite(strike) & np.isfinite(ent_px)
    if side < 0:
        # short equity / call-side: mirror not used for put-seller job
        pass
    n = int(ok.sum())
    if n == 0:
        return {"n": 0, "breach": np.nan, "breach_delta": np.nan}
    br = float(breached[ok].mean())
    delta = np.nan
    if peer_breach_rate is not None:
        peers = peer_breach_rate[ok]
        peers = peers[np.isfinite(peers)]
        if peers.size:
            delta = br - float(peers.mean())
    return {"n": n, "breach": br, "breach_delta": delta}


def _peer_breach_rate(breached: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """Same-day vol-decile leave-one-out breach rate."""
    n, m = breached.shape
    out = np.full((n, m), np.nan)
    b = breached.astype(float)
    b[~np.isfinite(b)] = np.nan
    for t in range(n):
        drow = dec[t]
        brow = b[t]
        for d in range(10):
            idx = np.flatnonzero((drow == d) & np.isfinite(brow))
            if idx.size < 2:
                continue
            vals = brow[idx]
            out[t, idx] = (vals.sum() - vals) / (idx.size - 1)
    return out


def _context_masks(pack, dates, tickers, c) -> dict[str, np.ndarray]:
    """Named boolean day masks / ticker masks for context splits."""
    out = {}
    if "SPY" in tickers:
        j = tickers.index("SPY")
        spy = c[:, j]
        sma = sma_mat(spy[:, None], 200)[:, 0]
        above = (spy > sma) & np.isfinite(sma)
        out["SPY>SMA200"] = above
        out["SPY<SMA200"] = ~above & np.isfinite(sma)
    iv = pack["iv"].to_numpy(dtype=float) if "iv" in pack else None
    if iv is not None:
        # cross-sectional IV tercile each day
        terc = np.full(iv.shape, -1, dtype=np.int8)
        for t in range(len(dates)):
            row = iv[t]
            ok = np.isfinite(row)
            if ok.sum() < 30:
                continue
            q = np.nanpercentile(row[ok], [100 / 3, 200 / 3])
            terc[t, ok] = np.digitize(row[ok], q)  # 0,1,2
        for lab, k in (("IV_lo", 0), ("IV_mid", 1), ("IV_hi", 2)):
            out[lab] = terc == k  # ticker×day bool via broadcasting later
        out["_iv_terc"] = terc
    secs = load_sectors(tickers)
    out["_sectors"] = secs
    return out


def run_usecases(pack: dict, seed: int = SEED) -> tuple[Path, float]:
    """Variant grids + put-breach + lenses + context → what-works md (≤40 lines)."""
    t0 = time.perf_counter()
    dates, tickers, o, c, h = _align(pack)
    l = pack["l"].to_numpy(dtype=float)
    v = pack["v"].to_numpy(dtype=float)
    tbill = load_tbill()
    atr = atr14_mat(h, l, c)
    dec = vol_decile_mat(realized_vol20(c))
    hold_rets = {hh: fwd_returns(o, c, hh) for hh in HOLDS}
    peer_means = {hh: leave_one_out_decile_means(hold_rets[hh], dec) for hh in HOLDS}
    fwd_mins = {hh: fwd_min_low_mat(l, hh) for hh in (5, 10, 21)}
    # precompute put-breach peer rates for k=1 and 1.5×ATR
    ent_px = np.roll(o, -1, 0)
    peer_br = {}
    for hh in (5, 10, 21):
        for k in (1.0, 1.5):
            breached = fwd_mins[hh] < (ent_px - k * atr)
            peer_br[(hh, k)] = _peer_breach_rate(breached, dec)

    variants: list[tuple[str, str, np.ndarray, int]] = []
    for per in (2, 3, 4, 5, 7, 14):
        for thr in (5, 10, 15, 20, 25, 30):
            for decl in (0, 2, 3):
                variants.append(("rsi", f"rsi{per}<{thr}_d{decl}",
                                 _sig_rsi_variant(c, per, thr, decl), 5))
    for win in (10, 20, 50):
        for thr in (-1.5, -2.0, -2.5):
            variants.append(("zscore", f"z{win}<{thr:g}", _sig_z_variant(c, win, thr), 21))
    for pct in (0.01, 0.02, 0.03, 0.05):
        for d in ("down", "up"):
            variants.append(("gap", f"gap_{d}_{int(pct*100)}pct",
                             _sig_gap_variant(o, c, pct, d), 5))
    for look in (63, 126, 252):
        variants.append(("52w", f"high_{look}d", _sig_52w_variant(c, look), 10))
    pead_e = load_pead_entry(dates, tickers)
    for hh in (5, 10, 21):
        variants.append(("pead", f"pead_h{hh}", pead_e, hh))

    rng0 = np.random.default_rng(seed)
    rows = []
    n_trials = 0
    # Phase 1: cheap grid — fitval pick metrics + holdout primary/matched/raw only
    for fam, lab, entry, pref_h in variants:
        holds = (pref_h,) if fam == "pead" else HOLDS
        for hd in holds:
            pm = peer_means[hd]
            rets = hold_rets[hd]
            for side, sname in ((1, "long"), (-1, "short")):
                n_trials += 1
                m_fv = cell_metrics(dates, rets, entry, side, "fitval",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill, hd, peer_mean=pm, do_random=False)
                m_ho = cell_metrics(dates, rets, entry, side, "holdout",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill, hd, peer_mean=pm, do_random=False)
                rows.append({
                    "family": fam, "variant": lab, "side": sname, "hold": hd,
                    "entry": entry, "n_ho": m_ho["n"], "ex_ho": m_ho["excess_bp"],
                    "t_fv": m_fv["t"], "ex_fv": m_fv["excess_bp"],
                    "matched_ho": m_ho["matched_excess_bp"], "raw_ho": m_ho["raw_excess_bp"],
                    "_mo": m_fv["mo_excess"],
                })

    for r in rows:
        xs = r["_mo"].to_numpy(dtype=float) if len(r["_mo"]) else np.asarray([])
        r["dsr"] = deflated_sharpe(xs, max(n_trials, 1))
        del r["_mo"]

    df = pd.DataFrame([{k: v for k, v in r.items() if k != "entry"} | {"_i": i}
                       for i, r in enumerate(rows)])
    entries = [r["entry"] for r in rows]

    # Phase 2: pick best variant per family×side on fitval excess; enrich holdout jobs
    ctx = _context_masks(pack, dates, tickers, c)
    picks = []
    for fam in sorted(df.family.unique()):
        for sname in ("long", "short"):
            sub = df[(df.family == fam) & (df.side == sname)].copy()
            sub = sub[np.isfinite(sub.ex_fv)]
            if sub.empty:
                continue
            best = sub.sort_values(["ex_fv", "t_fv"], ascending=False).iloc[0]
            i = int(best._i)
            entry = entries[i]
            hd = int(best.hold)
            side = 1 if sname == "long" else -1
            pm = peer_means[hd]
            rets = hold_rets[hd]
            # breach (long only, hold≥5)
            br_d = float("nan")
            if side == 1 and hd in fwd_mins:
                st = _breach_stats(entry, side, o, atr, fwd_mins[hd], 1.0, "holdout",
                                   dates, peer_br[(hd, 1.0)])
                st15 = _breach_stats(entry, side, o, atr, fwd_mins[hd], 1.5, "holdout",
                                     dates, peer_br[(hd, 1.5)])
                br_d = st["breach_delta"] if np.isfinite(st["breach_delta"]) else st15["breach_delta"]
                if np.isfinite(st15["breach_delta"]) and (
                        not np.isfinite(br_d) or st15["breach_delta"] < br_d):
                    br_d = st15["breach_delta"]
            where = []
            for name, mask in ctx.items():
                if name.startswith("_"):
                    continue
                ent2 = entry & mask[:, None] if mask.ndim == 1 else entry & mask
                m_c = cell_metrics(dates, rets, ent2, side, "holdout",
                                   np.random.default_rng(0), tbill, hd,
                                   peer_mean=pm, do_random=False)
                if np.isfinite(m_c["excess_bp"]) and m_c["excess_bp"] > 0 and m_c["n"] >= 30:
                    where.append(f"{name}:{m_c['excess_bp']:.0f}bp")
            secs = ctx.get("_sectors") or {}
            if secs:
                sec_scores = []
                for sec in sorted(set(secs.values())):
                    cols = [j for j, t in enumerate(tickers) if secs.get(t) == sec]
                    if not cols:
                        continue
                    ent_s = np.zeros_like(entry)
                    ent_s[:, cols] = entry[:, cols]
                    m_s = cell_metrics(dates, rets, ent_s, side, "holdout",
                                       np.random.default_rng(0), tbill, hd,
                                       peer_mean=pm, do_random=False)
                    if m_s["n"] >= 30 and np.isfinite(m_s["excess_bp"]) and m_s["excess_bp"] > 0:
                        sec_scores.append((m_s["excess_bp"], sec))
                for bp, sec in sorted(sec_scores, reverse=True)[:2]:
                    where.append(f"{sec}:{bp:.0f}bp")
            jobs = []
            n_ok = int(best.n_ho) >= 50
            if n_ok and np.isfinite(best.ex_ho) and best.ex_ho > 0 and np.isfinite(best.t_fv) and best.t_fv >= 2:
                jobs.append("stock entry")
            if n_ok and np.isfinite(br_d) and br_d < -0.01:
                jobs.append("put timing")
            if n_ok and np.isfinite(best.ex_ho) and best.ex_ho < -5:
                jobs.append("avoid-list")
            if where and "stock entry" not in jobs:
                jobs.append("sizing")
            if not jobs:
                jobs = ["weak"]
            lens = "vol-decile"
            if np.isfinite(best.raw_ho) and np.isfinite(best.ex_ho) and best.raw_ho > best.ex_ho + 20:
                lens += "; raw≫matched→high-beta pick"
            picks.append({
                "family": fam, "variant": best.variant, "side": sname, "hold": hd,
                "job": "/".join(jobs), "ex_ho": float(best.ex_ho),
                "matched": float(best.matched_ho) if np.isfinite(best.matched_ho) else float("nan"),
                "raw": float(best.raw_ho) if np.isfinite(best.raw_ho) else float("nan"),
                "breach_d": br_d, "t_fv": float(best.t_fv) if np.isfinite(best.t_fv) else float("nan"),
                "dsr": float(best.dsr) if np.isfinite(best.dsr) else float("nan"),
                "n": int(best.n_ho), "where": ",".join(where[:4]), "lens": lens,
            })

    picks_df = pd.DataFrame(picks)
    works = picks_df[picks_df.job != "weak"].sort_values("ex_ho", ascending=False) if len(picks_df) else picks_df
    weak = picks_df[picks_df.job == "weak"] if len(picks_df) else picks_df

    day = date.today().isoformat()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    md = OUT_DIR / f"{day}-usecases.md"
    wall = time.perf_counter() - t0
    L = [f"# Fast screen use-cases {day} (A341)",
         f"variants={len(variants)} cells={len(rows)} n_trials={n_trials} wall={wall:.1f}s",
         "comparator=vol-decile(20d) primary; ticker-matched secondary",
         "",
         "## What works",
         "strategy → best version → job → holdout bp + breach Δ + where"]
    for _, r in works.head(12).iterrows():
        bd = f"{r.breach_d*100:+.1f}pp" if np.isfinite(r.breach_d) else "n/a"
        L.append(
            f"- {r.family}/{r.side}: {r.variant} h={r.hold} → {r.job} | "
            f"ho {r.ex_ho:+.1f}bp (matched {r.matched:+.0f}/raw {r.raw:+.0f}) "
            f"breachΔ {bd} t_fv={r.t_fv:.1f} DSR={r.dsr:.2f} n={r.n} | {r['where'] or '—'}"
        )
    if len(weak):
        L += ["", "## Weak (closest variant)"]
        for _, r in weak.head(6).iterrows():
            L.append(
                f"- {r.family}/{r.side}: {r.variant} h={r.hold} ho={r.ex_ho:+.1f}bp "
                f"t_fv={r.t_fv:.1f} — no clear job"
            )
    L += ["", f"Ref: zscore20/L21 vol-decile ≈ +{REF_Z20_L21_BP}bp n≈{REF_Z20_L21_N}"]
    md.write_text("\n".join(L[:40]) + "\n")
    # csv without entry matrices
    pd.DataFrame([{k: v for k, v in r.items() if k != "entry"} for r in rows]).to_csv(
        OUT_DIR / f"{day}-usecases.csv", index=False)
    return md, wall



# ── A341 puts: same-delta short-put pricing of screen hits ───────────────────

PUT_DELTAS = (0.30, 0.20)
PUT_DTE, PUT_ENTRY, PUT_EXIT = 45, "next_open", "half_dte"
HOLD_START = date(2025, 1, 1)


def _import_lab():
    import importlib.util
    spec = importlib.util.spec_from_file_location("backtest_lab", HERE / "backtest_lab.py")
    lab = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(lab)
    return lab


def _import_excess():
    import importlib.util
    spec = importlib.util.spec_from_file_location("s151_ex", HERE / "s151_phase4_excess.py")
    ex = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(ex)
    return ex


def a350_iv_wall_daily_ok() -> bool:
    """A350 needs daily IV-wall series; ticker_technicals.put_wall_strike is null placeholder."""
    try:
        with connect() as conn:
            n = rows(conn, "SELECT COUNT(*) AS n FROM ticker_technicals WHERE put_wall_strike IS NOT NULL")
        return bool(n and int(n[0]["n"]) > 0)
    except Exception:
        return False


def _pnl_coll_bp_wk(tr: dict, dte: int) -> float:
    """Credit-normalized S151 pnl → bp/week of strike collateral."""
    k = float(tr.get("K") or 0.0)
    cr = float(tr.get("credit") or 0.0)
    if k <= 0 or dte <= 0:
        return float("nan")
    return float(tr["pnl"]) * cr / k * 1e4 * 7.0 / dte


def _load_put_pool(lab, delta: float) -> tuple[list[dict], int]:
    for dte in (PUT_DTE, 25, 14):
        pool = lab._load_trade_pool("sell_put", delta, dte, PUT_ENTRY, PUT_EXIT)
        if pool:
            return pool, dte
    return [], PUT_DTE


def _pool_index(pool: list[dict]) -> dict[tuple[str, date], dict]:
    out: dict[tuple[str, date], dict] = {}
    for x in pool:
        d = x["d"]
        if hasattr(d, "date"):
            d = d.date()
        out[(x["ticker"], d)] = {**x, "d": d}
    return out


def _month_cluster_t_vals(dates_ym: list[tuple[int, int]], vals: list[float]) -> float:
    by: dict[tuple[int, int], list[float]] = {}
    for ym, v in zip(dates_ym, vals):
        if not np.isfinite(v):
            continue
        by.setdefault(ym, []).append(float(v))
    mo = [float(np.mean(v)) for v in by.values()]
    if len(mo) < 4 or np.std(mo, ddof=1) <= 0:
        return float("nan")
    return float(np.mean(mo) / (np.std(mo, ddof=1) / np.sqrt(len(mo))))


def _put_cell_stats(sig: list[dict], peer_ex: list[float], tb_bp: float, dte: int) -> dict:
    empty = {"n": 0, "bp_wk": np.nan, "win": np.nan, "worst_dec": np.nan,
             "t": np.nan, "peer_ex_bp": np.nan, "peer_ex_t": np.nan, "tbill_bp": tb_bp}
    if not sig:
        return empty
    bps_all = [_pnl_coll_bp_wk(x, dte) for x in sig]
    bps = np.array([b for b in bps_all if np.isfinite(b)], dtype=float)
    if bps.size == 0:
        return empty
    yms = [(x["d"].year, x["d"].month) for x in sig]
    t = _month_cluster_t_vals(yms, bps_all)
    pex = np.asarray(peer_ex, dtype=float)
    pex_ok = pex[np.isfinite(pex)]
    peer_t = _month_cluster_t_vals(yms, list(pex))
    return {
        "n": int(bps.size),
        "bp_wk": float(np.mean(bps)),
        "win": float(np.mean(bps > 0)),
        "worst_dec": float(np.percentile(bps, 10)),
        "t": t,
        "peer_ex_bp": float(np.mean(pex_ok)) if pex_ok.size else float("nan"),
        "peer_ex_t": peer_t,
        "tbill_bp": tb_bp,
    }


def _peer_ex_for_sigs(sig: list[dict], day_dec_pnl: dict, dte: int) -> list[float]:
    """Leave-one-out excess vs same-day same vol-decile peers' put bp/wk."""
    out = []
    for x in sig:
        key = (x["d"], int(x.get("_dec", -1)))
        peers = day_dec_pnl.get(key, [])
        mine = _pnl_coll_bp_wk(x, dte)
        if len(peers) < 2 or not np.isfinite(mine):
            out.append(float("nan"))
            continue
        loo = (sum(peers) - mine) / (len(peers) - 1)
        out.append(mine - loo)
    return out


def _build_day_dec_pnl(pool: list[dict], tick_ix: dict, dates, dec: np.ndarray, dte: int) -> dict:
    date_ix = {pd.Timestamp(d).date(): i for i, d in enumerate(dates)}
    buckets: dict[tuple[date, int], list[float]] = {}
    for x in pool:
        d = x["d"].date() if hasattr(x["d"], "date") else x["d"]
        ti = tick_ix.get(x["ticker"])
        di = date_ix.get(d)
        if ti is None or di is None:
            continue
        dv = int(dec[di, ti])
        if dv < 0:
            continue
        bp = _pnl_coll_bp_wk({**x, "d": d}, dte)
        if np.isfinite(bp):
            buckets.setdefault((d, dv), []).append(bp)
            x["_dec"] = dv
    return buckets


def _match_signals(entry: np.ndarray, dates, tickers, idx: dict) -> tuple[list[dict], int, float]:
    """Signal close t → pool entry date t+1. Returns (matched trades, n_signal, coverage)."""
    n_sig = 0
    matched = []
    for t, j in zip(*np.where(entry[:-1])):
        n_sig += 1
        d_ent = pd.Timestamp(dates[t + 1]).date()
        tr = idx.get((tickers[j], d_ent))
        if tr is not None:
            matched.append(tr)
    cov = (len(matched) / n_sig) if n_sig else 0.0
    return matched, n_sig, cov


def run_puts(pack: dict) -> Path:
    """Price z50<-2.5 long + gap_up_5pct as same-delta short puts vs vol-decile peers + T-bill."""
    t0 = time.perf_counter()
    lab = _import_lab()
    EX = _import_excess()
    dates, tickers, o, c, h = _align(pack)
    tbill = load_tbill()
    dec = vol_decile_mat(realized_vol20(c))
    tick_ix = {t: i for i, t in enumerate(tickers)}
    signals = {
        "z50<-2.5/long": _sig_z_variant(c, 50, -2.5),
        "gap_up_5pct": _sig_gap_variant(o, c, 0.05, "up"),
    }
    # T-bill bp/wk on collateral (flat approx)
    mid = pd.Timestamp(dates[len(dates) // 2]).date()
    rate = tbill_at(tbill, mid) or 0.0
    tb_bp = rate * 7.0 / 365.0 * 1e4
    rows_out = []
    for delta in PUT_DELTAS:
        pool, dte = _load_put_pool(lab, delta)
        if not pool:
            for sname, entry in signals.items():
                n_sig = int(entry[:-1].sum())
                rows_out.append({"signal": sname, "delta": delta, "n": 0, "coverage": 0.0,
                                 "n_sig": n_sig,
                                 "note": f"trade pool missing sell_put Δ{delta} — no impute"})
            continue
        for x in pool:
            if hasattr(x["d"], "date"):
                x["d"] = x["d"].date()
        day_dec = _build_day_dec_pnl(pool, tick_ix, dates, dec, dte)
        idx = _pool_index(pool)
        sector_map = {r["ticker"]: r.get("sector") or "?" for r in pool}
        for sname, entry in signals.items():
            matched, n_sig, cov = _match_signals(entry, dates, tickers, idx)
            if n_sig == 0:
                rows_out.append({"signal": sname, "delta": delta, "n": 0, "coverage": 0.0,
                                 "n_sig": 0, "note": "no signal days"})
                continue
            if not matched:
                rows_out.append({"signal": sname, "delta": delta, "n": 0, "coverage": 0.0,
                                 "n_sig": n_sig, "note": "0% pool coverage — no impute"})
                continue
            peer_ex = _peer_ex_for_sigs(matched, day_dec, dte)
            fit = [x for x in matched if x["d"] < HOLD_START]
            ho = [x for x in matched if x["d"] >= HOLD_START]
            st_all = _put_cell_stats(matched, peer_ex, tb_bp, dte)
            st_fit = _put_cell_stats(fit, _peer_ex_for_sigs(fit, day_dec, dte), tb_bp, dte)
            st_ho = _put_cell_stats(ho, _peer_ex_for_sigs(ho, day_dec, dte), tb_bp, dte)
            m = EX.metrics_for(matched, pool, sector_map, date(2018, 1, 1), None, None)
            rows_out.append({
                "signal": sname, "delta": delta, "dte": dte, "n": st_all["n"],
                "n_sig": n_sig, "coverage": cov,
                "bp_wk": st_all["bp_wk"], "win": st_all["win"],
                "worst_dec": st_all["worst_dec"], "t": st_all["t"],
                "peer_ex_bp": st_all["peer_ex_bp"], "tbill_bp": tb_bp,
                "fit_bp": st_fit["bp_wk"], "fit_t": st_fit["t"], "fit_n": st_fit["n"],
                "ho_bp": st_ho["bp_wk"], "ho_t": st_ho["t"], "ho_n": st_ho["n"],
                "ho_peer_ex": st_ho["peer_ex_bp"], "ho_peer_t": st_ho["peer_ex_t"],
                "ex_sm": m.get("excess_mean_sm", float("nan")) if m else float("nan"),
                "note": "",
            })
    # regime split: z10<-2.5 short h21 + pead short h21 × SPY>/<SMA200
    regime_rows = _regime_split_puts(pack, dates, tickers, o, c)
    # marginal: a352 champion top-tier × signal 2×2 at Δ0.20
    x22 = _score_signal_x22(signals, dates, tickers)
    return _write_puts_md(rows_out, regime_rows, x22, time.perf_counter() - t0)


def _signal_entry_keys(entry: np.ndarray, dates, tickers) -> set[tuple[str, date]]:
    """Signal close/bar t → entry date t+1 (same convention as put pool match)."""
    out: set[tuple[str, date]] = set()
    for t, j in zip(*np.where(entry[:-1])):
        out.add((tickers[j], pd.Timestamp(dates[t + 1]).date()))
    return out


def _score_signal_x22(signals: dict, dates, tickers) -> list[dict]:
    """2×2: a352 champion top-third vs rest × {signal, no signal}; same weeks/tickers."""
    with connect() as conn:
        book = rebuild_book(conn)
    tick_set = set(tickers)
    by: dict[date, list[dict]] = defaultdict(list)
    for e in book:
        by[e["d"]].append(e)
    labeled: list[dict] = []
    n_book = 0
    n_joinable = 0
    for d, g in by.items():
        if len(g) < MIN_NAMES:
            continue
        n_keep = max(1, len(g) // 3)
        ranked = sorted(g, key=lambda e: (-e["score"], e["t"]))
        top = {id(e) for e in ranked[:n_keep]}
        for e in g:
            n_book += 1
            if e["t"] in tick_set:
                n_joinable += 1
            labeled.append({
                "t": e["t"], "d": e["d"],
                "top": id(e) in top,
                "bp_wk": float(e["pnl"]) * 1e4,
                "in_bars": e["t"] in tick_set,
            })
    cov = (n_joinable / n_book) if n_book else 0.0
    out = []
    for sname, entry in signals.items():
        keys = _signal_entry_keys(entry, dates, tickers)
        cells = {
            ("top", True): [], ("top", False): [],
            ("rest", True): [], ("rest", False): [],
        }
        for e in labeled:
            if not e["in_bars"]:
                continue
            tier = "top" if e["top"] else "rest"
            sig = (e["t"], e["d"]) in keys
            cells[(tier, sig)].append(e)
        def cell_stat(rows: list[dict]) -> dict:
            if not rows:
                return {"n": 0, "bp_wk": float("nan")}
            bps = [r["bp_wk"] for r in rows if np.isfinite(r["bp_wk"])]
            return {"n": len(bps), "bp_wk": float(np.mean(bps)) if bps else float("nan")}
        top_sig, top_nos = cells[("top", True)], cells[("top", False)]
        st_ts, st_tn = cell_stat(top_sig), cell_stat(top_nos)
        added = (st_ts["bp_wk"] - st_tn["bp_wk"]
                 if np.isfinite(st_ts["bp_wk"]) and np.isfinite(st_tn["bp_wk"])
                 else float("nan"))
        # month-clustered t on (signal − month mean of top-tier no-signal)
        nos_by_m: dict[tuple[int, int], list[float]] = defaultdict(list)
        for r in top_nos:
            if np.isfinite(r["bp_wk"]):
                nos_by_m[(r["d"].year, r["d"].month)].append(r["bp_wk"])
        nos_m = {k: float(np.mean(v)) for k, v in nos_by_m.items()}
        yms, diffs = [], []
        for r in top_sig:
            if not np.isfinite(r["bp_wk"]):
                continue
            ym = (r["d"].year, r["d"].month)
            if ym not in nos_m:
                continue
            yms.append(ym)
            diffs.append(r["bp_wk"] - nos_m[ym])
        added_t = _month_cluster_t_vals(yms, diffs)
        out.append({
            "signal": sname, "join_cov": cov,
            "top_sig": st_ts, "top_nosig": st_tn,
            "rest_sig": cell_stat(cells[("rest", True)]),
            "rest_nosig": cell_stat(cells[("rest", False)]),
            "added_bp": added, "added_t": added_t,
        })
    return out


def _regime_split_puts(pack, dates, tickers, o, c) -> list[dict]:
    """z10<-2.5 short h21 + pead short h21 under SPY>/<SMA200; n + month-clustered t."""
    ctx = _context_masks(pack, dates, tickers, c)
    rets = fwd_returns(o, c, 21)
    pead_e = load_pead_entry(dates, tickers)
    entries = {"z10<-2.5": _sig_z_variant(c, 10, -2.5), "pead": pead_e}
    out = []
    for sname, entry in entries.items():
        for reg in ("SPY>SMA200", "SPY<SMA200"):
            mask = ctx.get(reg)
            if mask is None:
                continue
            ent = entry & mask[:, None] & np.isfinite(rets)
            sel = (-1.0 * rets)[ent]
            n = int(sel.size)
            mean_bp = float(np.mean(sel) * 1e4) if n else float("nan")
            t = month_cluster_t(dates, -1.0 * rets, ent)
            out.append({"signal": f"{sname}/short/h21", "regime": reg,
                        "n": n, "t": t, "mean_bp": mean_bp})
    return out


def _write_puts_md(cells: list[dict], regime: list[dict], x22: list[dict], wall: float) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    day = date.today().isoformat()
    md = OUT_DIR / f"{day}-puts.md"
    ranked = sorted(
        [r for r in cells if r.get("n", 0) > 0 and np.isfinite(r.get("peer_ex_bp", np.nan))],
        key=lambda r: r["peer_ex_bp"], reverse=True,
    )
    rest = [r for r in cells if r not in ranked]
    L = [f"# Fast screen puts {day} (A341)",
         f"sell_put Δ{list(PUT_DELTAS)} DTE≈{PUT_DTE} {PUT_ENTRY}/{PUT_EXIT}; "
         f"collateral bp/wk; peers=same-day 20d-vol-decile LOO; wall={wall:.1f}s",
         "library: A339=triple_rsi5 ✓; A348 overnight/intraday/rsi_rotation ✓; "
         + ("A350 iv-wall daily ✓" if a350_iv_wall_daily_ok()
            else "A350: needs minute data, skipped"),
         "", "## Best cells (by peer excess bp/wk)"]
    for r in (ranked + rest)[:6]:
        if r.get("n", 0) == 0:
            L.append(f"- {r.get('signal','?')} Δ{r.get('delta')}: coverage "
                     f"{100*r.get('coverage',0):.1f}% n_sig={r.get('n_sig',0)} — {r.get('note','')}")
            continue
        L.append(
            f"- {r['signal']} Δ{r['delta']}: n={r['n']} cov={100*r['coverage']:.1f}% "
            f"bp/wk={r['bp_wk']:+.1f} peer_ex={r['peer_ex_bp']:+.1f} "
            f"win={100*r['win']:.0f}% worst_dec={r['worst_dec']:+.1f} t={r['t']:.2f} "
            f"tb={r['tbill_bp']:+.2f} | fit n={r['fit_n']} {r['fit_bp']:+.1f}bp t={r['fit_t']:.2f} "
            f"→ ho n={r['ho_n']} raw={r['ho_bp']:+.1f}bp t={r['ho_t']:.2f} "
            f"peer_ex={r.get('ho_peer_ex', float('nan')):+.1f}bp t={r.get('ho_peer_t', float('nan')):.2f}"
        )
    L += ["", "## Holdout peer excess (≥2025-01-01, Δ0.20)"]
    for r in cells:
        if r.get("delta") != 0.2 or r.get("n", 0) == 0:
            continue
        if r.get("signal") not in ("gap_up_5pct", "z50<-2.5/long"):
            continue
        L.append(
            f"- {r['signal']}: n={r['ho_n']} peer_ex={r.get('ho_peer_ex', float('nan')):+.1f} bp/wk "
            f"t={r.get('ho_peer_t', float('nan')):.2f} (raw {r['ho_bp']:+.1f}bp t={r['ho_t']:.2f})"
        )
    L += ["", "## Score×signal 2×2 (a352 champion top-third, Δ0.20 weeks)"]
    if x22:
        L.append(f"join coverage={100 * x22[0]['join_cov']:.1f}% (ticker in bar pack)")
    for x in x22:
        def fmt(c):
            return f"n={c['n']} {c['bp_wk']:+.1f}bp" if c["n"] else "n=0"
        L.append(
            f"- {x['signal']}: top∩sig {fmt(x['top_sig'])}; top∩nosig {fmt(x['top_nosig'])}; "
            f"rest∩sig {fmt(x['rest_sig'])}; rest∩nosig {fmt(x['rest_nosig'])}; "
            f"added_in_top={x['added_bp']:+.1f}bp/wk t={x['added_t']:.2f}"
        )
    L += ["", "## Regime (stock h21 short)"]
    for r in regime:
        L.append(f"- {r['signal']} {r['regime']}: n={r['n']} mean={r['mean_bp']:+.1f}bp t={r['t']:.2f}")
    md.write_text("\n".join(L[:40]) + "\n")
    return md


# ── report ───────────────────────────────────────────────────────────────────

def write_outputs(df: pd.DataFrame, cold_s: float, warm_s: float | None) -> tuple[Path, Path]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    day = date.today().isoformat()
    csv_p = OUT_DIR / f"{day}.csv"
    md_p = OUT_DIR / f"{day}.md"
    out_cols = [c for c in df.columns if not c.startswith("_")]
    df[out_cols].to_csv(csv_p, index=False)
    surv = df[df["survivor"] == True]  # noqa: E712
    best = df.iloc[0] if len(df) else None
    top10 = df.nlargest(10, "excess_bp_holdout", keep="all")
    notes = gap_contradiction_notes(df)
    for n in notes:
        print(n)
    L = [
        f"# Fast screen {day} (A341)",
        f"cold={cold_s:.1f}s warm={warm_s:.1f}s" if warm_s is not None else f"cold={cold_s:.1f}s",
        f"cells={len(df)} survivors={len(surv)} n_trials={int(df['n_trials'].iloc[0]) if len(df) else 0} "
        f"PBO={df['pbo'].iloc[0]:.3f}" if len(df) and np.isfinite(df['pbo'].iloc[0]) else f"cells={len(df)}",
        "",
        "## Best cell",
    ]
    if best is not None:
        L.append(
            f"- {best.strategy}/{best.side}/hold={best.hold}: holdout excess "
            f"{best.excess_bp_holdout:.1f}bp n={int(best.n_holdout)} t_fitval={best.t_fitval:.2f} "
            f"DSR={best.dsr:.3f} survivor={best.survivor}"
        )
    L += ["", "## Survivors"]
    if len(surv) == 0:
        L.append("- (none)")
    else:
        for _, r in surv.iterrows():
            L.append(
                f"- {r.strategy}/{r.side}/{r.hold}: excess {r.excess_bp_holdout:.1f}bp "
                f"t_fv={r.t_fitval:.2f} DSR={r.dsr:.3f}"
            )
    if notes:
        L += ["", "## Notes"]
        L.extend(f"- {n}" for n in notes)
    L += ["", "## Top 10 by holdout excess"]
    for _, r in top10.iterrows():
        L.append(
            f"- {r.strategy}/{r.side}/{r.hold}: {r.excess_bp_holdout:.1f}bp "
            f"n={int(r.n_holdout)} DSR={r.dsr:.3f}"
        )
    md_p.write_text("\n".join(L[:40]) + "\n")
    return csv_p, md_p


# ── A359 conditional engine (intraday condition sets + short puts) ─────────────

def run_conditional(tickers: list[str] | None, smoke: bool) -> dict:
    from conditional_engine import (  # noqa: WPS433
        jamie_example_spec,
        run_conditional_strategy,
        universe_tickers_from_db,
        write_report,
    )

    if tickers is None:
        tickers = universe_tickers_from_db(50 if smoke else None)
    entry, exits, inst = jamie_example_spec()
    payload = run_conditional_strategy(tickers, entry, exits, inst)
    tag = "jamie-smoke" if smoke else "jamie-universe"
    write_report(payload, tag)
    return payload


def conditional_self_test() -> list[str]:
    from conditional_engine import (  # noqa: WPS433
        ConditionSet,
        ExitRules,
        IndicatorCondition,
        PutInstrument,
        entry_cross_mask,
        nearest_listed_strike,
        simulate_session_puts,
        standard_listed_strikes,
    )

    lines: list[str] = []
    closes = np.array([50.0, 48.0, 44.0, 43.0, 46.0, 55.0, 52.0])
    entry = ConditionSet("or", [IndicatorCondition("rsi14", "lt", 20.0, "5m")])
    cross = entry_cross_mask(entry, closes)
    n_cross = int(cross.sum())
    lines.append(f"{'PASS' if n_cross <= 2 else 'FAIL'} entry cross count={n_cross} (expect sparse edges)")

    listed = standard_listed_strikes(100.0)
    k = nearest_listed_strike(99.2, listed)
    lines.append(f"{'PASS' if k in listed else 'FAIL'} nearest listed strike={k}")

    bars = pd.DataFrame({
        "o": [100, 99, 98, 99, 100, 101],
        "c": [100, 99, 98, 99, 100, 101],
        "session_date": [date.today()] * 6,
    })
    exits = ExitRules(take_profit_frac=0.5, time_stop="same_day")
    from conditional_engine import SpreadCalibration  # noqa: WPS433

    sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
    tr, _ = simulate_session_puts(
        bars, np.zeros(6, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
        instrument=PutInstrument(), spread=sp, force_entry_bar=0,
    )
    ok_la = tr and tr[0]["fill_bar"] > tr[0]["signal_bar"]
    lines.append(f"{'PASS' if ok_la else 'FAIL'} look-ahead fill_bar>{'signal_bar' if tr else '?'}")

    bars2 = pd.DataFrame({
        "o": [50, 49, 48, 47, 60, 60],
        "c": [50, 49, 48, 47, 60, 60],
        "session_date": [date.today()] * 6,
    })
    exits2 = ExitRules(
        close_conditions=[IndicatorCondition("rsi14", "gt", 50.0, "5m")],
        take_profit_frac=0.99,
        stop_loss_mult=2.0,
        time_stop="same_day",
    )
    tr2, _ = simulate_session_puts(
        bars2, np.array([False, False, True, False, False, False]),
        exits2, iv_anchor=30.0, iv_beta=-2.0, instrument=PutInstrument(),
        spread=sp, listed_strikes=[45.0, 47.5, 50.0], force_entry_bar=2,
    )
    reason = tr2[0]["exit_reason"] if tr2 else ""
    lines.append(f"{'PASS' if reason in ('close_condition', 'take_profit', 'stop_loss', 'time_stop') else 'FAIL'} "
                 f"first-hit exit={reason}")
    return lines


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="A341 fast screen")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_run = sub.add_parser("run")
    p_run.add_argument("--strategies", default="")
    p_run.add_argument("--tickers", default="")
    p_run.add_argument("--rebuild", action="store_true")
    p_run.add_argument("--skip-usecases", action="store_true")
    p_st = sub.add_parser("self-test")
    p_st.add_argument("--rebuild", action="store_true")
    p_puts = sub.add_parser("puts")
    p_puts.add_argument("--rebuild", action="store_true")
    p_cond = sub.add_parser("conditional")
    p_cond.add_argument("--tickers", default="")
    p_cond.add_argument("--smoke", action="store_true")
    p_cond.add_argument("--sweep", action="store_true", help="RSI threshold × exit frontier (A359 review)")
    p_cond.add_argument("--survivor-tail", action="store_true", help="tp50_overnight tail stats × RSI 5/30 (8 cells)")
    p_cond.add_argument("--index-oversold", action="store_true", help="S159 daily SPY/QQQ RSI oversold puts")
    p_cond.add_argument("--bench-a359", action="store_true", help="A369 legacy vs cached sweep wall time")
    p_cond.add_argument("--staging", action="store_true", help="A369 cost-aware staging chain 1h RSI<30")
    p_cond.add_argument("--leak-test", action="store_true", help="A369 leak test (planted + S159)")
    p_lens = sub.add_parser("lens", help="A369 per-stock threshold lens (S160 generalised)")
    p_lens.add_argument("--h", type=int, default=5)
    p_lens.add_argument("--gth", type=int, default=25, help="force global threshold")
    p_lens.add_argument("--notes", action="store_true", help="write stock notes (n>=3)")
    p_cself = sub.add_parser("conditional-self-test")
    args = ap.parse_args()

    if not a350_iv_wall_daily_ok():
        print("A350: needs minute data, skipped")

    if args.cmd == "self-test":
        t0 = time.perf_counter()
        pack = load_bars(["SPY", "QQQ"], rebuild=args.rebuild)
        lines = self_test(pack)
        for ln in lines:
            print(ln)
        print(f"self-test wall {time.perf_counter()-t0:.1f}s")
        return 0 if all(ln.startswith("PASS") for ln in lines) else 1

    if args.cmd == "puts":
        pack = load_bars(None, rebuild=args.rebuild)
        md = run_puts(pack)
        print(f"wrote {md}")
        return 0

    if args.cmd == "conditional-self-test":
        lines = conditional_self_test()
        for ln in lines:
            print(ln)
        return 0 if all(ln.startswith("PASS") for ln in lines) else 1

    if args.cmd == "lens":
        from threshold_lens import lens_rsi14_h5, write_stock_notes  # noqa: WPS433

        res = lens_rsi14_h5(args.gth)
        print(json.dumps({k: v for k, v in res.items() if k != "per_stock"}, default=str, indent=2))
        if args.notes:
            n = write_stock_notes(res.get("per_stock") or [], src="A369", author="cursor")
            print(f"notes_written={n}")
        return 0

    if args.cmd == "conditional":
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] or None
        if args.survivor_tail:
            from conditional_engine import (  # noqa: WPS433
                format_survivor_tail_table,
                run_survivor_tail_cells,
                universe_tickers_from_db,
                write_report,
            )

            if tickers is None:
                tickers = universe_tickers_from_db(50 if args.smoke else None)
            payload = run_survivor_tail_cells(tickers)
            write_report(payload, "survivor-tail-smoke" if args.smoke else "survivor-tail")
            print(format_survivor_tail_table(payload["survivor_tail"]))
            return 0
        if args.index_oversold:
            from conditional_engine import run_index_oversold_puts, write_report  # noqa: WPS433

            payload = run_index_oversold_puts()
            write_report(payload, "index-oversold-smoke" if args.smoke else "index-oversold")
            best = payload.get("best_rsi25") or {}
            print(json.dumps({
                "best": {k: v for k, v in best.items() if k != "worst_trade"},
                "n_events_rsi25": len(payload.get("events") or []),
            }, indent=2, default=str))
            return 0
        if args.bench_a359:
            from conditional_engine import A359_21_TICKERS, benchmark_threshold_sweep  # noqa: WPS433

            if tickers is None:
                tickers = A359_21_TICKERS
            bench = benchmark_threshold_sweep(tickers, smoke=args.smoke)
            print(json.dumps(bench, indent=2, default=str))
            return 0
        if args.staging:
            from conditional_engine import A359_21_TICKERS, run_a359_1h_rsi30_staging  # noqa: WPS433

            if tickers is None:
                tickers = A359_21_TICKERS
            out = run_a359_1h_rsi30_staging(tickers)
            print(out["formatted"])
            return 0
        if args.leak_test:
            from conditional_engine import run_conditional_leak_test  # noqa: WPS433

            print(json.dumps(run_conditional_leak_test(tickers), indent=2, default=str))
            return 0
        if args.sweep:
            from conditional_engine import (  # noqa: WPS433
                format_frontier_table,
                run_threshold_sweep,
                universe_tickers_from_db,
                write_report,
            )

            if tickers is None:
                tickers = universe_tickers_from_db(50 if args.smoke else None)
            payload = run_threshold_sweep(tickers, smoke=args.smoke)
            write_report(payload, "frontier-smoke" if args.smoke else "frontier")
            print(format_frontier_table(payload["frontier"]))
            frontier = payload.get("frontier") or []
            cond = [r for r in frontier if r.get("role") == "cond" and np.isfinite(r.get("net_mid_pnl_coll", float("nan")))]
            cond.sort(key=lambda r: r.get("net_mid_pnl_coll", -1e9), reverse=True)
            for r in cond[:5]:
                print(
                    f"leak top rsi<{r.get('rsi_lt')} {r.get('exit')} {r.get('window')}: "
                    f"shift_bp={r.get('shift_bp')} cov={r.get('shift_coverage')} "
                    f"placebo_p={r.get('placebo_p')} flag={r.get('leak_flag')} "
                    f"net_fill={r.get('net_fill_pnl_coll')}"
                )
            return 0
        payload = run_conditional(tickers, smoke=args.smoke)
        c = payload.get("conditional", {})
        b = payload.get("base", {})
        print(json.dumps({
            "n": c.get("n"), "win": c.get("win"), "mean_pnl_coll": c.get("mean_pnl_coll"),
            "mean_pnl_coll_gross": c.get("mean_pnl_coll_gross"),
            "lift": payload.get("lift_pnl_coll"), "exit_mix": c.get("exit_mix"),
            "base_n": b.get("n"), "wall_s": payload.get("wall_s"),
            "spread_n": (payload.get("spread_calibration") or {}).get("n_obs"),
        }, indent=2))
        return 0

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] or None
    strats = [s.strip() for s in args.strategies.split(",") if s.strip()] or None

    # run: cold then warm timing
    if CACHE.is_file() and not args.rebuild and tickers is None:
        CACHE.unlink()  # force cold
    t0 = time.perf_counter()
    pack = load_bars(tickers, rebuild=True)
    t_load_cold = time.perf_counter() - t0
    t1 = time.perf_counter()
    df = run_screen(pack, strats)
    t_screen = time.perf_counter() - t1
    cold = t_load_cold + t_screen
    # warm
    t2 = time.perf_counter()
    pack_w = load_bars(tickers, rebuild=False)
    df_w = run_screen(pack_w, strats)
    warm = time.perf_counter() - t2
    csv_p, md_p = write_outputs(df, cold, warm)
    print(f"cold={cold:.1f}s (load {t_load_cold:.1f}+screen {t_screen:.1f}) warm={warm:.1f}s")
    print(f"cells={len(df)} survivors={int(df.survivor.sum())} "
          f"PBO={df.pbo.iloc[0]:.3f} DSR_best={df.dsr.iloc[0]:.3f}")
    print(f"wrote {csv_p}")
    print(f"wrote {md_p}")
    if cold > 300:
        print(f"WARN cold {cold:.1f}s > 5 min")
    if warm > 60:
        print(f"WARN warm {warm:.1f}s > 60 s")

    if not args.skip_usecases and tickers is None:
        uc_md, uc_s = run_usecases(pack_w)
        print(f"usecases wall={uc_s:.1f}s wrote {uc_md}")
        if uc_s > 300:
            print(f"WARN usecases {uc_s:.1f}s > 5 min")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
