# watchlist-no-max-size

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P1 |
| **Area** | multi-user / perf |
| **Effort** | XS |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Added a `MAX_WATCHLIST_SIZE = 75` guard in `routes/watchlist.ts` POST — counts existing rows before insert and returns 400 when at cap. `use-watchlist.ts`'s `addEntry` now checks response status and surfaces the 400 via a destructive-variant toast, matching the existing error-toast pattern elsewhere in the app. Verified via the full api-server test suite (35 pass) and clean typecheck on both packages.
