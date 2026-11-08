# WS4: discrepancyFlags — Fix & Results

**Date:** 2026-07-09  
**Status:** Complete

## Problem

`ticker_fundamentals.discrepancy_flags` was only written by the old `writeFundamentalsRow()` path (FMP-only, in `fundamentals-db.ts`). After a `merge-trusted` run, this column went stale or null for all but 5 tickers.

However, `merge-trusted` already computed divergence per field (`result.divergent` via `compareAll()` — >20% relative difference triggers divergent=true). This was written to `field_provenance.divergent` but NOT back to `ticker_fundamentals.discrepancy_flags`.

## Fix

In `merge-trusted.ts`, after collecting `provenanceBatch`, compute divergent fields and include `discrepancyFlags` in the upsert:

```typescript
const divergentFields = provenanceBatch
  .filter(({ result }) => result.divergent)
  .map(({ field }) => field);
const discrepancyFlags = divergentFields.length > 0 ? divergentFields.join(",") : null;
```

The upsert now includes `discrepancyFlags` in both `values()` and `onConflictDoUpdate.set`.

## Results

| Before | After |
|---|---|
| 5 tickers with flags (stale FMP-only data) | 255 tickers with live flags |

Sample (GOOGL): `pegRatio,priceToBook,priceToSales,netMargin,returnOnEquity,returnOnAssets,revenueGrowthYoY,epsGrowth,debtToEquity,cashAndEquivalents,totalDebt,sharesOutstanding,currentRatio,interestExpense,freeCashFlow,dividendYield,earningsPerShare`

## Impact

- StockDB admin view now shows current divergence flags for all tickers
- The `discrepancyFlags` column is refreshed on every `merge-trusted` run
- `null` means no divergence detected (all sources agree or only one source available)
- High divergence counts (GOOGL=17, AAPL=16) highlight tickers where source data conflicts — these may warrant manual review or override
