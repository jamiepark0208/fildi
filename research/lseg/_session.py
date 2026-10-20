"""LSEG Workspace desktop session + shared research imports.

Requires the Refinitiv/LSEG Workspace app running and logged in (API proxy on 127.0.0.1:9000)
and LSEG_APP_KEY in repo-root .env.local (Workspace search: APPKEY).
"""
from __future__ import annotations

import math
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

RESEARCH = Path(__file__).resolve().parents[1]
if str(RESEARCH) not in sys.path:
    sys.path.insert(0, str(RESEARCH))

import lseg.data as ld  # noqa: E402
import pandas as pd  # noqa: E402

from db import connect_local, load_env  # noqa: E402,F401


# LSEG Workspace desktop API limits (developers.lseg.com "maximum usage reference guide"):
# 10,000 requests/day, 5 requests/sec across all apps on this Workspace, 50 MB/min, 5 GB/day.
LSEG_DAILY_REQUESTS = 10_000
LSEG_BUDGET_FRACTION = 0.8  # refuse to start a run once 80% of today's requests are used
# 2026-10-19: research backfills burned 9.5k/10k and blocked the 07:00 Model List sync (~40 requests).
# Production jobs (daily.py sets LSEG_PRIORITY=1) keep the last 20% for themselves.
LSEG_PRIORITY_FRACTION = 0.98
LSEG_MONTHLY_DATAPOINTS = 10_000_000  # Datastream-style monthly allowance (self-imposed guard; history pulls are the big users)
LSEG_MIN_INTERVAL_S = 0.25  # ≤4 req/s, leaves headroom for Workspace's own Excel/UI calls
RETRYABLE = ("429", "timeout", "timed out", "temporarily", "503", "502", "connection reset", "too many")


class MeteredLD:
    """Wraps lseg.data: throttles, retries transient errors, and counts requests + approx datapoints."""

    def __init__(self, ld_mod: Any):
        self._ld = ld_mod
        self.requests = 0
        self.datapoints = 0
        self.errors = 0
        self._last = 0.0

    def _call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        import time

        for attempt in range(3):
            wait = LSEG_MIN_INTERVAL_S - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                out = fn(*args, **kwargs)
                shape = getattr(out, "shape", None)
                if shape:
                    self.datapoints += int(shape[0]) * max(int(shape[1]) - 1, 1)
                return out
            except Exception as e:  # field/entitlement errors are not retryable; throttling/network are
                self.errors += 1
                if attempt == 2 or not any(k in str(e).lower() for k in RETRYABLE):
                    raise
                time.sleep(2 * (attempt + 1))

    def get_data(self, *a: Any, **k: Any) -> Any:
        return self._call(self._ld.get_data, *a, **k)

    def get_history(self, *a: Any, **k: Any) -> Any:
        return self._call(self._ld.get_history, *a, **k)

    def __getattr__(self, name: str) -> Any:  # session, discovery, news… pass through (not metered)
        return getattr(self._ld, name)


def _usage_today(conn: Any) -> int:
    row = conn.execute(
        "SELECT calls_made FROM api_usage WHERE source = 'lseg' AND date = (now() AT TIME ZONE 'America/Los_Angeles')::date"
    ).fetchone()
    return int(row[0]) if row else 0


USAGE_DDL = """CREATE TABLE IF NOT EXISTS lseg_research.usage_daily (
  date date PRIMARY KEY, requests integer NOT NULL DEFAULT 0, datapoints bigint NOT NULL DEFAULT 0, errors integer NOT NULL DEFAULT 0)"""


def _datapoints_this_month(conn: Any) -> int:
    conn.execute(USAGE_DDL)
    row = conn.execute("SELECT COALESCE(SUM(datapoints), 0) FROM lseg_research.usage_daily WHERE date >= date_trunc('month', now())").fetchone()
    return int(row[0])


def _record_datapoints(conn: Any, m: "MeteredLD") -> None:
    conn.execute(USAGE_DDL)
    conn.execute(
        """INSERT INTO lseg_research.usage_daily (date, requests, datapoints, errors)
           VALUES ((now() AT TIME ZONE 'America/Los_Angeles')::date, %s, %s, %s)
           ON CONFLICT (date) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests,
             datapoints = usage_daily.datapoints + EXCLUDED.datapoints, errors = usage_daily.errors + EXCLUDED.errors""",
        (m.requests, m.datapoints, m.errors))


def _record_usage(conn: Any, calls: int) -> None:
    # Same table/semantics as artifacts/api-server/src/lib/api-usage.ts recordApiUsage → shows in API Monitor.
    conn.execute(
        """
        INSERT INTO api_usage (source, date, calls_made)
        VALUES ('lseg', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s)
        ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + EXCLUDED.calls_made, updated_at = now()
        """,
        (calls,),
    )


@contextmanager
def lseg_session() -> Iterator[Any]:
    load_env()
    key = os.environ.get("LSEG_APP_KEY")
    if not key:
        raise RuntimeError("LSEG_APP_KEY missing from .env.local (Workspace search: APPKEY)")
    with connect_local() as conn:
        used = _usage_today(conn)
        month_pts = _datapoints_this_month(conn)
        conn.commit()
    if month_pts >= LSEG_MONTHLY_DATAPOINTS * LSEG_BUDGET_FRACTION:
        raise RuntimeError(
            f"LSEG budget guard: ~{month_pts:,} datapoints used this month (stop at {int(LSEG_BUDGET_FRACTION * 100)}% of "
            f"{LSEG_MONTHLY_DATAPOINTS:,}). Narrow the pull or wait for next month.")
    frac = LSEG_PRIORITY_FRACTION if os.environ.get("LSEG_PRIORITY") == "1" else LSEG_BUDGET_FRACTION
    if used >= LSEG_DAILY_REQUESTS * frac:
        raise RuntimeError(
            f"LSEG budget guard: {used}/{LSEG_DAILY_REQUESTS} requests already used today "
            f"(stop at {int(frac * 100)}%). Try again tomorrow."
        )
    try:
        ld.open_session(name="desktop.workspace", app_key=key)
    except Exception as e:
        raise RuntimeError(
            "Could not open LSEG Workspace session. Is Refinitiv/LSEG Workspace running and logged in "
            f"(API proxy on 127.0.0.1:9000)? Underlying error: {str(e)[:200]}"
        ) from e
    if str(ld.session.get_default().open_state).split(".")[-1] != "Opened":
        ld.close_session()
        raise RuntimeError("LSEG session did not open. Log in to Workspace, then rerun.")
    metered = MeteredLD(ld)
    try:
        yield metered
    finally:
        ld.close_session()
        try:
            with connect_local() as conn:
                _record_usage(conn, metered.requests)
                _record_datapoints(conn, metered)
                conn.commit()
        except Exception as e:  # metering must never break a sync
            print(f"warn: could not record LSEG usage ({e})")
        print(f"lseg usage: {metered.requests} requests, ~{metered.datapoints} datapoints, {metered.errors} errors")


def clean(v: Any) -> Any:
    """pandas NA/NaN/NaT → None; numpy scalars → python."""
    if v is None:
        return None
    try:
        if pd.isna(v):  # NaN / NaT / pd.NA
            return None
    except (TypeError, ValueError):  # array-likes
        pass
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float) and math.isinf(v):
        return None
    if isinstance(v, str) and not v.strip():
        return None
    return v


def load_ric_map(tickers: list[str]) -> dict[str, str]:
    """ticker → RIC from research_common.security_map (run sync_ids.py first)."""
    with connect_local() as conn:
        rows = conn.execute(
            "SELECT ticker, ric FROM research_common.security_map WHERE ticker = ANY(%s) AND ric IS NOT NULL",
            (tickers,),
        ).fetchall()
    return {t: r for t, r in rows}


MAX_TICKERS = 300  # LSEG lane cap (Datastream budget ~10M pts/mo; 300 × ~30 fields/day is ~0.1%). 150 → 300 on 2026-10-05 for the model tier


def portfolio_tickers() -> list[str]:
    """Stocks + option underlyings in the latest Robinhood portfolio snapshot (app data, not vendor)."""
    with connect_local() as conn:
        rows = conn.execute(
            """
            WITH s AS (SELECT MAX(id) AS id FROM portfolio_snapshots)
            SELECT DISTINCT UPPER(symbol) FROM portfolio_positions WHERE snapshot_id = (SELECT id FROM s)
            UNION
            SELECT DISTINCT UPPER(symbol) FROM portfolio_options WHERE snapshot_id = (SELECT id FROM s)
            """
        ).fetchall()
    return sorted(r[0] for r in rows if r[0] and r[0].replace(".", "").isalpha())


def coverage_tickers(max_tier: int = 7) -> list[str]:
    """lseg_research.coverage in priority order (built by coverage.py). Empty if not built yet."""
    with connect_local() as conn:
        exists = conn.execute("SELECT to_regclass('lseg_research.coverage') IS NOT NULL").fetchone()[0]
        if not exists:
            return []
        rows = conn.execute(
            "SELECT ticker FROM lseg_research.coverage WHERE tier <= %s ORDER BY tier, score DESC",
            (max_tier,),
        ).fetchall()
    return [r[0] for r in rows]


def add_lseg_universe_args(p) -> None:
    from common.universe import add_universe_args

    add_universe_args(p)
    p.add_argument("--no-holdings", action="store_true",
                   help="Shared book only (skip coverage table / holdings)")


def resolve_lseg_universe(args) -> list[str]:
    """--tickers wins; --no-holdings = shared book; else coverage table (held/traded/watchlist/lookalike/book),
    falling back to holdings ∪ book if coverage.py hasn't run. Cap MAX_TICKERS."""
    from common.universe import resolve_universe

    base = resolve_universe(args)
    if getattr(args, "tickers", None) or getattr(args, "no_holdings", False):
        return base
    cov = coverage_tickers()
    if cov:
        return list(dict.fromkeys(cov + base))[:MAX_TICKERS]
    try:
        held = portfolio_tickers()
    except Exception as e:  # portfolio tables absent on a fresh DB
        print(f"warn: holdings unavailable ({e}); using book only")
        held = []
    return list(dict.fromkeys(held + base))[:MAX_TICKERS]
