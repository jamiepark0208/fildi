"""11-11 (Jamie: "stale sec filings should be checked… everyone compared against the same dated data").

Per ticker, from what sec_gold_fields already stored (vendor_raw, 0 API calls):
  filed   = newest periodic filing in EDGAR submissions (10-K/10-Q/20-F/40-F) and its report period
  facts   = newest balance-sheet period in companyfacts (us-gaap or ifrs-full Assets)
Kinds logged to data_issues:
  sec_facts_lag   — EDGAR has a newer report than companyfacts carries (TSM: 20-F for FY25 filed 2026-04-16, facts stop FY24)
  sec_no_recent   — no periodic filing in 400 d (delisted / foreign filer moved off EDGAR)
  period_spread   — prints the spread of fact periods across the universe so mixed-date comparisons are visible
Run: .venv/bin/python sec_staleness.py [--quiet]
"""
from __future__ import annotations

import collections
import json
import sys
from datetime import date

from build_plan import connect, rows
import data_issues

PERIODIC = ("10-K", "10-Q", "20-F", "40-F", "10-K/A", "20-F/A")
LAG_DAYS = 45


def _latest(conn, endpoint: str) -> dict[str, dict]:
    out = {}
    for r in rows(conn, """SELECT DISTINCT ON (key) key, payload FROM vendor_raw WHERE source = 'sec' AND endpoint = %s
                           ORDER BY key, fetched_on DESC""", (endpoint,)):
        p = r["payload"]
        out[r["key"]] = p if isinstance(p, dict) else json.loads(p)
    return out


def newest_report(sub: dict) -> tuple[str, str, str] | None:
    rec = (sub.get("filings") or {}).get("recent") or {}
    best = None
    for form, filed, period in zip(rec.get("form", []), rec.get("filingDate", []), rec.get("reportDate", [])):
        if form in PERIODIC and period and (best is None or period > best[2]):
            best = (form, filed, period)
    return best


def newest_fact_end(facts: dict) -> str | None:
    ends = []
    for tax in ("us-gaap", "ifrs-full"):
        node = ((facts.get("facts") or {}).get(tax) or {}).get("Assets") or {}
        for vals in (node.get("units") or {}).values():
            ends += [u["end"] for u in vals if not u.get("start")]
    return max(ends) if ends else None


def main() -> None:
    quiet = "--quiet" in sys.argv
    today = date.today()
    with connect() as conn:
        subs, facts = _latest(conn, "submissions"), _latest(conn, "companyfacts")
    lag, gone, ends = [], [], collections.Counter()
    for t, sub in subs.items():
        rep = newest_report(sub)
        fe = newest_fact_end(facts.get(t) or {})
        if fe:
            ends[fe[:7]] += 1
        if rep is None or (today - date.fromisoformat(rep[1])).days > 400:
            gone.append(t)
            data_issues.record("sec_staleness.py", "sec_no_recent", ticker=t, field="filing",
                               detail=f"newest periodic filing {rep[1] if rep else 'none'} ({rep[0] if rep else '-'})")
            continue
        if fe and (date.fromisoformat(rep[2]) - date.fromisoformat(fe)).days > LAG_DAYS:
            lag.append((t, rep, fe))
            data_issues.record("sec_staleness.py", "sec_facts_lag", ticker=t, field="companyfacts",
                               detail=f"{rep[0]} for period {rep[2]} filed {rep[1]}, companyfacts Assets stop {fe} → need filing-level XBRL or another source")
    print(f"sec staleness: {len(subs)} filers · facts lag the newest report > {LAG_DAYS} d: {len(lag)} · no periodic filing 400 d: {len(gone)}")
    if not quiet:
        print("  lag:", " ".join(f"{t}({fe[:7]}<{rep[2][:7]})" for t, rep, fe in sorted(lag)[:40]))
        print("  no recent:", " ".join(sorted(gone)[:40]))
        print("  fact period mix (YYYY-MM: n):", dict(sorted(ends.items())[-8:]))


if __name__ == "__main__":
    main()
