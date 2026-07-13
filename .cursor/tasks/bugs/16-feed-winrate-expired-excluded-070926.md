# feed-winrate-expired-excluded

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | correctness |
| **Effort** | S |
| **Benefit** | Med — trustworthy track record |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Extended the `wins`/`losses` SQL CASE in the profile-stats query (`routes/feed.ts`) to also count `EXPIRED_WIN`/`EXPIRED_LOSS` statuses, matching the client-side `TopPerformers` aggregation in `feed.tsx` exactly. The separate `closed` stat (manual-close only) was left untouched since it has a distinct, correct meaning. Added an inline comment documenting the resolved-status set. No unit test added — this codebase's test suite is pure-function only, and a DB-fixture harness for SQL CASE logic was out of scope. Verified via clean typecheck.
