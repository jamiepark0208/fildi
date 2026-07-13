# watchlist-peer-flag-cascade

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P1 |
| **Area** | overprocessing / multi-user |
| **Effort** | S |
| **Benefit** | Med — limits global backfill expansion |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

**Note: the task's originally proposed fix (delete the synchronous peer bulk-flag) was found incomplete during implementation and was NOT what shipped.** Tracing every reader of the `fetch_fundamentals` registry flag showed nightly enrichment, merge-trusted, startup-refresh, data-health, and all backfill scripts gate their universe on that flag — deleting the peer bulk-flag outright would have permanently stranded peer tickers from ever getting fundamentals data, since nothing else covers unflagged tickers.

Instead, shipped option B (moved, not deleted): removed the synchronous bulk `ticker_registry` update from `watchlist.ts` POST, and added a capped (25/run) peer-expansion step inside `nightly-enrichment.ts` that flags previously-unflagged peers of the already-flagged universe and folds them into that same run's fetch + merge pass, so peer-relative scoring still gets populated — just async on the existing twice-weekly schedule instead of synchronously on every watchlist add.

Verified live against the real running process (test user add showed flagged-peer count stayed at 0, previously would have jumped to 13) and via a read-only mirrored query confirming the expansion logic against ~294 real backlog peers. Did not run the actual nightly-enrichment fetch/merge pipeline end-to-end — deferred by explicit user request (not a blocker for this bug's acceptance criteria).
