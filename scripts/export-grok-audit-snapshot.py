#!/usr/bin/env python3
"""A162 stage 1 — allowlisted aggregate snapshot for Grok audits (no holdings/secrets).

Run with watchlist venv:
  scripts/watchlist_sync/.venv/bin/python scripts/export-grok-audit-snapshot.py

Writes to FILDI_GROK_AUDIT_DIR (default ~/.fildi/grok-audit/). Cite snapshot_at always.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402

BANNED = re.compile(r"account|secret|token|password|holding|credential|apikey|api_key", re.I)
OUT_DIR = Path(os.environ.get("FILDI_GROK_AUDIT_DIR", Path.home() / ".fildi" / "grok-audit"))


def _safe_ident(*names: str) -> None:
    for c in names:
        if BANNED.search(c or ""):
            raise SystemExit(f"export refused: name matches deny-list: {c}")


def one(conn, sql: str):
    """Run one query; rollback to savepoint on error so the txn stays usable."""
    with conn.cursor() as cur:
        cur.execute("SAVEPOINT grok_audit")
        try:
            cur.execute(sql)
            cols = [d.name for d in cur.description] if cur.description else []
            _safe_ident(*cols)
            row = cur.fetchone()
            cur.execute("RELEASE SAVEPOINT grok_audit")
            return dict(zip(cols, row)) if row else {}
        except Exception as e:
            cur.execute("ROLLBACK TO SAVEPOINT grok_audit")
            return {"error": str(e).split("\n")[0][:160]}


def main() -> None:
    now = datetime.now(timezone.utc)
    snap: dict = {
        "snapshot_at": now.isoformat(),
        "schema": "grok-audit-v1",
        "note": "Aggregates only. Cite snapshot_at in every answer. Excludes portfolio holdings, account ids, secrets.",
    }
    with connect() as conn:
        snap["freshness"] = {
            "fund_score_snapshots": one(conn, "SELECT count(*)::int AS n, max(computed_at)::text AS max_ts FROM fund_score_snapshots"),
            "tech_score_snapshots": one(conn, "SELECT count(*)::int AS n, max(computed_at)::text AS max_ts FROM tech_score_snapshots"),
            "ticker_technicals": one(conn, "SELECT count(*)::int AS n, max(technicals_last_fetched)::text AS max_ts FROM ticker_technicals"),
            "prices_historical": one(conn, "SELECT count(*)::int AS n, max(date)::text AS max_ts FROM prices_historical"),
            "enrichment_runs": one(conn, "SELECT count(*)::int AS n, max(started_at)::text AS max_ts FROM enrichment_runs"),
        }

        # coverage on latest as_of only
        snap["fund_coverage"] = one(conn, """
            WITH latest AS (SELECT max(as_of) AS a FROM fund_score_snapshots)
            SELECT count(*)::int AS n,
                   count(fund_total)::int AS with_score,
                   round(100.0 * count(fund_total) / nullif(count(*),0), 1) AS pct
            FROM fund_score_snapshots f, latest WHERE f.as_of = latest.a""")
        snap["tech_coverage"] = one(conn, """
            WITH latest AS (SELECT max(as_of) AS a FROM tech_score_snapshots)
            SELECT count(*)::int AS n,
                   count(tech_total)::int AS with_score,
                   round(100.0 * count(tech_total) / nullif(count(*),0), 1) AS pct
            FROM tech_score_snapshots t, latest WHERE t.as_of = latest.a""")

        snap["forecast_ledger"] = one(conn, """
            SELECT count(*) FILTER (WHERE outcome IS NOT NULL)::int AS resolved,
                   count(*) FILTER (WHERE outcome IS NULL)::int AS open,
                   count(*)::int AS total
            FROM watchlist_sync.forecast_ledger""")

        snap["stamps"] = {
            "model_recs_max_date": one(conn, "SELECT max(snapshot_date)::text AS v FROM model_recs").get("v"),
            "option_score_snapshots_max": one(conn, "SELECT max(as_of)::text AS v FROM option_score_snapshots").get("v"),
            "fund_score_snapshots_max": one(conn, "SELECT max(as_of)::text AS v FROM fund_score_snapshots").get("v"),
            "tech_score_snapshots_max": one(conn, "SELECT max(as_of)::text AS v FROM tech_score_snapshots").get("v"),
            "enrichment_runs_last": one(conn, "SELECT max(started_at)::text AS v FROM enrichment_runs").get("v"),
        }

        # app_config: keys only + short non-secret previews
        cfg = one(conn, "SELECT count(*)::int AS n FROM app_config")
        snap["app_config_n"] = cfg.get("n")
        with conn.cursor() as cur:
            cur.execute("SELECT key, left(value::text, 60) AS value FROM app_config ORDER BY key LIMIT 40")
            cols = [d.name for d in cur.description]
            _safe_ident(*cols)
            safe = []
            for key, val in cur.fetchall():
                if BANNED.search(key or "") or BANNED.search(val or ""):
                    continue
                safe.append({"key": key, "value_preview": val})
            snap["app_config_preview"] = safe

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    latest = OUT_DIR / "snapshot-latest.json"
    dated = OUT_DIR / f"snapshot-{now.strftime('%Y%m%d')}.json"
    text = json.dumps(snap, indent=2, default=str) + "\n"
    latest.write_text(text)
    dated.write_text(text)
    print(json.dumps({"ok": True, "path": str(latest), "snapshot_at": snap["snapshot_at"]}))


if __name__ == "__main__":
    main()
