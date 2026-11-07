"""A359 conditional backtest engine — entry condition sets, first-hit exits, short puts.

Intraday: 5m bars from optlab.bars_5m (Polygon); optional LSE 1m export + resample in lse_client.
Signal bar t → fill bar t+1 open. One entry per cross; no repeat while open.
"""
from __future__ import annotations

import json
import math
import pickle
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

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
COST_BP = 10  # round-trip option friction ~10 bp of collateral

Logic = Literal["and", "or"]
CmpOp = Literal["lt", "lte", "gt", "gte"]


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
    take_profit_frac: float | None = None  # fraction of entry credit captured
    stop_loss_mult: float | None = None  # loss cap = mult × credit (2 → pay 3× credit to close)
    time_stop: Literal["same_day", "bars", "expiry"] = "same_day"
    max_bars: int | None = None


@dataclass
class PutInstrument:
    target_delta: float = -0.15
    dte_target: int = 30
    dte_min: int = 15
    dte_max: int = 45


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
    """True on bars where the condition set newly becomes true (edge trigger)."""
    rsi_cache = {14: rsi_series(closes, 14), 5: rsi_series(closes, 5), 2: rsi_series(closes, 2)}
    parts = [condition_true_series(c, closes, rsi_cache=rsi_cache) for c in conds.conditions]
    if not parts:
        return np.zeros(len(closes), dtype=bool)
    stack = np.vstack(parts)
    if conds.logic == "and":
        level = stack.all(axis=0)
    else:
        level = stack.any(axis=0)
    prev = np.roll(level, 1)
    prev[0] = False
    return level & ~prev


def third_friday(y: int, m: int) -> date:
    d = date(y, m, 15)
    return d + timedelta((4 - d.weekday()) % 7)


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
    """Coarse listed grid when /v3/pairs not called."""
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


def simulate_session_puts(
    bars: pd.DataFrame,
    entry_mask: np.ndarray,
    exit_rules: ExitRules,
    *,
    spot_iv: float,
    instrument: PutInstrument,
    listed_strikes: list[float] | None = None,
    force_entry_bar: int | None = None,
) -> list[dict]:
    """One RTH session; returns 0–1 trades (first entry only when flat)."""
    if bars.empty:
        return []
    closes = bars["c"].to_numpy(dtype=float)
    opens = bars["o"].to_numpy(dtype=float)
    session_d = bars["session_date"].iloc[0]
    rsi14 = rsi_series(closes, 14)
    trades: list[dict] = []

    in_pos = False
    start_i = 1
    if force_entry_bar is not None:
        start_i = force_entry_bar

    i = 0
    while i < len(bars) - 1:
        if not in_pos:
            enter_signal = (i in (force_entry_bar,) if force_entry_bar is not None
                            else bool(entry_mask[i]))
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
            iv = spot_iv if np.isfinite(spot_iv) and spot_iv > 0 else 30.0
            v = iv / 100.0 if iv > 3 else iv
            model_k = strike_for_delta(spot, iv, dte, instrument.target_delta)
            listed = listed_strikes or standard_listed_strikes(spot)
            strike = nearest_listed_strike(model_k, listed)
            t0 = dte / 365.0
            credit = bs_put(spot, strike, v, t0)
            if credit <= 0:
                i += 1
                continue
            entry_i = fill_i
            in_pos = True
            exit_reason = "session_end"
            exit_i = len(bars) - 1
            exit_mark = bs_put(float(closes[exit_i]), strike, v, max(t0 * 0.2, 1 / 365))
            for j in range(entry_i + 1, len(bars)):
                s = float(closes[j])
                if not np.isfinite(s):
                    continue
                mins_left = (len(bars) - 1 - j) * 5
                t_rem = max((dte * 24 * 60 - (j - entry_i) * 5) / (365 * 24 * 60), 1 / (365 * 24 * 60))
                mark = bs_put(s, strike, v, t_rem)
                pnl_f = put_pnl_frac_short(credit, mark)
                if exit_rules.close_conditions:
                    ok = True
                    for ec in exit_rules.close_conditions:
                        val = rsi14[j] if ec.indicator == "rsi14" else float("nan")
                        ok = ok and _cmp(val, ec.op, ec.threshold)
                    if ok:
                        exit_reason = "close_condition"
                        exit_i, exit_mark = j, mark
                        break
                if exit_rules.take_profit_frac is not None and pnl_f >= exit_rules.take_profit_frac:
                    exit_reason = "take_profit"
                    exit_i, exit_mark = j, mark
                    break
                if exit_rules.stop_loss_mult is not None and mark >= credit * (1 + exit_rules.stop_loss_mult):
                    exit_reason = "stop_loss"
                    exit_i, exit_mark = j, mark
                    break
                if exit_rules.time_stop == "same_day" and j == len(bars) - 1:
                    exit_reason = "time_stop"
                    exit_i, exit_mark = j, mark
                    break
            pnl_frac = put_pnl_frac_short(credit, exit_mark)
            coll_frac = credit / strike if strike > 0 else 0.0
            pnl_coll = pnl_frac * coll_frac - COST_BP / 1e4
            trades.append({
                "session": session_d.isoformat(),
                "signal_bar": i,
                "fill_bar": entry_i,
                "exit_bar": exit_i,
                "exit_reason": exit_reason,
                "spot_entry": spot,
                "strike": strike,
                "model_strike": model_k,
                "credit": credit,
                "pnl_frac": pnl_frac,
                "pnl_coll_frac": pnl_coll,
                "win": pnl_coll > 0,
            })
            in_pos = False
            i = exit_i + 1
            continue
        i += 1
    return trades


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


def load_daily_iv(conn, tickers: list[str], d0: date, d1: date) -> dict[tuple[str, date], float]:
    iv: dict[tuple[str, date], float] = {}
    rows = conn.execute(
        """SELECT ticker, date, iv30_put::float8
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND date BETWEEN %s AND %s AND iv30_put > 0""",
        (tickers, d0, d1),
    ).fetchall()
    for t, d, v in rows:
        iv[(t, d)] = float(v)
    return iv


def aggregate_trades(trades: list[dict], sectors: dict[str, str]) -> dict[str, Any]:
    if not trades:
        return {"n": 0, "n_eff": 0.0, "win": np.nan, "mean_pnl_coll": np.nan, "exit_mix": {}}
    pnls = np.array([t["pnl_coll_frac"] for t in trades], dtype=float)
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
        "median_pnl_coll": float(np.median(pnls)),
        "exit_mix": dict(mix),
    }


def run_conditional_strategy(
    tickers: list[str],
    entry: ConditionSet,
    exit_rules: ExitRules,
    instrument: PutInstrument,
    *,
    base_every_day: bool = True,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    with connect() as conn:
        bars_map = load_bars_5m_db(conn, tickers)
        if not bars_map:
            return {"error": "no bars_5m data", "tickers": tickers}
        sectors = load_groups(conn)
        all_dates = set()
        for df in bars_map.values():
            all_dates.update(df["session_date"].unique())
        d0, d1 = min(all_dates), max(all_dates)
        iv_map = load_daily_iv(conn, list(bars_map.keys()), d0, d1)

    cond_trades: list[dict] = []
    base_trades: list[dict] = []
    calls_used = 0

    for tk, df in bars_map.items():
        for session, sess_df in df.groupby("session_date"):
            sess_df = sess_df.reset_index(drop=True)
            closes = sess_df["c"].to_numpy(dtype=float)
            cross = entry_cross_mask(entry, closes)
            iv = iv_map.get((tk, session), 30.0)
            listed = standard_listed_strikes(float(closes[0]))
            ts = simulate_session_puts(
                sess_df, cross, exit_rules, spot_iv=iv, instrument=instrument,
                listed_strikes=listed,
            )
            for t in ts:
                t["ticker"] = tk
                cond_trades.append(t)
            if base_every_day and len(sess_df) > 2:
                bts = simulate_session_puts(
                    sess_df, cross, exit_rules, spot_iv=iv, instrument=instrument,
                    listed_strikes=listed, force_entry_bar=0,
                )
                for t in bts[:1]:
                    t["ticker"] = tk
                    base_trades.append(t)

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
        "lse_calls": calls_used,
        "trades_sample": cond_trades[:5],
    }


def jamie_example_spec() -> tuple[ConditionSet, ExitRules, PutInstrument]:
    entry = ConditionSet(
        logic="or",
        conditions=[
            IndicatorCondition("rsi14", "lt", 10.0, "5m"),
            IndicatorCondition("rsi14", "lt", 15.0, "5m"),
        ],
    )
    exit_rules = ExitRules(
        close_conditions=[IndicatorCondition("rsi14", "gt", 50.0, "5m")],
        take_profit_frac=0.50,
        stop_loss_mult=2.0,
        time_stop="same_day",
    )
    return entry, exit_rules, PutInstrument(target_delta=-0.15)


def write_report(payload: dict[str, Any], tag: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    day = date.today().isoformat()
    path = OUT_DIR / f"{day}-{tag}.json"
    path.write_text(json.dumps(payload, indent=2, default=str))
    return path


def universe_tickers_from_db(limit: int | None = None) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT ticker FROM optlab.bars_5m ORDER BY ticker"
        ).fetchall()
    tickers = [r[0] for r in rows]
    return tickers[:limit] if limit else tickers
