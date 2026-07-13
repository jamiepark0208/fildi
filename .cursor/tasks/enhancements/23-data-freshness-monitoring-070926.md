# data-freshness-monitoring

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P2 |
| **Area** | data |
| **Effort** | S (enhance existing) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [polygon-av-backfill](24-polygon-av-backfill-completion-070926.md), [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md) |

### Resolution (2026-07-11)
An audit found most of this task's originally-scoped work already shipped (the `GET /api/admin/data-health` endpoint and ApiMonitorTab "Data Health" panel with fresh/stale/neverFetched counts and null-field ranking pre-existed). The real gap-fill was adding bronze row counts (`polygon_fundamentals`, `av_fundamentals`) to the health payload and UI, so empty bronze tables are no longer invisible to admins.
