"""Delete all locally stored WRDS research data (USC student license end-of-affiliation).

Drops schema wrds_research, blanks WRDS-owned columns on research_common.security_map
(ibes_oftic, crsp_permno, cusip8 — LSEG ric/isin untouched), and removes 'wrds' rows from api_usage.
The app degrades gracefully: /api/research/wrds/* return available:false when the schema is missing.

Usage: .venv/bin/python purge.py --dry-run | --confirm
"""
from __future__ import annotations

import argparse

from db import connect_local


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--confirm", action="store_true")
    args = p.parse_args()
    with connect_local() as conn:
        tables = conn.execute(
            "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'wrds_research' ORDER BY 1"
        ).fetchall()
        mapped = conn.execute(
            """
            SELECT count(*) FROM research_common.security_map
            WHERE ibes_oftic IS NOT NULL OR crsp_permno IS NOT NULL
            """
        ).fetchone()[0]
        print("would delete:" if args.dry_run else "deleting:")
        for t, n in tables:
            print(f"  wrds_research.{t}: {n} rows")
        print(f"  research_common.security_map WRDS columns on {mapped} rows")
        print("  api_usage WHERE source = 'wrds'")
        if args.dry_run:
            return
        conn.execute("DROP SCHEMA IF EXISTS wrds_research CASCADE")
        # Blank WRDS-owned identity cols only — leave LSEG ric/cusip/isin alone.
        conn.execute(
            """
            UPDATE research_common.security_map
            SET ibes_oftic = NULL, crsp_permno = NULL, updated_by_wrds = NULL
            """
        )
        # Drop orphan map rows with neither lane filled (same spirit as LSEG purge).
        conn.execute(
            """
            DELETE FROM research_common.security_map
            WHERE ibes_oftic IS NULL AND crsp_permno IS NULL
              AND ric IS NULL AND cusip IS NULL AND isin IS NULL
            """
        )
        conn.execute("DELETE FROM api_usage WHERE source = 'wrds'")
        conn.commit()
    print("done. Also remove WRDS_USERNAME/WRDS_PASSWORD from .env.local if affiliation ended.")


if __name__ == "__main__":
    main()
