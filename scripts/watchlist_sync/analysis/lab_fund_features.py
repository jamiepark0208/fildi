#!/usr/bin/env python3
"""Scorecard lab, fundamentals lane: point-in-time analyst-expectation features → watchlist_sync.lab_fund.

Only the expectations family has point-in-time history today (WRDS IBES statsum/surpsum, 2020+, ~270 names; Cursor's pull).
Quality / value / growth / safety need filed-date statement history (edgar_statement_history covers 20 names), so they are
not graded yet (see out/lab/conclusions.md, data ask).

Definitions mirror the live engine (fund-derived-metrics.ts / breakdown-enrichment.ts):
  ibes_breadth   (numup − numdown) / numest, FY1 annual EPS, latest statpers ≤ as_of
  ibes_sue       mean of the last 4 SUE scores (anndats ≤ as_of), each clipped to ±5
  ibes_drift     (meanest − previous statpers meanest) / |previous|, FY1          (engine's meanDriftPct ÷ 100)
plus two standard variants for comparison: ibes_drift_3m (vs ~3 months earlier) and ibes_disp (stdev / |meanest|, lower = better).

Usage: .venv/bin/python analysis/lab_fund_features.py
"""
from __future__ import annotations

import json
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.lab_fund (
  ticker text NOT NULL, as_of date NOT NULL, features jsonb NOT NULL, computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, as_of))"""


def f(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    with connect() as conn:
        conn.execute(DDL)
        keys = rows(conn, "SELECT DISTINCT ticker, as_of FROM watchlist_sync.lab_outcomes")
        st = defaultdict(list)
        for r in rows(conn, """SELECT UPPER(oftic) t, statpers d, numest, numup, numdown, meanest, stdev FROM wrds_research.ibes_statsum
                               WHERE measure = 'EPS' AND fiscalp IN ('ANN', 'Y') AND fpi IN ('1', '1.0') AND oftic IS NOT NULL ORDER BY 1, 2"""):
            st[r["t"]].append(r)
        su = defaultdict(list)
        for r in rows(conn, """SELECT UPPER(oftic) t, anndats d, suescore FROM wrds_research.ibes_surpsum
                               WHERE measure = 'EPS' AND oftic IS NOT NULL AND suescore IS NOT NULL ORDER BY 1, 2"""):
            su[r["t"]].append(r)
    out = []
    for k in keys:
        t, a = k["ticker"], k["as_of"]
        s = st.get(t, [])
        i = bisect_right([r["d"] for r in s], a) - 1
        feats = {}
        if i >= 0 and (a - s[i]["d"]).days <= 45:          # stale estimates (> 45 days) treated as missing
            r = s[i]
            n, up, dn, m = f(r["numest"]), f(r["numup"]) or 0, f(r["numdown"]) or 0, f(r["meanest"])
            feats["ibes_breadth"] = (up - dn) / n if n and n > 0 else None
            if i >= 1 and m is not None and f(s[i - 1]["meanest"]):
                feats["ibes_drift"] = (m - f(s[i - 1]["meanest"])) / abs(f(s[i - 1]["meanest"]))
            j = bisect_right([q["d"] for q in s], a - timedelta(days=90)) - 1
            if j >= 0 and m is not None and f(s[j]["meanest"]):
                feats["ibes_drift_3m"] = (m - f(s[j]["meanest"])) / abs(f(s[j]["meanest"]))
            sd = f(r["stdev"])
            feats["ibes_disp"] = sd / abs(m) if sd is not None and m else None
            feats["ibes_numest"] = n
        u = [max(-5.0, min(5.0, f(x["suescore"]))) for x in su.get(t, []) if x["d"] <= a and f(x["suescore"]) is not None][-4:]
        feats["ibes_sue"] = sum(u) / len(u) if u else None
        out.append((t, a, json.dumps(feats)))
    with connect() as conn:
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.lab_fund (ticker, as_of, features) VALUES (%s, %s, %s)
                               ON CONFLICT (ticker, as_of) DO UPDATE SET features = EXCLUDED.features, computed_at = now()""", out)
        conn.commit()
    cov = sum(1 for _, _, x in out if json.loads(x).get("ibes_breadth") is not None)
    print(f"lab_fund: {len(out)} rows · breadth coverage {cov / max(1, len(out)):.0%}")


if __name__ == "__main__":
    main()
