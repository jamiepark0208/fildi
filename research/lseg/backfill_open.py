#!/usr/bin/env python3
"""Backfill lseg_research.daily_history.open from sources we already store (10-26, Jamie: "open is easily fetchable").

LSEG's own OPEN_PRC is fetched from now on by sync_daily_history.py (OHLC) and backfill_ohlc.py; until the Workspace proxy is up,
history comes from:
  1. public.prices_historical (open/close, 2024-10 →, nightly)          open × LSEG close ÷ source close (same day)
  2. wrds_research.crsp_dsf openprc (2017 → 2024-12, unadjusted)        |openprc| × LSEG close ÷ |prc|
  3. --polygon: Polygon adjusted daily aggs (free 2-year window) for names still missing opens; raw kept in vendor_raw (rule 4c);
     12.5 s between calls (5/min). For when the LSEG monthly datapoint guard blocks backfill_ohlc.py --missing-open.
Scaling by the same day's close ratio puts the open on LSEG's share basis (splits). A row is kept only if the scaled open sits
inside that day's LSEG low…high (± 1 %); several CRSP permnos on one ticker/date → the one whose close ratio is nearest the
previous kept day's. Never overwrites an LSEG open.

    scripts/watchlist_sync/.venv/bin/python research/lseg/backfill_open.py [--polygon]
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db import connect_local  # noqa: E402  (no lseg.data import needed)


def polygon(conn) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync/analysis"))
    import option_history as O
    since = date.today() - timedelta(days=729)
    todo = conn.execute("""SELECT ticker, MIN(date) FROM lseg_research.daily_history WHERE open IS NULL AND date >= %s
                           GROUP BY 1 ORDER BY 1""", (since,)).fetchall()
    only = {x for a in sys.argv if a.startswith("--tickers=") for x in a[10:].upper().split(",")}
    todo = [r for r in todo if not only or r[0] in only]
    print(f"polygon: {len(todo)} tickers with missing opens since {since}", flush=True)
    for i, (t, frm) in enumerate(todo):
        d = O.get(f"/v2/aggs/ticker/{t}/range/1/day/{frm}/{date.today()}?adjusted=true&sort=asc&limit=50000")
        if d:
            payload = json.dumps(d)
            conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                            VALUES ('polygon', 'aggs/day', %s, %s, %s::jsonb, %s) ON CONFLICT (source, endpoint, key, fetched_on)
                            DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                         (f"{t}:{frm}", date.today(), payload, hashlib.sha256(payload.encode()).hexdigest()))
            conn.execute("CREATE TEMP TABLE IF NOT EXISTS poly_open (ticker text, date date, open float8, close float8)")
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO poly_open VALUES (%s, %s, %s, %s)",
                                [(t, O.day(r["t"]), r["o"], r["c"]) for r in d.get("results") or [] if r.get("o") and r.get("c")])
            O.flush_usage(conn)
        conn.commit()
        if i % 25 == 0:
            print(f"  {i + 1}/{len(todo)} {t}", flush=True)
        time.sleep(12.5)


def main() -> None:
    with connect_local() as conn:
        if "--polygon" in sys.argv:
            polygon(conn)
        conn.execute("ALTER TABLE lseg_research.daily_history ADD COLUMN IF NOT EXISTS open real")
        bars = defaultdict(dict)
        for t, d, c, h, l in conn.execute("""SELECT ticker, date, close::float8, high::float8, low::float8 FROM lseg_research.daily_history
                                             WHERE open IS NULL AND close > 0"""):
            bars[t][d] = (c, h, l)
        src = defaultdict(lambda: defaultdict(list))   # (t, d) → [(open, close, tag)]
        for t, d, o, c in conn.execute("""SELECT ticker, date, open::float8, close::float8 FROM prices_historical
                                          WHERE open > 0 AND close > 0 AND ticker = ANY(%s)""", (list(bars),)):
            src[t][d].append((o, c, "ph"))
        for t, d, o, c, p in conn.execute("""SELECT ticker, date, ABS(openprc), ABS(prc), permno FROM wrds_research.crsp_dsf
                                             WHERE openprc IS NOT NULL AND prc IS NOT NULL AND prc <> 0 AND ticker = ANY(%s)""", (list(bars),)):
            src[t][d].append((o, c, f"crsp{p}"))
        if conn.execute("SELECT to_regclass('pg_temp.poly_open')").fetchone()[0]:
            for t, d, o, c in conn.execute("SELECT ticker, date, open, close FROM poly_open"):
                src[t][d].append((o, c, "polygon"))
        rows, kept, rejected = [], defaultdict(int), 0
        for t, days in bars.items():
            prev_ratio = None
            for d in sorted(days):
                c, h, l = days[d]
                cands = src[t].get(d) or []
                if not cands:
                    continue
                ph = [x for x in cands if x[2] in ("ph", "polygon")]
                pick = ph or sorted(cands, key=lambda x: abs((c / x[1]) / prev_ratio - 1) if prev_ratio else 0)
                o_src, c_src, tag = pick[0]
                ratio = c / c_src
                o = o_src * ratio
                lo, hi = (l or c) * 0.99, (h or c) * 1.01
                if not lo <= o <= hi:
                    rejected += 1
                    continue
                prev_ratio = ratio
                rows.append((o, t, d))
                kept["prices_historical" if tag == "ph" else tag if tag == "polygon" else "crsp"] += 1
        with conn.cursor() as cur:
            cur.executemany("UPDATE lseg_research.daily_history SET open = %s WHERE ticker = %s AND date = %s AND open IS NULL", rows)
        conn.commit()
        n, tot = conn.execute("SELECT COUNT(*) FILTER (WHERE open IS NOT NULL), COUNT(*) FROM lseg_research.daily_history").fetchone()
        print(f"open backfill: {dict(kept)} kept, {rejected} rejected (outside the day's range) · daily_history now {n:,}/{tot:,} rows with open")


if __name__ == "__main__":
    main()
