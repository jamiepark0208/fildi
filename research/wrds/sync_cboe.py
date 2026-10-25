#!/usr/bin/env python3
"""
A265 — CBOE index histories → wrds_research.cboe_daily (research only).

Series: VIX, VIX9D, VIX3M, VVIX, SKEW.
Source: CBOE public daily_prices CSVs (cdn.cboe.com). WRDS `cboe.cboe` only
has VIX/VXO/VXN/VXD; LSEG get_history is refused when the monthly datapoint
budget is ≥80% used — so the CDN is the complete path for all five.
"""
from __future__ import annotations

import argparse
import csv
import io
import sys
import urllib.request
from datetime import datetime, timezone

from db import (
    connect_local,
    ensure_schema,
    execute_values,
    log_pull,
    upsert_sync_state,
)

DATASET = "cboe_daily"
INDEXES = ("VIX", "VIX9D", "VIX3M", "VVIX", "SKEW")
CDN = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{index}_History.csv"


def _parse_mdy(s: str):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def fetch_index(index: str) -> list[tuple]:
    url = CDN.format(index=index)
    req = urllib.request.Request(url, headers={"User-Agent": "fildi-research/a265"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    rows: list[tuple] = []
    reader = csv.DictReader(io.StringIO(text))
    for r in reader:
        d = _parse_mdy(r.get("DATE") or r.get("Date") or "")
        if d is None:
            continue
        raw = r.get("CLOSE") or r.get(index) or r.get("Close")
        if raw is None or str(raw).strip() == "":
            continue
        try:
            close = float(raw)
        except ValueError:
            continue
        if not (close > 0):
            continue
        rows.append((d, index, close, "cboe_cdn"))
    return rows


def gap_stats(conn, index: str) -> dict:
    rows = conn.execute(
        """
        SELECT date FROM wrds_research.cboe_daily
        WHERE index = %s ORDER BY date
        """,
        (index,),
    ).fetchall()
    if len(rows) < 2:
        return {"n": len(rows), "max_gap": None, "min": None, "max": None}
    dates = [r[0] for r in rows]
    max_gap = max((dates[i] - dates[i - 1]).days for i in range(1, len(dates)))
    return {"n": len(dates), "max_gap": max_gap, "min": dates[0], "max": dates[-1]}


def main() -> int:
    p = argparse.ArgumentParser(description="Sync CBOE indexes → wrds_research.cboe_daily")
    p.add_argument("--indexes", default=",".join(INDEXES), help="Comma list (default all five)")
    args = p.parse_args()
    indexes = [x.strip().upper() for x in args.indexes.split(",") if x.strip()]

    ensure_schema()
    started = datetime.now(timezone.utc)
    total = 0
    notes: list[str] = []

    with connect_local() as local:
        try:
            for index in indexes:
                batch = fetch_index(index)
                if not batch:
                    notes.append(f"{index}: empty CDN response")
                    continue
                execute_values(
                    local,
                    """
                    INSERT INTO wrds_research.cboe_daily (date, index, close, source)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (date, index) DO UPDATE SET
                      close = EXCLUDED.close,
                      source = EXCLUDED.source,
                      fetched_at = now()
                    """,
                    batch,
                    page_size=1000,
                )
                total += len(batch)
                g = gap_stats(local, index)
                notes.append(
                    f"{index}: n={g['n']} {g['min']}→{g['max']} max_gap_cal={g['max_gap']}"
                )
                print(notes[-1])

            upsert_sync_state(
                local,
                dataset=DATASET,
                watermark=started.date().isoformat(),
                rows=total,
                tickers=indexes,
                notes="; ".join(notes)
                + " | CDN (WRDS cboe lacks VIX9D/VIX3M/VVIX/SKEW; LSEG budget blocked)",
            )
            log_pull(
                local,
                dataset=DATASET,
                status="ok",
                tickers=indexes,
                rows=total,
                watermark_to=started.date().isoformat(),
            )
            local.commit()
        except Exception as e:
            local.rollback()
            with connect_local() as c2:
                log_pull(
                    c2,
                    dataset=DATASET,
                    status="error",
                    tickers=indexes,
                    error=str(e)[:500],
                )
                c2.commit()
            print("ERROR", e, file=sys.stderr)
            return 1

    print(f"upserted {total} rows across {len(indexes)} indexes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
