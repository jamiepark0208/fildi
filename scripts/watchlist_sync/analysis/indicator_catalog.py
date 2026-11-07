"""A359 — registry of regime/technical inputs for conditional backtests.

One home for catalog metadata; values computed in conditional_engine / fast_screen.
Only indicators implemented in condition_true_series are advertised (A362).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Timeframe = Literal["1d", "4h", "1h", "30m", "15m", "10m", "5m", "3m", "2m", "1m"]

SourceKind = Literal["computed", "lseg_daily", "optlab_bars_5m", "lse_export", "polygon", "api"]


@dataclass(frozen=True)
class IndicatorSpec:
    id: str
    label: str
    timeframes: tuple[Timeframe, ...]
    source: SourceKind
    notes: str = ""
    tf_default: str = "5m"


CATALOG: tuple[IndicatorSpec, ...] = (
    IndicatorSpec("rsi2", "RSI(2)", ("1m", "2m", "5m", "1d"), "computed", tf_default="5m"),
    IndicatorSpec("rsi5", "RSI(5)", ("1m", "2m", "5m", "15m", "1d"), "computed", tf_default="5m"),
    IndicatorSpec("rsi14", "RSI(14)", ("1m", "2m", "5m", "15m", "1h", "1d"), "computed", tf_default="5m"),
    IndicatorSpec("close_above_ema20", "Close > EMA(20)", ("15m", "1h", "1d"), "computed", tf_default="15m"),
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
            "tf_default": s.tf_default,
        }
        for s in CATALOG
    ]
