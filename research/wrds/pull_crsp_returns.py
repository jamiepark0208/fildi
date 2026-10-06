#!/usr/bin/env python3
"""
Pull CRSP daily returns for tickers (USC: crsp_a_stock / crsp_q_stock subscribed).

Academic research only — parquet under research/wrds/out/.
Note: CRSP on WRDS often lags calendar (probe showed through ~2024-12 for this account).
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta

from _auth import connect


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--tickers", default="NVDA,MSFT,AAPL,AMZN,GOOGL,META,TSLA")
    p.add_argument("--start", default="", help="YYYY-MM-DD (default: end-minus-days)")
    p.add_argument("--end", default="", help="YYYY-MM-DD (default: latest in dsf for universe)")
    p.add_argument("--days", type=int, default=730, help="Lookback if --start omitted")
    args = p.parse_args()

    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    out_dir = os.path.join(os.path.dirname(__file__), "out")
    os.makedirs(out_dir, exist_ok=True)

    print(f"Connecting… tickers={tickers}", flush=True)
    db = connect()

    names = db.raw_sql(f"""
        SELECT DISTINCT permno, ticker, namedt, nameenddt, exchcd, shrcd
        FROM crsp.stocknames
        WHERE UPPER(ticker) IN ({",".join(repr(t) for t in tickers)})
    """)
    if names is None or names.empty:
        print("No permnos for tickers")
        db.close()
        return 2
    path_n = os.path.join(out_dir, "crsp_stocknames.parquet")
    names.to_parquet(path_n, index=False)
    print(f"stocknames: {len(names)} rows → {path_n}")

    permnos = ",".join(str(int(p)) for p in names["permno"].unique())
    mx = db.raw_sql(f"SELECT MAX(date) AS mx FROM crsp.dsf WHERE permno IN ({permnos})")
    max_date = str(mx.iloc[0]["mx"])[:10]
    end = args.end or max_date
    if args.start:
        start = args.start
    else:
        end_d = date.fromisoformat(end[:10])
        start = (end_d - timedelta(days=args.days)).isoformat()
    print(f"dsf window {start} → {end} (max available={max_date})")

    dsf = db.raw_sql(f"""
        SELECT permno, date, prc, ret, retx, vol, shrout
        FROM crsp.dsf
        WHERE permno IN ({permnos})
          AND date >= '{start}'
          AND date <= '{end}'
    """)
    if dsf is None or dsf.empty:
        print("dsf empty")
        db.close()
        return 2

    # attach ticker via latest name row
    latest = (
        names.sort_values("nameenddt")
        .drop_duplicates("permno", keep="last")[["permno", "ticker"]]
    )
    dsf = dsf.merge(latest, on="permno", how="left")
    path = os.path.join(out_dir, "crsp_dsf.parquet")
    dsf.to_parquet(path, index=False)
    print(f"dsf: {len(dsf)} rows, {dsf['ticker'].nunique()} tickers → {path}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
