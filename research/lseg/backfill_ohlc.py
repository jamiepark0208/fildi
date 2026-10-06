"""One-off: daily high / low / volume (+ warm-up closes from 2018-10) → lseg_research.daily_history (research/backtests only).

Why: the scorecard validation harness (scripts/watchlist_sync/analysis/scorecard_store) replays Fildi's own technical engine
on history. That engine needs OHLCV and ~335 trailing bars (what prices_historical holds live), so 2020 replays need 2018-10 warm-up.
Never writes prices_historical: the live engine's percentiles run over the whole stored series, so deeper history there would
silently change live scores.

Rules (same as sync_daily_history): batched (BATCH RICs/request), resumable (commit per batch; tickers already backfilled are
skipped), existing closes never overwritten (COALESCE), monthly datapoint guard via lseg_session.
Caveats: prices are split-adjusted; ACVOL_UNS is unadjusted primary-venue volume (fine for the engine's own-history percentiles,
small artifacts around splits).

Usage: .venv/bin/python backfill_ohlc.py [--start 2018-10-01] [--tickers A,B]
"""
from __future__ import annotations

import argparse
from datetime import date

from _session import connect_local, load_ric_map, lseg_session
from db import ensure_schema, log_pull
from sync_daily_history import fetch, series_of

DATASET = "daily_history_ohlc"
BATCH = 20
FIELDS = {"TRDPRC_1": "close", "HIGH_1": "high", "LOW_1": "low", "ACVOL_UNS": "volume"}
DDL = """ALTER TABLE lseg_research.daily_history ADD COLUMN IF NOT EXISTS high real;
ALTER TABLE lseg_research.daily_history ADD COLUMN IF NOT EXISTS low real;
ALTER TABLE lseg_research.daily_history ADD COLUMN IF NOT EXISTS volume double precision;"""
UPSERT = """INSERT INTO lseg_research.daily_history (ticker, date, close, high, low, volume, fetched_at)
VALUES (%s, %s, %s, %s, %s, %s, now())
ON CONFLICT (ticker, date) DO UPDATE SET close = COALESCE(daily_history.close, EXCLUDED.close),
  high = EXCLUDED.high, low = EXCLUDED.low, volume = EXCLUDED.volume, fetched_at = now()"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", default="2018-10-01")
    p.add_argument("--tickers", default="")
    a = p.parse_args()
    end = date.today().isoformat()
    with connect_local() as conn:
        ensure_schema(conn)
        for stmt in DDL.split(";"):
            if stmt.strip():
                conn.execute(stmt)
        conn.commit()
        tickers = [t.strip().upper() for t in a.tickers.split(",") if t.strip()] or [
            r[0] for r in conn.execute("SELECT DISTINCT ticker FROM lseg_research.daily_history ORDER BY 1").fetchall()]
        done = {r[0] for r in conn.execute(
            "SELECT ticker FROM lseg_research.daily_history WHERE high IS NOT NULL GROUP BY 1 HAVING MIN(date) <= %s::date + 30",
            (a.start,)).fetchall()}
    todo = [t for t in tickers if t not in done]
    ric_map = load_ric_map(todo)
    no_ric = [t for t in todo if t not in ric_map]
    todo = [t for t in todo if t in ric_map]
    print(f"{len(tickers)} tickers · {len(done & set(tickers))} already backfilled · {len(todo)} to fetch · no RIC: {no_ric[:15]}")
    total, empty = 0, []
    with lseg_session() as ld, connect_local() as conn:
        try:
            for i in range(0, len(todo), BATCH):
                batch = todo[i:i + BATCH]
                frames = fetch(ld, [ric_map[t] for t in batch], list(FIELDS), a.start, end)
                rows = []
                for t in batch:
                    ric = ric_map[t]
                    day: dict[date, dict] = {}
                    for f, col in FIELDS.items():
                        for d, v in series_of(frames.get(ric), ric, f):
                            day.setdefault(d, {})[col] = v
                    if not any("high" in v for v in day.values()):
                        empty.append(t)
                        continue
                    rows += [(t, d, v.get("close"), v.get("high"), v.get("low"), v.get("volume")) for d, v in day.items()]
                with conn.cursor() as cur:
                    cur.executemany(UPSERT, rows)
                conn.commit()  # resumable
                total += len(rows)
                print(f"  batch {i // BATCH + 1}/{(len(todo) + BATCH - 1) // BATCH}: {len(rows)} rows")
        except Exception as e:
            conn.rollback()
            log_pull(conn, dataset=DATASET, status="error", tickers=todo, error=str(e)[:500])
            conn.commit()
            raise
        log_pull(conn, dataset=DATASET, status="ok", tickers=todo, rows=total, watermark_from=a.start)
        conn.commit()
    print(f"{DATASET}: {total} rows · no OHLC returned: {empty[:20]}")


if __name__ == "__main__":
    main()
