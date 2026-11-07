"""A359 conditional backtest engine — entry condition sets, first-hit exits, short puts.

Intraday: 5m bars from optlab.bars_5m (Polygon); optional LSE 1m export + resample in lse_client.
Signal bar t → fill bar t+1 open. One entry per cross; no repeat while open.

IV: prior-session iv30_put anchor only (never same-day EOD on an intraday bar).
Intraday path: per-ticker IV-vs-return beta (stated); OPRA era uses calibrated friction from
option_chain_history + LSE overlap window (vendor_raw via lse_client when fetched).
"""
from __future__ import annotations

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

    def round_trip_frac(
        self,
        spot: float,
        strike: float,
        dte: int,
        *,
        ticker: str = "",
        volume: int = 0,
        open_interest: int = 0,
    ) -> float:
        if spot <= 0 or strike <= 0:
            return DEFAULT_SPREAD_RT
        mb, db = self._mb_db(spot, strike, dte)
        tk = ticker.upper() if ticker else ""
        if tk:
            tb = self.ticker_buckets.get((tk, mb, db))
            if tb is None:
                # Snapshots are weekly (dte≈2–5); reuse shorter-DTE ticker median for 7–30 DTE marks.
                # Then the ticker's nearest moneyness bin (QQQ 0.97 = atm had no own quotes → fell to a
                # junk global bin at 0.41 rt; own near_otm = 0.037). Own ticker beats any global bin.
                for alt_mb in _MB_NEIGHBORS[mb]:
                    for alt_db in (db, "short", "mid", "long"):
                        tb = self.ticker_buckets.get((tk, alt_mb, alt_db))
                        if tb is not None:
                            break
                    if tb is not None:
                        break
            if tb is not None:
                return tb
            lb = self.ticker_liq_bin.get(tk)
            if lb:
                return self._fallback_bucket(mb, db, lb)
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
                  (ask::float8 - bid::float8) / NULLIF((bid::float8 + ask::float8) / 2.0, 0)
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
    t_liq: dict[str, list[float]] = defaultdict(list)
    n_used = 0
    for ticker, m, dte, vol, oi, spr in rows:
        if spr is None or not math.isfinite(spr) or spr <= 0 or spr > 2:
            continue
        n_used += 1
        mb, db = _moneyness_bin(float(m)), _dte_bin(int(dte))
        lb = _liq_bin(int(vol or 0), int(oi or 0))
        acc[(mb, db, lb)].append(float(spr))
        tk = str(ticker).upper()
        t_acc[(tk, mb, db)].append(float(spr))
        t_liq[tk].append(float((vol or 0) + (oi or 0)))
    buckets = {k: float(np.median(v)) for k, v in acc.items() if len(v) >= MIN_BUCKET_N}
    ticker_buckets = {k: float(np.median(v)) for k, v in t_acc.items() if len(v) >= MIN_BUCKET_N}
    ticker_liq_bin = {
        tk: _liq_bin(int(np.median(v)), 0) for tk, v in t_liq.items() if v
    }
    return SpreadCalibration(
        buckets=buckets,
        n_obs=n_used,
        source="option_chain_history≥2025-10-01 RTH liq mid≥0.10",
        ticker_buckets=ticker_buckets,
        ticker_liq_bin=ticker_liq_bin,
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
    iv = iv_anchor * math.exp(-beta * lr)
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


def rsi_series(closes: np.ndarray, n: int = 14) -> np.ndarray:
    s = pd.Series(closes, dtype=float)
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return (100 - 100 / (1 + up / dn.replace(0, np.nan))).to_numpy(dtype=float)


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
    raise NotImplementedError(cond.indicator)


def entry_cross_mask(conds: ConditionSet, closes: np.ndarray) -> np.ndarray:
    rsi_cache = {14: rsi_series(closes, 14), 5: rsi_series(closes, 5), 2: rsi_series(closes, 2)}
    parts = [condition_true_series(c, closes, rsi_cache=rsi_cache) for c in conds.conditions]
    if not parts:
        return np.zeros(len(closes), dtype=bool)
    stack = np.vstack(parts)
    level = stack.all(axis=0) if conds.logic == "and" else stack.any(axis=0)
    prev = np.roll(level, 1)
    prev[0] = False
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


def _apply_friction(
    gross_coll: float,
    credit: float,
    strike: float,
    spot: float,
    spread: SpreadCalibration,
    dte: int,
    *,
    ticker: str = "",
) -> tuple[float, float, float, float]:
    prem = credit / strike if strike > 0 else 0.0
    rt = spread.round_trip_frac(spot, strike, dte, ticker=ticker)
    friction_cross = rt * prem
    friction_mid = 0.5 * rt * prem
    return gross_coll - friction_mid, gross_coll - friction_cross, friction_mid, friction_cross


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
) -> tuple[list[dict], OpenPut | None]:
    if bars.empty:
        return [], carry
    closes = bars["c"].to_numpy(dtype=float)
    opens = bars["o"].to_numpy(dtype=float)
    session_d = bars["session_date"].iloc[0]
    rsi14 = rsi_series(closes, 14)
    trades: list[dict] = []
    open_pos = carry
    in_pos = carry is not None

    if in_pos and open_pos is not None:
        entry_i = 0
        i = 0
    else:
        i = 0
    while i < len(bars) - 1:
        if not in_pos:
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
        if carry is not None and in_pos and open_pos.fill_bar >= len(bars):
            entry_i = 0
        else:
            entry_i = open_pos.fill_bar if open_pos.fill_bar < len(bars) else 0
        strike = open_pos.strike
        credit = open_pos.credit
        spot_entry = open_pos.spot_entry
        expiry = open_pos.expiry
        exit_reason = "session_end"
        exit_i = len(bars) - 1
        exit_mark = credit
        start_j = max(entry_i + 1, i + 1)
        for j in range(start_j, len(bars)):
            s = float(closes[j])
            if not np.isfinite(s):
                continue
            iv_j = iv_intraday_path(open_pos.iv_anchor, spot_entry, s, iv_beta)
            vj = iv_j / 100.0 if iv_j > 3 else iv_j
            days_elapsed = (session_d - open_pos.entry_session).days + (j - entry_i) * 5 / (24 * 60)
            dte_rem = max(open_pos.dte_at_entry - days_elapsed, 1 / (365 * 24 * 60))
            t_rem = dte_rem / 365.0
            mark = bs_put(s, strike, vj, t_rem)
            pnl_f = put_pnl_frac_short(credit, mark)
            if exit_rules.close_conditions:
                ok = True
                for ec in exit_rules.close_conditions:
                    val = rsi14[j] if ec.indicator == "rsi14" else float("nan")
                    ok = ok and _cmp(val, ec.op, ec.threshold)
                if ok:
                    exit_reason, exit_i, exit_mark = "close_condition", j, mark
                    break
            if exit_rules.take_profit_frac is not None and pnl_f >= exit_rules.take_profit_frac:
                exit_reason, exit_i, exit_mark = "take_profit", j, mark
                break
            if exit_rules.stop_loss_mult is not None and mark >= credit * (1 + exit_rules.stop_loss_mult):
                exit_reason, exit_i, exit_mark = "stop_loss", j, mark
                break
            if exit_rules.time_stop == "same_day" and j == len(bars) - 1:
                exit_reason, exit_i, exit_mark = "time_stop", j, mark
                break
            # Claude 11-07: "overnight" = close on the first bar of the next session if TP not hit
            # (before, the position carried until TP fired — past expiry — so losers waited for recovery).
            if exit_rules.time_stop == "overnight" and session_d > open_pos.entry_session:
                exit_reason, exit_i, exit_mark = "time_stop", j, mark
                break
            # Hard close at expiry for every rule, at intrinsic.
            if session_d >= expiry and j == len(bars) - 1:
                exit_reason, exit_i, exit_mark = "expiry", j, max(strike - s, 0.0)
                break
        pnl_frac = put_pnl_frac_short(credit, exit_mark)
        coll_frac = credit / strike if strike > 0 else 0.0
        gross_coll = pnl_frac * coll_frac
        net_mid, net_cross, friction_mid, friction_cross = _apply_friction(
            gross_coll, credit, strike, spot_entry, spread, open_pos.dte_at_entry, ticker=ticker,
        )
        closed = exit_reason != "session_end" or exit_rules.time_stop == "same_day"
        if not closed and exit_rules.time_stop in ("overnight", "expiry"):
            return trades, open_pos
        trades.append({
            "session": session_d.isoformat(),
            "ticker": ticker,
            "signal_bar": open_pos.signal_bar,
            "fill_bar": entry_i,
            "exit_bar": exit_i,
            "exit_reason": exit_reason,
            "spot_entry": spot_entry,
            "strike": strike,
            "credit": credit,
            "pnl_frac": pnl_frac,
            "pnl_coll_frac_gross": gross_coll,
            "pnl_coll_frac": net_mid,
            "pnl_coll_frac_cross": net_cross,
            "friction_coll_frac": friction_mid,
            "friction_coll_frac_cross": friction_cross,
            "win": net_mid > 0,
            "iv_anchor": open_pos.iv_anchor,
            "iv_beta": iv_beta,
            "in_opra_window": session_d >= OPRA_START,
        })
        in_pos = False
        open_pos = None
        i = exit_i + 1
        continue
    return trades, open_pos


def load_bars_5m_db(conn, tickers: list[str]) -> dict[str, pd.DataFrame]:
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
        df["session_date"] = pd.to_datetime(df["ts"]).dt.tz_localize(None).dt.date
        out[tk] = df
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
    mid = np.array([t["pnl_coll_frac"] for t in trades], dtype=float)
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
            by_y[sess].append(float(t["pnl_coll_frac"]))
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
    pnls = np.array([t["pnl_coll_frac"] for t in trades], dtype=float)
    cross = np.array([t.get("pnl_coll_frac_cross", t["pnl_coll_frac"]) for t in trades], dtype=float)
    gross = np.array([t.get("pnl_coll_frac_gross", t["pnl_coll_frac"]) for t in trades], dtype=float)
    mix: dict[str, int] = defaultdict(int)
    for t in trades:
        mix[t["exit_reason"]] += 1
    clusters: dict[tuple[str, str], int] = defaultdict(int)
    for t in trades:
        sec = sectors.get(t.get("ticker", ""), "UNK")
        key = (t["session"], sec)
        clusters[key] += 1
    n_eff = sum(1.0 / clusters[k] for k in clusters)
    return {
        "n": len(trades),
        "n_eff": float(n_eff),
        "win": float(np.mean([t["win"] for t in trades])),
        "mean_pnl_coll": float(np.mean(pnls)),
        "mean_pnl_coll_cross": float(np.mean(cross)),
        "mean_pnl_coll_gross": float(np.mean(gross)),
        "median_pnl_coll": float(np.median(pnls)),
        "exit_mix": dict(mix),
        **tail_stats_coll(trades),
    }


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
) -> tuple[list[dict], list[dict]]:
    cond_trades: list[dict] = []
    base_trades: list[dict] = []
    carry: OpenPut | None = None
    base_carry: OpenPut | None = None  # Claude 11-07: base keeps its open position across sessions (was dropped → only same-day winners counted)
    for session, sess_df in sorted(df.groupby("session_date"), key=lambda x: x[0]):
        sess_df = sess_df.reset_index(drop=True)
        closes = sess_df["c"].to_numpy(dtype=float)
        cross = entry_cross_mask(entry, closes) if carry is None else np.zeros(len(closes), dtype=bool)
        anchor = prior_business_iv(iv_series, session)
        if anchor is None:
            anchor = 30.0
        listed = standard_listed_strikes(float(closes[0]))
        ts, carry = simulate_session_puts(
            sess_df, cross, exit_rules,
            iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
            spread=spread, listed_strikes=listed, carry=carry, ticker=tk,
        )
        cond_trades.extend(ts)
        if carry is not None and session >= carry.expiry:
            carry = None
        if base_every_day and len(sess_df) > 2:
            if base_carry is not None:
                bts, base_carry = simulate_session_puts(
                    sess_df, np.zeros(len(closes), dtype=bool), exit_rules,
                    iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
                    spread=spread, listed_strikes=listed, carry=base_carry, ticker=tk,
                )
                base_trades.extend(bts[:1])
            elif carry is None:
                bts, base_carry = simulate_session_puts(
                    sess_df, cross, exit_rules,
                    iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
                    spread=spread, listed_strikes=listed, force_entry_bar=0, ticker=tk,
                )
                base_trades.extend(bts[:1])
                if bts:
                    base_carry = None
    return cond_trades, base_trades


def run_conditional_strategy(
    tickers: list[str],
    entry: ConditionSet,
    exit_rules: ExitRules,
    instrument: PutInstrument,
    *,
    base_every_day: bool = True,
    session_filter: Callable[[date], bool] | None = None,
    keep_trades: bool = False,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    with connect() as conn:
        bars_map = load_bars_5m_db(conn, tickers)
        if not bars_map:
            return {"error": "no bars_5m data", "tickers": tickers}
        sectors = load_groups(conn)
        spread = load_spread_calibration(conn)
        betas = load_iv_return_betas(conn, list(bars_map.keys()))
        default_beta = float(np.median(list(betas.values()))) if betas else -2.0
        all_dates = set()
        for df in bars_map.values():
            all_dates.update(df["session_date"].unique())
        d0, d1 = min(all_dates), max(all_dates)
        iv_maps = load_daily_iv_series(conn, list(bars_map.keys()), d0, d1)

    cond_trades: list[dict] = []
    base_trades: list[dict] = []
    for tk, df in bars_map.items():
        if session_filter is not None:
            df = df[df["session_date"].map(session_filter)].copy()
            if df.empty:
                continue
        beta = betas.get(tk, default_beta)
        ct, bt = _run_ticker_sessions(
            tk, df, entry, exit_rules, instrument,
            iv_maps.get(tk, {}), beta, spread, base_every_day=base_every_day,
        )
        cond_trades.extend(ct)
        base_trades.extend(bt)

    cond_stats = aggregate_trades(cond_trades, sectors)
    base_stats = aggregate_trades(base_trades, sectors)
    lift = (
        cond_stats["mean_pnl_coll"] - base_stats["mean_pnl_coll"]
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
        "spread_calibration": {"n_obs": spread.n_obs, "source": spread.source, "n_buckets": len(spread.buckets)},
        "iv_beta_median": default_beta,
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
        "net_mid_pnl_coll": stats.get("mean_pnl_coll"),
        "net_cross_pnl_coll": stats.get("mean_pnl_coll_cross"),
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
    }


def run_threshold_sweep(tickers: list[str], smoke: bool = False) -> dict[str, Any]:
    inst = PutInstrument(target_delta=-0.15)
    rows: list[dict[str, Any]] = []
    thresholds = [5.0 + 2.5 * i for i in range(int((30.0 - 5.0) / 2.5) + 1)]
    for thr in thresholds:
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        for exit_name, exits in frontier_exit_variants():
            full = run_conditional_strategy(tickers, entry, exits, inst, session_filter=None)
            opra = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=lambda d: d >= OPRA_START,
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
    return {"frontier": rows, "thresholds": thresholds}


def run_survivor_tail_cells(tickers: list[str]) -> dict[str, Any]:
    """Re-run tp50_overnight × RSI {5,30} × {full,opra} × {cond,base} — 8 rows."""
    inst = PutInstrument(target_delta=-0.15)
    exits = dict(frontier_exit_variants())["tp50_overnight"]
    rows: list[dict[str, Any]] = []
    for thr in (30.0, 5.0):
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        for win_label, filt in (("full", None), ("opra", lambda d: d >= OPRA_START)):
            payload = run_conditional_strategy(
                tickers, entry, exits, inst, session_filter=filt, keep_trades=True,
            )
            c, b = payload["conditional"], payload["base"]
            rows.append(_frontier_row(win_label, thr, "tp50_overnight", "cond", c, lift=payload.get("lift_pnl_coll"), base_n=b.get("n")))
            rows.append(_frontier_row(win_label, thr, "tp50_overnight", "base", b))
    return {"survivor_tail": rows, "exit": "tp50_overnight"}


def write_report(payload: dict[str, Any], tag: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    from datetime import date as dt

    day = dt.today().isoformat()
    path = OUT_DIR / f"{day}-{tag}.json"
    path.write_text(json.dumps(payload, indent=2, default=str))
    return path


def format_survivor_tail_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "window | rsi | role | n | win | net_mid | w5_mid | cvar1_mid | maxL_mid | net_cross | w5_cross | lift",
        "---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:",
    ]
    for r in rows:
        lift = r.get("lift")
        lift_v = float(lift) if lift is not None and lift == lift else float("nan")
        lines.append(
            f"{r['window']} | {r['rsi_lt']:.0f} | {r['role']} | {r['n']} | {r.get('win', float('nan')):.1%} | "
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


def chain_put_mid(conn, ticker: str, as_of: date, strike: float, expiry: date) -> float | None:
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
    row2 = conn.execute(
        """SELECT (bid::float8 + ask::float8) / 2.0, strike::float8
           FROM option_chain_history
           WHERE ticker = %s AND side = 'put' AND as_of = %s AND expiry = %s
             AND bid > 0 AND ask > bid
           ORDER BY abs(strike::float8 - %s) LIMIT 1""",
        (ticker, as_of, expiry, strike),
    ).fetchone()
    if row2 and row2[0]:
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
    net_mid, net_cross, _, _ = _apply_friction(
        gross_coll, credit, strike, spot, spread, dte, ticker=ticker,
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

