# Caching Patterns — FILDI

## Rule: Every Yahoo Finance call must be cached

Never add a yahooFinance.* call to any route without a TTLCache instance.
No exceptions. Check existing cache instances before adding a new one.

## TTLCache utility
Location: artifacts/api-server/src/lib/ttl-cache.ts
Import: import { TTLCache } from '../lib/ttl-cache'

## All cache instances must be:
1. Named — pass a plain English name as second constructor arg
2. Exported — so cache-registry.ts can collect stats
3. Registered — add to artifacts/api-server/src/lib/cache-registry.ts

## Current cache instances and TTLs
Name              | Display Name              | TTL      | File
------------------|---------------------------|----------|---------------------------
search            | Ticker Search             | 24 hours | routes/stocks.ts
quote             | Stock Price & Profile     | 1 hour   | routes/stocks.ts
compare           | Stock Comparison          | 1 hour   | routes/stocks.ts
breakdown         | Stock Analysis            | 2 hours  | routes/stocks.ts
history           | Price History             | 1 hour   | routes/stocks.ts
history-1d        | Price History (Intraday)  | 15 min   | routes/stocks.ts
options           | Options Chain             | 30 min   | routes/options.ts
options-expiry    | Options Calendar          | 24 hours | lib/options.ts
macro-regime      | Market Regime (VIX)       | 30 min   | routes/macro-regime.ts (raw var)

## Cache key conventions
- Single ticker: ticker.toUpperCase() e.g. "NVDA"
- Multiple tickers: "TICKER1:TICKER2" uppercase sorted
- Period-based: "TICKER_PERIOD" e.g. "NVDA_1M"
- Shared/global: "shared"

## Standard cache pattern (copy this exactly)
```ts
const myCache = new TTLCache<MyType>(TTL_MS, 'display-name')

router.get('/my-route', requireAuth, async (req, res, next) => {
  try {
    const key = req.params.ticker.toUpperCase()
    const cached = myCache.get(key)
    if (cached) return res.json(cached)

    const data = await yahooFinance.something(...)
    myCache.set(key, data)
    res.json(data)
  } catch (err) {
    next(err)
  }
})
```

## Adding a new cache instance checklist
- [ ] Import TTLCache from lib/ttl-cache
- [ ] Choose TTL: search/expiry=24h, fundamentals=2h, price=1h, options=30min, intraday=15min
- [ ] Pass a plain English display name
- [ ] Export the instance from the route file
- [ ] Add to cache-registry.ts getAllCaches() array
- [ ] Add a row to the table above in this file

## Ticker search specifically
searchCache covers GET /stocks/search only.
If any new component or page adds a ticker search input, it must call
GET /api/stocks/search — do not call yahooFinance.search() directly
from any other route. One endpoint, one cache, all consumers.