A356 Phase 1 — external tools audit, mechanical evidence. Read research/common/asks/A356.md (Ask + Detail) first; it lists columns, sources, and exact files. Agent: cursor, Refs: A356.
Write ONLY research/common/external-tools-audit.md (new) and append your packet to A356.md § Reviews. Read-only everywhere else. No secrets: env key names only.
Fast paths (use these, don't search the tree):
- Calls: psql "$DATABASE_URL" (source .env.local) — api_usage(source, date, calls_made).
- Schema before SQL: scripts/dbcols.sh <table>.
- Jobs: artifacts/api-server/src/lib/scheduled-tasks-inventory.ts; ls ~/Library/LaunchAgents | grep -i fildi; scripts/install-*-launchd.sh.
- Catalog: artifacts/api-server/src/lib/data-sources-catalog.ts; research/common/data-inventory.md.
- UI: route file → grep its /api path in artifacts/stock-compare/src → component → which pages/*.tsx imports it (tab name).
- AI: grep each source's table/route/field names in lib/ai-explain.ts, routes/explain.ts, lib/haiku.ts, lib/desk-facts.ts, routes/stock-context.ts, lib/breakdown-enrichment.ts.
- Universe count: select count(*) from fmp_fundamentals.
Table: one row per source, 10 columns exactly as A356 Detail. Below the table: "Overlaps" (field → sources → which wins, cite FIELD_DEFS in scripts/merge-trusted.ts), "Not shown in UI", "Not in AI context", "Dead keys/code".
Packet ≤ 20 lines: counts per finding type, top 10 findings. Commit your 2 files (trailers Refs: A356, Agent: cursor), then scripts/agent-git-sync.sh. Budget 60 min.
