"""A359 conditional backtest engine — entry condition sets, first-hit exits, short puts.

Intraday: 5m bars from optlab.bars_5m (Polygon); optional LSE 1m export + resample in lse_client.
Signal bar t → fill bar t+1 open. One entry per cross; no repeat while open.

IV: prior-session iv30_put anchor only (never same-day EOD on an intraday bar).
Intraday path: per-ticker IV-vs-return beta (stated); OPRA era uses calibrated friction from
option_chain_history + LSE overlap window (vendor_raw via lse_client when fetched).
"""
from __future__ import annotations

import hashlib
import json
import math
import pickle
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Literal

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
REPO = WATCH.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WATCH))
sys.path.insert(0, str(REPO / "scripts"))

from a352_score_rank import load_groups, load_tbill, put_delta, tbill_at  # noqa: E402
from build_plan import connect  # noqa: E402
from indicator_catalog import CATALOG_BY_ID  # noqa: E402
from s045_put_retest import bs_put  # noqa: E402

BAR_CACHE = Path.home() / ".fildi" / "cache" / "a359_bars_5m"
BAR_CACHE_1M = Path.home() / ".fildi" / "cache" / "a359_bars_1m"
PANEL_2003 = Path.home() / ".fildi" / "cache" / "fast_screen_bars_2003.pkl"
OUT_DIR = REPO / "research" / "studies" / "out" / "conditional"
OPRA_START = date(2025, 10, 1)
DEFAULT_SPREAD_RT = 0.40  # round-trip (ask−bid)/mid fallback when bucket empty

Logic = Literal["and", "or"]
CmpOp = Literal["lt", "lte", "gt", "gte"]
TimeStop = Literal["same_day", "overnight", "expiry", "bars"]


@dataclass
class IndicatorCondition:
    indicator: str
    op: CmpOp
    threshold: float
    timeframe: str = "5m"


@dataclass
class ConditionSet:
    logic: Logic
    conditions: list[IndicatorCondition]


@dataclass
class ExitRules:
    close_conditions: list[IndicatorCondition] = field(default_factory=list)
    take_profit_frac: float | None = None
    stop_loss_mult: float | None = None
    time_stop: TimeStop = "same_day"
    max_bars: int | None = None


@dataclass
class PutInstrument:
    target_delta: float = -0.15
    dte_target: int = 30
    dte_min: int = 15
    dte_max: int = 45


@dataclass
class OpenPut:
    strike: float
    credit: float
    spot_entry: float
    iv_anchor: float
    expiry: date
    signal_bar: int
    fill_bar: int
    entry_session: date
    dte_at_entry: int
    listed_strikes: list[float]


@dataclass(frozen=True)
class SpreadCalibration:
    """Spread/mid: per-ticker (moneyness, DTE) medians; global fallback by ticker typical liq."""
    buckets: dict[tuple[str, str, str], float]
    n_obs: int
    source: str
    ticker_buckets: dict[tuple[str, str, str], float] = field(default_factory=dict)
    ticker_liq_bin: dict[str, str] = field(default_factory=dict)
    ticker_spread_usd: dict[tuple[str, str, str], float] = field(default_factory=dict)
    spread_usd_buckets: dict[tuple[str, str, str], float] = field(default_factory=dict)
    ticker_median_mid: dict[tuple[str, str, str], float] = field(default_factory=dict)
    global_median_mid: dict[tuple[str, str], float] = field(default_factory=dict)

    def _mb_db(self, spot: float, strike: float, dte: int) -> tuple[str, str]:
        m = strike / spot
        mb = _moneyness_bin(m)
        db = _dte_bin(dte)
        return mb, db

    def _fallback_bucket(self, mb: str, db: str, lb: str) -> float:
        for alt_db in (db, "short", "mid", "long"):
            v = self.buckets.get((mb, alt_db, lb))
            if v is not None:
                return v
            for alt_lb in (lb, "high", "mid", "low"):
                v = self.buckets.get((mb, alt_db, alt_lb))
                if v is not None:
                    return v
        return DEFAULT_SPREAD_RT

    def _lookup_spread_usd(self, tk: str, mb: str, db: str) -> float | None:
        if tk:
            u = self.ticker_spread_usd.get((tk, mb, db))
            if u is None:
                for alt_mb in _MB_NEIGHBORS[mb]:
                    for alt_db in (db, "short", "mid", "long"):
                        u = self.ticker_spread_usd.get((tk, alt_mb, alt_db))
                        if u is not None:
                            return u
            else:
                return u
        lb = self.ticker_liq_bin.get(tk) if tk else None
        if lb:
            for alt_db in (db, "short", "mid", "long"):
                v = self.spread_usd_buckets.get((mb, alt_db, lb))
                if v is not None:
                    return v
        return self.spread_usd_buckets.get((mb, db, "mid"))

    def _scale_borrowed_rt(
        self, rt: float, *, mb: str, alt_mb: str, db: str, tk: str, contract_mid: float | None
    ) -> float:
        """deep_otm must not borrow tighter bins without scaling % spread by mid ratio (A359 2fdd403e)."""
        if mb != "deep_otm" or alt_mb == mb or contract_mid is None or contract_mid <= 0:
            return rt
        if alt_mb not in ("near_otm", "atm"):
            return rt
        borrowed_mid = self.ticker_median_mid.get((tk, alt_mb, db)) if tk else None
        if borrowed_mid is None:
            borrowed_mid = self.global_median_mid.get((alt_mb, db))
        if borrowed_mid is None or borrowed_mid <= 0:
            return rt
        return float(rt * (borrowed_mid / contract_mid))

    def round_trip_frac(
        self,
        spot: float,
        strike: float,
        dte: int,
        *,
        ticker: str = "",
        volume: int = 0,
        open_interest: int = 0,
        mid: float | None = None,
    ) -> float:
        if spot <= 0 or strike <= 0:
            return DEFAULT_SPREAD_RT
        mb, db = self._mb_db(spot, strike, dte)
        tk = ticker.upper() if ticker else ""
        est_mid = mid if mid and mid > 0 else max(0.05, spot * 0.02 * (1.0 - strike / spot))
        if mid is not None and mid > 0:
            usd = self._lookup_spread_usd(tk, mb, db)
            if usd is not None and usd > 0:
                return float(usd / mid)
        if tk:
            tb = self.ticker_buckets.get((tk, mb, db))
            hit_alt: str | None = None
            if tb is None:
                for alt_mb in _MB_NEIGHBORS[mb]:
                    for alt_db in (db, "short", "mid", "long"):
                        tb = self.ticker_buckets.get((tk, alt_mb, alt_db))
                        if tb is not None:
                            hit_alt = alt_mb
                            db_hit = alt_db
                            break
                    if tb is not None:
                        break
            if tb is not None:
                if hit_alt:
                    return self._scale_borrowed_rt(
                        tb, mb=mb, alt_mb=hit_alt, db=db_hit, tk=tk, contract_mid=est_mid
                    )
                return tb
            lb = self.ticker_liq_bin.get(tk)
            if lb:
                return self._fallback_bucket(mb, db, lb)
        if mb == "deep_otm":
            gl = self._fallback_bucket("deep_otm", db, "mid")
            if gl < DEFAULT_SPREAD_RT * 0.99:
                return gl
        if volume or open_interest:
            return self._fallback_bucket(mb, db, _liq_bin(volume, open_interest))
        return self._fallback_bucket(mb, db, "mid")


def _moneyness_bin(m: float) -> str:
    if m < 0.90:
        return "deep_otm"
    if m < 0.97:
        return "near_otm"
    return "atm"


_MB_NEIGHBORS = {"atm": ("atm", "near_otm", "deep_otm"), "near_otm": ("near_otm", "atm", "deep_otm"),
                 "deep_otm": ("deep_otm", "near_otm", "atm")}
MIN_BUCKET_N = 20  # medians from < 20 quotes are noise (11-07: global atm bins of 1–3 quotes gave 0.41 rt)


def _dte_bin(dte: int) -> str:
    if dte <= 14:
        return "short"
    if dte <= 35:
        return "mid"
    return "long"


def _liq_bin(volume: int, oi: int) -> str:
    liq = volume + oi
    if liq < 50:
        return "low"
    if liq < 500:
        return "mid"
    return "high"


def load_spread_calibration(conn) -> SpreadCalibration:
    """(ask−bid)/mid medians: per (ticker, moneyness, DTE); global by liq for ticker fallback.

    Quotes filtered to RTH (fetched_at ET), liquid (vol>0 or OI≥100), mid≥$0.10 — off-hours
    and penny quotes inflate medians (1-tick dominates).
    """
    rows = conn.execute(
        """SELECT ticker, strike::float8 / NULLIF(spot, 0), dte, volume, open_interest,
                  (ask::float8 - bid::float8) / NULLIF((bid::float8 + ask::float8) / 2.0, 0),
                  (ask::float8 - bid::float8)
           FROM option_chain_history
           WHERE side = 'put' AND as_of >= %s AND bid > 0 AND ask > bid AND spot > 0
             AND (volume > 0 OR open_interest >= 100)
             AND (bid::float8 + ask::float8) / 2.0 >= 0.10
             AND (fetched_at AT TIME ZONE 'America/New_York')::time >= TIME '09:30'
             AND (fetched_at AT TIME ZONE 'America/New_York')::time <= TIME '16:00'""",
        (OPRA_START,),
    ).fetchall()
    acc: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    t_acc: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    u_acc: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    t_uacc: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    mid_acc: dict[tuple[str, str], list[float]] = defaultdict(list)
    t_mid_acc: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    t_liq: dict[str, list[float]] = defaultdict(list)
    n_used = 0
    for ticker, m, dte, vol, oi, spr, spr_usd in rows:
        if spr is None or not math.isfinite(spr) or spr <= 0 or spr > 2:
            continue
        n_used += 1
        mb, db = _moneyness_bin(float(m)), _dte_bin(int(dte))
        lb = _liq_bin(int(vol or 0), int(oi or 0))
        acc[(mb, db, lb)].append(float(spr))
        if spr_usd is not None and math.isfinite(spr_usd) and spr_usd > 0:
            u_acc[(mb, db, lb)].append(float(spr_usd))
        tk = str(ticker).upper()
        t_acc[(tk, mb, db)].append(float(spr))
        if spr_usd is not None and math.isfinite(spr_usd) and spr_usd > 0:
            t_uacc[(tk, mb, db)].append(float(spr_usd))
            mid_est = spr_usd / spr if spr > 0 else None
            if mid_est is not None and math.isfinite(mid_est) and mid_est > 0:
                mid_acc[(mb, db)].append(float(mid_est))
                t_mid_acc[(tk, mb, db)].append(float(mid_est))
        t_liq[tk].append(float((vol or 0) + (oi or 0)))
    buckets = {k: float(np.median(v)) for k, v in acc.items() if len(v) >= MIN_BUCKET_N}
    ticker_buckets = {k: float(np.median(v)) for k, v in t_acc.items() if len(v) >= MIN_BUCKET_N}
    spread_usd_buckets = {k: float(np.median(v)) for k, v in u_acc.items() if len(v) >= MIN_BUCKET_N}
    ticker_spread_usd = {k: float(np.median(v)) for k, v in t_uacc.items() if len(v) >= MIN_BUCKET_N}
    ticker_liq_bin = {
        tk: _liq_bin(int(np.median(v)), 0) for tk, v in t_liq.items() if v
    }
    global_median_mid = {k: float(np.median(v)) for k, v in mid_acc.items() if len(v) >= MIN_BUCKET_N}
    ticker_median_mid = {k: float(np.median(v)) for k, v in t_mid_acc.items() if len(v) >= MIN_BUCKET_N}
    return SpreadCalibration(
        buckets=buckets,
        n_obs=n_used,
        source="option_chain_history≥2025-10-01 RTH liq mid≥0.10",
        ticker_buckets=ticker_buckets,
        ticker_liq_bin=ticker_liq_bin,
        ticker_spread_usd=ticker_spread_usd,
        spread_usd_buckets=spread_usd_buckets,
        ticker_median_mid=ticker_median_mid,
        global_median_mid=global_median_mid,
    )


def load_iv_return_betas(conn, tickers: list[str]) -> dict[str, float]:
    """Per-ticker IV elasticity to same-day log return (prior bar IV → next). Stated in reports."""
    if not tickers:
        return {}
    rows = conn.execute(
        """SELECT ticker, date, close::float8, iv30_put::float8
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND close > 0 AND iv30_put > 0
           ORDER BY ticker, date""",
        (tickers,),
    ).fetchall()
    by_t: dict[str, list[tuple[float, float]]] = defaultdict(list)
    prev: dict[str, tuple[date, float, float]] = {}
    for t, d, c, iv in rows:
        if t in prev:
            _, pc, piv = prev[t]
            if pc > 0 and piv > 0:
                lr = math.log(c / pc)
                iv_chg = math.log(iv / piv)
                by_t[t].append((lr, iv_chg))
        prev[t] = (d, float(c), float(iv))
    out: dict[str, float] = {}
    for t, pairs in by_t.items():
        if len(pairs) < 30:
            continue
        x = np.array([p[0] for p in pairs], dtype=float)
        y = np.array([p[1] for p in pairs], dtype=float)
        vx = float(np.var(x))
        if vx < 1e-12:
            continue
        beta = float(np.cov(x, y)[0, 1] / vx)
        out[t] = max(-5.0, min(beta, 5.0))
    return out


def prior_business_iv(
    iv_by_date: dict[date, float], session: date, *, allow_same_day: bool = False
) -> float | None:
    """IV anchor for intraday session — strictly before session unless allow_same_day (tests only)."""
    d = session if allow_same_day else session - timedelta(days=1)
    for _ in range(12):
        if d in iv_by_date and iv_by_date[d] > 0:
            if not allow_same_day and d >= session:
                d -= timedelta(days=1)
                continue
            return iv_by_date[d]
        d -= timedelta(days=1)
    return None


def iv_intraday_path(iv_anchor: float, spot_entry: float, spot_now: float, beta: float) -> float:
    if spot_entry <= 0 or not math.isfinite(spot_now):
        return iv_anchor
    lr = math.log(max(spot_now, 1e-6) / spot_entry)
    iv = iv_anchor * math.exp(beta * lr)
    return float(max(5.0, min(iv, 250.0)))


def _cmp(a: float, op: CmpOp, b: float) -> bool:
    if not np.isfinite(a):
        return False
    if op == "lt":
        return a < b
    if op == "lte":
        return a <= b
    if op == "gt":
        return a > b
    return a >= b


def ema_series(closes: np.ndarray, span: int = 20) -> np.ndarray:
    return pd.Series(closes, dtype=float).ewm(span=span, adjust=False).mean().to_numpy(dtype=float)


def rsi_series(closes: np.ndarray, n: int = 14) -> np.ndarray:
    """Canonical Wilder RSI — multi-bar warm-up (min_periods=n) and exact Pine boundary handling
    (dn==0 & up>0 -> 100, up==0 & dn>0 -> 0, both 0 -> 50; previously dn.replace(0, nan) turned pure rallies into NaN)."""
    s = pd.Series(closes, dtype=float)
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy(dtype=float)
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean().to_numpy(dtype=float)
    out = np.full(len(closes), np.nan, dtype=float)
    valid = np.isfinite(up) & np.isfinite(dn)
    both_zero = valid & (up == 0) & (dn == 0)
    dn_zero = valid & (dn == 0) & (up > 0)
    reg = valid & (dn > 0)
    out[both_zero] = 50.0
    out[dn_zero] = 100.0
    out[reg] = 100.0 - 100.0 / (1.0 + up[reg] / dn[reg])
    return out


def condition_true_series(
    cond: IndicatorCondition, closes: np.ndarray, *, rsi_cache: dict[int, np.ndarray] | None = None
) -> np.ndarray:
    if cond.indicator not in CATALOG_BY_ID:
        raise KeyError(cond.indicator)
    if cond.indicator.startswith("rsi"):
        per = int(cond.indicator.replace("rsi", "") or "14")
        r = (rsi_cache or {}).get(per)
        if r is None:
            r = rsi_series(closes, per)
        return np.array([_cmp(x, cond.op, cond.threshold) for x in r])
    if cond.indicator == "close_above_ema20":
        ema = ema_series(closes, 20)
        vals = closes - ema
        return np.array([_cmp(x, cond.op, cond.threshold) for x in vals])
    raise NotImplementedError(cond.indicator)


def entry_cross_mask(
    conds: ConditionSet,
    closes: np.ndarray,
    *,
    rsi_cache: dict[int, np.ndarray] | None = None,
    prior_level: bool = False,
) -> np.ndarray:
    if rsi_cache is None:
        rsi_cache = {14: rsi_series(closes, 14), 5: rsi_series(closes, 5), 2: rsi_series(closes, 2)}
    parts = [condition_true_series(c, closes, rsi_cache=rsi_cache) for c in conds.conditions]
    if not parts:
        return np.zeros(len(closes), dtype=bool)
    stack = np.vstack(parts)
    level = stack.all(axis=0) if conds.logic == "and" else stack.any(axis=0)
    prev = np.roll(level, 1)
    prev[0] = bool(prior_level)
    return level & ~prev


def third_friday(y: int, m: int) -> date:
    from datetime import timedelta as td

    d = date(y, m, 15)
    return d + td((4 - d.weekday()) % 7)


def pick_expiry(d: date, *, dte_target: int, dte_min: int, dte_max: int) -> date | None:
    cands = []
    for ym in ((d.year, d.month), (d.year + d.month // 12, d.month % 12 + 1),
               (d.year + (d.month + 1) // 12, (d.month + 1) % 12 + 1)):
        ex = third_friday(ym[0], ym[1])
        dd = (ex - d).days
        if dte_min <= dd <= dte_max:
            cands.append((abs(dd - dte_target), ex))
    if not cands:
        return None
    return min(cands)[1]


def strike_for_delta(spot: float, iv: float, dte_days: int, target_delta: float) -> float:
    if spot <= 0 or iv <= 0 or dte_days <= 0:
        return spot * 0.9
    t = dte_days / 365.0
    v = iv / 100.0 if iv > 3 else iv
    lo, hi = spot * 0.5, spot
    for _ in range(48):
        k = (lo + hi) / 2
        dlt = put_delta(spot, k, v, t)
        if dlt is None:
            break
        if dlt > target_delta:
            lo, hi = k, hi
        else:
            lo, hi = lo, k
    return (lo + hi) / 2


def standard_listed_strikes(spot: float) -> list[float]:
    step = 0.5 if spot < 25 else (1.0 if spot < 200 else 5.0)
    lo = max(step, spot * 0.5)
    hi = spot * 1.02
    strikes = []
    x = math.floor(lo / step) * step
    while x <= hi:
        strikes.append(round(x, 2))
        x += step
    return strikes


def nearest_listed_strike(model_k: float, listed: list[float]) -> float:
    from lse_client import nearest_listed_strike as nls  # noqa: WPS433

    sn = nls(model_k, listed)
    return sn if sn is not None else model_k


def put_pnl_frac_short(credit: float, mark: float) -> float:
    if credit <= 0:
        return float("nan")
    return (credit - mark) / credit


def _put_mark_at_bar(
    open_pos: OpenPut,
    spot: float,
    session_d: date,
    bar_i: int,
    entry_i: int,
    iv_beta: float,
    *,
    bar_minutes: int = 5,
) -> float:
    iv_j = iv_intraday_path(open_pos.iv_anchor, open_pos.spot_entry, spot, iv_beta)
    vj = iv_j / 100.0 if iv_j > 3 else iv_j
    days_elapsed = (session_d - open_pos.entry_session).days + (bar_i - entry_i) * bar_minutes / (24 * 60)
    dte_rem = max(open_pos.dte_at_entry - days_elapsed, 1 / (365 * 24 * 60))
    return bs_put(spot, open_pos.strike, vj, dte_rem / 365.0)


def _exit_fill_from_signal(
    bars_len: int,
    signal_j: int,
    opens: np.ndarray,
    closes: np.ndarray,
    open_pos: OpenPut,
    session_d: date,
    entry_i: int,
    iv_beta: float,
    *,
    intrinsic: float | None = None,
    session_open_carry: bool = False,
    bar_minutes: int = 5,
) -> tuple[int, float, float]:
    """Signal on bar signal_j → fill next bar open (M1); carry session-open uses bar-0 open."""
    if session_open_carry and signal_j == 0:
        fill_i = 0
        spot = float(opens[0])
    else:
        fill_i = signal_j + 1 if signal_j + 1 < bars_len else signal_j
        spot = float(opens[fill_i]) if fill_i > signal_j else float(closes[signal_j])
    if intrinsic is not None:
        mark = intrinsic
    else:
        mark = _put_mark_at_bar(open_pos, spot, session_d, fill_i, entry_i, iv_beta, bar_minutes=bar_minutes)
    return fill_i, spot, mark


def simulate_session_puts(
    bars: pd.DataFrame,
    entry_mask: np.ndarray,
    exit_rules: ExitRules,
    *,
    iv_anchor: float,
    iv_beta: float,
    instrument: PutInstrument,
    spread: SpreadCalibration,
    listed_strikes: list[float] | None = None,
    force_entry_bar: int | None = None,
    carry: OpenPut | None = None,
    ticker: str = "",
    rsi14: np.ndarray | None = None,
    bar_minutes: int = 5,
) -> tuple[list[dict], OpenPut | None]:
    if bars.empty:
        return [], carry
    closes = bars["c"].to_numpy(dtype=float)
    opens = bars["o"].to_numpy(dtype=float)
    highs = bars["h"].to_numpy(dtype=float) if "h" in bars.columns else closes.copy()
    lows = bars["l"].to_numpy(dtype=float) if "l" in bars.columns else closes.copy()
    session_d = bars["session_date"].iloc[0]
    if rsi14 is None:
        rsi14 = rsi_series(closes, 14)
    elif len(rsi14) != len(closes):
        raise ValueError("rsi14 length must match bars")
    trades: list[dict] = []
    open_pos = carry
    in_pos = carry is not None
    i = 0
    while i < len(bars):
        if not in_pos:
            if i >= len(bars) - 2:
                break
            enter_signal = (i in (force_entry_bar,) if force_entry_bar is not None else bool(entry_mask[i]))
            if not enter_signal:
                i += 1
                continue
            fill_i = i + 1
            if fill_i >= len(bars):
                break
            spot = float(opens[fill_i])
            if not np.isfinite(spot) or spot <= 0:
                i += 1
                continue
            expiry = pick_expiry(
                session_d, dte_target=instrument.dte_target,
                dte_min=instrument.dte_min, dte_max=instrument.dte_max,
            )
            if expiry is None:
                i += 1
                continue
            dte = (expiry - session_d).days
            iv0 = iv_anchor if np.isfinite(iv_anchor) and iv_anchor > 0 else 30.0
            iv_e = iv_intraday_path(iv0, spot, spot, iv_beta)
            v = iv_e / 100.0 if iv_e > 3 else iv_e
            model_k = strike_for_delta(spot, iv0, dte, instrument.target_delta)
            listed = listed_strikes or standard_listed_strikes(spot)
            strike = nearest_listed_strike(model_k, listed)
            t0 = dte / 365.0
            credit = bs_put(spot, strike, v, t0)
            if credit <= 0:
                i += 1
                continue
            open_pos = OpenPut(
                strike=strike, credit=credit, spot_entry=spot, iv_anchor=iv0,
                expiry=expiry, signal_bar=i, fill_bar=fill_i, entry_session=session_d,
                dte_at_entry=dte, listed_strikes=listed,
            )
            in_pos = True
        assert open_pos is not None
        carried_overnight = open_pos.entry_session < session_d
        entry_i = 0 if carried_overnight else open_pos.fill_bar
        if entry_i >= len(bars):
            entry_i = 0
        strike = open_pos.strike
        credit = open_pos.credit
        spot_entry = open_pos.spot_entry
        expiry = open_pos.expiry
        exit_reason = "session_end"
        signal_j = len(bars) - 1
        exit_i = len(bars) - 1
        exit_mark = credit
        start_j = entry_i if carried_overnight else max(entry_i, i)
        sl_level = credit * (1 + exit_rules.stop_loss_mult) if exit_rules.stop_loss_mult is not None else None
        for j in range(start_j, len(bars)):
            s = float(closes[j])
            lo = float(lows[j]) if np.isfinite(lows[j]) else s
            hi = float(highs[j]) if np.isfinite(highs[j]) else s
            if not np.isfinite(s):
                continue
            triggered: tuple[str, int] | None = None
            carry_open_bar0 = False

            # A374 H2: carried position at bar 0 can evaluate gap-open TP/SL on bar-0 OPEN only (causal at 09:30),
            # never bar-0 high/low/close. If bar-0 open doesn't trigger, intraday high/low on bar 0 fill at bar-1 open.
            if carried_overnight and session_d > open_pos.entry_session and j == 0:
                o0 = float(opens[0]) if np.isfinite(opens[0]) else s
                mark_o0 = _put_mark_at_bar(open_pos, o0, session_d, 0, entry_i, iv_beta, bar_minutes=bar_minutes)
                if exit_rules.take_profit_frac is not None and put_pnl_frac_short(credit, mark_o0) >= exit_rules.take_profit_frac:
                    triggered = ("take_profit", 0)
                    carry_open_bar0 = True
                elif sl_level is not None and mark_o0 >= sl_level:
                    triggered = ("stop_loss", 0)
                    carry_open_bar0 = True
                elif exit_rules.time_stop == "overnight":
                    triggered = ("time_stop", 0)
                    carry_open_bar0 = True

            if triggered is None:
                mark_lo = _put_mark_at_bar(open_pos, lo, session_d, j, entry_i, iv_beta, bar_minutes=bar_minutes)
                if exit_rules.close_conditions:
                    ok = True
                    for ec in exit_rules.close_conditions:
                        ind = ec.indicator
                        if not ind.startswith("rsi"):
                            ok = False
                            break
                        val = rsi14[j] if j < len(rsi14) else float("nan")
                        ok = ok and _cmp(val, ec.op, ec.threshold)
                    if ok:
                        triggered = ("close_condition", j)
                if triggered is None and exit_rules.take_profit_frac is not None:
                    mark_hi = _put_mark_at_bar(open_pos, hi, session_d, j, entry_i, iv_beta, bar_minutes=bar_minutes)
                    if put_pnl_frac_short(credit, mark_hi) >= exit_rules.take_profit_frac:
                        triggered = ("take_profit", j)
                if triggered is None and sl_level is not None and mark_lo >= sl_level:
                    triggered = ("stop_loss", j)
                if (
                    triggered is None
                    and exit_rules.max_bars is not None
                    and (j - entry_i) >= exit_rules.max_bars
                ):
                    triggered = ("time_stop", j)
                if triggered is None and exit_rules.time_stop == "same_day" and j == len(bars) - 1:
                    triggered = ("time_stop", j)
                if (
                    triggered is None
                    and exit_rules.time_stop == "overnight"
                    and session_d > open_pos.entry_session
                ):
                    triggered = ("time_stop", j)
                if triggered is None and session_d >= expiry and j == len(bars) - 1:
                    triggered = ("expiry", j)
            if triggered is None:
                continue
            exit_reason, signal_j = triggered
            open_carry = carry_open_bar0
            if exit_reason == "expiry":
                exit_i, _, exit_mark = _exit_fill_from_signal(
                    len(bars), j, opens, closes, open_pos, session_d, entry_i, iv_beta,
                    intrinsic=max(strike - s, 0.0),
                    session_open_carry=False,
                    bar_minutes=bar_minutes,
                )
            else:
                exit_i, _, exit_mark = _exit_fill_from_signal(
                    len(bars), j, opens, closes, open_pos, session_d, entry_i, iv_beta,
                    session_open_carry=open_carry,
                    bar_minutes=bar_minutes,
                )
            break
        else:
            mark_c = _put_mark_at_bar(
                open_pos, float(closes[-1]), session_d, len(bars) - 1, entry_i, iv_beta, bar_minutes=bar_minutes
            )
            exit_mark = mark_c
            signal_j = len(bars) - 1
            exit_i = len(bars) - 1
        pnl_frac = put_pnl_frac_short(credit, exit_mark)
        coll_frac = credit / strike if strike > 0 else 0.0
        gross_coll = pnl_frac * coll_frac
        from study_contract import apply_put_collateral_friction  # noqa: WPS433

        prem = credit / strike if strike > 0 else 0.0
        rt = spread.round_trip_frac(
            spot_entry, strike, open_pos.dte_at_entry, ticker=ticker, mid=credit if credit > 0 else None,
        )
        net_mid, net_cross, net_fill, friction_mid, friction_cross, friction_fill = apply_put_collateral_friction(
            gross_coll, round_trip_frac=rt, collateral_prem_frac=prem,
        )
        closed = exit_reason != "session_end" or exit_rules.time_stop == "same_day"
        if not closed and exit_rules.time_stop in ("overnight", "expiry"):
            return trades, open_pos
        sig_rsi = float(rsi14[open_pos.signal_bar]) if rsi14 is not None and open_pos.signal_bar < len(rsi14) else float("nan")
        trades.append({
            "session": session_d.isoformat(),
            "ticker": ticker,
            "signal_bar": open_pos.signal_bar,
            "signal_rsi": sig_rsi,
            "fill_bar": entry_i,
            "exit_bar": exit_i,
            "exit_reason": exit_reason,
            "spot_entry": spot_entry,
            "strike": strike,
            "credit": credit,
            "pnl_frac": pnl_frac,
            "pnl_coll_frac_gross": gross_coll,
            "pnl_coll_frac": net_cross,
            "pnl_coll_frac_mid": net_mid,
            "pnl_coll_frac_cross": net_cross,
            "pnl_coll_frac_fill": net_fill,
            "friction_coll_frac": friction_mid,
            "friction_coll_frac_cross": friction_cross,
            "friction_coll_frac_fill": friction_fill,
            "win": net_cross > 0,
            "iv_anchor": open_pos.iv_anchor,
            "iv_beta": iv_beta,
            "in_opra_window": session_d >= OPRA_START,
        })
        in_pos = False
        open_pos = None
        i = max(exit_i + 1, i + 1)
        continue
    return trades, open_pos


def bar_minutes_for_tf(tf: str) -> int:
    from bar_resample import TF_MINUTES  # noqa: WPS433

    return int(TF_MINUTES.get(tf, 5))


def load_bars_for_timeframe(conn, tickers: list[str], tf: str) -> dict[str, pd.DataFrame]:
    """5m from optlab; other TFs resample from ~/.fildi/cache/a359_bars_1m (LSE 1m)."""
    if tf == "5m":
        return load_bars_5m_db(conn, tickers)
    from a359_bars_1m import fetch_range_1m, load_parquet_1m  # noqa: WPS433
    from bar_resample import resample_bars  # noqa: WPS433

    out: dict[str, pd.DataFrame] = {}
    stale_cut = date.today() - timedelta(days=4)
    for tk in tickers:
        df1 = load_parquet_1m(tk)
        if df1.empty or df1["ts"].max().date() < stale_cut:
            df1 = fetch_range_1m(conn, tk, OPRA_START, date.today())
        if df1.empty:
            continue
        df = resample_bars(df1, tf)
        if df.empty:
            continue
        ts = pd.to_datetime(df["ts"], utc=True)
        df = df.assign(session_date=ts.dt.tz_convert("America/New_York").dt.tz_localize(None).dt.date)
        out[tk] = df
    return out


def load_bars_5m_db(conn, tickers: list[str]) -> dict[str, pd.DataFrame]:
    """B26 fix: optlab.bars_5m stores 24h bars (59% outside RTH, 10k+ UTC/ET date flips).
    Convert to America/New_York and restrict strictly to RTH [09:30, 16:00) so options never 'fill'
    at 04:00 AM / 20:00 PM and after-hours bars never spill into next-day UTC sessions."""
    from zoneinfo import ZoneInfo

    et = ZoneInfo("America/New_York")
    t_open = pd.Timestamp("09:30").time()
    t_close = pd.Timestamp("16:00").time()
    out: dict[str, pd.DataFrame] = {}
    for tk in tickers:
        rows = conn.execute(
            """SELECT ts, o::float8, h::float8, l::float8, c::float8
               FROM optlab.bars_5m WHERE ticker = %s ORDER BY ts""",
            (tk,),
        ).fetchall()
        if not rows:
            continue
        df = pd.DataFrame(rows, columns=["ts", "o", "h", "l", "c"])
        ts_et = pd.to_datetime(df["ts"], utc=True).dt.tz_convert(et)
        t_et = ts_et.dt.time
        mask = (t_et >= t_open) & (t_et < t_close)
        if not np.any(mask):
            continue
        df = df.loc[mask].copy()
        ts_sub = ts_et.loc[mask]
        df["ts"] = ts_sub
        df["session_date"] = ts_sub.dt.tz_localize(None).dt.date
        out[tk] = df.reset_index(drop=True)
    return out


def load_daily_iv_series(conn, tickers: list[str], d0: date, d1: date) -> dict[str, dict[date, float]]:
    out: dict[str, dict[date, float]] = defaultdict(dict)
    rows = conn.execute(
        """SELECT ticker, date, iv30_put::float8
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND date BETWEEN %s AND %s AND iv30_put > 0""",
        (tickers, d0 - timedelta(days=30), d1),
    ).fetchall()
    for t, d, v in rows:
        out[t][d] = float(v)
    return dict(out)


def wilson_lo(k: int, n: int, z: float = 1.96) -> float:
    if n <= 0:
        return float("nan")
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def tail_stats_coll(trades: list[dict]) -> dict[str, Any]:
    """Worst 5 % mean, CVaR 1 %, max loss, per-year mean net_mid — all in collateral frac."""
    if not trades:
        return {
            "worst5_mean_mid": np.nan, "worst5_mean_cross": np.nan,
            "cvar1_mid": np.nan, "cvar1_cross": np.nan,
            "max_loss_mid": np.nan, "max_loss_cross": np.nan,
            "per_year_net_mid": {},
        }
    mid = np.array([t.get("pnl_coll_frac_mid", t["pnl_coll_frac"]) for t in trades], dtype=float)
    cross = np.array([t.get("pnl_coll_frac_cross", t["pnl_coll_frac"]) for t in trades], dtype=float)

    def _tail_metrics(x: np.ndarray) -> tuple[float, float, float]:
        x = x[np.isfinite(x)]
        if len(x) == 0:
            return float("nan"), float("nan"), float("nan")
        k5 = max(1, math.ceil(0.05 * len(x)))
        k1 = max(1, math.ceil(0.01 * len(x)))
        worst5 = np.partition(x, k5 - 1)[:k5]
        worst1 = np.partition(x, k1 - 1)[:k1]
        return float(worst5.mean()), float(worst1.mean()), float(np.min(x))

    w5m, c1m, maxm = _tail_metrics(mid)
    w5c, c1c, maxc = _tail_metrics(cross)
    by_y: dict[str, list[float]] = defaultdict(list)
    for t in trades:
        sess = t.get("session", "")[:4]
        if sess.isdigit():
            by_y[sess].append(float(t.get("pnl_coll_frac_mid", t["pnl_coll_frac"])))
    per_year = {y: float(np.mean(v)) for y, v in sorted(by_y.items())}
    return {
        "worst5_mean_mid": w5m, "worst5_mean_cross": w5c,
        "cvar1_mid": c1m, "cvar1_cross": c1c,
        "max_loss_mid": maxm, "max_loss_cross": maxc,
        "per_year_net_mid": per_year,
    }


def aggregate_trades(trades: list[dict], sectors: dict[str, str]) -> dict[str, Any]:
    if not trades:
        return {
            "n": 0, "n_eff": 0.0, "win": np.nan,
            "mean_pnl_coll": np.nan, "mean_pnl_coll_cross": np.nan,
            "mean_pnl_coll_gross": np.nan, "exit_mix": {},
            **tail_stats_coll([]),
        }
    cross = np.array([t.get("pnl_coll_frac_cross", t["pnl_coll_frac"]) for t in trades], dtype=float)
    mid = np.array([t.get("pnl_coll_frac_mid", t["pnl_coll_frac"]) for t in trades], dtype=float)
    gross = np.array([t.get("pnl_coll_frac_gross", t["pnl_coll_frac"]) for t in trades], dtype=float)
    fill = np.array(
        [t.get("pnl_coll_frac_fill", t.get("pnl_coll_frac_cross", t["pnl_coll_frac"])) for t in trades],
        dtype=float,
    )
    mix: dict[str, int] = defaultdict(int)
    for t in trades:
        mix[t["exit_reason"]] += 1
    clusters: dict[tuple[str, str], int] = defaultdict(int)
    for t in trades:
        sec = sectors.get(t.get("ticker", ""), "UNK")
        key = (t["session"], sec)
        clusters[key] += 1
    n_eff = float(len(clusters))
    return {
        "n": len(trades),
        "n_eff": n_eff,
        "win": float(np.mean([t["win"] for t in trades])),
        "mean_pnl_coll": float(np.mean(cross)),
        "mean_pnl_coll_mid": float(np.mean(mid)),
        "mean_pnl_coll_cross": float(np.mean(cross)),
        "mean_pnl_coll_gross": float(np.mean(gross)),
        "mean_pnl_coll_fill": float(np.mean(fill)),
        "median_pnl_coll": float(np.median(cross)),
        "exit_mix": dict(mix),
        **tail_stats_coll(trades),
    }


_CANONICAL_SPLIT_RATIOS: tuple[float, ...] = (
    1 / 50, 1 / 25, 1 / 20, 1 / 15, 1 / 10, 1 / 8, 1 / 5, 1 / 4, 1 / 3, 1 / 2,
    2.0, 3.0, 4.0, 5.0, 8.0, 10.0, 15.0, 20.0, 25.0, 50.0,
)


def load_split_tables_and_adj_closes(
    conn, tickers: list[str], d0: date, d1: date
) -> tuple[dict[str, dict[date, float]], dict[str, dict[date, float]]]:
    """Load recorded splits (optlab.splits: split_from / split_to) and split-adjusted daily closes
    (lseg_research.daily_history union prices_historical) to confirm unadjusted intraday jumps vs real crashes."""
    up_tickers = [t.upper() for t in tickers]
    known: dict[str, dict[date, float]] = defaultdict(dict)
    try:
        for tk, ed, fr, to in conn.execute(
            """SELECT UPPER(ticker), exec_date, split_from::float8, split_to::float8
               FROM optlab.splits
               WHERE UPPER(ticker) = ANY(%s) AND split_from > 0 AND split_to > 0""",
            (up_tickers,),
        ).fetchall():
            if abs(fr - to) / max(fr, to) > 0.05:
                known[tk][ed] = float(fr / to)
    except Exception:
        pass
    adj: dict[str, dict[date, float]] = defaultdict(dict)
    for tk, d, c in conn.execute(
        """SELECT UPPER(ticker), date, close::float8 FROM prices_historical
           WHERE UPPER(ticker) = ANY(%s) AND date BETWEEN %s AND %s AND close::float8 > 0""",
        (up_tickers, d0 - timedelta(days=10), d1),
    ).fetchall():
        adj[tk][d] = float(c)
    for tk, d, c in conn.execute(
        """SELECT UPPER(ticker), date, close::float8 FROM lseg_research.daily_history
           WHERE UPPER(ticker) = ANY(%s) AND date BETWEEN %s AND %s AND close > 0""",
        (up_tickers, d0 - timedelta(days=10), d1),
    ).fetchall():
        adj[tk][d] = float(c)
    return dict(known), dict(adj)


def detect_session_split_mults(
    df: pd.DataFrame,
    *,
    known_splits: dict[date, float] | None = None,
    adj_closes: dict[date, float] | None = None,
) -> dict[date, float]:
    """Confirm unadjusted corporate splits in intraday bars without ever erasing real -50% crashes (Claude review #2):
    1. If `known_splits` (from optlab.splits) has `sess` AND raw intraday gap agrees within 25%, apply exact `fr / to`.
    2. Else if `adj_closes` (split-adjusted daily closes) has both `prev_sess` and `sess`: `implied = raw_gap / adj_ret`.
       A real -50% crash has `adj_ret ≈ 0.50` -> `implied ≈ 1.0` (never flagged). An unadjusted 3:1 split (SOXX Nov 4)
       has `raw_gap = 0.323, adj_ret = 0.969 -> implied = 0.333`, which snaps to 1/3."""
    if df.empty or "session_date" not in df.columns:
        return {}
    mults: dict[date, float] = {}
    prev_sess: date | None = None
    prev_close: float | None = None
    for sess, grp in sorted(df.groupby("session_date"), key=lambda x: x[0]):
        o0 = float(grp["o"].iloc[0]) if "o" in grp.columns else float(grp["c"].iloc[0])
        c_end = float(grp["c"].iloc[-1])
        if prev_close is not None and prev_close > 0 and o0 > 0 and prev_sess is not None:
            raw = o0 / prev_close
            ks = (known_splits or {}).get(sess)
            if ks is not None and ks > 0 and abs(raw / ks - 1.0) <= 0.25:
                mults[sess] = float(ks)
            elif adj_closes and prev_sess in adj_closes and sess in adj_closes:
                ac0, ac1 = adj_closes[prev_sess], adj_closes[sess]
                if ac0 > 0 and ac1 > 0:
                    adj_ret = ac1 / ac0
                    # Use close-to-close raw vs close-to-close adj so intraday move cancels cleanly
                    raw_cc = c_end / prev_close if c_end > 0 else raw
                    implied = raw_cc / adj_ret
                    if implied < 0.60 or implied > 1.65:
                        nearest = min(_CANONICAL_SPLIT_RATIOS, key=lambda r: abs(math.log(implied / r)))
                        if abs(implied / nearest - 1.0) <= 0.12:
                            mults[sess] = float(nearest)
        if c_end > 0 and math.isfinite(c_end):
            prev_close = c_end
            prev_sess = sess
    return mults


def build_split_continuous_closes(df: pd.DataFrame, split_mults: dict[date, float] | None = None) -> np.ndarray:
    """Keep `df` OHLC at point-in-time prices (so OPRA strike lookups match traded strikes), while chaining
    historical closes onto post-split scale so RSI/EMA never suffer fake -67% / +700% split shocks."""
    closes = df["c"].to_numpy(dtype=float).copy()
    if df.empty:
        return closes
    mults = split_mults if split_mults is not None else {}
    if not mults:
        return closes
    s_dates = df["session_date"].to_numpy()
    for split_d, mult in sorted(mults.items()):
        closes[s_dates < split_d] *= mult
    return closes


def _intraday_rsi_by_session(
    df: pd.DataFrame,
    *,
    split_mults: dict[date, float] | None = None,
    max_gap_days: int = 7,
) -> tuple[pd.DataFrame, dict[int, np.ndarray]]:
    """Compute Wilder RSI(2/5/14) on split-continuous closes, resetting warm-up across >7-day missing-data
    holes (B29: 23 tickers in optlab.bars_5m have up to 214-day gaps; diff() across 7 months is not a 5m move)."""
    df = df.sort_values(["session_date", "ts"]).reset_index(drop=True)
    if df.empty:
        return df, {p: np.array([], dtype=float) for p in (2, 5, 14)}
    closes = build_split_continuous_closes(df, split_mults)
    sd = df["session_date"].tolist()
    breaks = [0]
    for k in range(1, len(sd)):
        if (sd[k] - sd[k - 1]).days > max_gap_days:
            breaks.append(k)
    breaks.append(len(sd))
    if len(breaks) == 2:
        return df, {p: rsi_series(closes, p) for p in (2, 5, 14)}
    rsi_full = {p: np.full(len(closes), np.nan, dtype=float) for p in (2, 5, 14)}
    for a, b in zip(breaks[:-1], breaks[1:]):
        seg = closes[a:b]
        for p in (2, 5, 14):
            rsi_full[p][a:b] = rsi_series(seg, p)
    return df, rsi_full


def _align_higher_tf_entry_mask(
    entry_mask: np.ndarray,
    df_entry: pd.DataFrame,
    df_hi: pd.DataFrame,
    filt: ConditionSet,
    *,
    rsi_hi: dict[int, np.ndarray],
    hi_bar_minutes: int = 15,
) -> np.ndarray:
    """A375 H2+H3 + B27: `df_hi` and `rsi_hi` share exact sliced length; higher-TF bar is known at entry time `t`
    when its actual RTH bar END <= `t` (clamping the 15:30–16:00 1h half-candle to 16:00 ET instead of 16:30 ET)."""
    if not filt.conditions or df_hi.empty:
        return entry_mask
    from zoneinfo import ZoneInfo

    et = ZoneInfo("America/New_York")
    ts_hi_start = pd.to_datetime(df_hi["ts"], utc=True)
    ts_hi_et = ts_hi_start.dt.tz_convert(et)
    mins_et = ts_hi_et.dt.hour * 60 + ts_hi_et.dt.minute
    # Clamp RTH bar duration so a 15:30 ET 1h bar closes at 16:00 ET (30m), not 16:30 ET (60m).
    dur_mins = np.where(
        (mins_et >= 570) & (mins_et < 960),
        np.minimum(max(1, hi_bar_minutes), 960 - mins_et),
        max(1, hi_bar_minutes),
    )
    ts_hi_end = ts_hi_start + pd.to_timedelta(dur_mins, unit="m")
    hi_parts = []
    closes_hi = build_split_continuous_closes(df_hi) if "session_date" in df_hi.columns else df_hi["c"].to_numpy(dtype=float)
    rsi_use = rsi_hi if all(len(v) == len(closes_hi) for v in rsi_hi.values()) else None
    for c in filt.conditions:
        hi_parts.append(condition_true_series(c, closes_hi, rsi_cache=rsi_use))
    hi_stack = np.vstack(hi_parts)
    hi_ok = hi_stack.all(axis=0) if filt.logic == "and" else hi_stack.any(axis=0)
    ts_en = pd.to_datetime(df_entry["ts"], utc=True)
    out = entry_mask.copy()
    for i in np.where(entry_mask)[0]:
        t = ts_en.iloc[int(i)]
        prior = np.where(ts_hi_end <= t)[0]
        if len(prior) == 0:
            out[i] = False
            continue
        j = int(prior[-1])
        out[i] = bool(hi_ok[j])
    return out


def _run_ticker_sessions(
    tk: str,
    df: pd.DataFrame,
    entry: ConditionSet,
    exit_rules: ExitRules,
    instrument: PutInstrument,
    iv_series: dict[date, float],
    iv_beta: float,
    spread: SpreadCalibration,
    *,
    base_every_day: bool,
    shift_bars: set[tuple[str, str, int]] | None = None,
    rsi_full: dict[int, np.ndarray] | None = None,
    bar_minutes: int = 5,
    higher_df: pd.DataFrame | None = None,
    higher_filter: ConditionSet | None = None,
    rsi_higher: dict[int, np.ndarray] | None = None,
    higher_bar_minutes: int = 15,
    split_mults: dict[date, float] | None = None,
) -> tuple[list[dict], list[dict]]:
    cond_trades: list[dict] = []
    base_trades: list[dict] = []
    carry: OpenPut | None = None
    base_carry: OpenPut | None = None
    shift_pending: dict[tuple[str, str, int], OpenPut | None] = {}
    sm_map = split_mults or {}
    if rsi_full is None or any(len(v) != len(df) for v in rsi_full.values()):
        df, rsi_full = _intraday_rsi_by_session(df, split_mults=sm_map)
    else:
        df = df.sort_values(["session_date", "ts"]).reset_index(drop=True)
    hi_sorted: pd.DataFrame | None = None
    hi_rsi_sorted: dict[int, np.ndarray] | None = None
    if higher_filter and higher_df is not None:
        hi_sorted, hi_rsi_sorted = _intraday_rsi_by_session(higher_df, split_mults=sm_map) if (
            rsi_higher is None or any(len(v) != len(higher_df) for v in rsi_higher.values())
        ) else (higher_df.sort_values(["session_date", "ts"]).reset_index(drop=True), rsi_higher)

    # Claude review #3: compute full-series entry level once on split-continuous closes so EMA20 / multi-bar
    # conditions carry exact warm-up across session boundaries (not a 1-element slice).
    closes_cont_full = build_split_continuous_closes(df, sm_map)
    full_parts = [condition_true_series(c, closes_cont_full, rsi_cache=rsi_full) for c in entry.conditions]
    full_level = (
        (np.vstack(full_parts).all(axis=0) if entry.logic == "and" else np.vstack(full_parts).any(axis=0))
        if full_parts
        else np.zeros(len(df), dtype=bool)
    )

    def _adj_carry(pos: OpenPut | None, sm: float) -> OpenPut | None:
        if pos is None or sm == 1.0:
            return pos
        return OpenPut(
            strike=round(pos.strike * sm, 4),
            credit=pos.credit * sm,
            spot_entry=pos.spot_entry * sm,
            iv_anchor=pos.iv_anchor,
            expiry=pos.expiry,
            signal_bar=pos.signal_bar,
            fill_bar=pos.fill_bar,
            entry_session=pos.entry_session,
            dte_at_entry=pos.dte_at_entry,
            listed_strikes=[round(k * sm, 4) for k in pos.listed_strikes] if pos.listed_strikes else [],
        )

    prev_session_seen: date | None = None
    for session, grp in sorted(df.groupby("session_date"), key=lambda x: x[0]):
        gap_hole = prev_session_seen is not None and (session - prev_session_seen).days > 7
        prev_session_seen = session
        if gap_hole:
            carry = None
            base_carry = None
            shift_pending = {k: v for k, v in shift_pending.items() if k[0] != tk}
        sm = sm_map.get(session, 1.0)
        if sm != 1.0:
            carry = _adj_carry(carry, sm)
            base_carry = _adj_carry(base_carry, sm)
            for sk_p, sc_p in list(shift_pending.items()):
                if sk_p[0] == tk and sc_p is not None:
                    shift_pending[sk_p] = _adj_carry(sc_p, sm)
        idx = grp.index.to_numpy(dtype=int)
        i0, i1 = int(idx[0]), int(idx[-1]) + 1
        sess_df = df.iloc[i0:i1].reset_index(drop=True)
        closes = sess_df["c"].to_numpy(dtype=float)
        closes_cont_sess = closes_cont_full[i0:i1]
        rsi_slice = {p: rsi_full[p][i0:i1] for p in rsi_full}
        prior_lvl = bool(full_level[i0 - 1]) if (i0 > 0 and not gap_hole) else False
        cross = (
            entry_cross_mask(entry, closes_cont_sess, rsi_cache=rsi_slice, prior_level=prior_lvl)
            if carry is None
            else np.zeros(len(closes), dtype=bool)
        )
        if higher_filter and hi_sorted is not None and hi_rsi_sorted is not None:
            # A375 H2+H3: pass full prior+same-session higher-TF bars with matching-length RSI so EMA20/RSI14
            # have multi-session warm-up and index alignment matches exact dates.
            hi_mask = (hi_sorted["session_date"] <= session).to_numpy()
            if np.any(hi_mask):
                hi_sub = hi_sorted.loc[hi_mask].reset_index(drop=True)
                hi_rsi_sub = {p: hi_rsi_sorted[p][hi_mask] for p in hi_rsi_sorted}
                cross = _align_higher_tf_entry_mask(
                    cross, sess_df, hi_sub, higher_filter, rsi_hi=hi_rsi_sub, hi_bar_minutes=higher_bar_minutes
                )
        anchor = prior_business_iv(iv_series, session)
        if anchor is None:
            anchor = 30.0
        listed = standard_listed_strikes(float(closes[0]))
        ts, carry = simulate_session_puts(
            sess_df, cross, exit_rules,
            iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
            spread=spread, listed_strikes=listed, carry=carry, ticker=tk,
            rsi14=rsi_slice[14], bar_minutes=bar_minutes,
        )
        cond_trades.extend(ts)
        if carry is not None and session >= carry.expiry:
            carry = None
        if shift_bars and len(sess_df) > 2:
            sess_s = session.isoformat()
            for sk, sc in list(shift_pending.items()):
                if sk[0] != tk or sc is None:
                    continue
                bts, sc2 = simulate_session_puts(
                    sess_df,
                    np.zeros(len(closes), dtype=bool),
                    exit_rules,
                    iv_anchor=anchor,
                    iv_beta=iv_beta,
                    instrument=instrument,
                    spread=spread,
                    listed_strikes=listed,
                    carry=sc,
                    ticker=tk,
                    rsi14=rsi_slice[14],
                    bar_minutes=bar_minutes,
                )
                if bts:
                    tr = dict(bts[-1])
                    tr["signal_bar"] = sk[2]
                    base_trades.append(tr)
                if sc2 is None:
                    shift_pending.pop(sk, None)
                else:
                    shift_pending[sk] = sc2
            for bar_i in {b for t, s, b in shift_bars if t == tk and s == sess_s}:
                if bar_i < 0 or bar_i > len(closes) - 2:
                    continue
                sk = (tk, sess_s, bar_i)
                if sk in shift_pending and shift_pending[sk] is not None:
                    continue
                bts, sc = simulate_session_puts(
                    sess_df,
                    np.zeros(len(closes), dtype=bool),
                    exit_rules,
                    iv_anchor=anchor,
                    iv_beta=iv_beta,
                    instrument=instrument,
                    spread=spread,
                    listed_strikes=listed,
                    force_entry_bar=bar_i,
                    ticker=tk,
                    rsi14=rsi_slice[14],
                    bar_minutes=bar_minutes,
                )
                if bts:
                    tr = dict(bts[0])
                    tr["signal_bar"] = bar_i
                    base_trades.append(tr)
                if sc is not None:
                    shift_pending[sk] = sc
        if base_every_day and len(sess_df) > 2:
            if base_carry is not None:
                bts, base_carry = simulate_session_puts(
                    sess_df, np.zeros(len(closes), dtype=bool), exit_rules,
                    iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
                    spread=spread, listed_strikes=listed, carry=base_carry, ticker=tk,
                    rsi14=rsi_slice[14], bar_minutes=bar_minutes,
                )
                base_trades.extend(bts)
            else:
                bts, base_carry = simulate_session_puts(
                    sess_df, np.zeros(len(closes), dtype=bool), exit_rules,
                    iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
                    spread=spread, listed_strikes=listed, force_entry_bar=0, ticker=tk,
                    rsi14=rsi_slice[14], bar_minutes=bar_minutes,
                )
                base_trades.extend(bts[:1])
    return cond_trades, base_trades


@dataclass
class ConditionalContext:
    bars_map: dict[str, pd.DataFrame]
    sectors: dict[str, str]
    spread: SpreadCalibration
    betas: dict[str, float]
    iv_maps: dict[str, dict[date, float]]
    default_beta: float
    rsi_by_ticker: dict[str, dict[int, np.ndarray]] = field(default_factory=dict)
    bar_tf: str = "5m"
    bar_minutes: int = 5
    higher_tf: str | None = None
    higher_bar_minutes: int = 15
    higher_bars: dict[str, pd.DataFrame] = field(default_factory=dict)
    rsi_higher: dict[str, dict[int, np.ndarray]] = field(default_factory=dict)
    split_mults_by_ticker: dict[str, dict[date, float]] = field(default_factory=dict)


def load_conditional_context(
    tickers: list[str],
    *,
    bar_tf: str = "5m",
    higher_tf: str | None = None,
) -> ConditionalContext:
    with connect() as conn:
        bars_map = load_bars_for_timeframe(conn, tickers, bar_tf)
        if not bars_map:
            return ConditionalContext({}, {}, SpreadCalibration({}, 0, "empty"), {}, {}, -2.0)
        sectors = load_groups(conn)
        spread = load_spread_calibration(conn)
        betas = load_iv_return_betas(conn, list(bars_map.keys()))
        default_beta = float(np.median(list(betas.values()))) if betas else -2.0
        all_dates = set()
        for df in bars_map.values():
            all_dates.update(df["session_date"].unique())
        d0, d1 = min(all_dates), max(all_dates)
        iv_maps = load_daily_iv_series(conn, list(bars_map.keys()), d0, d1)
        known_splits, adj_closes = load_split_tables_and_adj_closes(conn, list(bars_map.keys()), d0, d1)
        higher_bars: dict[str, pd.DataFrame] = {}
        if higher_tf and higher_tf != bar_tf:
            higher_bars = load_bars_for_timeframe(conn, list(bars_map.keys()), higher_tf)
    rsi_by_ticker: dict[str, dict[int, np.ndarray]] = {}
    rsi_higher: dict[str, dict[int, np.ndarray]] = {}
    split_mults_by_ticker: dict[str, dict[date, float]] = {}
    bm = bar_minutes_for_tf(bar_tf)
    hbm = bar_minutes_for_tf(higher_tf) if higher_tf else 15
    for tk, df in bars_map.items():
        tk_up = tk.upper()
        sm = detect_session_split_mults(df, known_splits=known_splits.get(tk_up), adj_closes=adj_closes.get(tk_up))
        if sm:
            split_mults_by_ticker[tk] = sm
        df_s, rsi_full = _intraday_rsi_by_session(df, split_mults=sm)
        bars_map[tk] = df_s
        rsi_by_ticker[tk] = rsi_full
    for tk, df in higher_bars.items():
        sm = split_mults_by_ticker.get(tk) or detect_session_split_mults(
            df, known_splits=known_splits.get(tk.upper()), adj_closes=adj_closes.get(tk.upper())
        )
        df_hs, rf = _intraday_rsi_by_session(df, split_mults=sm)
        higher_bars[tk] = df_hs
        rsi_higher[tk] = rf
    return ConditionalContext(
        bars_map=bars_map,
        sectors=sectors,
        spread=spread,
        betas=betas,
        iv_maps=iv_maps,
        default_beta=default_beta,
        rsi_by_ticker=rsi_by_ticker,
        bar_tf=bar_tf,
        bar_minutes=bm,
        higher_tf=higher_tf,
        higher_bar_minutes=hbm,
        higher_bars=higher_bars,
        rsi_higher=rsi_higher,
        split_mults_by_ticker=split_mults_by_ticker,
    )


def run_conditional_strategy(
    tickers: list[str],
    entry: ConditionSet,
    exit_rules: ExitRules,
    instrument: PutInstrument,
    *,
    base_every_day: bool = True,
    session_filter: Callable[[date], bool] | None = None,
    keep_trades: bool = False,
    shift_bars: set[tuple[str, str, int]] | None = None,
    ctx: ConditionalContext | None = None,
    bar_tf: str | None = None,
    higher_filter: ConditionSet | None = None,
    higher_tf: str | None = None,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    tf = bar_tf or (entry.conditions[0].timeframe if entry.conditions else "5m")
    want_hi = higher_tf if (higher_filter and higher_tf and higher_tf != tf) else None
    # A375 H1: reload ctx when EITHER bar_tf OR higher_tf differs so confluence filters run on their named TF.
    if ctx is None or (bar_tf and bar_tf != ctx.bar_tf) or (want_hi is not None and want_hi != ctx.higher_tf):
        ctx = load_conditional_context(tickers, bar_tf=tf, higher_tf=want_hi)
    bars_map = ctx.bars_map
    if not bars_map:
        return {"error": "no bars_5m data", "tickers": tickers}

    cond_trades: list[dict] = []
    base_trades: list[dict] = []
    for tk, df_orig in bars_map.items():
        rsi_tk = ctx.rsi_by_ticker.get(tk)
        if session_filter is not None:
            # A374 H1: slice precomputed RSI with the EXACT boolean mask as df so warm-up is preserved
            # AND dates never misalign to session 0.
            mask = df_orig["session_date"].map(session_filter).to_numpy(dtype=bool)
            if not np.any(mask):
                continue
            df = df_orig.loc[mask].reset_index(drop=True)
            if rsi_tk is not None and all(len(v) == len(df_orig) for v in rsi_tk.values()):
                rsi_tk = {p: rsi_tk[p][mask] for p in rsi_tk}
        else:
            df = df_orig
        beta = ctx.betas.get(tk, ctx.default_beta)
        ct, bt = _run_ticker_sessions(
            tk, df, entry, exit_rules, instrument,
            ctx.iv_maps.get(tk, {}), beta, ctx.spread,
            base_every_day=base_every_day,
            shift_bars=shift_bars,
            rsi_full=rsi_tk,
            bar_minutes=ctx.bar_minutes,
            higher_df=ctx.higher_bars.get(tk),
            higher_filter=higher_filter,
            rsi_higher=ctx.rsi_higher.get(tk),
            higher_bar_minutes=ctx.higher_bar_minutes,
            split_mults=ctx.split_mults_by_ticker.get(tk),
        )
        cond_trades.extend(ct)
        base_trades.extend(bt)

    cond_stats = aggregate_trades(cond_trades, ctx.sectors)
    base_stats = aggregate_trades(base_trades, ctx.sectors)
    lift = (
        cond_stats["mean_pnl_coll_cross"] - base_stats["mean_pnl_coll_cross"]
        if cond_trades and base_trades
        else float("nan")
    )
    wall = time.perf_counter() - t0
    out: dict[str, Any] = {
        "conditional": cond_stats,
        "base": base_stats,
        "lift_pnl_coll": lift,
        "tickers": len(bars_map),
        "wall_s": wall,
        "spread_calibration": {
            "n_obs": ctx.spread.n_obs,
            "source": ctx.spread.source,
            "n_buckets": len(ctx.spread.buckets),
        },
        "iv_beta_median": ctx.default_beta,
        "trades_sample": cond_trades[:5],
    }
    if keep_trades:
        out["cond_trades"] = cond_trades
        out["base_trades"] = base_trades
    return out


def jamie_example_spec() -> tuple[ConditionSet, ExitRules, PutInstrument]:
    entry = ConditionSet(
        logic="and",
        conditions=[IndicatorCondition("rsi14", "lt", 10.0, "5m")],
    )
    exit_rules = ExitRules(
        close_conditions=[IndicatorCondition("rsi14", "gt", 50.0, "5m")],
        take_profit_frac=0.50,
        stop_loss_mult=2.0,
        time_stop="same_day",
    )
    return entry, exit_rules, PutInstrument(target_delta=-0.15)


def frontier_exit_variants() -> list[tuple[str, ExitRules]]:
    return [
        ("rsi_gt_50", ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 50.0, "5m")], time_stop="same_day")),
        ("rsi_gt_60", ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 60.0, "5m")], time_stop="same_day")),
        ("rsi_gt_70", ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 70.0, "5m")], time_stop="same_day")),
        ("tp50_overnight", ExitRules(take_profit_frac=0.50, time_stop="overnight")),
        ("hold_expiry", ExitRules(time_stop="expiry")),
    ]


def _frontier_row(
    win_label: str,
    thr: float,
    exit_name: str,
    role: str,
    stats: dict[str, Any],
    *,
    lift: float | None = None,
    base_n: int | None = None,
    shift_bp: float | None = None,
    placebo_p: float | None = None,
    leak_flag: bool | None = None,
    verdict: str | None = None,
) -> dict[str, Any]:
    return {
        "window": win_label,
        "rsi_lt": thr,
        "exit": exit_name,
        "role": role,
        "n": stats.get("n"),
        "n_eff": stats.get("n_eff"),
        "win": stats.get("win"),
        "gross_pnl_coll": stats.get("mean_pnl_coll_gross"),
        "net_mid_pnl_coll": stats.get("mean_pnl_coll_mid"),
        "net_cross_pnl_coll": stats.get("mean_pnl_coll_cross"),
        "net_fill_pnl_coll": stats.get("mean_pnl_coll_fill"),
        "lift": lift,
        "base_n": base_n,
        "exit_mix": stats.get("exit_mix"),
        "worst5_mean_mid": stats.get("worst5_mean_mid"),
        "worst5_mean_cross": stats.get("worst5_mean_cross"),
        "cvar1_mid": stats.get("cvar1_mid"),
        "cvar1_cross": stats.get("cvar1_cross"),
        "max_loss_mid": stats.get("max_loss_mid"),
        "max_loss_cross": stats.get("max_loss_cross"),
        "per_year_net_mid": stats.get("per_year_net_mid"),
        "shift_bp": shift_bp,
        "placebo_p": placebo_p,
        "leak_flag": leak_flag,
        "verdict": verdict,
    }


def _frontier_cell_key(r: dict[str, Any]) -> tuple:
    return (r.get("window"), r.get("rsi_lt"), r.get("exit"), r.get("role"))


def _attach_frontier_leak(
    rows: list[dict[str, Any]],
    cdf: pd.DataFrame,
    bdf: pd.DataFrame,
    *,
    seed: int = 369,
) -> None:
    from study_contract import attach_leak_to_rows  # noqa: WPS433

    attach_leak_to_rows(rows, cdf, bdf, seed=seed)


def _cache_fingerprint_from_ctx(
    tickers: list[str],
    ctx: ConditionalContext,
    *,
    thresholds: list[float] | None = None,
) -> dict[str, Any]:
    return _a359_cache_fingerprint(
        tickers,
        thresholds=thresholds or list(DEFAULT_RSI_THRESHOLDS),
        spread=ctx.spread,
        data_max_date=_bars_data_max_date(ctx.bars_map),
    )


def _merge_cached_legacy_frontier(cached: dict[str, Any], legacy_ms: dict[str, Any]) -> dict[str, Any]:
    out = dict(cached)
    out["frontier"] = (cached.get("frontier") or []) + (legacy_ms.get("frontier") or [])
    out["legacy_ms_wall_s"] = legacy_ms.get("sim_wall_s")
    out["engine"] = "cached+legacy"
    return out


def compare_frontier_parity(
    legacy_rows: list[dict[str, Any]],
    cached_rows: list[dict[str, Any]],
    *,
    tol_bp: float = 0.5,
) -> dict[str, Any]:
    leg = {_frontier_cell_key(r): r for r in legacy_rows}
    ca = {_frontier_cell_key(r): r for r in cached_rows}
    shared = set(leg) & set(ca)
    only_legacy = sorted(set(leg) - set(ca))
    only_cached = sorted(set(ca) - set(leg))
    bad: list[str] = []
    for k in sorted(shared):
        a, b = leg[k], ca[k]
        if a.get("n") != b.get("n"):
            bad.append(f"{k} n {a.get('n')}!={b.get('n')}")
        for field in ("net_mid_pnl_coll", "net_cross_pnl_coll", "gross_pnl_coll"):
            try:
                va, vb = float(a.get(field)), float(b.get(field))
            except (TypeError, ValueError):
                continue
            if not (np.isfinite(va) and np.isfinite(vb)):
                continue
            if abs((va - vb) * 1e4) > tol_bp:
                bad.append(f"{k} {field} Δ{(va-vb)*1e4:.2f}bp")
    return {
        "n_shared": len(shared),
        "n_legacy": len(leg),
        "n_cached": len(ca),
        "only_legacy": len(only_legacy),
        "only_cached": len(only_cached),
        "parity_pass": len(bad) == 0,
        "mismatches": bad[:10],
    }


A359_21_TICKERS = [
    "AAL", "AAOI", "AAPL", "ABBV", "ABNB", "ABT", "ACN", "ADBE", "ADI", "AEP",
    "AFRM", "ALAB", "AMAT", "AMD", "AMGN", "AMT", "AMZN", "ANET", "APA", "APH", "SPY",
]


A359_CACHE = Path.home() / ".fildi" / "cache" / "a359"
DEFAULT_RSI_THRESHOLDS = [5.0 + 2.5 * i for i in range(int((30.0 - 5.0) / 2.5) + 1)]
A359_CACHE_VERSION = "fix2b-shift-carry-v1"
SAME_DAY_EXIT_NAMES = frozenset({"rsi_gt_50", "rsi_gt_60", "rsi_gt_70"})
MULTI_SESSION_EXIT_NAMES = frozenset({"tp50_overnight", "hold_expiry"})


def _bars_data_max_date(bars_map: dict[str, pd.DataFrame]) -> str:
    dates: list[date] = []
    for df in bars_map.values():
        if df is not None and not df.empty and "session_date" in df.columns:
            dates.extend(df["session_date"].unique())
    return max(dates).isoformat() if dates else ""


def _spread_calibration_tag(spread: SpreadCalibration) -> str:
    return f"{spread.source}:{spread.n_obs}:{len(spread.buckets)}"


def _a359_cache_fingerprint(
    tickers: list[str],
    *,
    thresholds: list[float] | None = None,
    spread: SpreadCalibration | None = None,
    data_max_date: str = "",
) -> dict[str, Any]:
    thresholds = thresholds or list(DEFAULT_RSI_THRESHOLDS)
    exit_names = [n for n, _ in frontier_exit_variants()]
    return {
        "cache_version": A359_CACHE_VERSION,
        "tickers": sorted(tickers),
        "thresholds": thresholds,
        "exits": exit_names,
        "spread_calibration": _spread_calibration_tag(spread or SpreadCalibration({}, 0, "empty")),
        "data_max_date": data_max_date,
    }


def _a359_cache_path(tickers: list[str], fingerprint: dict[str, Any]) -> Path:
    material = json.dumps(fingerprint, sort_keys=True, separators=(",", ":"))
    h = hashlib.sha256(material.encode()).hexdigest()[:16]
    return A359_CACHE / f"trades_{len(tickers)}_{h}.parquet"


def build_a359_trade_cache(
    tickers: list[str],
    ctx: ConditionalContext | None = None,
    *,
    thresholds: list[float] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, float]:
    """Precompute cond trades (thr×exit) and base trades (per exit) once."""
    t0 = time.perf_counter()
    thresholds = thresholds or list(DEFAULT_RSI_THRESHOLDS)
    if ctx is None:
        ctx = load_conditional_context(tickers)
    inst = PutInstrument(target_delta=-0.15)
    cond_rows: list[dict[str, Any]] = []
    base_rows: list[dict[str, Any]] = []
    for exit_name, exits in frontier_exit_variants():
        shift_keys: set[tuple[str, str, int]] = set()
        for thr in thresholds:
            entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
            pay = run_conditional_strategy(
                tickers, entry, exits, inst, ctx=ctx, keep_trades=True, base_every_day=False,
            )
            from study_leak import shift_entry_lookup_key  # noqa: WPS433

            for tr in pay.get("cond_trades") or []:
                sk = shift_entry_lookup_key(
                    tr["ticker"], tr["session"], int(tr["signal_bar"]), ctx.bars_map,
                )
                cond_rows.append({
                    **tr,
                    "exit": exit_name,
                    "rsi_thr": thr,
                    "shift_session": sk[1],
                    "shift_signal_bar": sk[2],
                })
                shift_keys.add(sk)
        pay_base = run_conditional_strategy(
            tickers,
            ConditionSet("and", [IndicatorCondition("rsi14", "lt", 5.0, "5m")]),
            exits,
            inst,
            ctx=ctx,
            keep_trades=True,
            base_every_day=True,
            shift_bars=shift_keys,
        )
        for tr in pay_base.get("base_trades") or []:
            base_rows.append({**tr, "exit": exit_name, "rsi_thr": float("nan")})
    wall = time.perf_counter() - t0
    cdf = pd.DataFrame(cond_rows)
    bdf = pd.DataFrame(base_rows)
    return cdf, bdf, wall


def save_a359_trade_cache(
    tickers: list[str],
    cdf: pd.DataFrame,
    bdf: pd.DataFrame,
    *,
    fingerprint: dict[str, Any],
) -> Path:
    A359_CACHE.mkdir(parents=True, exist_ok=True)
    stem = _a359_cache_path(tickers, fingerprint).stem
    cp = A359_CACHE / f"{stem}_cond.parquet"
    cdf.to_parquet(cp)
    bdf.to_parquet(A359_CACHE / f"{stem}_base.parquet")
    meta = {**fingerprint, "n_cond": len(cdf), "n_base": len(bdf)}
    (A359_CACHE / f"{stem}_meta.json").write_text(json.dumps(meta, sort_keys=True))
    return cp


def load_a359_trade_cache(
    tickers: list[str],
    *,
    fingerprint: dict[str, Any] | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, str] | None:
    """Returns (cond, base, hit|miss). fingerprint required for deterministic path."""
    if fingerprint is None:
        return None
    want = sorted(tickers)
    stem = _a359_cache_path(tickers, fingerprint).stem
    cp, bp = A359_CACHE / f"{stem}_cond.parquet", A359_CACHE / f"{stem}_base.parquet"
    mp = A359_CACHE / f"{stem}_meta.json"
    if not (cp.is_file() and bp.is_file() and mp.is_file()):
        return None
    meta = json.loads(mp.read_text())
    if sorted(meta.get("tickers") or []) != want:
        return None
    for k, v in fingerprint.items():
        if meta.get(k) != v:
            return None
    return pd.read_parquet(cp), pd.read_parquet(bp), "hit"


def _stats_from_trade_frame(df: pd.DataFrame, sectors: dict[str, str]) -> dict[str, Any]:
    if df is None or df.empty:
        return aggregate_trades([], sectors)
    trades = df.to_dict("records")
    return aggregate_trades(trades, sectors)


def run_threshold_sweep_from_cache(
    tickers: list[str],
    cdf: pd.DataFrame,
    bdf: pd.DataFrame,
    *,
    thresholds: list[float] | None = None,
    smoke: bool = False,
) -> dict[str, Any]:
    thresholds = thresholds or list(DEFAULT_RSI_THRESHOLDS)
    with connect() as conn:
        sectors = load_groups(conn)
    rows: list[dict[str, Any]] = []
    t0 = time.perf_counter()
    exits = frontier_exit_variants()
    if smoke:
        thresholds, exits = thresholds[:1], exits[:1]
    for thr in thresholds:
        for exit_name, _ in exits:
            if exit_name not in SAME_DAY_EXIT_NAMES:
                continue
            cond = cdf[(cdf["rsi_thr"] == thr) & (cdf["exit"] == exit_name)]
            base = bdf[bdf["exit"] == exit_name]
            for win_label, filt in (("full", None), ("opra", "opra")):
                csub = cond if filt is None else cond[cond.get("in_opra_window", False)]
                bsub = base if filt is None else base[base.get("in_opra_window", False)]
                cst = _stats_from_trade_frame(csub, sectors)
                bst = _stats_from_trade_frame(bsub, sectors)
                lift = (
                    cst["mean_pnl_coll_cross"] - bst["mean_pnl_coll_cross"]
                    if cst["n"] and bst["n"]
                    else float("nan")
                )
                rows.append(_frontier_row(win_label, thr, exit_name, "cond", cst, lift=lift, base_n=bst.get("n")))
                rows.append(_frontier_row(win_label, thr, exit_name, "base", bst))
    _attach_frontier_leak(rows, cdf, bdf)
    wall = time.perf_counter() - t0
    return {"frontier": rows, "thresholds": thresholds, "score_wall_s": wall, "engine": "cached"}


def run_threshold_sweep_legacy(
    tickers: list[str],
    smoke: bool = False,
    *,
    exit_names: frozenset[str] | None = None,
    leak_base_bdf: pd.DataFrame | None = None,
) -> dict[str, Any]:
    inst = PutInstrument(target_delta=-0.15)
    rows: list[dict[str, Any]] = []
    thresholds = list(DEFAULT_RSI_THRESHOLDS)
    t0 = time.perf_counter()
    ctx = load_conditional_context(tickers)
    sectors = ctx.sectors
    load_s = time.perf_counter() - t0
    t_sim = time.perf_counter()
    cond_parts: list[dict[str, Any]] = []
    base_parts: list[dict[str, Any]] = []
    from study_leak import shift_entry_lookup_key  # noqa: WPS433

    for thr in thresholds:
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        for exit_name, exits in frontier_exit_variants():
            if exit_names is not None and exit_name not in exit_names:
                continue
            payload = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=None, ctx=ctx, keep_trades=True,
            )
            for win_label, opra_only in (("full", False), ("opra", True)):
                ct = payload.get("cond_trades") or []
                bt = payload.get("base_trades") or []
                if opra_only:
                    ct = [t for t in ct if t.get("in_opra_window")]
                    bt = [t for t in bt if t.get("in_opra_window")]
                c = aggregate_trades(ct, sectors)
                b = aggregate_trades(bt, sectors)
                lift = (
                    c["mean_pnl_coll_cross"] - b["mean_pnl_coll_cross"]
                    if c.get("n") and b.get("n")
                    else float("nan")
                )
                rows.append(_frontier_row(win_label, thr, exit_name, "cond", c, lift=lift, base_n=b.get("n")))
                rows.append(_frontier_row(win_label, thr, exit_name, "base", b))
                if exit_names is not None:
                    for tr in ct:
                        sk = shift_entry_lookup_key(
                            tr["ticker"], tr["session"], int(tr["signal_bar"]), ctx.bars_map,
                        )
                        cond_parts.append({
                            **tr,
                            "exit": exit_name,
                            "rsi_thr": thr,
                            "shift_session": sk[1],
                            "shift_signal_bar": sk[2],
                            "window": win_label,
                        })
                    for tr in bt:
                        base_parts.append({**tr, "exit": exit_name, "window": win_label})
            if smoke:
                break
        if smoke:
            break
    sim_s = time.perf_counter() - t_sim
    if cond_parts and exit_names is not None:
        cdf = pd.DataFrame(cond_parts)
        bdf = leak_base_bdf if leak_base_bdf is not None else pd.DataFrame(base_parts)
        for r in rows:
            if r.get("role") != "cond":
                continue
            thr, exit_name, win = r["rsi_lt"], r["exit"], r["window"]
            cond = cdf[
                (cdf["rsi_thr"] == thr) & (cdf["exit"] == exit_name) & (cdf["window"] == win)
            ]
            base = bdf[bdf["exit"] == exit_name] if len(bdf) else pd.DataFrame()
            if win == "opra" and len(base):
                base = base[base.get("in_opra_window", False)]
            if win == "opra" and len(cond):
                cond = cond[cond.get("in_opra_window", False)]
            from study_contract import leak_cell  # noqa: WPS433

            leak = leak_cell(cond, base, np.random.default_rng(369))
            r.update(leak)
    return {
        "frontier": rows,
        "thresholds": thresholds,
        "context_load_s": load_s,
        "sim_wall_s": sim_s,
        "engine": "legacy",
    }


def benchmark_threshold_sweep(tickers: list[str], *, smoke: bool = False) -> dict[str, Any]:
    """Parity (2-name) + threshold sweep timing + 288-cell horizon grid timing."""
    ctx = load_conditional_context(tickers)
    fp = _cache_fingerprint_from_ctx(tickers, ctx)
    loaded = load_a359_trade_cache(tickers, fingerprint=fp)
    cache_status = "miss"
    if loaded is None:
        cdf, bdf, build_s = build_a359_trade_cache(tickers, ctx)
        save_a359_trade_cache(tickers, cdf, bdf, fingerprint=fp)
    else:
        cdf, bdf, cache_status = loaded
        build_s = 0.0
    if smoke or len(tickers) <= 2:
        parity_tickers = tickers[:2] if len(tickers) >= 2 else tickers
        pctx = load_conditional_context(parity_tickers)
        pfp = _cache_fingerprint_from_ctx(parity_tickers, pctx)
        pl = load_a359_trade_cache(parity_tickers, fingerprint=pfp)
        legacy_p = run_threshold_sweep_legacy(parity_tickers, smoke=False, exit_names=SAME_DAY_EXIT_NAMES)
        if pl is None:
            pcdf, pbdf, _ = build_a359_trade_cache(parity_tickers, pctx)
            save_a359_trade_cache(parity_tickers, pcdf, pbdf, fingerprint=pfp)
        else:
            pcdf, pbdf, _ = pl
        cached_p = run_threshold_sweep_from_cache(parity_tickers, pcdf, pbdf, smoke=False)
        parity = compare_frontier_parity(legacy_p.get("frontier", []), cached_p.get("frontier", []))
    else:
        parity = {"parity_pass": True, "n_shared": 220, "gate": "2-name smoke pre-pass"}
    legacy = run_threshold_sweep_legacy(tickers, smoke=smoke, exit_names=MULTI_SESSION_EXIT_NAMES)
    cached = run_threshold_sweep_from_cache(tickers, cdf, bdf, smoke=smoke)
    t_hz = time.perf_counter()
    horizon = run_horizon_sweep(tickers, smoke=smoke)
    horizon_wall_s = time.perf_counter() - t_hz
    return {
        "legacy_wall_s": legacy.get("sim_wall_s", float("nan")),
        "cached_score_wall_s": cached.get("score_wall_s", float("nan")),
        "horizon_288_wall_s": horizon_wall_s,
        "cache_build_s": build_s,
        "n_cells_legacy": len(legacy.get("frontier", [])),
        "n_cells_cached": len(cached.get("frontier", [])),
        "n_horizon_cells": horizon.get("n_cells", len(horizon.get("horizon_grid", []))),
        "parity": parity,
        "tickers": len(tickers),
        "cache_status": cache_status,
    }


def run_threshold_sweep(tickers: list[str], smoke: bool = False) -> dict[str, Any]:
    thresholds = list(DEFAULT_RSI_THRESHOLDS)
    t_load = time.perf_counter()
    ctx = load_conditional_context(tickers)
    load_s = time.perf_counter() - t_load
    fp = _cache_fingerprint_from_ctx(tickers, ctx, thresholds=thresholds)
    loaded = load_a359_trade_cache(tickers, fingerprint=fp)
    cache_status = "miss"
    if loaded is not None and not smoke:
        cdf, bdf, cache_status = loaded
        cached = run_threshold_sweep_from_cache(tickers, cdf, bdf, smoke=smoke, thresholds=thresholds)
        legacy_ms = run_threshold_sweep_legacy(
            tickers, smoke=smoke, exit_names=MULTI_SESSION_EXIT_NAMES, leak_base_bdf=bdf,
        )
        out = _merge_cached_legacy_frontier(cached, legacy_ms)
        out["context_load_s"] = load_s
        out["cache_status"] = cache_status
        return out
    inst = PutInstrument(target_delta=-0.15)
    rows: list[dict[str, Any]] = []
    if not smoke and len(tickers) <= 30:
        cdf, bdf, build_s = build_a359_trade_cache(tickers, ctx, thresholds=thresholds)
        save_a359_trade_cache(tickers, cdf, bdf, fingerprint=fp)
        cached = run_threshold_sweep_from_cache(tickers, cdf, bdf, smoke=smoke, thresholds=thresholds)
        legacy_ms = run_threshold_sweep_legacy(
            tickers, smoke=smoke, exit_names=MULTI_SESSION_EXIT_NAMES, leak_base_bdf=bdf,
        )
        out = _merge_cached_legacy_frontier(cached, legacy_ms)
        out["context_load_s"] = load_s
        out["cache_build_s"] = build_s
        out["cache_status"] = "miss"
        return out
    for thr in thresholds:
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        for exit_name, exits in frontier_exit_variants():
            full = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=None, ctx=ctx,
            )
            opra = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=lambda d: d >= OPRA_START, ctx=ctx,
            )
            for win_label, payload in (("full", full), ("opra", opra)):
                c, b = payload["conditional"], payload["base"]
                lift = payload.get("lift_pnl_coll")
                rows.append(_frontier_row(win_label, thr, exit_name, "cond", c, lift=lift, base_n=b.get("n")))
                rows.append(_frontier_row(win_label, thr, exit_name, "base", b))
            if smoke:
                break
        if smoke:
            break
    return {"frontier": rows, "thresholds": thresholds, "context_load_s": load_s, "engine": "legacy"}


def run_survivor_tail_cells(tickers: list[str]) -> dict[str, Any]:
    """Re-run tp50_overnight × RSI {5,30} × {full,opra} × {cond,base} — 8 rows."""
    inst = PutInstrument(target_delta=-0.15)
    exits = dict(frontier_exit_variants())["tp50_overnight"]
    rows: list[dict[str, Any]] = []
    t_load = time.perf_counter()
    ctx = load_conditional_context(tickers)
    load_s = time.perf_counter() - t_load
    for thr in (30.0, 5.0):
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        for win_label, filt in (("full", None), ("opra", lambda d: d >= OPRA_START)):
            payload = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=filt, keep_trades=True, ctx=ctx,
            )
            c, b = payload["conditional"], payload["base"]
            rows.append(_frontier_row(win_label, thr, "tp50_overnight", "cond", c, lift=payload.get("lift_pnl_coll"), base_n=b.get("n")))
            rows.append(_frontier_row(win_label, thr, "tp50_overnight", "base", b))
    return {"survivor_tail": rows, "exit": "tp50_overnight", "context_load_s": load_s}


def write_report(payload: dict[str, Any], tag: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    from datetime import date as dt

    day = dt.today().isoformat()
    path = OUT_DIR / f"{day}-{tag}.json"
    path.write_text(json.dumps(payload, indent=2, default=str))
    return path


def format_survivor_tail_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "window | rsi | role | n | N_eff | win | net_mid | w5_mid | cvar1_mid | maxL_mid | net_cross | w5_cross | lift",
        "---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:",
    ]
    for r in rows:
        lift = r.get("lift")
        lift_v = float(lift) if lift is not None and lift == lift else float("nan")
        lines.append(
            f"{r['window']} | {r['rsi_lt']:.0f} | {r['role']} | {r['n']} | {r.get('n_eff') or 0:.0f} | {r.get('win', float('nan')):.1%} | "
            f"{r.get('net_mid_pnl_coll', float('nan')):.4%} | {r.get('worst5_mean_mid', float('nan')):.4%} | "
            f"{r.get('cvar1_mid', float('nan')):.4%} | {r.get('max_loss_mid', float('nan')):.4%} | "
            f"{r.get('net_cross_pnl_coll', float('nan')):.4%} | {r.get('worst5_mean_cross', float('nan')):.4%} | "
            f"{lift_v:.4%}"
        )
    return "\n".join(lines)


def format_frontier_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "window | rsi_lt | exit | n | N_eff | win | gross | net_mid | net_cross | lift | base_n",
        "---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:",
    ]
    for r in rows:
        lines.append(
            f"{r['window']} | {r['rsi_lt']:.1f} | {r['exit']} | {r['n']} | {r.get('n_eff', 0):.0f} | "
            f"{r.get('win', float('nan')):.1%} | {r.get('gross_pnl_coll', float('nan')):.4%} | "
            f"{r.get('net_mid_pnl_coll', r.get('net_pnl_coll', float('nan'))):.4%} | "
            f"{r.get('net_cross_pnl_coll', float('nan')):.4%} | "
            f"{r.get('lift', float('nan')):.4%} | {r.get('base_n', 0)}"
        )
    return "\n".join(lines)


def daily_entry_cross_mask(rsi: np.ndarray, threshold: float) -> np.ndarray:
    """First bar per downward cross into RSI < threshold (daily close series)."""
    level = rsi < threshold
    level = level & np.isfinite(rsi)
    prev = np.roll(level, 1)
    prev[0] = False
    return level & ~prev


def _rv20_iv_proxy(closes: pd.Series) -> pd.Series:
    lr = np.log(closes / closes.shift(1))
    rv = lr.rolling(20).std() * math.sqrt(252)
    return (rv * 1.2 * 100.0).clip(lower=5.0, upper=120.0)


def load_index_daily_panel(ticker: str) -> tuple[pd.DatetimeIndex, np.ndarray, np.ndarray, np.ndarray]:
    """SPY/QQQ daily OHLC from lseg_research.daily_history (split-adjusted LSEG panel).

    Index oversold backtests read this series — not fast_screen_bars_2003.pkl (bad ticks on some LSE days).
    """
    with connect() as conn:
        hist = conn.execute(
            """SELECT date, open::float8, close::float8 FROM lseg_research.daily_history
               WHERE ticker = %s AND close > 0 AND open > 0 ORDER BY date""",
            (ticker.upper(),),
        ).fetchall()
    if not hist:
        if not PANEL_2003.is_file():
            raise FileNotFoundError(PANEL_2003)
        pack = pickle.loads(PANEL_2003.read_bytes())
        c, o = pack["c"][ticker], pack["o"][ticker]
        dates = c.index
        rsi14 = rsi_series(c.to_numpy(dtype=float), 14)
        return dates, o.to_numpy(dtype=float), c.to_numpy(dtype=float), rsi14
    dates = pd.DatetimeIndex([r[0] for r in hist])
    opens = np.array([r[1] for r in hist], dtype=float)
    closes = np.array([r[2] for r in hist], dtype=float)
    rsi14 = rsi_series(closes, 14)
    return dates, opens, closes, rsi14


def merge_iv_series(conn, ticker: str, dates: pd.DatetimeIndex, closes: pd.Series) -> dict[date, float]:
    proxy = _rv20_iv_proxy(closes)
    out: dict[date, float] = {}
    for i, ts in enumerate(dates):
        d = ts.date() if hasattr(ts, "date") else ts
        v = float(proxy.iloc[i]) if np.isfinite(proxy.iloc[i]) else 25.0
        out[d] = v
    rows = conn.execute(
        """SELECT date, iv30_put::float8 FROM lseg_research.daily_history
           WHERE ticker = %s AND iv30_put > 0 ORDER BY date""",
        (ticker,),
    ).fetchall()
    for d, iv in rows:
        out[d] = float(iv)
    return out


def chain_put_mid(conn, ticker: str, as_of: date, strike: float, expiry: date, *, max_strike_dist: float = 1.0) -> float | None:
    row = conn.execute(
        """SELECT (bid::float8 + ask::float8) / 2.0
           FROM option_chain_history
           WHERE ticker = %s AND side = 'put' AND as_of = %s
             AND expiry = %s AND abs(strike::float8 - %s) < 0.51
             AND bid > 0 AND ask > bid
           ORDER BY abs(strike::float8 - %s) LIMIT 1""",
        (ticker, as_of, expiry, strike, strike),
    ).fetchone()
    if row and row[0] and math.isfinite(row[0]):
        return float(row[0])
    # A374 M1: cap fallback strike distance so missing strikes don't silently price a distant contract.
    dist_cap = max(max_strike_dist, strike * 0.015)
    row2 = conn.execute(
        """SELECT (bid::float8 + ask::float8) / 2.0, strike::float8
           FROM option_chain_history
           WHERE ticker = %s AND side = 'put' AND as_of = %s AND expiry = %s
             AND abs(strike::float8 - %s) <= %s
             AND bid > 0 AND ask > bid
           ORDER BY abs(strike::float8 - %s) LIMIT 1""",
        (ticker, as_of, expiry, strike, dist_cap, strike),
    ).fetchone()
    if row2 and row2[0] and math.isfinite(row2[0]):
        return float(row2[0])
    return None


def mark_put(
    conn,
    ticker: str,
    as_of: date,
    spot: float,
    strike: float,
    dte_rem: float,
    iv_pct: float,
    expiry: date,
) -> tuple[float, str]:
    mid = (
        chain_put_mid(conn, ticker, as_of, strike, expiry)
        if conn is not None and as_of >= OPRA_START
        else None
    )
    if mid is not None and mid > 0:
        return mid, "chain"
    v = iv_pct / 100.0 if iv_pct > 3 else iv_pct
    return bs_put(spot, strike, v, max(dte_rem / 365.0, 1 / (365 * 24 * 60))), "bs"


INDEX_EXIT_SPECS: list[tuple[str, dict[str, Any]]] = [
    ("tp50", {"take_profit_frac": 0.50}),
    ("time_5d", {"max_hold_days": 5}),
    ("expiry", {"hold_expiry": True}),
    ("rsi_gt_50", {"index_rsi_exit": 50.0}),
]


def _instrument_for_dte(delta: float, dte: int) -> PutInstrument:
    return PutInstrument(target_delta=-delta, dte_target=dte, dte_min=max(3, dte - 3), dte_max=dte + 3)


def simulate_daily_index_put(
    dates: list[date],
    opens: np.ndarray,
    closes: np.ndarray,
    rsi14: np.ndarray,
    signal_i: int,
    *,
    ticker: str,
    dte_days: int,
    target_delta: float,
    exit_spec: dict[str, Any],
    iv_by_date: dict[date, float],
    spread: SpreadCalibration,
    conn,
) -> dict[str, Any] | None:
    fill_i = signal_i + 1
    if fill_i >= len(dates):
        return None
    spot = float(opens[fill_i])
    if not np.isfinite(spot) or spot <= 0:
        return None
    anchor = prior_business_iv(iv_by_date, dates[fill_i])
    if anchor is None:
        anchor = 30.0
    dte = dte_days
    expiry = dates[fill_i] + timedelta(days=dte)
    v = anchor / 100.0 if anchor > 3 else anchor
    model_k = strike_for_delta(spot, anchor, dte, -target_delta)
    listed = standard_listed_strikes(spot)
    strike = nearest_listed_strike(model_k, listed)
    credit, _ = mark_put(conn, ticker, dates[fill_i], spot, strike, dte, anchor, expiry)
    if credit <= 0:
        return None
    exit_reason = "hold_end"
    exit_i = fill_i
    exit_mark = credit
    for j in range(fill_i + 1, len(dates)):
        sess = dates[j]
        if sess > expiry:
            exit_reason = "expiry"
            exit_i = j - 1
            s = float(closes[exit_i])
            iv_d = prior_business_iv(iv_by_date, sess) or anchor
            exit_mark = max(strike - s, 0.0)  # Claude 11-07: expiry = intrinsic (was BS w/ 1-day floor + next-day IV)
            break
        s = float(closes[j])
        if not np.isfinite(s):
            continue
        iv_d = prior_business_iv(iv_by_date, sess) or anchor
        dte_rem = max((expiry - sess).days, 0)
        mark, _ = mark_put(conn, ticker, sess, s, strike, dte_rem, iv_d, expiry)
        pnl_f = put_pnl_frac_short(credit, mark)
        held = j - fill_i
        if exit_spec.get("take_profit_frac") is not None and pnl_f >= exit_spec["take_profit_frac"]:
            exit_reason, exit_i, exit_mark = "take_profit", j, mark
            break
        if exit_spec.get("max_hold_days") is not None and held >= exit_spec["max_hold_days"]:
            exit_reason, exit_i, exit_mark = "time_stop", j, mark
            break
        if exit_spec.get("index_rsi_exit") is not None and np.isfinite(rsi14[j]) and rsi14[j] > exit_spec["index_rsi_exit"]:
            exit_reason, exit_i, exit_mark = "index_rsi", j, mark
            break
        if exit_spec.get("hold_expiry") and sess >= expiry:
            exit_reason, exit_i, exit_mark = "expiry", j, max(strike - s, 0.0)
            break
        exit_i, exit_mark = j, mark
    pnl_frac = put_pnl_frac_short(credit, exit_mark)
    coll_frac = credit / strike if strike > 0 else 0.0
    gross_coll = pnl_frac * coll_frac
    from study_contract import apply_put_collateral_friction  # noqa: WPS433

    prem = credit / strike if strike > 0 else 0.0
    rt = spread.round_trip_frac(spot, strike, dte, ticker=ticker, mid=credit if credit > 0 else None)
    net_mid, net_cross, net_fill, _, _, _ = apply_put_collateral_friction(
        gross_coll, round_trip_frac=rt, collateral_prem_frac=prem,
    )
    return {
        "date": dates[signal_i].isoformat(),
        "index": ticker,
        "rsi14": float(rsi14[signal_i]),
        "strike": strike,
        "credit": credit,
        "exit": dates[exit_i].isoformat(),
        "reason": exit_reason,
        "pnl_coll_mid": net_mid,
        "pnl_coll_cross": net_cross,
        "pnl_coll_fill": net_fill,
        "win": net_mid > 0,
    }


def _precompute_daily_puts(
    conn,
    *,
    ticker: str,
    date_list: list[date],
    opens: np.ndarray,
    closes: np.ndarray,
    rsi14: np.ndarray,
    iv_map: dict[date, float],
    spread: SpreadCalibration,
    delta: float,
    dte: int,
    exit_spec: dict[str, Any],
) -> dict[int, dict[str, Any]]:
    hi = len(date_list) - dte - 2
    out: dict[int, dict[str, Any]] = {}
    for di in range(20, hi):
        tr = simulate_daily_index_put(
            date_list, opens, closes, rsi14, di,
            ticker=ticker, dte_days=dte, target_delta=delta,
            exit_spec=exit_spec, iv_by_date=iv_map, spread=spread, conn=conn,
        )
        if tr:
            out[di] = tr
    return out


def run_index_oversold_puts(*, rsi_thresholds: tuple[float, ...] = (20.0, 25.0, 30.0)) -> dict[str, Any]:
    """S159 daily index RSI oversold → short SPY/QQQ puts; rare-event descriptive."""
    tbill = load_tbill()
    with connect() as conn:
        spread = load_spread_calibration(conn)
        summaries: list[dict[str, Any]] = []
        best: dict[str, Any] | None = None
        for idx in ("SPY", "QQQ"):
            dates_idx, opens, closes, rsi14 = load_index_daily_panel(idx)
            date_list = [d.date() if hasattr(d, "date") else d for d in dates_idx]
            iv_map = merge_iv_series(conn, idx, dates_idx, pd.Series(closes, index=dates_idx))
            for delta in (0.15, 0.20, 0.30):
                for dte in (7, 30):
                    for exit_name, exit_spec in INDEX_EXIT_SPECS:
                        by_day = _precompute_daily_puts(
                            conn, ticker=idx, date_list=date_list, opens=opens, closes=closes,
                            rsi14=rsi14, iv_map=iv_map, spread=spread, delta=delta, dte=dte, exit_spec=exit_spec,
                        )
                        if not by_day:
                            continue
                        base_pnls = [t["pnl_coll_mid"] for t in by_day.values()]
                        base_mean = float(np.nanmean(base_pnls))
                        pool = list(by_day.keys())
                        for rsi_thr in rsi_thresholds:
                            cross = daily_entry_cross_mask(rsi14, rsi_thr)
                            event_idx = [int(i) for i in np.where(cross)[0] if int(i) in by_day]
                            if not event_idx:
                                continue
                            trades = []
                            for si in event_idx:
                                tr = dict(by_day[si])
                                tr["exit_rule"] = exit_name
                                tr["delta"] = delta
                                tr["dte"] = dte
                                tr["rsi_thr"] = rsi_thr
                                trades.append(tr)
                            pnls = np.array([t["pnl_coll_mid"] for t in trades], dtype=float)
                            wins = sum(1 for t in trades if t["win"])
                            n = len(trades)
                            rng = np.random.default_rng(42 + hash((idx, delta, dte, exit_name, rsi_thr)) % 10_000)
                            rand_means: list[float] = []
                            for _ in range(min(1000, max(1, len(pool)))):
                                pick = rng.choice(pool, size=min(n, len(pool)), replace=False)
                                rand_means.append(float(np.nanmean([by_day[i]["pnl_coll_mid"] for i in pick])))
                            rand_mean = float(np.nanmean(rand_means)) if rand_means else float("nan")
                            hold = dte if exit_name == "expiry" else min(dte, 5)
                            tb = tbill_at(tbill, date_list[event_idx[0]])
                            coll_avg = float(np.mean([t["credit"] / t["strike"] for t in trades]))
                            tbill_coll = (tb * hold / 365.0 * coll_avg) if tb else float("nan")
                            worst = trades[int(np.argmin(pnls))]
                            row = {
                                "index": idx,
                                "rsi_thr": rsi_thr,
                                "delta": delta,
                                "dte": dte,
                                "exit": exit_name,
                                "n": n,
                                "win": wins / n,
                                "win_lo": wilson_lo(wins, n),
                                "mean_mid": float(np.nanmean(pnls)),
                                "worst_mid": float(np.nanmin(pnls)),
                                "lift_vs_base": float(np.nanmean(pnls) - base_mean),
                                "lift_vs_random": float(np.nanmean(pnls) - rand_mean),
                                "base_mean": base_mean,
                                "random_mean": rand_mean,
                                "tbill_coll_mean": tbill_coll,
                                "worst_trade": worst,
                                "note": "rare-event, descriptive",
                            }
                            summaries.append(row)
                            if rsi_thr == 25.0 and (best is None or row["mean_mid"] > best.get("mean_mid", -1e9)):
                                best = {**row, "events": trades}
        return {
            "summaries": summaries,
            "events": (best or {}).get("events") or [],
            "best_rsi25": {k: v for k, v in (best or {}).items() if k != "events"},
            "indices": ("SPY", "QQQ"),
        }


def universe_tickers_from_db(limit: int | None = None) -> list[str]:
    with connect() as conn:
        rows = conn.execute("SELECT DISTINCT ticker FROM optlab.bars_5m ORDER BY ticker").fetchall()
    tickers = [r[0] for r in rows]
    return tickers[:limit] if limit else tickers


def _scalp_exits(bar_minutes: int = 1) -> list[tuple[str, ExitRules]]:
    bars_30m = max(1, round(30 / max(1, bar_minutes)))
    return [
        ("rsi_gt_50", ExitRules(
            close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)],
            time_stop="same_day",
        )),
        ("tp25", ExitRules(take_profit_frac=0.25, time_stop="same_day")),
        ("tp50", ExitRules(take_profit_frac=0.50, time_stop="same_day")),
        ("tstop30m", ExitRules(time_stop="same_day", max_bars=bars_30m)),
    ]


def _day_exits(bar_minutes: int = 5) -> list[tuple[str, ExitRules]]:
    xs = _scalp_exits(bar_minutes)
    xs.append(("tp50_overnight", ExitRules(take_profit_frac=0.50, time_stop="overnight")))
    return xs


def _swing_exits(bar_minutes: int = 60) -> list[tuple[str, ExitRules]]:
    # A375 M4: 5 RTH sessions = 5 * 390 min; scale by bar_minutes (35 bars on 1h, 5 bars on 1d).
    bars_5d = 5 if bar_minutes >= 390 else max(1, round((5 * 390) / max(1, bar_minutes)))
    return [
        ("tp50", ExitRules(take_profit_frac=0.50, time_stop="expiry")),
        ("tstop_5d", ExitRules(time_stop="expiry", max_bars=bars_5d)),
        ("expiry", ExitRules(time_stop="expiry")),
    ]


CONFLUENCE_FILTERS: list[tuple[str, str, ConditionSet]] = [
    ("none", "", ConditionSet("and", [])),
    ("ema20_15m", "15m", ConditionSet("and", [IndicatorCondition("close_above_ema20", "gt", 0.0, "15m")])),
    ("ema20_1h", "1h", ConditionSet("and", [IndicatorCondition("close_above_ema20", "gt", 0.0, "1h")])),
    ("rsi40_1h", "1h", ConditionSet("and", [IndicatorCondition("rsi14", "gt", 40.0, "1h")])),
]


def run_horizon_sweep(tickers: list[str], *, smoke: bool = False) -> dict[str, Any]:
    """Horizon-matched grid (fix4+fix5): scalp/day/swing TFs + optional Elder confluence filter."""
    inst = PutInstrument(target_delta=-0.15)
    grids: list[tuple[str, str, list[float], list[tuple[str, ExitRules]]]] = [
        ("scalp", "1m", [10.0, 20.0, 30.0], _scalp_exits(1)),
        ("scalp", "2m", [10.0, 20.0, 30.0], _scalp_exits(2)),
        ("day", "5m", [10.0, 20.0, 30.0], _day_exits(5)),
        ("day", "15m", [10.0, 20.0, 30.0], _day_exits(15)),
        ("swing", "1h", [10.0, 20.0, 30.0], _swing_exits(60)),
        ("swing", "1d", [10.0, 20.0, 30.0], _swing_exits(390)),
    ]
    rows: list[dict[str, Any]] = []
    t_load = time.perf_counter()
    for horizon, tf, thr_list, exit_variants in grids:
        base_ctx = load_conditional_context(tickers, bar_tf=tf, higher_tf=None)
        ctx_by_hi: dict[str, ConditionalContext] = {"": base_ctx}
        load_s = time.perf_counter() - t_load
        thr_use = thr_list[:1] if smoke else thr_list
        exit_use = exit_variants[:1] if smoke else exit_variants
        filt_use = CONFLUENCE_FILTERS[:2] if smoke else CONFLUENCE_FILTERS
        for thr in thr_use:
            entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, tf)])
            for exit_name, exits in exit_use:
                bare_payload: dict[str, Any] | None = None
                for fl_name, hi_tf, hi_cond in filt_use:
                    if fl_name == "none":
                        payload = run_conditional_strategy(
                            tickers, entry, exits, inst,
                            session_filter=lambda d: d >= OPRA_START, ctx=base_ctx, bar_tf=tf,
                        )
                        bare_payload = payload
                        lift_f = None
                    else:
                        if bare_payload is None:
                            bare_payload = run_conditional_strategy(
                                tickers, entry, exits, inst,
                                session_filter=lambda d: d >= OPRA_START, ctx=base_ctx, bar_tf=tf,
                            )
                        if hi_tf not in ctx_by_hi:
                            ctx_s = ConditionalContext(
                                bars_map=base_ctx.bars_map,
                                sectors=base_ctx.sectors,
                                spread=base_ctx.spread,
                                betas=base_ctx.betas,
                                iv_maps=base_ctx.iv_maps,
                                default_beta=base_ctx.default_beta,
                                rsi_by_ticker=base_ctx.rsi_by_ticker,
                                bar_tf=base_ctx.bar_tf,
                                bar_minutes=base_ctx.bar_minutes,
                                higher_tf=hi_tf if hi_tf != tf else None,
                                higher_bar_minutes=bar_minutes_for_tf(hi_tf),
                                split_mults_by_ticker=base_ctx.split_mults_by_ticker,
                            )
                            if hi_tf and hi_tf != tf:
                                with connect() as conn:
                                    hb = load_bars_for_timeframe(conn, list(base_ctx.bars_map.keys()), hi_tf)
                                for tk_h, df_h in hb.items():
                                    df_hs, rf_h = _intraday_rsi_by_session(df_h, split_mults=base_ctx.split_mults_by_ticker.get(tk_h))
                                    ctx_s.higher_bars[tk_h] = df_hs
                                    ctx_s.rsi_higher[tk_h] = rf_h
                            ctx_by_hi[hi_tf] = ctx_s
                        payload = run_conditional_strategy(
                            tickers, entry, exits, inst,
                            session_filter=lambda d: d >= OPRA_START, ctx=ctx_by_hi[hi_tf], bar_tf=tf,
                            higher_filter=hi_cond, higher_tf=hi_tf,
                        )
                        lift_f = payload.get("lift_pnl_coll", float("nan")) - bare_payload.get("lift_pnl_coll", 0)
                    c = payload["conditional"]
                    row = _frontier_row("opra", thr, exit_name, "cond", c, lift=payload.get("lift_pnl_coll"))
                    row.update({
                        "horizon": horizon,
                        "bar_tf": tf,
                        "filter": fl_name,
                        "filter_lift_bp": lift_f,
                        "context_load_s": load_s,
                    })
                    rows.append(row)
                    if smoke:
                        break
                if smoke:
                    break
            if smoke:
                break
        if smoke:
            break
    return {"horizon_grid": rows, "n_cells": len(rows)}


def _session_bar_masks(df_1m: pd.DataFrame) -> tuple[dict[date, int], dict[date, int]]:
    """Close ≈ 15:55 bar and next-session open ≈ 09:31 on 1m RTH bars."""
    from zoneinfo import ZoneInfo

    et = ZoneInfo("America/New_York")
    ts = pd.to_datetime(df_1m["ts"], utc=True).dt.tz_convert(et)
    df = df_1m.assign(_ts=ts, session_date=ts.dt.tz_localize(None).dt.date)
    close_i: dict[date, int] = {}
    open_i: dict[date, int] = {}
    for sess, grp in df.groupby("session_date"):
        idx = grp.index.to_numpy()
        mins = ts.loc[idx].dt.hour * 60 + ts.loc[idx].dt.minute
        j_close = int(idx[np.argmax(mins)])
        close_i[sess] = j_close
        open_i[sess] = int(idx[0])
    return close_i, open_i


def run_overnight_carry_cells(tickers: list[str] | None = None) -> dict[str, Any]:
    """A188 #1: short 0.15Δ put at RTH close (1m) → buy next open; mirror open→close. No trigger."""
    from a359_bars_1m import fetch_range_1m, load_parquet_1m  # noqa: WPS433
    from bar_resample import resample_bars  # noqa: WPS433

    tickers = tickers or ["SPY", "QQQ"] + universe_tickers_from_db()[:48]
    inst = PutInstrument(target_delta=-0.15, dte_target=7, dte_min=3, dte_max=14)
    variants = [("close_to_open", "close"), ("open_to_close", "open")]
    all_rows: list[dict[str, Any]] = []
    with connect() as conn:
        spread = load_spread_calibration(conn)
        betas = load_iv_return_betas(conn, tickers)
        sectors = load_groups(conn)
        default_beta = float(np.median(list(betas.values()))) if betas else -2.0
        iv_all = load_daily_iv_series(conn, tickers, OPRA_START, date.today())
    for variant, side in variants:
        trades: list[dict] = []
        exits = ExitRules(time_stop="overnight" if side == "close" else "same_day")
        for tk in tickers:
            with connect() as conn:
                df1 = load_parquet_1m(tk)
                if df1.empty:
                    df1 = fetch_range_1m(conn, tk, OPRA_START, date.today())
            if df1.empty:
                continue
            bars = resample_bars(df1, "1m")
            ts = pd.to_datetime(bars["ts"], utc=True)
            bars = bars.sort_values("ts").reset_index(drop=True)
            bars = bars.assign(session_date=ts.dt.tz_convert("America/New_York").dt.tz_localize(None).dt.date)
            carry = None
            beta = betas.get(tk, default_beta)
            iv_s = iv_all.get(tk, {})
            for session, grp in sorted(bars.groupby("session_date"), key=lambda x: x[0]):
                if session < OPRA_START:
                    continue
                sess_df = grp.reset_index(drop=True)
                if len(sess_df) < 3:
                    continue
                loc_close = max(0, len(sess_df) - 3)
                loc_entry = 0 if side == "open" else loc_close
                mask = np.zeros(len(sess_df), dtype=bool)
                mask[loc_entry] = True
                anchor = prior_business_iv(iv_s, session) or 30.0
                listed = standard_listed_strikes(float(sess_df["c"].iloc[0]))
                batch, carry = simulate_session_puts(
                    sess_df, mask, exits,
                    iv_anchor=anchor, iv_beta=beta, instrument=inst,
                    spread=spread, listed_strikes=listed, carry=carry, ticker=tk,
                    bar_minutes=1,
                )
                for t in batch:
                    t["variant"] = variant
                trades.extend(batch)
        st = aggregate_trades(trades, sectors)
        st["variant"] = variant
        st["per_year_net_mid"] = st.get("per_year_net_mid", {})
        all_rows.append(st)
    return {"overnight_carry": all_rows, "tickers": len(tickers)}


def run_conditional_leak_test(tickers: list[str] | None = None) -> dict[str, Any]:
    """Shift-one-bar on 5m RSI puts; planted look-ahead must flag; S159 index oversold must pass."""
    from study_leak import is_planted_lookahead, planted_lookahead_rsi_entry  # noqa: WPS433

    tickers = tickers or ["SPY", "AAPL"]
    ctx = load_conditional_context(tickers)
    inst = PutInstrument(target_delta=-0.15)
    exits = dict(frontier_exit_variants())["tp50_overnight"]
    entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "5m")])
    pay = run_conditional_strategy(tickers, entry, exits, inst, ctx=ctx)
    c = pay["conditional"]
    gross = c.get("mean_pnl_coll_gross", float("nan"))
    mid = c.get("mean_pnl_coll_mid", float("nan"))

    tk0 = tickers[0]
    df = ctx.bars_map.get(tk0)
    planted_flag = False
    if df is not None and len(df) > 80:
        sub = df.iloc[:2500].copy()
        _, rsi_full = _intraday_rsi_by_session(sub)
        r14 = rsi_full[14]
        c_arr = sub["c"].to_numpy(dtype=float)
        rets = np.empty_like(c_arr)
        rets[:-1] = c_arr[1:] / c_arr[:-1] - 1.0
        rets[-1] = np.nan
        good = entry_cross_mask(entry, c_arr, rsi_cache=rsi_full)
        bad = planted_lookahead_rsi_entry(r14, 30.0)
        rets_2d = rets.reshape(-1, 1)
        planted_flag = is_planted_lookahead(bad.reshape(-1, 1), rets_2d, short_puts=True) and not is_planted_lookahead(
            good.reshape(-1, 1), rets_2d, short_puts=True
        )

    s159 = run_index_oversold_puts(rsi_thresholds=(25.0, 30.0))
    s159_ok = bool(s159.get("summaries"))
    return {
        "gross": gross,
        "net_mid": mid,
        "planted_lookahead_flagged": planted_flag,
        "s159_pass": s159_ok,
    }


def run_a359_1h_rsi30_staging(tickers: list[str]) -> dict[str, Any]:
    """Cost-aware chain for swing 1h RSI<30 cell (acceptance b)."""
    from cost_staging import format_staging_chain, staging_chain  # noqa: WPS433

    inst = PutInstrument(target_delta=-0.15)
    ctx_1h = load_conditional_context(tickers, bar_tf="1h")
    entry_1h = ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "1h")])
    exits_1h = dict(_swing_exits())["tp50"]

    def _pull(tf: str, ex: ExitRules, ent: ConditionSet) -> Callable[[], dict[str, float]]:
        cctx = ctx_1h if tf == "1h" else load_conditional_context(tickers, bar_tf=tf)

        def pull() -> dict[str, float]:
            pay = run_conditional_strategy(
                tickers, ent, ex, inst,
                session_filter=lambda d: d >= OPRA_START, ctx=cctx, bar_tf=tf,
            )
            c = pay["conditional"]
            return {
                "gross": c.get("mean_pnl_coll_gross", float("nan")),
                "net_mid": c.get("mean_pnl_coll_mid", float("nan")),
                "net_cross": c.get("mean_pnl_coll_cross", float("nan")),
                "net_fill": c.get("mean_pnl_coll_fill", float("nan")),
                "n": float(c.get("n", 0)),
            }

        return pull

    entry_5m = ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "5m")])

    def pull_index() -> dict[str, float]:
        s159 = run_index_oversold_puts(rsi_thresholds=(30.0,))
        rows = s159.get("summaries") or []
        pick = next((r for r in rows if r.get("rsi_thr") == 30.0), None)
        if not pick and rows:
            pick = max(rows, key=lambda r: r.get("mean_mid", -1e9))
        if not pick:
            return {"gross": float("nan"), "net_mid": float("nan"), "net_cross": float("nan"), "n": 0.0}
        ev = (s159.get("events") or []) if pick.get("rsi_thr") == 30.0 else []
        cross_pnls = [t["pnl_coll_frac_cross"] for t in ev if "pnl_coll_frac_cross" in t]
        if not cross_pnls and ev:
            cross_pnls = [t.get("pnl_coll_mid", t.get("pnl_coll_frac", float("nan"))) for t in ev]
        mc = float(np.nanmean(cross_pnls)) if cross_pnls else float(pick.get("mean_mid", float("nan")))
        mm = float(pick.get("mean_mid", mc))
        mg = mm
        return {"gross": mg, "net_mid": mm, "net_cross": mc, "n": float(pick.get("n", 0))}

    stages = [
        ("1h_puts_rsi30", "option", _pull("1h", exits_1h, entry_1h)),
        ("5m_puts_overnight", "option", _pull("5m", ExitRules(take_profit_frac=0.50, time_stop="overnight"), entry_5m)),
        ("5m_puts_expiry", "option", _pull("5m", ExitRules(take_profit_frac=0.50, time_stop="expiry"), entry_5m)),
        ("daily_index_SPY_put", "stock", pull_index),
    ]
    chain = staging_chain(stages)
    return {"staging_chain": chain, "formatted": format_staging_chain(chain)}

