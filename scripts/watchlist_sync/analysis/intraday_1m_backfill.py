"""A126 Phase 1b — Polygon free 1-min aggregates → watchlist_sync.intraday_bars_1m.

Resumable overnight backfill (same 5/min gate as option_history.py). Default keep
window = 60 calendar days of 1m bars; older rows pruned. Chunks ≈ 50 days/call.

  .venv/bin/python analysis/intraday_1m_backfill.py --plan
  .venv/bin/python analysis/intraday_1m_backfill.py --ticker SPY --days 10
  .venv/bin/python analysis/intraday_1m_backfill.py            # universe, 60d
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect, rows  # noqa: E402

API = "https://api.polygon.io"
GAP_S = 12.5
LAST_RUN = Path("/tmp/fildi-logs/intraday-1m-last.json")
CHUNK_DAYS = 50
KEEP_DAYS_DEFAULT = 60

DDL = """
CREATE SCHEMA IF NOT EXISTS watchlist_sync;
CREATE TABLE IF NOT EXISTS watchlist_sync.intraday_bars_1m (
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v double precision NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'polygon',
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS idx_intraday_bars_1m_ts
  ON watchlist_sync.intraday_bars_1m (ts DESC);
CREATE TABLE IF NOT EXISTS watchlist_sync.intraday_1m_chunks (
  ticker text NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  n int NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, from_date, to_date)
);
CREATE TABLE IF NOT EXISTS watchlist_sync.intraday_bars_5m (
  ticker text NOT NULL,
  ts timestamptz NOT NULL,
  o double precision NOT NULL,
  h double precision NOT NULL,
  l double precision NOT NULL,
  c double precision NOT NULL,
  v double precision NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'polygon-1m-rollup',
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS idx_intraday_bars_5m_ts
  ON watchlist_sync.intraday_bars_5m (ts DESC);
"""

_last = 0.0
_calls = 0


def key() -> str:
    if os.environ.get("POLYGON_API_KEY"):
        return os.environ["POLYGON_API_KEY"]
    env = HERE.parent.parent.parent / ".env.local"
    for line in open(env):
        if line.startswith("POLYGON_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("POLYGON_API_KEY missing")


def get(path: str) -> dict:
    global _last, _calls
    sep = "&" if "?" in path else "?"
    url = f"{API}{path}{sep}apiKey={key()}"
    for attempt in range(5):
        wait = _last + GAP_S - time.time()
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        _calls += 1
        try:
            with urllib.request.urlopen(url, timeout=90) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(65)
                continue
            if e.code in (403, 404):
                return {}
            time.sleep(15 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            time.sleep(15 * (attempt + 1))
    return {}


def flush_usage(conn) -> None:
    global _calls
    if not _calls:
        return
    conn.execute(
        """INSERT INTO api_usage (source, date, calls_made, updated_at)
           VALUES ('polygon', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
           ON CONFLICT (source, date) DO UPDATE SET
             calls_made = api_usage.calls_made + excluded.calls_made,
             updated_at = now()""",
        (_calls,),
    )
    conn.commit()
    _calls = 0


def progress(msg: str) -> None:
    try:
        LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
        LAST_RUN.write_text(
            json.dumps({"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "ok": True, "detail": msg})
        )
    except OSError:
        pass
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def universe(conn) -> list[str]:
    out = ["SPY", "QQQ"]
    book = HERE.parent / "out/pm/book-latest.json"
    if book.is_file():
        for p in json.loads(book.read_text()).get("positions", []):
            t = (p.get("ticker") or "").upper()
            if t and "." not in t and t not in out:
                out.append(t)
    for r in rows(conn, """SELECT ticker FROM model_recs GROUP BY ticker ORDER BY COUNT(*) DESC LIMIT 40"""):
        t = (r["ticker"] or "").upper()
        if t and "." not in t and t not in out:
            out.append(t)
    return out


def chunk_ranges(start: date, end: date) -> list[tuple[date, date]]:
    out: list[tuple[date, date]] = []
    cur = start
    while cur <= end:
        hi = min(end, cur + timedelta(days=CHUNK_DAYS - 1))
        out.append((cur, hi))
        cur = hi + timedelta(days=1)
    return out


def fetch_chunk(conn, ticker: str, lo: date, hi: date) -> int:
    have = conn.execute(
        "SELECT 1 FROM watchlist_sync.intraday_1m_chunks WHERE ticker = %s AND from_date = %s AND to_date = %s",
        (ticker, lo, hi),
    ).fetchone()
    if have:
        return 0
    d = get(f"/v2/aggs/ticker/{ticker}/range/1/minute/{lo}/{hi}?adjusted=true&sort=asc&limit=50000")
    res = d.get("results") or []
    # Polygon may paginate via next_url — follow once with same key gate
    next_url = d.get("next_url")
    while next_url:
        # next_url already has apiKey sometimes; strip and re-key via get()
        path = next_url.replace(API, "")
        if "apiKey=" in path:
            path = path.split("apiKey=")[0].rstrip("&?")
        more = get(path)
        res += more.get("results") or []
        next_url = more.get("next_url")
    rows_in = []
    for r in res:
        ts = datetime.fromtimestamp(r["t"] / 1000, timezone.utc)
        o, h, l, c = r.get("o"), r.get("h"), r.get("l"), r.get("c")
        if o is None or h is None or l is None or c is None:
            continue
        rows_in.append((ticker, ts, float(o), float(h), float(l), float(c), float(r.get("v") or 0)))
    with conn.cursor() as cur:
        if rows_in:
            cur.executemany(
                """INSERT INTO watchlist_sync.intraday_bars_1m (ticker, ts, o, h, l, c, v, source)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'polygon')
                   ON CONFLICT (ticker, ts) DO UPDATE SET
                     o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c,
                     v = EXCLUDED.v, source = EXCLUDED.source""",
                rows_in,
            )
        cur.execute(
            """INSERT INTO watchlist_sync.intraday_1m_chunks (ticker, from_date, to_date, n)
               VALUES (%s,%s,%s,%s)
               ON CONFLICT (ticker, from_date, to_date) DO UPDATE SET n = EXCLUDED.n, fetched_at = now()""",
            (ticker, lo, hi, len(rows_in)),
        )
    conn.commit()
    return len(rows_in)


def prune(conn, keep_days: int) -> None:
    cutoff = date.today() - timedelta(days=keep_days)
    conn.execute("DELETE FROM watchlist_sync.intraday_bars_1m WHERE ts::date < %s", (cutoff,))
    conn.execute("DELETE FROM watchlist_sync.intraday_1m_chunks WHERE to_date < %s", (cutoff,))
    conn.commit()


def rollup_5m(conn, ticker: str) -> int:
    """Aggregate 1m → 5m forever table (A126 Claude plan). Idempotent upsert."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH b AS (
              SELECT ticker,
                     to_timestamp(floor(extract(epoch FROM ts) / 300) * 300) AT TIME ZONE 'UTC' AS ts,
                     (array_agg(o ORDER BY ts))[1] AS o,
                     max(h) AS h,
                     min(l) AS l,
                     (array_agg(c ORDER BY ts DESC))[1] AS c,
                     sum(v) AS v
              FROM watchlist_sync.intraday_bars_1m
              WHERE ticker = %s
              GROUP BY 1, 2
            )
            INSERT INTO watchlist_sync.intraday_bars_5m (ticker, ts, o, h, l, c, v, source)
            SELECT ticker, ts, o, h, l, c, v, 'polygon-1m-rollup' FROM b
            ON CONFLICT (ticker, ts) DO UPDATE SET
              o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c,
              v = EXCLUDED.v, source = EXCLUDED.source
            """,
            (ticker,),
        )
        n = cur.rowcount
    conn.commit()
    return n


def backfill_ticker(conn, ticker: str, days: int) -> int:
    end = date.today()
    start = end - timedelta(days=days)
    total = 0
    for lo, hi in chunk_ranges(start, end):
        n = fetch_chunk(conn, ticker, lo, hi)
        total += n
        if n:
            progress(f"{ticker} {lo}→{hi} +{n}")
    n5 = rollup_5m(conn, ticker)
    if n5:
        progress(f"{ticker} 5m rollup +{n5}")
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--ticker", action="append", default=[])
    ap.add_argument("--days", type=int, default=KEEP_DAYS_DEFAULT)
    ap.add_argument("--rollup-only", action="store_true", help="only rebuild 5m from existing 1m")
    args = ap.parse_args()

    lock_path = Path("/tmp/fildi-logs/intraday-1m.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock = open(lock_path, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another intraday_1m_backfill holds the lock; exiting")
        return

    conn = connect()
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.commit()

    tickers = [t.upper() for t in args.ticker] if args.ticker else universe(conn)
    if args.plan:
        chunks = (args.days + CHUNK_DAYS - 1) // CHUNK_DAYS
        print(f"tickers {len(tickers)} · days {args.days} · ~{len(tickers) * chunks} calls · {' '.join(tickers[:20])}{'…' if len(tickers) > 20 else ''}")
        return

    if args.rollup_only:
        if not args.ticker:
            tickers = [r["ticker"] for r in rows(conn, "SELECT DISTINCT ticker FROM watchlist_sync.intraday_bars_1m ORDER BY 1")]
        for i, t in enumerate(tickers):
            n5 = rollup_5m(conn, t)
            progress(f"rollup {t} ({i + 1}/{len(tickers)}) 5m+={n5}")
        progress("rollup done")
        return

    for i, t in enumerate(tickers):
        n = backfill_ticker(conn, t, args.days)
        flush_usage(conn)
        progress(f"done {t} ({i + 1}/{len(tickers)}) bars+={n}")
    prune(conn, args.days)
    flush_usage(conn)
    progress("all done")


if __name__ == "__main__":
    main()
