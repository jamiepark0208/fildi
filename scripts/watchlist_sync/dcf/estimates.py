"""Analyst consensus by fiscal year (A283 fix (a)): FMP /stable/analyst-estimates (annual) → watchlist_sync.consensus_annual.
Revenue and EBIT mean / high / low and analyst counts per fiscal year end — the DCF's years 1–3 centre (engine.consensus).
Watchlist first, refreshed weekly, at most --max calls a run (FMP budget 220/day shared with external_iv). Raw → vendor_raw,
calls metered in api_usage (source fmp). Names off our plan ("Premium") are retried after 30 days.
Usage: .venv/bin/python dcf/estimates.py [--max 60] [TICKERS...]"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect, rows  # noqa: E402
from external_iv import _fmp, _meter  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.consensus_annual (
    ticker text NOT NULL, fiscal_end date NOT NULL, as_of date NOT NULL,
    rev_avg double precision, rev_low double precision, rev_high double precision,
    ebit_avg double precision, ebit_low double precision, ebit_high double precision,
    eps_avg double precision, n_rev int, n_eps int, n_ebit int, source text NOT NULL DEFAULT 'fmp', actual boolean NOT NULL DEFAULT false,
    PRIMARY KEY (ticker, fiscal_end, as_of, source))"""
MISS = """CREATE TABLE IF NOT EXISTS watchlist_sync.consensus_annual_miss (ticker text PRIMARY KEY, as_of date NOT NULL, why text)"""


def refresh(conn, tickers: list[str], max_calls: int) -> int:
    conn.execute(DDL); conn.execute(MISS); conn.commit()
    calls = done = 0
    for t in tickers:
        last = rows(conn, "SELECT max(as_of) d FROM watchlist_sync.consensus_annual WHERE ticker = %s AND source = 'fmp'", (t,))[0]["d"]
        miss = rows(conn, "SELECT as_of FROM watchlist_sync.consensus_annual_miss WHERE ticker = %s", (t,))
        if (last and (date.today() - last).days < 7) or (miss and (date.today() - miss[0]["as_of"]).days < 30):
            continue
        if calls + 1 > max_calls:
            break
        d, err = _fmp(conn, "analyst-estimates", t, "&period=annual&limit=10", whole=True)
        calls += 1
        if not d:
            conn.execute("""INSERT INTO watchlist_sync.consensus_annual_miss VALUES (%s, %s, %s)
                            ON CONFLICT (ticker) DO UPDATE SET as_of = EXCLUDED.as_of, why = EXCLUDED.why""", (t, date.today(), err))
            conn.commit()
            continue
        for r in d:
            conn.execute("""INSERT INTO watchlist_sync.consensus_annual (ticker, fiscal_end, as_of, rev_avg, rev_low, rev_high,
                            ebit_avg, ebit_low, ebit_high, eps_avg, n_rev, n_eps) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                            ON CONFLICT (ticker, fiscal_end, as_of, source) DO NOTHING""",
                         (t, r["date"], date.today(), r.get("revenueAvg"), r.get("revenueLow"), r.get("revenueHigh"),
                          r.get("ebitAvg"), r.get("ebitLow"), r.get("ebitHigh"), r.get("epsAvg"),
                          r.get("numAnalystsRevenue"), r.get("numAnalystsEps")))
        conn.execute("DELETE FROM watchlist_sync.consensus_annual_miss WHERE ticker = %s", (t,))
        conn.commit()
        done += 1
    _meter(conn, calls)
    conn.commit()
    print(f"consensus_annual: {done} tickers, {calls} calls")
    return calls


def main() -> None:
    a = sys.argv[1:]
    mx = int(a[a.index("--max") + 1]) if "--max" in a else 60
    names = [x.upper() for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] != "--max")]
    with connect() as c:
        if not names:
            names = [r["t"] for r in rows(c, "SELECT DISTINCT UPPER(ticker) t FROM watchlist ORDER BY 1")]
        refresh(c, names, mx)


if __name__ == "__main__":
    main()
