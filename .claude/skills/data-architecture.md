---
name: data-architecture
description: What to fetch, how often, what to cache. Read before writing any fetch or cache code.
---
## Data tiers

### Tier A — Persistent (once per day, never re-fetch)
  Historical OHLCV → PostgreSQL `prices_historical`, INSERT OR IGNORE on (ticker, date)
  RSI/MFI signal   → PostgreSQL `indicator_cache` (renamed from `scorecard_cache` — if you see
                     the old name anywhere it's stale), upsert on (ticker, scored_date)
  Fundamentals     → PostgreSQL `ticker_fundamentals` (Bronze→Silver→Gold pipeline, see db-patterns.md)
  Technicals (V2)  → PostgreSQL `ticker_technicals`, 55+ cols, see technical-scorecard.md
  Ticker metadata  → PostgreSQL `watchlist` / `ticker_registry`, fetch on init only
  RSI thresholds   → hardcoded in `src/lib/constants.ts` (31-ticker legacy tier map — NOT the
                     257-ticker fundamentals universe, see signal-filters.md), not fetched

### Tier B — In-memory (page load + manual refresh button only)
  Current price    → in-memory TTLCache, no DB persistence, no Redis
  5-day return     → derived from current price + prices_historical

### Tier C — Short-lived in-memory cache (options)
  Options chain       → TTLCache 30 min per ticker (routes/options.ts `optionsCache`)
                        Expiry calendar → TTLCache 24h shared key (lib/options.ts `expiryCache`)
                        First request per day skips undated fetch; subsequent tickers reuse dates

## Indicator refresh logic (getIndicators, lib/indicators.ts) — one of two live scoring systems
This is the simpler RSI/MFI GO/WATCH/NO signal, not the primary V2 scorer (see
technical-scorecard.md for that — both run independently and are both rendered in the UI).
  1. Check indicator_cache for (ticker, today) → return immediately if found (unless refresh=true)
  2. Read prices_historical for ticker, last 90 calendar days
  3. If rows >= 60 → compute RSI/MFI directly from DB rows (no yfinance call)
  4. If rows < 60 → fetch 90d from yfinance, INSERT OR IGNORE into prices_historical,
     compute from fetched data
  5. Upsert result into indicator_cache
  Populated two ways: lib/seeder.ts runs this at server **boot** (not a nightly cron) for any
  watchlist ticker missing today's row; routes/indicators.ts and routes/technical.ts also call
  it on-demand from user-triggered refresh requests.

## Per-ticker refresh endpoint
  GET /api/indicators/:ticker?refresh=true
    Skips indicator_cache lookup, recomputes, overwrites DB record.
    Only affects that one ticker — this is the "manual refresh button" trigger.
  GET /api/indicators/batch?tickers=NVDA,AAPL&refresh=true
    Refreshes only the listed tickers, max 3 concurrent.

## TTLCache shared utility
  Location: `artifacts/api-server/src/lib/ttl-cache.ts`
  Usage: `new TTLCache<T>(ttlMs, 'name')`
  Methods: get(), set(), clear(), getStats() → { name, ttlMs, entryCount, hits, misses, hitRate, entries }
  Admin dashboard: GET /api/admin/cache/status (requireAdmin) — shows all named caches + hit rates.
  Full current TTL table (18 caches as of 2026-07-14): see caching-patterns.md — not duplicated
  here to avoid the two tables drifting apart again.

## Never do these
  - Never fetch options chain on watchlist page load
  - Never re-fetch historical OHLCV already in prices_historical
  - Never call yfinance inside a React render or useEffect
  - Never batch all tickers in one shot — max 3 concurrent fetches regardless of which
    universe you're touching (the 31-ticker legacy tier list or the 257-ticker fundamentals set)
  - No Redis — not provisioned (confirmed no package/import/env var in the repo); in-memory
    TTLCache is the shim. `middleware/rateLimiter.ts` has a forward-looking comment about moving
    to Redis before horizontal scaling (enh/29) — not yet needed.

## Permissions note
  Settings sub-tabs (Trading, User Mgmt, Cache Monitor, API Monitor) and the Portfolio nav item
  are admin-only, gated both in the frontend nav/tab list AND on the backend routes
  (requireAdmin) — hiding a nav item alone doesn't stop a direct URL/curl hit from triggering
  real computation, so both layers matter. Stock DB is the exception: view is open to any
  signed-in user (requireAuth), only the Refresh button and provenance edit popover are
  admin-gated. See settings.tsx and positions.ts/portfolio-snapshot.ts/portfolio-ingest.ts.

## Data source
  All market data via yahoo-finance2 — no API keys required for that source (fundamentals
  pipeline also pulls FMP/Finnhub/EDGAR/Polygon/Alpha Vantage — see db-patterns.md).
  RSI + MFI + ATR computed locally with the technicalindicators npm package.
  DB access via @workspace/db (drizzle + pg, DATABASE_URL from Replit Secrets).
