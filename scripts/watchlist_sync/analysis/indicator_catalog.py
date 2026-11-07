"""A359 — registry of regime/technical inputs for conditional backtests.

One home for catalog metadata; values computed in conditional_engine / fast_screen.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Timeframe = Literal["1d", "5m", "1m"]

SourceKind = Literal["computed", "lseg_daily", "optlab_bars_5m", "lse_export", "polygon", "api"]


@dataclass(frozen=True)
class IndicatorSpec:
    id: str
    label: str
    timeframes: tuple[Timeframe, ...]
    source: SourceKind
    notes: str = ""


CATALOG: tuple[IndicatorSpec, ...] = (
    IndicatorSpec("rsi2", "RSI(2)", ("1d", "5m"), "computed"),
    IndicatorSpec("rsi5", "RSI(5)", ("1d", "5m"), "computed"),
    IndicatorSpec("rsi14", "RSI(14)", ("1d", "5m"), "computed"),
    IndicatorSpec("mfi14", "MFI(14)", ("1d",), "computed"),
    IndicatorSpec("zscore20", "Z-score 20d", ("1d",), "computed"),
    IndicatorSpec("zscore50", "Z-score 50d", ("1d",), "computed"),
    IndicatorSpec("gap_pct", "Overnight gap %", ("1d",), "computed"),
    IndicatorSpec("atr_pct", "ATR14 / close", ("1d",), "computed"),
    IndicatorSpec("rv20", "Realized vol 20d", ("1d",), "computed"),
    IndicatorSpec("iv_rank252", "IV rank 252d", ("1d",), "lseg_daily", "needs iv history"),
    IndicatorSpec("iv_div_rv", "IV ÷ RV20", ("1d",), "lseg_daily"),
    IndicatorSpec("sma50_pos", "Close vs SMA50", ("1d",), "computed"),
    IndicatorSpec("sma200_pos", "Close vs SMA200", ("1d",), "computed"),
    IndicatorSpec("dist_52w_high", "Distance from 52w high", ("1d",), "computed"),
    IndicatorSpec("dist_52w_low", "Distance from 52w low", ("1d",), "computed"),
    IndicatorSpec("volume_surge", "Volume z-score 20", ("1d",), "computed"),
    IndicatorSpec("spy_sma200", "SPY above SMA200", ("1d",), "lseg_daily"),
    IndicatorSpec("vix_level", "VIX close", ("1d",), "lseg_daily"),
    IndicatorSpec("sector_rs", "Sector ETF 21d RS", ("1d",), "lseg_daily"),
    IndicatorSpec("earnings_window", "Days to earnings", ("1d",), "lseg_daily"),
    IndicatorSpec("model_list_score", "Model List option score", ("1d",), "computed"),
)

CATALOG_BY_ID = {x.id: x for x in CATALOG}


def catalog_json() -> list[dict]:
    """API-shaped list for Backtest Lab (phase 3)."""
    return [
        {
            "id": s.id,
            "label": s.label,
            "timeframes": list(s.timeframes),
            "source": s.source,
            "notes": s.notes,
        }
        for s in CATALOG
    ]
