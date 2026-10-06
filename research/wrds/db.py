"""Local Postgres helpers for wrds_research schema (DATABASE_URL from .env.local)."""
from __future__ import annotations

import hashlib
import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

import psycopg
from dotenv import load_dotenv

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def _load_db_url() -> str:
    # research/wrds/db.py → repo root is parents[2]
    root = Path(__file__).resolve().parents[2]
    for path in (root / ".env.local", root / ".env", Path(__file__).parent / ".env"):
        if path.is_file():
            load_dotenv(path, override=False)
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL missing (set in repo-root .env.local)")
    return url


@contextmanager
def connect_local() -> Iterator[psycopg.Connection]:
    with psycopg.connect(_load_db_url()) as conn:
        yield conn


def ensure_schema(conn: psycopg.Connection | None = None) -> None:
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    # Strip line comments; split on semicolons
    cleaned = re.sub(r"--[^\n]*", "", sql)
    stmts = [s.strip() for s in cleaned.split(";") if s.strip()]

    def _run(c: psycopg.Connection) -> None:
        for stmt in stmts:
            c.execute(stmt)
        c.commit()

    if conn is not None:
        _run(conn)
    else:
        with connect_local() as c:
            _run(c)


def source_key(*parts: Any) -> str:
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def get_watermark(conn: psycopg.Connection, dataset: str) -> str | None:
    row = conn.execute(
        "SELECT watermark, last_ok_at FROM wrds_research.sync_state WHERE dataset = %s",
        (dataset,),
    ).fetchone()
    return row[0] if row else None


def get_last_ok(conn: psycopg.Connection, dataset: str):
    row = conn.execute(
        "SELECT last_ok_at FROM wrds_research.sync_state WHERE dataset = %s",
        (dataset,),
    ).fetchone()
    return row[0] if row else None


def upsert_sync_state(
    conn: psycopg.Connection,
    *,
    dataset: str,
    watermark: str,
    rows: int,
    tickers: Sequence[str],
    notes: str = "",
) -> None:
    conn.execute(
        """
        INSERT INTO wrds_research.sync_state (dataset, watermark, last_ok_at, last_rows, last_tickers, notes)
        VALUES (%s, %s, now(), %s, %s, %s)
        ON CONFLICT (dataset) DO UPDATE SET
          watermark = EXCLUDED.watermark,
          last_ok_at = EXCLUDED.last_ok_at,
          last_rows = EXCLUDED.last_rows,
          last_tickers = EXCLUDED.last_tickers,
          notes = EXCLUDED.notes
        """,
        (dataset, watermark, rows, list(tickers), notes),
    )


def log_pull(
    conn: psycopg.Connection,
    *,
    dataset: str,
    status: str,
    tickers: Sequence[str],
    rows: int | None = None,
    watermark_from: str | None = None,
    watermark_to: str | None = None,
    error: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO wrds_research.pull_log
          (dataset, finished_at, status, tickers, rows_upserted, watermark_from, watermark_to, error)
        VALUES (%s, now(), %s, %s, %s, %s, %s, %s)
        """,
        (dataset, status, list(tickers), rows, watermark_from, watermark_to, error),
    )


def record_api_usage(calls: int = 1) -> None:
    """Count WRDS Cloud SQL pulls into api_usage (source=wrds) for Settings → API Monitor."""
    if calls <= 0:
        return
    try:
        with connect_local() as conn:
            conn.execute(
                """
                INSERT INTO api_usage (source, date, calls_made)
                VALUES ('wrds', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s)
                ON CONFLICT (source, date) DO UPDATE
                  SET calls_made = api_usage.calls_made + EXCLUDED.calls_made,
                      updated_at = now()
                """,
                (calls,),
            )
            conn.commit()
    except Exception:
        # Metering must never break a sync.
        pass


def execute_values(
    conn: psycopg.Connection,
    sql: str,
    rows: Sequence[tuple[Any, ...]],
    page_size: int = 500,
) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        for i in range(0, len(rows), page_size):
            chunk = rows[i : i + page_size]
            cur.executemany(sql, chunk)
    return len(rows)
