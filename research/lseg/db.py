"""Local Postgres helpers for lseg_research schema (DATABASE_URL from .env.local).

Mirrors research/wrds/db.py so both lanes keep identical sync_state / pull_log bookkeeping.
"""
from __future__ import annotations

import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]  # fildi/
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA = "lseg_research"


def load_env() -> None:
    for path in (ROOT / ".env.local", ROOT / ".env", Path(__file__).parent / ".env"):
        if path.is_file():
            load_dotenv(path, override=False)


@contextmanager
def connect_local() -> Iterator[psycopg.Connection]:
    load_env()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL missing (set in repo-root .env.local)")
    with psycopg.connect(url) as conn:
        yield conn


def ensure_schema(conn: psycopg.Connection | None = None) -> None:
    cleaned = re.sub(r"--[^\n]*", "", SCHEMA_PATH.read_text(encoding="utf-8"))
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


def get_last_ok(conn: psycopg.Connection, dataset: str):
    row = conn.execute(
        f"SELECT last_ok_at FROM {SCHEMA}.sync_state WHERE dataset = %s", (dataset,)
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
        f"""
        INSERT INTO {SCHEMA}.sync_state (dataset, watermark, last_ok_at, last_rows, last_tickers, notes)
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
        f"""
        INSERT INTO {SCHEMA}.pull_log
          (dataset, finished_at, status, tickers, rows_upserted, watermark_from, watermark_to, error)
        VALUES (%s, now(), %s, %s, %s, %s, %s, %s)
        """,
        (dataset, status, list(tickers), rows, watermark_from, watermark_to, error),
    )


def executemany(conn: psycopg.Connection, sql: str, rows: Sequence[tuple[Any, ...]]) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
    return len(rows)


FETCH_ATTEMPTS_DDL = f"""CREATE TABLE IF NOT EXISTS {SCHEMA}.fetch_attempts (
  dataset text NOT NULL, ticker text NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(), got_rows integer NOT NULL,
  PRIMARY KEY (dataset, ticker))"""


def record_attempts(conn: psycopg.Connection, dataset: str, got: dict[str, int]) -> None:
    """Remember what each ticker returned, so names the vendor has no data for aren't re-requested every run."""
    conn.execute(FETCH_ATTEMPTS_DDL)
    with conn.cursor() as cur:
        cur.executemany(
            f"""INSERT INTO {SCHEMA}.fetch_attempts (dataset, ticker, attempted_at, got_rows) VALUES (%s, %s, now(), %s)
                ON CONFLICT (dataset, ticker) DO UPDATE SET attempted_at = now(), got_rows = EXCLUDED.got_rows""",
            [(dataset, t, n) for t, n in got.items()])


def recently_empty(conn: psycopg.Connection, dataset: str, tickers: Sequence[str], days: int) -> set[str]:
    """Tickers that returned nothing for this dataset within the last `days` (negative cache)."""
    conn.execute(FETCH_ATTEMPTS_DDL)
    return {r[0] for r in conn.execute(
        f"""SELECT ticker FROM {SCHEMA}.fetch_attempts WHERE dataset = %s AND ticker = ANY(%s) AND got_rows = 0
            AND attempted_at > now() - make_interval(days => %s)""", (dataset, list(tickers), days)).fetchall()}
