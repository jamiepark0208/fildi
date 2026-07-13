# analyst-data-persistence

| Field | Value |
|---|---|
| **Status** | done (Track 1) — Track 2 (Finviz PT) still pending spike |
| **Priority** | P1 |
| **Area** | data |
| **Effort** | L (Track 1 M; Track 2 M after spike) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research + user-request |
| **Skill** | `.claude/skills/data-agent.md`, `caching-patterns.md`, `db-patterns.md` |

### Resolution — Track 1 done (2026-07-11), Track 2 open
Track 1 shipped: new `yahoo_analyst_actions` (bronze) + `analyst_events` (gold) tables, applied via hand-extracted additive SQL. Verified end-to-end on NVDA (982 raw Yahoo events → 164 deduped rows in both tables). Breakdown route is now DB-first for analyst actions when fresh (<7d), with live Yahoo fallback + write-through otherwise — full-universe backfill was intentionally deferred since this fallback makes it safe to skip. Found and fixed two bugs during verification: `getStaleAnalystTickers` used a raw SQL array literal that drizzle doesn't serialize correctly (fixed with `inArray`), and `fetchYahooAnalystActions` only logged API calls on failure, making Yahoo volume invisible to the API Monitor (added success-path logging). Wired the previously-dead `analystActions` prop into a new "Analyst Rating Changes" table in `AnalystRatingsSection`. FE `buildCatalysts` dedupe (originally W5) was confirmed already unnecessary. **Track 2** (Finviz per-firm price targets) still needs its coverage spike before any schema/backfill work.
