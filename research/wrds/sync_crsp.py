#!/usr/bin/env python3
"""
Incremental CRSP dsf → wrds_research (academic research only).

TTL: 90 days (CRSP lags; quarterly is enough).
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

from _auth import connect
from db import (
    connect_local,
    ensure_schema,
    execute_values,
    get_last_ok,
    get_watermark,
    log_pull,
    upsert_sync_state,
)
from universe import add_universe_args, resolve_universe


def _f(v):
    if v is None or pd.isna(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

TTL_DAYS = 90
DATASET = "crsp_dsf"


def main() -> int:
    p = argparse.ArgumentParser(description="Sync CRSP dsf → wrds_research")
    add_universe_args(p)
    p.add_argument("--days", type=int, default=730, help="First-backfill lookback from max date")
    args = p.parse_args()
    tickers = resolve_universe(args)
    if not tickers:
        print("empty universe")
        return 2

    print(f"universe ({len(tickers)}): {','.join(tickers[:12])}")
    db = connect()
    try:
        with connect_local() as local:
            ensure_schema(local)

            if not args.force:
                last = get_last_ok(local, DATASET)
                if last:
                    if last.tzinfo is None:
                        last = last.replace(tzinfo=timezone.utc)
                    if datetime.now(timezone.utc) - last < timedelta(days=TTL_DAYS):
                        print(f"skip {DATASET}: within {TTL_DAYS}d TTL")
                        log_pull(local, dataset=DATASET, status="skipped", tickers=tickers)
                        local.commit()
                        return 0

            # Prefer W1 map (keeps GOOGL≠GOOG); fall back to stocknames ticker match.
            mapped = local.execute(
                """
                SELECT ticker, crsp_permno FROM research_common.security_map
                WHERE ticker = ANY(%s) AND crsp_permno IS NOT NULL
                """,
                (tickers,),
            ).fetchall()
            permno_list = [int(p) for _, p in mapped]
            if not permno_list:
                ticker_sql = ",".join(repr(t) for t in tickers)
                names = db.raw_sql(f"""
                    SELECT DISTINCT permno, ticker, nameenddt
                    FROM crsp.stocknames
                    WHERE UPPER(ticker) IN ({ticker_sql})
                """)
                if names is None or names.empty:
                    print("no permnos — run fill_security_map_wrds.py")
                    return 2
                latest = (
                    names.sort_values("nameenddt")
                    .drop_duplicates("permno", keep="last")[["permno", "ticker"]]
                )
                permno_list = [int(x) for x in latest["permno"].unique()]
            else:
                print(f"using security_map permnos ({len(permno_list)})")
            permnos = ",".join(str(x) for x in permno_list)
            mx = db.raw_sql(
                f"SELECT MAX(date) AS mx FROM crsp.dsf WHERE permno IN ({permnos})"
            )
            max_date = str(mx.iloc[0]["mx"])[:10]
            wm = get_watermark(local, DATASET)
            if wm:
                start = wm
            else:
                from datetime import date as date_cls
                end_d = date_cls.fromisoformat(max_date)
                start = (end_d - timedelta(days=args.days)).isoformat()

            print(f"{DATASET}: {start} → {max_date}", flush=True)
            dsf = db.raw_sql(f"""
                SELECT permno, date, prc, ret, retx, vol, shrout
                FROM crsp.dsf
                WHERE permno IN ({permnos})
                  AND date >= '{start}'
                  AND date <= '{max_date}'
            """)
            if dsf is None or dsf.empty:
                log_pull(local, dataset=DATASET, status="ok", tickers=tickers, rows=0,
                         watermark_from=start, watermark_to=max_date)
                local.commit()
                print("  0 rows")
                return 0

            dsf = dsf.merge(latest, on="permno", how="left")
            rows = []
            for r in dsf.itertuples(index=False):
                rows.append((
                    int(r.permno),
                    None if pd.isna(r.ticker) else str(r.ticker).upper(),
                    r.date,
                    _f(r.prc), _f(r.ret), _f(r.retx), _f(r.vol), _f(r.shrout),
                ))

            sql = """
                INSERT INTO wrds_research.crsp_dsf
                  (permno, ticker, date, prc, ret, retx, vol, shrout, fetched_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (permno, date) DO UPDATE SET
                  ticker = EXCLUDED.ticker, prc = EXCLUDED.prc, ret = EXCLUDED.ret,
                  retx = EXCLUDED.retx, vol = EXCLUDED.vol, shrout = EXCLUDED.shrout,
                  fetched_at = now()
            """
            n = execute_values(local, sql, rows)
            upsert_sync_state(
                local, dataset=DATASET, watermark=max_date, rows=n, tickers=tickers,
                notes="crsp.dsf",
            )
            log_pull(
                local, dataset=DATASET, status="ok", tickers=tickers, rows=n,
                watermark_from=start, watermark_to=max_date,
            )
            local.commit()
            print(f"  upserted {n} → watermark {max_date}")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
