"""Shim — shared universe lives in research/common/. Prefer importing common.universe."""
from __future__ import annotations

import sys
from pathlib import Path

_research = Path(__file__).resolve().parents[1]
if str(_research) not in sys.path:
    sys.path.insert(0, str(_research))

from common.universe import (  # noqa: E402
    DEFAULT_BOOK,
    EARNINGS_WATCH_PATH,
    MAX_TICKERS,
    add_universe_args,
    from_coverage,
    from_holdings,
    from_registry,
    load_book,
    load_earnings_watch,
    parse_tickers,
    resolve_universe,
)

__all__ = [
    "DEFAULT_BOOK",
    "EARNINGS_WATCH_PATH",
    "MAX_TICKERS",
    "add_universe_args",
    "from_coverage",
    "from_holdings",
    "from_registry",
    "load_book",
    "load_earnings_watch",
    "parse_tickers",
    "resolve_universe",
]
