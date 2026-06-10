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

### Tier C — On-demand (fetch fresh on every user click, no server cache)
  Options chain slice → fetch fresh via yf2.options() on each request
                        no caching — stale bid/ask is worse than a small delay

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
