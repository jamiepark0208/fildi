# session-table-growth

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | continuous-run |
| **Effort** | S |
| **Benefit** | Med — long-run DB health |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Added `pruneSessionInterval: 900` (15 min) to the `PgSession` store config in `app.ts`. connect-pg-simple's built-in pruner deletes rows past the `expire` column on that interval, leaving active sessions and the `rolling: true` refresh behavior untouched since it only targets already-expired rows. Uses the same shared pool whose connection budget was already increased (bug/6), so the periodic prune query has headroom. Verified via clean typecheck; no manual production-scale row-count verification performed (needs months of real traffic to observe).
