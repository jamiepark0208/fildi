# register-empty-watchlist

| Field | Value |
|---|---|
| **Status** | rejected — 2026-07-10 |
| **Priority** | P1 |
| **Area** | multi-user / onboarding |
| **Created** | 2026-07-10 |
| **Type** | FIX (rejected — product decision) |

## Resolution

Confirmed real (register only inserted into `users`, no watchlist rows) and implemented: bulk insert `WATCHLIST` (31 tickers) with `getTier()` + `status: monitoring`, `onConflictDoNothing()` for idempotency. Verified live.

**Reverted at explicit user direction.** Product decision: watchlists must be user-specific with zero cross-account seeding — new accounts start empty, not pre-loaded with a shared "house" list. `auth.ts` is back to inserting only the user row.

**Do not re-attempt as filed.** If empty-watchlist onboarding UX is still wanted, it needs a different design (e.g. an explicit opt-in "add starter tickers" prompt) — file as a new task, not a revival of this one.
