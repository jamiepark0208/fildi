# api-integration-test-harness

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | api |
| **Effort** | M (~1–2 sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md) |

### Resolution (2026-07-10)
Added a node:test harness for api-server with no live vendor calls: `merge-trusted.priority.test.ts` (15 tests covering `resolveFromIndex` and FIELD_DEFS priority locks) and `catalysts.test.ts` (20 tests covering all pure catalyst-building functions). Test script uses a glob so new test files are auto-discovered; total 35/35 pass. Test files import with `.ts` extensions because the `--experimental-strip-types` runner doesn't resolve `.js` → `.ts`. Phase B (a supertest healthz smoke test) was deferred — `app.ts` constructs a real Postgres session store on import, requiring `SESSION_SECRET`/`DATABASE_URL`, and no mockable seam exists yet.
