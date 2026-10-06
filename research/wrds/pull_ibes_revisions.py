#!/usr/bin/env python3
"""
Pull IBES consensus summary (statsum) + actuals for tickers.

Academic research only — writes parquet under research/wrds/out/.
Does not touch TradeDash Postgres or fund_score.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

from _auth import connect

# Priority tables for revision / surprise research
TARGETS = [
    ("tr_ibes", "statsumu_epsus"),   # unadjusted US EPS consensus history
    ("tr_ibes", "statsum_epsus"),
    ("tr_ibes", "surpsum"),          # if present
    ("tr_ibes", "actpsum_epsus"),
    ("tr_ibes", "actu_epsus"),
]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--tickers", default="NVDA,MSFT,AAPL,AMZN,GOOGL,META,TSLA")
    p.add_argument("--days", type=int, default=730)
    args = p.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    start = (date.today() - timedelta(days=args.days)).isoformat()
    out_dir = os.path.join(os.path.dirname(__file__), "out")
    os.makedirs(out_dir, exist_ok=True)

    print(f"Connecting… tickers={tickers} since={start}", flush=True)
    db = connect()
    libs = set(db.list_libraries())
    tables_by_lib = {lib: set(db.list_tables(library=lib)) for lib in ("tr_ibes", "ibes") if lib in libs}

    ticker_sql = ",".join(repr(t) for t in tickers)
    ticker_sql_l = ",".join(repr(t.lower()) for t in tickers)
    pulled = 0

    for lib, table in TARGETS:
        if lib not in tables_by_lib or table not in tables_by_lib[lib]:
            print(f"  skip missing {lib}.{table}")
            continue
        desc = db.describe_table(library=lib, table=table)
        cols = {str(n).lower(): str(n) for n in desc["name"].tolist()}
        ticker_col = cols.get("oftic") or cols.get("ticker")
        date_col = cols.get("statpers") or cols.get("anndats") or cols.get("pends")
        if not ticker_col:
            print(f"  {lib}.{table}: no ticker/oftic")
            continue
        date_filter = f"AND {date_col} >= '{start}'" if date_col else ""
        # oftic is usually exchange ticker (NVDA); ticker is IBES mnemonic
        sql = f"""
            SELECT *
            FROM {lib}.{table}
            WHERE UPPER({ticker_col}) IN ({ticker_sql})
               OR LOWER({ticker_col}) IN ({ticker_sql_l})
            {date_filter}
        """
        try:
            df = db.raw_sql(sql)
        except Exception as e:
            print(f"  query fail {lib}.{table}: {e}")
            continue
        if df is None or df.empty:
            print(f"  {lib}.{table}: 0 rows")
            continue
        path = os.path.join(out_dir, f"ibes_{lib}_{table}.parquet")
        df.to_parquet(path, index=False)
        print(f"  OK {lib}.{table}: {len(df)} rows → {path}")
        pulled += 1

    db.close()
    if not pulled:
        print("No IBES rows pulled")
        return 2
    print(f"Done — {pulled} tables")
    return 0


if __name__ == "__main__":
    sys.exit(main())
