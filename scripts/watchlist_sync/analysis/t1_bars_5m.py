#!/usr/bin/env python3
"""T1 input (A281): ~2 years of Polygon 5-minute aggregates for the sold-put names → optlab.bars_5m (research only).

Names = every ticker the put engine priced (watchlist_sync.put_recs_daily with a strike, latest day). Polygon free tier keeps
2 years; 50k bars per call ≈ 260 days incl. extended hours → ~3 calls per name, shared 5/min polygon_gate. Resumable: a name whose
stored range already reaches yesterday is skipped. Every field of each agg (o h l c v vw n t) is kept (rule 4c), so no vendor_raw
copy of the ~4 MB pages.

    .venv/bin/python analysis/t1_bars_5m.py [--tickers=A,B]
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import option_history as O  # noqa: E402
from build_plan import connect  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS optlab.bars_5m (ticker text NOT NULL, ts timestamptz NOT NULL, o float8, h float8, l float8,
  c float8, v float8, vw float8, n int, PRIMARY KEY (ticker, ts))"""


def main():
    only = [x for a in sys.argv[1:] if a.startswith("--tickers=") for x in a[10:].upper().split(",")]
    with connect() as conn:
        conn.execute(DDL)
        conn.commit()
        names = only or [t for (t,) in conn.execute("""SELECT ticker FROM watchlist_sync.put_recs_daily WHERE payload->>'strike' IS NOT NULL
                                                      AND as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily) ORDER BY rank""")]
        have = dict(conn.execute("SELECT ticker, MAX(ts)::date FROM optlab.bars_5m GROUP BY 1").fetchall())
        end = date.today() - timedelta(days=1)
        print(f"bars_5m: {len(names)} names", flush=True)
        for k, t in enumerate(names):
            frm = (have[t] + timedelta(days=1)) if t in have else date.today() - timedelta(days=729)
            n = 0
            while frm <= end:
                d = O.get(f"/v2/aggs/ticker/{t}/range/5/minute/{frm}/{end}?adjusted=true&sort=asc&limit=50000")
                res = d.get("results") or []
                if not res:
                    break
                with conn.cursor() as cur:
                    cur.executemany("""INSERT INTO optlab.bars_5m VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                                    [(t, datetime.fromtimestamp(r["t"] / 1000, timezone.utc), r.get("o"), r.get("h"), r.get("l"),
                                      r.get("c"), r.get("v"), r.get("vw"), r.get("n")) for r in res])
                conn.commit()
                n += len(res)
                last = O.day(res[-1]["t"])
                if len(res) < 50000 or last <= frm:
                    break
                frm = last   # next page from the last day (overlap is ignored by the key)
            O.flush_usage(conn)
            conn.commit()
            if k % 10 == 0:
                print(f"  {k + 1}/{len(names)} {t} +{n}", flush=True)
        print("bars_5m done", flush=True)


if __name__ == "__main__":
    main()
