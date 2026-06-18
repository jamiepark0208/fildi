# TradeDash — Project Context
> last_updated: 2026-06-10 | update when architecture or data sources change

## What this is
Institutional-grade put-selling research tool. Surfaces put candidates by scoring fundamentals + technicals + options premium.

## Architecture
- **Frontend:** React 18 + TypeScript + Tailwind SPA — `artifacts/stock-compare/` — port 8081 (Vite, hot-reloads)
- **Backend:** Node/Express ESM API — `artifacts/api-server/` — port 8080 — **NO hot-reload; must rebuild after every src change**
- **DB:** PostgreSQL via Drizzle ORM — `lib/db/`
- **No Redis** — in-memory TTLCache only (`lib/ttl-cache.ts` — shared utility with stats tracking)
- **Admin cache dashboard** — GET /api/admin/cache/status, DELETE /api/admin/cache/clear/:name (settings page)

## Two scoring layers (self-relative, peer-set invariant)

**Fundamental scorer** (`computeRankingsV2` in `rankings.ts`)
- 4 families: Value 20%, Growth 25%, Quality 35%, Safety 20%
- Data source: FMP API, weekly refresh
- DB table: `tickerFundamentals`

**Technical scorer** (`computeTechnicalRankingsV2` in `technical-rankings.ts`)
- 6 components: oversoldDepth 25%, reversalSignal 20%, volatilityState 22%, trendContext 18%, optionsFlow 10%, volumeConfirm 5%
- Data source: Yahoo Finance `.chart()`, OHLCV 420 calendar days, daily refresh
- DB table: `tickerTechnicals` (55 cols)

## Data sources
- **FMP API:** fundamentals, weekly (budget guard: 220 calls/day via `fmp_api_usage` table)
- **Yahoo Finance (yahoo-finance2):** OHLCV via `.chart()`, options via `.options()` — always pass `{validateResult:false}`
- **FRED:** macro data, 4h file cache at `artifacts/macro-data.json`
- **Treasury.gov CSV:** yield curve

## Watchlist
Tickers defined in the `watchlist` DB table (3 tiers). Tags: blue=holding/assigned, green=long conviction, yellow=moderate/income, purple=market context.
Financial tickers excluded from roicWaccSpread: HOOD, SOFI.

## Key DB tables
| Table | Purpose |
|---|---|
| `watchlist` | tickers with tier/status/tag |
| `positions` | short_put / short_call / long_stock / long_call / long_put |
| `signal_log` | fired signals with outcome tracking |
| `prices_historical` | OHLCV, INSERT OR IGNORE |
| `scorecard_cache` | RSI/MFI/indicator results, upsert on (ticker, scored_date) |
| `tickerFundamentals` | fundamental scorer output |
| `tickerTechnicals` | technical scorer output (55 cols) |
| `fmp_api_usage` | budget guard (callsToday, resetDate) |

## Options scanner
Combines both scores + options chain to surface put candidates by premium/strike ratio, signal, and combined score.
Extra/hidden tickers persisted to localStorage (`fildi_scanner_extra`, `fildi_scanner_hidden`).

## AI explain endpoint
`POST /api/explain/score` — Haiku, 200 tokens, no storage. "Explain" button in Rankings Leaderboard + Technical Leaderboard; session-cached per ticker.

## Context files
- **API endpoints**: `.agents/context/api-endpoints.md` (all routes — check before adding new ones)
- Full skills: `.claude/skills/` (tracked in git — readable by all agents)
- Memory/lessons: `.agents/memory/` (MEMORY.md index)
- Active tasks: `.agents/tasks/`
- Phase reports: `.claude/docs/`
