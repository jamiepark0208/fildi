# polygon-av-backfill-completion

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P2 |
| **Area** | data |
| **Effort** | M (ops + small script fixes; no FIELD_DEFS priority changes) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [data-freshness](23-data-freshness-monitoring-070926.md), L-01 / L-04 |

### Resolution (2026-07-11)
Bronze tables (`polygon_fundamentals`, `av_fundamentals`) populated by running the existing (already-built) backfill scripts — no client/pipeline rewrite needed, since Polygon/AV clients, `merge-trusted.ts` FIELD_DEFS priorities, and the AV 25/day budget guard already existed. A stale header comment in `backfill-av.ts` claiming AV wasn't wired into FIELD_DEFS (false as of this task) was fixed. AV rotation was not put on a cron — expected, since job-queue infra (enh/28) remains deferred; manual/cron-documented runs are the interim path.
