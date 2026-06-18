---
name: data-architecture
description: What to fetch, how often, what to cache. Read before writing any fetch or cache code.
---
## Data tiers

### Tier A — Persistent (once per day, never re-fetch)
  Historical OHLCV → PostgreSQL `prices_historical`, INSERT OR IGNORE on (ticker, date)
  RSI/MFI result   → PostgreSQL `scorecard_cache`, upsert on (ticker, scored_date) as JSONB
  Ticker metadata  → PostgreSQL `watchlist`, fetch on init only
  RSI thresholds   → hardcoded in `src/lib/constants.ts`, not fetched

### Tier B — In-memory (page load + manual refresh button only)
  Current price    → in-memory TTLCache, no DB persistence, no Redis
  5-day return     → derived from current price + prices_historical

### Tier C — Short-lived in-memory cache (options)
  Options chain       → TTLCache 30 min per ticker (routes/options.ts `optionsCache`)
                        Expiry calendar → TTLCache 24h shared key (lib/options.ts `expiryCache`)
                        First request per day skips undated fetch; subsequent tickers reuse dates

## Indicator refresh logic (getIndicators)
  1. Check scorecard_cache for (ticker, today) → return immediately if found
  2. Read prices_historical for ticker, last 90 calendar days
  3. If rows >= 60 → compute RSI/MFI directly from DB rows (no yfinance call)
  4. If rows < 60 → fetch 90d from yfinance, INSERT OR IGNORE into prices_historical,
     compute from fetched data
  5. Upsert result into scorecard_cache
  Returns: { rsi, mfi, rsiThreshold, mfiThreshold, rsiOk, mfiOk, signal, tier, scoredDate }

## Per-ticker refresh endpoint
  GET /api/indicators/:ticker?refresh=true
    Skips scorecard_cache lookup, recomputes, overwrites DB record.
    Only affects that one ticker — this is the "manual refresh button" trigger.
  GET /api/indicators/batch?tickers=NVDA,AAPL&refresh=true
    Refreshes only the listed tickers, max 3 concurrent.

## TTLCache shared utility
  Location: `artifacts/api-server/src/lib/ttl-cache.ts`
  Usage: `new TTLCache<T>(ttlMs, 'name')`
  Methods: get(), set(), clear(), getStats() → { name, ttlMs, entryCount, hits, misses, hitRate, entries }
  Admin dashboard: GET /api/admin/cache/status (requireAdmin) — shows all named caches + hit rates

## Cache TTL reference (current values)
  | Cache | TTL | File |
  |---|---|---|
  | search | 24h | routes/stocks.ts |
  | quote | 1h | routes/stocks.ts |
  | compare | 1h | routes/stocks.ts |
  | breakdown | 2h | routes/stocks.ts |
  | history | 1h | routes/stocks.ts |
  | history-1d | 15m | routes/stocks.ts |
  | options | 30m | routes/options.ts |
  | options-expiry | 24h | lib/options.ts |
  | macro-regime | 30m | routes/macro-regime.ts (raw var) |

## Never do these
  - Never fetch options chain on watchlist page load
  - Never re-fetch historical OHLCV already in prices_historical
  - Never call yfinance inside a React render or useEffect
  - Never fetch all 31 tickers simultaneously (max 3 concurrent)
  - No Redis — not provisioned; in-memory TTLCache is the shim

## Data source
  All market data via yahoo-finance2 — no API keys required.
  RSI + MFI + ATR computed locally with the technicalindicators npm package.
  DB access via @workspace/db (drizzle + pg, DATABASE_URL from Replit Secrets).
