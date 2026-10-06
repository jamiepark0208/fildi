"""Delete all locally stored LSEG data (USC student license: remove vendor data when affiliation ends).

Drops schema lseg_research, blanks LSEG-owned columns (ric/cusip/isin) on research_common.security_map
(WRDS columns untouched), deletes research/common/out/earnings_watch.json, and removes 'lseg' rows from api_usage.
The app degrades gracefully: /api/research/lseg/* return available:false when the schema is missing.

Usage: .venv/bin/python purge.py --dry-run | --confirm
"""
from __future__ import annotations

import argparse

from _session import RESEARCH, connect_local


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--confirm", action="store_true")
    args = p.parse_args()
    watch = RESEARCH / "common" / "out" / "earnings_watch.json"
    with connect_local() as conn:
        tables = conn.execute(
            "SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'lseg_research' ORDER BY 1"
        ).fetchall()
        mapped = conn.execute(
            "SELECT count(*) FROM research_common.security_map WHERE ric IS NOT NULL OR cusip IS NOT NULL OR isin IS NOT NULL"
        ).fetchone()[0]
        print("would delete:" if args.dry_run else "deleting:")
        for t, n in tables:
            print(f"  lseg_research.{t}: {n} rows")
        print(f"  research_common.security_map LSEG columns on {mapped} rows")
        print(f"  {watch} ({'exists' if watch.exists() else 'absent'})")
        if args.dry_run:
            return
        conn.execute("DROP SCHEMA IF EXISTS lseg_research CASCADE")
        conn.execute("UPDATE research_common.security_map SET ric = NULL, cusip = NULL, isin = NULL, updated_by_lseg = NULL")
        conn.execute("DELETE FROM research_common.security_map WHERE ibes_oftic IS NULL AND crsp_permno IS NULL")
        conn.execute("DELETE FROM api_usage WHERE source = 'lseg'")
        conn.commit()
    watch.unlink(missing_ok=True)
    print("done. Also remove LSEG_APP_KEY from .env.local and revoke the key in Workspace (APPKEY).")


if __name__ == "__main__":
    main()
