#!/usr/bin/env python3
"""A357 step 4 — re-grade A352 on LSE traded entry premiums (run after full backfill).

Pre-registered pass/fail: see research/common/asks/A357.md § Re-grade.
Writes research/studies/a357-real-price-regrade.md when invoked.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

REPORT = HERE.parent.parent.parent / "research" / "studies" / "a357-real-price-regrade.md"
WEEK_FLOOR = __import__("datetime").date(2025, 10, 20)


def main() -> None:
    from build_plan import connect
    from build_plan_parts.db import rows

    with connect() as conn:
        n = rows(
            conn,
            "SELECT COUNT(DISTINCT occ)::int AS n FROM lse_option_daily",
        )[0]["n"]
        pending = rows(
            conn,
            """SELECT COUNT(*)::int AS n FROM (
                 SELECT 1 FROM lse_option_fetch_log WHERE status = 'no_data'
               ) x""",
        )[0]["n"]
    if n < 100:
        raise SystemExit(
            f"A357 regrade blocked: lse_option_daily has only {n} OCC(s). "
            "Finish scripts/watchlist_sync/analysis/a357_lse_option_backfill.py first."
        )
    print(f"TODO step 4: implement regrade on {n} OCCs ({pending} logged no-data); report → {REPORT}", flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
