"""A367 — one guard contract for incremental fetches (Python jobs)."""
from __future__ import annotations

import hashlib
import json
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

WS = Path(__file__).resolve().parent / "watchlist_sync"
if str(WS) not in sys.path:
    sys.path.insert(0, str(WS))
import rules as R  # noqa: E402

Cadence = Literal["daily", "weekly", "monthly"]
FetchMode = Literal["skip", "tail", "backfill"]


@dataclass(frozen=True)
class KeyPlan:
    key: str
    mode: FetchMode
    watermark: date | None
    tail_from: date | None
    tail_to: date | None


def expected_session(cadence: Cadence = "daily", now: datetime | date | None = None) -> date:
    """Last trading session the cadence promises (daily = last close)."""
    if isinstance(now, date) and not isinstance(now, datetime):
        now = datetime.combine(now, datetime.min.time())
    ref = R.last_close_date(now)
    if cadence == "daily":
        return ref
    if cadence == "weekly":
        d = ref
        for _ in range(6):
            if R.is_trading_day(d):
                return d
            d -= timedelta(days=1)
        return ref
    # monthly: last trading day of prior month window — coarse, enough for lab_fund
    d = ref.replace(day=1) - timedelta(days=1)
    while not R.is_trading_day(d):
        d -= timedelta(days=1)
    return d


def _parse_date(v: Any) -> date | None:
    if v is None:
        return None
    if isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    return date.fromisoformat(str(v)[:10])


def watermarks_for_keys(
    conn,
    *,
    table: str,
    date_col: str,
    key_col: str,
    keys: list[str],
) -> dict[str, date | None]:
    if "." not in table:
        raise ValueError(f"table must be schema-qualified: {table!r}")
    sch, rel = table.split(".", 1)
    rows = conn.execute(
        f"""SELECT {key_col}, MAX({date_col})::date
            FROM {sch}.{rel}
            WHERE {key_col} = ANY(%s)
            GROUP BY 1""",
        (keys,),
    ).fetchall()
    return {str(k): _parse_date(v) for k, v in rows}


def global_watermark(conn, *, table: str, date_col: str, key_filter: str = "TRUE") -> date | None:
    sch, rel = table.split(".", 1)
    row = conn.execute(
        f"SELECT MAX({date_col})::date FROM {sch}.{rel} WHERE {key_filter}",
    ).fetchone()
    return _parse_date(row[0] if row else None)


def plan_key(
    key: str,
    watermark: date | None,
    *,
    cadence: Cadence = "daily",
    overlap_days: int = 2,
    allow_backfill: bool = False,
    now: datetime | None = None,
) -> KeyPlan:
    expected = expected_session(cadence, now)
    if watermark is None:
        if allow_backfill:
            return KeyPlan(key, "backfill", None, None, expected)
        return KeyPlan(key, "skip", None, None, None)
    if watermark >= expected:
        return KeyPlan(key, "skip", watermark, None, None)
    tail_from = watermark - timedelta(days=max(0, overlap_days - 1))
    return KeyPlan(key, "tail", watermark, tail_from, expected)


def plan_fetch(
    conn,
    *,
    table: str,
    date_col: str,
    key_col: str,
    keys: list[str],
    cadence: Cadence = "daily",
    overlap_days: int = 2,
    allow_backfill: bool = False,
    now: datetime | None = None,
) -> list[KeyPlan]:
    wm = watermarks_for_keys(conn, table=table, date_col=date_col, key_col=key_col, keys=keys)
    return [
        plan_key(
            k,
            wm.get(k),
            cadence=cadence,
            overlap_days=overlap_days,
            allow_backfill=allow_backfill,
            now=now,
        )
        for k in keys
    ]


def distinct_on_conflict_assignments(cols: list[str], table_alias: str = "t") -> str:
    """Postgres ON CONFLICT DO UPDATE SET … WHERE (t.*) IS DISTINCT FROM (EXCLUDED.*)."""
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    left = ", ".join(f"{table_alias}.{c}" for c in cols)
    right = ", ".join(f"EXCLUDED.{c}" for c in cols)
    return f"{sets} WHERE ({left}) IS DISTINCT FROM ({right})"


class FetchRunRecorder:
    def __init__(self, conn, *, source: str, job: str, meta: dict | None = None):
        self.conn = conn
        self.source = source
        self.job = job
        self.meta = meta or {}
        self.t0 = time.monotonic()
        row = conn.execute(
            """INSERT INTO fetch_runs (source, job, meta)
               VALUES (%s, %s, %s::jsonb) RETURNING id""",
            (source, job, json.dumps(self.meta)),
        ).fetchone()
        self.run_id = row[0]
        self.vendor_calls = 0
        self.rows_inserted = 0
        self.rows_changed = 0
        self.keys_planned = 0
        self.keys_skipped = 0
        self.keys_fetched = 0
        self.mode: str | None = None

    def finish(self, *, mode: str | None = None) -> int:
        if mode:
            self.mode = mode
        secs = time.monotonic() - self.t0
        self.conn.execute(
            """UPDATE fetch_runs SET finished_at = now(), mode = %s,
               keys_planned = %s, keys_skipped = %s, keys_fetched = %s,
               vendor_calls = %s, rows_inserted = %s, rows_changed = %s, seconds = %s
               WHERE id = %s""",
            (
                self.mode,
                self.keys_planned,
                self.keys_skipped,
                self.keys_fetched,
                self.vendor_calls,
                self.rows_inserted,
                self.rows_changed,
                secs,
                self.run_id,
            ),
        )
        return self.run_id


def inputs_unchanged_since_run(
    conn,
    *,
    job: str,
    input_watermark: str,
    code_path: str | None = None,
    force: bool = False,
) -> bool:
    """Heavy-step guard: skip when last ok run saw the same inputs + code hash."""
    if force:
        return False
    code_hash = None
    if code_path:
        p = Path(code_path)
        if p.is_file():
            code_hash = hashlib.sha256(p.read_bytes()).hexdigest()[:16]
    row = conn.execute(
        """SELECT meta FROM fetch_runs
           WHERE job = %s AND finished_at IS NOT NULL AND mode IS DISTINCT FROM 'error'
           ORDER BY finished_at DESC LIMIT 1""",
        (job,),
    ).fetchone()
    if not row:
        return False
    meta = row[0] or {}
    if meta.get("input_watermark") != input_watermark:
        return False
    if code_hash and meta.get("code_hash") != code_hash:
        return False
    return True
