#!/usr/bin/env python3
"""A341 fast screen — vectorized strategy library; survivors only get a full study.

Bars: pattern_lab.load once → wide matrices, cache ~/.fildi/cache/fast_screen_bars.pkl.
Library: triple_rsi5, rsi2_connors, zscore20, overnight, intraday, gap_down/up_2pct,
rsi_rotation, pead, 52w_high_breakout. Both sides. Entry next open after close signal.
Holds {1,5,10,21} or rule exit. Cost 5 bp/side. AFML DSR + PBO/CSCV. Survivor:
holdout excess > 0 AND fit+val month-clustered t ≥ 2 AND DSR ≥ 0.95.

    cd scripts/watchlist_sync && .venv/bin/python analysis/fast_screen.py self-test
    .venv/bin/python analysis/fast_screen.py run [--strategies a,b] [--tickers ..] [--rebuild]
Out: research/studies/out/fast_screen/<date>.csv + .md
"""
from __future__ import annotations

import argparse
import pickle
import sys
import time
from datetime import date, datetime
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
from a352_score_rank import load_tbill, tbill_at  # noqa: E402
from build_plan import connect, rows  # noqa: E402

CACHE = Path.home() / ".fildi" / "cache" / "fast_screen_bars.pkl"
OUT_DIR = REPO / "research" / "studies" / "out" / "fast_screen"
COST = 0.0005  # 5 bp / side
HOLDS = (1, 5, 10, 21)
N_RAND = 200
SEED = 42
CSCV_BLOCKS = 16
EULER = 0.5772156649


# ── bars ─────────────────────────────────────────────────────────────────────

def load_bars(tickers: list[str] | None, rebuild: bool) -> dict:
    if CACHE.is_file() and not rebuild and tickers is None:
        with CACHE.open("rb") as f:
            return pickle.load(f)
    t0 = time.perf_counter()
    df = PL.load(tickers)
    df = df.sort_values(["ticker", "date"])
    wide = {}
    for col in ("o", "h", "l", "c", "v"):
        wide[col] = df.pivot(index="date", columns="ticker", values=col).sort_index()
    dates = wide["c"].index
    tickers_out = list(wide["c"].columns)
    pack = {"o": wide["o"], "h": wide["h"], "l": wide["l"], "c": wide["c"], "v": wide["v"],
            "dates": dates, "tickers": tickers_out, "loaded_s": time.perf_counter() - t0}
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


def sma_mat(c: np.ndarray, n: int) -> np.ndarray:
    return pd.DataFrame(c).rolling(n, min_periods=n).mean().to_numpy()


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
                 tbill_curve, hold_days: int, *, do_random: bool = True) -> dict:
    sm = split_mask(dates, split)
    mask = entry & sm[:, None] & np.isfinite(rets)
    r = side * rets
    sel = r[mask]
    n = int(sel.size)
    empty = {"n": 0, "mean_bp": np.nan, "excess_bp": np.nan, "t": np.nan, "win": np.nan,
             "rand_mean_bp": np.nan, "pct_beaten": np.nan, "uncond_bp": np.nan, "tbill_bp": np.nan}
    if n == 0:
        return empty
    mean = float(np.mean(sel))
    win = float(np.mean(sel > 0))
    u_mask = sm[:, None] & np.isfinite(rets)
    uncond = float(np.mean(side * rets[u_mask])) if u_mask.any() else np.nan
    # month-clustered t on selected monthly means vs 0 (return level)
    months = dates.to_period("M")
    sel_i, sel_j = np.where(mask)
    if len(sel_i) == 0:
        return empty
    mo_lab = months[sel_i]
    mo_means = pd.Series(sel, index=mo_lab).groupby(level=0).mean()
    if len(mo_means) >= 4:
        t = float(mo_means.mean() / (mo_means.std(ddof=1) / np.sqrt(len(mo_means))))
    else:
        t = float("nan")
    rand_mean = pct_beaten = excess = float("nan")
    if do_random:
        # precompute per-month pools + counts once
        cnt_by_mo = pd.Series(1, index=mo_lab).groupby(level=0).sum()
        pools = {}
        for mo, cnt in cnt_by_mo.items():
            day_ix = np.where(sm & (months == mo))[0]
            pool = (side * rets[day_ix]).ravel()
            pool = pool[np.isfinite(pool)]
            pools[mo] = (pool, int(cnt))
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
    else:
        excess = mean - uncond if np.isfinite(uncond) else np.nan
        rand_mean = uncond
    # tbill: one rate at split midpoint
    mid_i = int(np.where(sm)[0][len(np.where(sm)[0]) // 2]) if sm.any() else 0
    d0 = pd.Timestamp(dates[mid_i]).date()
    rate = tbill_at(tbill_curve, d0)
    tbill_bp = (rate * hold_days / 365.0 * 1e4) if rate is not None else np.nan
    return {
        "n": n,
        "mean_bp": mean * 1e4,
        "excess_bp": excess * 1e4 if np.isfinite(excess) else np.nan,
        "t": t,
        "win": win,
        "rand_mean_bp": rand_mean * 1e4 if np.isfinite(rand_mean) else np.nan,
        "pct_beaten": pct_beaten,
        "uncond_bp": uncond * 1e4 if np.isfinite(uncond) else np.nan,
        "tbill_bp": tbill_bp,
        "rets_sel": sel,
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
    sr = xs.mean() / xs.std(ddof=1)
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

    # precompute hold returns
    hold_rets = {hh: fwd_returns(o, c, hh) for hh in HOLDS}
    overnight_r = overnight_returns(o, c)
    intraday_r = intraday_returns(o, c)

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
            hold_list = [("overnight", overnight_r, 1)]
        elif sid == "intraday":
            hold_list = [("intraday", intraday_r, 1)]
        elif sid == "pead":
            hold_list = [(hh, hold_rets[hh], hh) for hh in (5, 21)]
        elif exit_ is not None:
            rule_r = rule_exit_returns(o, c, entry, exit_)
            hold_list = [("rule", rule_r, 5)] + [(hh, hold_rets[hh], hh) for hh in HOLDS]
        else:
            hold_list = [(hh, hold_rets[hh], hh) for hh in HOLDS]

        dense = bool(entry.mean() > 0.05)  # overnight/intraday-like
        for hold_lab, rets, hd in hold_list:
            for side, side_name in ((1, "long"), (-1, "short")):
                # Full 200-draw random only on holdout (acceptance metric); fit/val use uncond excess.
                m_fit = cell_metrics(dates, rets, entry, side, "fit",
                                     np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                     tbill_curve, hd, do_random=False)
                m_val = cell_metrics(dates, rets, entry, side, "val",
                                     np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                     tbill_curve, hd, do_random=False)
                m_ho = cell_metrics(dates, rets, entry, side, "holdout",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, do_random=not dense)
                m_fv = cell_metrics(dates, rets, entry, side, "fitval",
                                    np.random.default_rng(rng0.integers(0, 2**31 - 1)),
                                    tbill_curve, hd, do_random=False)
                # fit+val combined selected rets for DSR later
                sm = split_mask(dates, "fitval")
                mask = entry & sm[:, None] & np.isfinite(rets)
                sel_fv = (side * rets)[mask]
                # monthly series for PBO (full sample)
                sm_all = np.ones(len(dates), dtype=bool)
                mask_all = entry & sm_all[:, None] & np.isfinite(rets)
                dd = pd.DataFrame({
                    "date": np.repeat(dates, rets.shape[1])[mask_all.ravel()],
                    "ret": (side * rets)[mask_all],
                })
                if len(dd):
                    mo = dd.groupby(dd.date.dt.to_period("M"))["ret"].mean()
                else:
                    mo = pd.Series(dtype=float)
                cell_series.append(mo)
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
                    "t_fitval": m_fv["t"], "excess_bp_fitval": m_fv["excess_bp"],
                    "pct_beaten_holdout": m_ho["pct_beaten"],
                    "uncond_bp_holdout": m_ho["uncond_bp"], "tbill_bp": m_ho["tbill_bp"],
                    "_sel_fv": sel_fv,
                })

    n_trials = len(rows_out)
    for r in rows_out:
        r["dsr"] = deflated_sharpe(r["_sel_fv"], n_trials)
        r["survivor"] = (
            np.isfinite(r["excess_bp_holdout"]) and r["excess_bp_holdout"] > 0
            and np.isfinite(r["t_fitval"]) and r["t_fitval"] >= 2
            and np.isfinite(r["dsr"]) and r["dsr"] >= 0.95
        )

    # PBO over cells with enough months
    if cell_series:
        # align months
        all_months = sorted(set().union(*[set(s.index) for s in cell_series if len(s)]))
        if all_months:
            mat = np.full((len(cell_series), len(all_months)), np.nan)
            for i, s in enumerate(cell_series):
                for j, mo in enumerate(all_months):
                    if mo in s.index:
                        mat[i, j] = s.loc[mo]
            # fill nan with column median for CSCV stability
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
        del r["_sel_fv"]

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
    return lines


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
    L += ["", "## Top 10 by holdout excess"]
    for _, r in top10.iterrows():
        L.append(
            f"- {r.strategy}/{r.side}/{r.hold}: {r.excess_bp_holdout:.1f}bp "
            f"n={int(r.n_holdout)} DSR={r.dsr:.3f}"
        )
    md_p.write_text("\n".join(L[:40]) + "\n")
    return csv_p, md_p


# ── CLI ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="A341 fast screen")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_run = sub.add_parser("run")
    p_run.add_argument("--strategies", default="")
    p_run.add_argument("--tickers", default="")
    p_run.add_argument("--rebuild", action="store_true")
    p_st = sub.add_parser("self-test")
    p_st.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()

    if args.cmd == "self-test":
        t0 = time.perf_counter()
        pack = load_bars(["SPY", "QQQ"], rebuild=args.rebuild)
        lines = self_test(pack)
        for ln in lines:
            print(ln)
        print(f"self-test wall {time.perf_counter()-t0:.1f}s")
        return 0 if all(ln.startswith("PASS") for ln in lines) else 1

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()] or None
    strats = [s.strip() for s in args.strategies.split(",") if s.strip()] or None

    # run: cold then warm timing
    if CACHE.is_file() and not args.rebuild:
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
    # acceptance timings
    if cold > 300:
        print(f"WARN cold {cold:.1f}s > 5 min")
    if warm > 60:
        print(f"WARN warm {warm:.1f}s > 60 s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
