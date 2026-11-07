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

from a352_score_rank import load_groups, put_delta  # noqa: E402
from build_plan import connect  # noqa: E402
from indicator_catalog import CATALOG_BY_ID  # noqa: E402
from s045_put_retest import bs_put  # noqa: E402

BAR_CACHE = Path.home() / ".fildi" / "cache" / "a359_bars_5m"
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
        v = self.buckets.get((mb, db, lb))
        if v is not None:
            return v
        for alt in (lb, "high", "mid", "low"):
            v = self.buckets.get((mb, db, alt))
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
    """(ask−bid)/mid medians: per (ticker, moneyness, DTE); global by liq for ticker fallback."""
    rows = conn.execute(
        """SELECT ticker, strike::float8 / NULLIF(spot, 0), dte, volume, open_interest,
                  (ask::float8 - bid::float8) / NULLIF((bid::float8 + ask::float8) / 2.0, 0)
           FROM option_chain_history
           WHERE side = 'put' AND as_of >= %s AND bid > 0 AND ask > bid AND spot > 0""",
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
    buckets = {k: float(np.median(v)) for k, v in acc.items() if v}
    ticker_buckets = {k: float(np.median(v)) for k, v in t_acc.items() if v}
    ticker_liq_bin = {
        tk: _liq_bin(int(np.median(v)), 0) for tk, v in t_liq.items() if v
    }
    return SpreadCalibration(
        buckets=buckets,
        n_obs=n_used,
        source="option_chain_history≥2025-10-01",
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
            if exit_rules.time_stop == "expiry" and session_d >= expiry and j == len(bars) - 1:
                exit_reason, exit_i, exit_mark = "expiry", j, mark
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


def aggregate_trades(trades: list[dict], sectors: dict[str, str]) -> dict[str, Any]:
    if not trades:
        return {
            "n": 0, "n_eff": 0.0, "win": np.nan,
            "mean_pnl_coll": np.nan, "mean_pnl_coll_cross": np.nan,
            "mean_pnl_coll_gross": np.nan, "exit_mix": {},
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
        if base_every_day and carry is None and len(sess_df) > 2:
            bts, _ = simulate_session_puts(
                sess_df, cross, exit_rules,
                iv_anchor=anchor, iv_beta=iv_beta, instrument=instrument,
                spread=spread, listed_strikes=listed, force_entry_bar=0, ticker=tk,
            )
            for t in bts[:1]:
                base_trades.append(t)
    return cond_trades, base_trades


def run_conditional_strategy(
    tickers: list[str],
    entry: ConditionSet,
    exit_rules: ExitRules,
    instrument: PutInstrument,
    *,
    base_every_day: bool = True,
    session_filter: Callable[[date], bool] | None = None,
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
    return {
        "conditional": cond_stats,
        "base": base_stats,
        "lift_pnl_coll": lift,
        "tickers": len(bars_map),
        "wall_s": wall,
        "spread_calibration": {"n_obs": spread.n_obs, "source": spread.source, "n_buckets": len(spread.buckets)},
        "iv_beta_median": default_beta,
        "trades_sample": cond_trades[:5],
    }


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
                rows.append({
                    "window": win_label,
                    "rsi_lt": thr,
                    "exit": exit_name,
                    "n": c["n"],
                    "n_eff": c.get("n_eff"),
                    "win": c.get("win"),
                    "gross_pnl_coll": c.get("mean_pnl_coll_gross"),
                    "net_mid_pnl_coll": c.get("mean_pnl_coll"),
                    "net_cross_pnl_coll": c.get("mean_pnl_coll_cross"),
                    "lift": payload.get("lift_pnl_coll"),
                    "base_n": b.get("n"),
                })
            if smoke:
                break
        if smoke:
            break
    return {"frontier": rows, "thresholds": thresholds}


def write_report(payload: dict[str, Any], tag: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    from datetime import date as dt

    day = dt.today().isoformat()
    path = OUT_DIR / f"{day}-{tag}.json"
    path.write_text(json.dumps(payload, indent=2, default=str))
    return path


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


def universe_tickers_from_db(limit: int | None = None) -> list[str]:
    with connect() as conn:
        rows = conn.execute("SELECT DISTINCT ticker FROM optlab.bars_5m ORDER BY ticker").fetchall()
    tickers = [r[0] for r in rows]
    return tickers[:limit] if limit else tickers

