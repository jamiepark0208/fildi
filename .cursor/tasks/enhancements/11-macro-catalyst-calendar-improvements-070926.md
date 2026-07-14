# macro-catalyst-calendar-improvements

| Field | Value |
|---|---|
| **Status** | done — 2026-07-14 |
| **Priority** | P1 |
| **Area** | ui |
| **Created** | 2026-07-09 |
| **Type** | ENHANCE (rescoped) |

## Resolution

Audit found W1/W2 (event list above TV embed) ~90% pre-built already — an existing "Tracked Events" list in `macro.tsx` just sat below `TradingViewEconomicCalendar` instead of above it — and W5's click-to-Regime plumbing (`setActiveTab`/`selectedIndicatorKey`) already existed from enh/10. W3 (color-code by portfolio/watchlist) was dropped: `MacroEvent` has no ticker field and `ECONOMIC_EVENTS` is pure macro-wide releases (CPI, FOMC, NFP...), so there's nothing to bucket by book membership. W4 (earnings) was redirected off this task per user decision — earnings are personal-to-book in a way macro releases aren't, and belong on Watchlist/Portfolio instead (see below).

**Built:** renamed "Tracked Events" → "Your Week", moved above the TV embed with TV-vs-FILDI helper copy; `EventRow` now takes `onJumpToIndicator` — a substring map (CPI, Core PCE, PPI, NFP, JOLTS, GDP, Retail Sales, Consumer Sentiment, ISM PMI, FOMC → `INDICATOR_SERIES` key) makes high-signal rows clickable through to the Regime tab with that indicator pre-selected. No new fetches, no N+1.

**Earnings side-quest (redirected here):** Watchlist stock breakdown already surfaced earnings via `buildCatalysts`/`CatalystsSection` — no change needed. Portfolio tab didn't have it: added `calendarEvents` to the existing per-position Yahoo `quoteSummary` call (same call, one more module, no new round-trip), threaded `earningsDate` through `StockMetrics` (openapi.yaml → regenerated `api-zod`/`api-client-react`), and added an "ER Nd" badge on positions with earnings within 7 days.
