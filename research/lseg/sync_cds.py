"""Daily 5-year CDS par mid spreads (bp) for names with a primary CDS RIC (lseg_research.signals_daily.cds_ric) → lseg_research.cds_daily.

Why (Claude 10-19, S060): the StarMine credit trim flag has no history anywhere (LSEG/WRDS), so it can't be tested. LSEG CDS history
starts 2025-08-29 and is patchy, so we collect it ourselves; S0xx re-tests the credit flag once ≥ 2 years exist (~2027-09).
Incremental: each RIC resumes from its last stored date (first run backfills from 2025-08-01). ~5 requests/day for ~86 RICs.

    .venv/bin/python sync_cds.py
"""
from __future__ import annotations

from datetime import date, timedelta

from _session import clean, connect_local, lseg_session

DDL = """CREATE TABLE IF NOT EXISTS lseg_research.cds_daily (
  ticker text NOT NULL, ric text NOT NULL, date date NOT NULL, par_mid_bp double precision NOT NULL, fetched_at timestamptz DEFAULT now(),
  PRIMARY KEY (ticker, date))"""
BATCH = 20


def main() -> None:
    with connect_local() as conn:
        conn.execute(DDL)
        rics = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, cds_ric FROM lseg_research.signals_daily
                                    WHERE cds_ric IS NOT NULL ORDER BY ticker, as_of DESC""").fetchall())
        last = dict(conn.execute("SELECT ticker, MAX(date) FROM lseg_research.cds_daily GROUP BY 1").fetchall())
        conn.commit()
    start = min((last.get(t, date(2025, 7, 31)) + timedelta(days=1) for t in rics), default=date.today())
    if start >= date.today():
        print("cds_daily: up to date"); return
    by_ric = {r: t for t, r in rics.items()}
    total = 0
    with lseg_session() as ld, connect_local() as conn:
        rl = list(by_ric)
        for i in range(0, len(rl), BATCH):
            b = rl[i:i + BATCH]
            h = ld.get_history(b, fields=["PAR_MID1"], interval="daily", start=start.isoformat(), end=date.today().isoformat())
            if h is None or h.empty:
                continue
            rows = []
            for ric in b:
                col = ric if ric in h.columns else (ric, "PAR_MID1") if (ric, "PAR_MID1") in h.columns else "PAR_MID1" if len(b) == 1 else None
                if col is None:
                    continue
                for ix, v in h[col].items():
                    v = clean(v)
                    if v is not None and v > 0:
                        rows.append((by_ric[ric], ric, ix.date(), float(v)))
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO lseg_research.cds_daily (ticker, ric, date, par_mid_bp) VALUES (%s, %s, %s, %s)
                                   ON CONFLICT (ticker, date) DO UPDATE SET par_mid_bp = EXCLUDED.par_mid_bp, fetched_at = now()""", rows)
            conn.commit()
            total += len(rows)
    print(f"cds_daily: {total} rows · {len(rics)} RICs from {start}")


if __name__ == "__main__":
    main()
