"""Audit Fildi's gold fundamentals against cached LSEG values → lseg_research.gold_audit.

Local SQL only (no LSEG calls, no quota). Never writes ticker_fundamentals / FIELD_DEFS — it records
disagreements for a human to review in Stock DB (and optionally queue a refetch from the gold source).

Checks (coverage tickers present in ticker_fundamentals):
  analyst_target_price  gold vs LSEG pt_mean          warn ≥15%, high ≥40%
  shares_outstanding    gold vs LSEG shares_out       warn ≥10%, high ≥50% (splits / share-class mixups)
  next_earnings_date    earnings_calendar vs LSEG     warn >3 days, high >7 days

Usage: .venv/bin/python audit_gold.py
"""
from __future__ import annotations

from _session import connect_local
from db import ensure_schema, log_pull, upsert_sync_state

DATASET = "gold_audit"

SQL = """
WITH s AS (SELECT DISTINCT ON (ticker) * FROM lseg_research.signals_daily ORDER BY ticker, as_of DESC),
tf AS (SELECT UPPER(ticker) AS ticker, analyst_target_price, shares_outstanding FROM ticker_fundamentals),
prov AS (SELECT UPPER(ticker) AS ticker, field, winning_source FROM field_provenance),
pt AS (
  SELECT s.ticker, 'analyst_target_price' AS field, tf.analyst_target_price::text AS gold_value,
         COALESCE(p.winning_source, '?') AS gold_source, ROUND(s.pt_mean::numeric, 2)::text AS lseg_value,
         100 * (tf.analyst_target_price / s.pt_mean - 1) AS diff
  FROM s JOIN tf USING (ticker) LEFT JOIN prov p ON p.ticker = s.ticker AND p.field = 'analystTargetPrice'
  WHERE s.pt_mean > 0 AND tf.analyst_target_price > 0
),
sh AS (
  SELECT s.ticker, 'shares_outstanding' AS field, tf.shares_outstanding::text AS gold_value,
         COALESCE(p.winning_source, '?') AS gold_source, ROUND(s.shares_out::numeric)::text AS lseg_value,
         100 * (tf.shares_outstanding / s.shares_out - 1) AS diff
  FROM s JOIN tf USING (ticker) LEFT JOIN prov p ON p.ticker = s.ticker AND p.field = 'sharesOutstanding'
  WHERE s.shares_out > 0 AND tf.shares_outstanding > 0
),
er AS (
  SELECT l.ticker, 'next_earnings_date' AS field, a.d::text AS gold_value, 'earnings_calendar' AS gold_source,
         l.d::text AS lseg_value, (a.d - l.d)::float8 AS diff
  FROM (SELECT ticker, MIN(event_date) d FROM lseg_research.events
        WHERE event_type = 'EarningsReleases' AND event_date >= CURRENT_DATE GROUP BY 1) l
  JOIN (SELECT UPPER(ticker) ticker, MIN(report_date::date) d FROM earnings_calendar
        WHERE report_date::date >= CURRENT_DATE GROUP BY 1) a USING (ticker)
)
SELECT * FROM (
  SELECT *, CASE WHEN ABS(diff) >= 40 THEN 'high' WHEN ABS(diff) >= 15 THEN 'warn' END AS sev FROM pt
  UNION ALL
  SELECT *, CASE WHEN ABS(diff) >= 50 THEN 'high' WHEN ABS(diff) >= 10 THEN 'warn' END FROM sh
  UNION ALL
  SELECT *, CASE WHEN ABS(diff) > 7 THEN 'high' WHEN ABS(diff) > 3 THEN 'warn' END FROM er
) x WHERE sev IS NOT NULL AND ticker IN (SELECT ticker FROM lseg_research.coverage)
"""


def main() -> None:
    with connect_local() as conn:
        ensure_schema(conn)
        rows = conn.execute(SQL).fetchall()
        with conn.cursor() as cur:
            cur.execute("DELETE FROM lseg_research.gold_audit")
            cur.executemany(
                "INSERT INTO lseg_research.gold_audit (ticker, field, gold_value, gold_source, lseg_value, diff, severity) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                rows,
            )
        tickers = sorted({r[0] for r in rows})
        upsert_sync_state(conn, dataset=DATASET, watermark="local", rows=len(rows), tickers=tickers)
        log_pull(conn, dataset=DATASET, status="ok", tickers=tickers, rows=len(rows))
        conn.commit()
    by = {}
    for r in rows:
        by.setdefault((r[1], r[6]), []).append(r[0])
    for (field, sev), ts in sorted(by.items()):
        print(f"{field:22s} {sev:4s} {len(ts):3d}  {', '.join(ts[:12])}{' …' if len(ts) > 12 else ''}")
    print(f"{DATASET}: {len(rows)} disagreements")


if __name__ == "__main__":
    main()
