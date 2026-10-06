#!/usr/bin/env python3
"""W4 — Latest WRDS firm_ratio snapshot for book tickers (audit gold fund metrics).

Surgical: ≤20 tickers recommended. Never merges into FIELD_DEFS / fund_score.

Usage:
  cd research/wrds && .venv/bin/python sync_finratio.py --universe book
  .venv/bin/python sync_finratio.py --tickers NVDA,MSFT --force
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

from _auth import connect
from db import connect_local, ensure_schema, execute_values, get_last_ok, log_pull, upsert_sync_state
from universe import add_universe_args, resolve_universe

DATASET = "finratio_snapshot"
TTL_DAYS = 90
MAX_PULL = 20

# Keep a small audit panel — not a second fund pipeline
COLS = [
    "ticker", "cusip", "permno", "public_date", "qdate",
    "pe_exi", "pe_op_dil", "bm", "ps", "pcf",
    "roe", "roa", "roce", "npm", "gpm",
    "de_ratio", "curr_ratio", "quick_ratio", "at_turn", "inv_turn",
]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    add_universe_args(p)
    args = p.parse_args()
    tickers = resolve_universe(args)[:MAX_PULL]
    if not tickers:
        print("empty universe")
        return 2

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

    ticker_sql = ",".join(repr(t) for t in tickers)
    print(f"{DATASET}: n={len(tickers)}", flush=True)
    db = connect()
    try:
        # Latest public_date per ticker
        df = db.raw_sql(f"""
            SELECT DISTINCT ON (UPPER(ticker))
                   UPPER(ticker) AS ticker, cusip, permno, public_date, qdate,
                   pe_exi, pe_op_dil, bm, ps, pcf,
                   roe, roa, roce, npm, gpm,
                   de_ratio, curr_ratio, quick_ratio, at_turn, inv_turn
            FROM wrdsapps.firm_ratio
            WHERE UPPER(ticker) IN ({ticker_sql})
            ORDER BY UPPER(ticker), public_date DESC NULLS LAST
        """)
    finally:
        db.close()

    if df is None or df.empty:
        print("0 rows")
        return 0

    def cell(v):
        if v is None:
            return None
        try:
            if pd.isna(v):
                return None
        except (TypeError, ValueError):
            pass
        if hasattr(v, "item"):
            try:
                v = v.item()
            except Exception:
                pass
        return v

    def fnum(v):
        v = cell(v)
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def inum(v):
        v = cell(v)
        if v is None:
            return None
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    rows = []
    for r in df.itertuples(index=False):
        def g(name):
            return cell(getattr(r, name, None))

        rows.append((
            str(g("ticker")).upper(),
            str(g("cusip")) if g("cusip") is not None else None,
            inum(g("permno")),
            g("public_date"),
            g("qdate"),
            fnum(g("pe_exi")),
            fnum(g("pe_op_dil")),
            fnum(g("bm")),
            fnum(g("ps")),
            fnum(g("pcf")),
            fnum(g("roe")),
            fnum(g("roa")),
            fnum(g("roce")),
            fnum(g("npm")),
            fnum(g("gpm")),
            fnum(g("de_ratio")),
            fnum(g("curr_ratio")),
            fnum(g("quick_ratio")),
            fnum(g("at_turn")),
            fnum(g("inv_turn")),
        ))

    sql = """
        INSERT INTO wrds_research.finratio_snapshot (
          ticker, cusip, permno, public_date, qdate,
          pe_exi, pe_op_dil, bm, ps, pcf,
          roe, roa, roce, npm, gpm,
          de_ratio, curr_ratio, quick_ratio, at_turn, inv_turn,
          fetched_at
        ) VALUES (
          %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now()
        )
        ON CONFLICT (ticker) DO UPDATE SET
          cusip=EXCLUDED.cusip, permno=EXCLUDED.permno,
          public_date=EXCLUDED.public_date, qdate=EXCLUDED.qdate,
          pe_exi=EXCLUDED.pe_exi, pe_op_dil=EXCLUDED.pe_op_dil, bm=EXCLUDED.bm,
          ps=EXCLUDED.ps, pcf=EXCLUDED.pcf, roe=EXCLUDED.roe, roa=EXCLUDED.roa,
          roce=EXCLUDED.roce, npm=EXCLUDED.npm, gpm=EXCLUDED.gpm,
          de_ratio=EXCLUDED.de_ratio, curr_ratio=EXCLUDED.curr_ratio,
          quick_ratio=EXCLUDED.quick_ratio, at_turn=EXCLUDED.at_turn,
          inv_turn=EXCLUDED.inv_turn, fetched_at=now()
    """
    with connect_local() as local:
        ensure_schema(local)
        n = execute_values(local, sql, rows)
        wm = str(max(df["public_date"]))[:10]
        upsert_sync_state(local, dataset=DATASET, watermark=wm, rows=n, tickers=tickers,
                          notes="wrdsapps.firm_ratio latest")
        log_pull(local, dataset=DATASET, status="ok", tickers=tickers, rows=n, watermark_to=wm)
        local.commit()
    print(f"upserted {n} finratio snapshots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
