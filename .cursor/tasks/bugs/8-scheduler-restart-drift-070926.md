# scheduler-restart-drift

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P1 |
| **Area** | continuous-run |
| **Effort** | M |
| **Benefit** | Med — avoid duplicate enrichment |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Applied fix option A inline in `scheduler.ts` rather than a separate config-keys module — same select-then-insert-or-update pattern as `scoring-config-db.ts`, storing key `last_enrichment_run` on the existing `app_config` table (confirmed present, no migration needed). `startScheduler()` is now async: it awaits loading the persisted last-run value to hydrate the in-memory `lastEnrichmentRun` export before registering the 30-minute interval, so `data-health.ts` needed no changes. After a successful run it persists the ISO timestamp back to the DB. Updated the `index.ts` call site to `.catch()` since the function is now async.

Verified typecheck clean and full test suite passing. Did not add a unit test for the persistence logic (DB-backed, outside this repo's pure-function test pattern) and did not manually verify a real restart during the Sun/Thu 02:00 UTC window (manual-only, needs the actual schedule window).
