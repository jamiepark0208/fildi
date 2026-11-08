# WS1: Price-Target Breakdown — Findings & Changes

**Date:** 2026-07-09  
**Status:** Complete

## Root Cause

The FMP `stable/price-target` (per-analyst) endpoint returns `[]` for all tickers. Confirmed by direct curl:
```
GET https://financialmodelingprep.com/stable/price-target?symbol=AAPL&apikey=...&limit=5 → []
```
Per-analyst price targets require a higher FMP plan than currently subscribed.

## Impact (before fix)

- Every `/api/stocks/breakdown` page load was burning **1 FMP credit** on a call that always returned empty
- The breakdown cache (2-hour TTL, `BREAKDOWN_CACHE_VER`) prevented repeated hits per ticker per window, but first-load still wasted budget
- UI showed "not yet loaded — check back shortly" — misleading, implied data was coming

## What's Available (no change needed)

Data that works via Yahoo Finance `financialData` module, already rendered:
- **Consensus target** (`targetMeanPrice` → `analystTargetPrice`) — shown in always-visible section
- **Range bar** (high / low / mean / median) — shown when section is expanded
- **Firm upgrade/downgrade actions** (`upgradeDowngradeHistory`) — in CatalystsSection

## Changes Made

| File | Change |
|---|---|
| `artifacts/api-server/src/routes/stocks.ts` | Removed FMP `price-target` fetch from `Promise.all`; removed `fmpTargetsRaw` destructuring and the deduplicate-by-firm block; set `analystPriceTargets = []` directly. Cache version bumped 4→5 to invalidate stale entries. |
| `artifacts/stock-compare/src/components/stock-breakdown.tsx` | Updated fallback message from "not yet loaded — check back shortly" → "not available on current data plan" |

## Budget Savings

~1 FMP call eliminated per unique ticker per 2-hour window. For a typical session visiting 5-10 breakdowns, this saves 5-10 FMP credits per session that were previously wasted with no data in return.

## Future Path

If per-analyst targets become important, options:
1. Upgrade FMP plan (enables the `stable/price-target` endpoint)
2. Use a paid alternative (e.g., Refinitiv, Bloomberg)
3. Scrape Yahoo Finance `upgradeDowngradeHistory` which has firm names + grades but not target prices
