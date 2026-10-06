"""Top-10 holders per coverage ticker → lseg_research.holders_top (ownership concentration + who's adding/trimming).

Uses the global StartNum/EndNum parameters so LSEG returns only the 10 largest holders (full lists run to thousands
of rows per name). 13F-based data moves quarterly → TTL 7d.

Usage: .venv/bin/python sync_holders.py [--tickers … | coverage default] [--force]
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone

from _session import add_lseg_universe_args, clean, connect_local, load_ric_map, lseg_session, resolve_lseg_universe
from db import ensure_schema, get_last_ok, log_pull, upsert_sync_state

DATASET = "holders_top"
TTL = timedelta(days=7)
TOP_N = 10
CHUNK = 25

UPSERT = """
INSERT INTO lseg_research.holders_top (ticker, as_of, rank, investor, investor_type, pct_out, change_shares, filing_date)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (ticker, as_of, rank) DO UPDATE SET investor = EXCLUDED.investor, investor_type = EXCLUDED.investor_type,
  pct_out = EXCLUDED.pct_out, change_shares = EXCLUDED.change_shares, filing_date = EXCLUDED.filing_date
"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(p)
    args = p.parse_args()
    tickers = resolve_lseg_universe(args)
    today = date.today()

    with connect_local() as conn:
        ensure_schema(conn)
        last = get_last_ok(conn, DATASET)
        if last and not args.force and not args.tickers and datetime.now(timezone.utc) - last < TTL:
            print(f"skip: {DATASET} refreshed {last:%Y-%m-%d} (< {TTL.days}d). Use --force.")
            return

    ric_map = load_ric_map(tickers)
    by_ric = {r: t for t, r in ric_map.items()}
    rics = list(ric_map.values())
    rows: list[tuple] = []
    with connect_local() as conn:
        try:
            with lseg_session() as ld:
                for i in range(0, len(rics), CHUNK):
                    df = ld.get_data(
                        rics[i : i + CHUNK],
                        ["TR.InvestorFullName", "TR.InvestorType", "TR.PctOfSharesOutHeld", "TR.SharesHeldChange", "TR.HoldingsDate"],
                        {"StartNum": 1, "EndNum": TOP_N},
                    )
                    rank: dict[str, int] = {}
                    for _, r in df.iterrows():
                        ric, name = r.iloc[0], clean(r.iloc[1])
                        if ric not in by_ric or not name:
                            continue
                        rank[ric] = rank.get(ric, 0) + 1
                        fd = clean(r.iloc[5])
                        rows.append((by_ric[ric], today, rank[ric], name, clean(r.iloc[2]), clean(r.iloc[3]),
                                     clean(r.iloc[4]), fd.date() if hasattr(fd, "date") else fd))
        except Exception as e:
            log_pull(conn, dataset=DATASET, status="error", tickers=tickers, error=str(e)[:500])
            conn.commit()
            raise
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lseg_research.holders_top WHERE as_of = %s AND ticker = ANY(%s)", (today, tickers))
            cur.executemany(UPSERT, rows)
        upsert_sync_state(conn, dataset=DATASET, watermark=today.isoformat(), rows=len(rows), tickers=tickers)
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(rows))
        conn.commit()
    print(f"{DATASET}: {len(rows)} holder rows for {len({r[0] for r in rows})} tickers")


if __name__ == "__main__":
    main()
