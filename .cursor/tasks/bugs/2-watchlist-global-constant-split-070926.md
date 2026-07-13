# watchlist-global-constant-split

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P0 |
| **Area** | multi-user / data |
| **Effort** | L (3–5 sessions) |
| **Benefit** | Critical — scorecard/scanner must match user's DB watchlist |
| **Implementation risk** | High — touches seeder, technical, scanner, constants |
| **Created** | 2026-07-10 |
| **Source** | bugs production-readiness audit |
| **Type** | FIX (SSOT) |

## Resolution

Implemented session-scoped scorecard: new `lib/watchlist-tickers.ts` provides `getUserWatchlistTickers`, `getUnionWatchlistTickers` (all users' distinct tickers ∪ default `WATCHLIST` seed), and `isTickerOnUserWatchlist`. `routes/technical.ts` scorecard/refresh endpoints now read the authenticated user's watchlist; `routes/indicators.ts` gates on `isTickerOnUserWatchlist` and defaults batch requests to the caller's watchlist; `lib/seeder.ts`'s `getMissingTickers` now sources from the union query so newly-added tickers get backfilled overnight (ticker_config bootstrap seeding intentionally left on the static `WATCHLIST`). Admin refresh routes (`technicals.ts`, `fundamentals.ts`) switched to the union query to cover all users. `constants.ts` `WATCHLIST` is now documented as seed-template-only, not runtime SSOT.

Not touched (out of scope): `lib/macro-highlights.ts`, `lib/startup-refresh.ts` (separate bug), and one-off backfill CLI scripts. Verified: full api-server (35) and stock-compare (268) test suites pass, typecheck clean on both packages.
