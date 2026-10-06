"""Shared research ticker universe — WRDS + LSEG.

WRDS syncs stay ≤ MAX_TICKERS (50). LSEG may use a higher cap in its own
`_session.MAX_TICKERS` when reading coverage; this module still caps at 50 for
shared CLI defaults so WRDS never full-dumps.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

BOOK_PATH = Path(__file__).with_name("universe_book.txt")
EARNINGS_WATCH_PATH = Path(__file__).resolve().parent / "out" / "earnings_watch.json"
MAX_TICKERS = 50

DEFAULT_BOOK = [
    "NVDA", "MSFT", "AAPL", "AMZN", "GOOGL", "META", "TSLA",
    "AVGO", "AMD", "CRM", "ORCL", "NFLX", "COST", "JPM", "XOM",
]


def parse_tickers(raw: str) -> list[str]:
    out = [t.strip().upper() for t in raw.split(",") if t.strip()]
    return out[:MAX_TICKERS]


def load_book(path: Path | None = None) -> list[str]:
    p = path or BOOK_PATH
    if not p.is_file():
        return DEFAULT_BOOK[:MAX_TICKERS]
    lines = [
        ln.strip().upper()
        for ln in p.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.startswith("#")
    ]
    return lines[:MAX_TICKERS]


def _db_url() -> str:
    try:
        from dotenv import load_dotenv
    except ImportError as e:
        raise RuntimeError("needs python-dotenv") from e
    root = Path(__file__).resolve().parents[2]
    for env in (root / ".env.local", root / ".env"):
        if env.is_file():
            load_dotenv(env, override=False)
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL missing")
    return url


def from_registry(limit: int = MAX_TICKERS) -> list[str]:
    """Active tickers from local ticker_registry."""
    try:
        import psycopg
    except ImportError as e:
        raise RuntimeError("registry universe needs psycopg") from e

    url = _db_url()
    with psycopg.connect(url) as conn:
        cols = {
            r[0]
            for r in conn.execute(
                """
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'ticker_registry'
                """
            ).fetchall()
        }
        if "active" in cols:
            where = "WHERE COALESCE(active, true) = true"
        elif "is_active" in cols:
            where = "WHERE COALESCE(is_active, true) = true"
        else:
            where = ""
        rows = conn.execute(
            f"SELECT ticker FROM ticker_registry {where} ORDER BY ticker LIMIT %s",
            (limit,),
        ).fetchall()
    return [r[0].upper() for r in rows]


def from_holdings(limit: int = MAX_TICKERS) -> list[str]:
    """Stocks + option underlyings from latest Robinhood portfolio snapshot."""
    try:
        import psycopg
    except ImportError as e:
        raise RuntimeError("holdings universe needs psycopg") from e

    url = _db_url()
    with psycopg.connect(url) as conn:
        rows = conn.execute(
            """
            WITH s AS (SELECT MAX(id) AS id FROM portfolio_snapshots)
            SELECT DISTINCT UPPER(symbol) AS ticker
            FROM portfolio_positions WHERE snapshot_id = (SELECT id FROM s)
            UNION
            SELECT DISTINCT UPPER(symbol)
            FROM portfolio_options WHERE snapshot_id = (SELECT id FROM s)
            """
        ).fetchall()
    out = sorted(r[0] for r in rows if r[0] and str(r[0]).replace(".", "").isalpha())
    return out[:limit]


def from_coverage(limit: int = MAX_TICKERS) -> list[str]:
    """Read-only: lseg_research.coverage priority order (Claude-built)."""
    try:
        import psycopg
    except ImportError as e:
        raise RuntimeError("coverage universe needs psycopg") from e

    url = _db_url()
    with psycopg.connect(url) as conn:
        exists = conn.execute(
            "SELECT to_regclass('lseg_research.coverage') IS NOT NULL"
        ).fetchone()[0]
        if not exists:
            return []
        rows = conn.execute(
            """
            SELECT ticker FROM lseg_research.coverage
            ORDER BY tier, score DESC
            LIMIT %s
            """,
            (limit,),
        ).fetchall()
    return [str(r[0]).upper() for r in rows]


def load_earnings_watch(path: Path | None = None) -> list[str]:
    """Tickers from LSEG loop-C handoff JSON (may be empty)."""
    p = path or EARNINGS_WATCH_PATH
    if not p.is_file():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    tickers = data.get("tickers") or []
    return [str(t).strip().upper() for t in tickers if str(t).strip()][:MAX_TICKERS]


def resolve_universe(args: argparse.Namespace) -> list[str]:
    if getattr(args, "tickers", None):
        parsed = parse_tickers(args.tickers)
        if parsed:
            return parsed
    mode = getattr(args, "universe", "book") or "book"
    limit = getattr(args, "limit", MAX_TICKERS) or MAX_TICKERS
    if mode == "registry":
        return from_registry(limit)
    if mode == "holdings":
        held = from_holdings(limit)
        return list(dict.fromkeys(held + load_book()))[:limit]
    if mode == "coverage":
        cov = from_coverage(limit)
        if cov:
            return cov
        # Fallback: holdings ∪ book (same as LSEG before coverage.py)
        return list(dict.fromkeys(from_holdings(limit) + load_book()))[:limit]
    return load_book()


def add_universe_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--tickers", default="", help="Comma list (overrides --universe)")
    p.add_argument(
        "--universe",
        choices=("book", "registry", "holdings", "coverage"),
        default="book",
        help="book|registry|holdings|coverage (lseg_research.coverage, WRDS-capped)",
    )
    p.add_argument("--limit", type=int, default=MAX_TICKERS)
    p.add_argument("--force", action="store_true", help="Ignore TTL skip (lane syncs)")
    p.add_argument(
        "--earnings-watch",
        action="store_true",
        help="Union LSEG research/common/out/earnings_watch.json (loop C); implies force for those names",
    )


def ensure_research_on_path() -> None:
    research = Path(__file__).resolve().parent.parent
    s = str(research)
    if s not in sys.path:
        sys.path.insert(0, s)
