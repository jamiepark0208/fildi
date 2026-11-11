"""Missing-data review (Jamie 11-11: "missing data is not meant to be left alone as unknown — it needs a second opinion").
For every scored name, each key statement field that is null in gold is classified and logged to data_issues:
  gold_null_sourceable — some bronze source has it → the merge/policy dropped it: fix the pipeline
  gold_null_no_source  — no source has it → find a better source (FactSet live referee, filings, LSEG)
agent_start 11a shows the counts; the reviewing agent fixes the producer, then verifies the cell and the score.
"""
from __future__ import annotations

from collections import Counter

import data_issues as DI
from build_plan import connect, rows  # noqa: E402

FIELDS = {   # gold column → bronze field names that carry the same quantity
    "total_revenue": ["totalRevenue", "annualTotalRevenue"],
    "net_income": ["netIncome"],
    "cash_and_equivalents": ["cashAndEquivalents", "totalCash"],
    "total_debt": ["totalDebt"],
    "total_assets": ["totalAssets"],
}


def main() -> None:
    with connect() as conn:
        gold = rows(conn, f"""SELECT f.ticker, {', '.join('f.' + c for c in FIELDS)} FROM ticker_fundamentals f
                              JOIN ticker_registry r ON r.ticker = f.ticker
                              WHERE r.is_active AND r.fetch_fundamentals AND f.fund_score_computed_at IS NOT NULL""")
        bronze: dict = {}
        for r in rows(conn, """SELECT ticker, field, string_agg(source || '=' || value::text, ', ') s FROM source_fundamentals
                               WHERE value IS NOT NULL AND field = ANY(%s) GROUP BY 1, 2""",
                      ([f for v in FIELDS.values() for f in v],)):
            bronze[(r["ticker"], r["field"])] = r["s"]
    c = Counter()
    for g in gold:
        for col, names in FIELDS.items():
            if g[col] is not None:
                continue
            seen = "; ".join(f"{n}: {bronze[(g['ticker'], n)]}" for n in names if (g["ticker"], n) in bronze)
            kind = "gold_null_sourceable" if seen else "gold_null_no_source"
            c[kind] += 1
            DI.record("data_gaps.py", kind, ticker=g["ticker"], field=col, detail=seen or "no bronze source")
    print(f"data gaps: {len(gold)} scored names · " + " · ".join(f"{k} {v}" for k, v in c.items()))


if __name__ == "__main__":
    main()
