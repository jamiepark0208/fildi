# home-hardcoded-fundamental-universe

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P1 |
| **Area** | ui / multi-user |
| **Effort** | S (~half day) |
| **Benefit** | High — home rankings match user's watchlist |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Removed the hardcoded `FUNDAMENTAL_WATCHLIST` array from `home.tsx`. The peer-groups query now uses `useWatchlist().tickers`, gated with `enabled: watchlistTickers.length > 0`; the rankings memo filters `serverRankings` down to that ticker set before mapping to `StockScore[]`. The related out-of-scope note in `new_app_features/4-home-dashboard-redesign` (which assumed the hardcode) was not rescoped as part of this fix — flagged for a follow-up doc pass. Verified via `tsc --noEmit` (clean) and the full stock-compare test suite (268 pass).
