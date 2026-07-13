# pg-pool-session-contention

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P1 |
| **Area** | continuous-run / multi-user |
| **Effort** | S |
| **Benefit** | Med — fewer pool timeouts under concurrent load |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Applied fix option A: `lib/db/src/index.ts` pool now sets `max: Number(process.env.DATABASE_POOL_MAX ?? 20)` and `idleTimeoutMillis: 30_000`, env-tunable with a safe default (up from the pg default of 10). Did not build a dedicated second pool for `connect-pg-simple` sessions (option B / phase 2) — out of scope for this pass. Documented `DATABASE_POOL_MAX` in `.claude/skills/build-and-run.md`. Verified typecheck clean; no load test was run (needs real concurrent traffic to observe, manual-only).
