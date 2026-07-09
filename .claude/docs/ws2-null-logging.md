# WS2: Null/Missing Data Logging — Findings & Changes

**Date:** 2026-07-09  
**Status:** Complete

## What Was Added

### 1. `fundamentals.ts` — `/fundamentals/rankings` route

After the `values` matrix is built (right before group exclusions are applied), each ticker is inspected for null metric values. Any ticker with ≥1 null metric emits a structured pino `warn` log:

```
[FUND-NULL] missing fundamental metrics in DB  { ticker, nullMetrics: [...], nullCount: N }
```

This fires on every call to `/fundamentals/rankings`, which is called by the frontend on each page load. Grep: `grep "\[FUND-NULL\]" /tmp/api-server.log`

### 2. `merge-trusted.ts` — end-of-batch run

Inside the ticker loop, after each ticker's fields are resolved, null fields are collected and emitted to stdout:

```
[FUND-NULL] AAPL: wacc (1/36 null)
[FUND-NULL] AAL: roic, revenueGrowthYoyPrior, debtToEquity, ... (8/36 null)
```

This fires whenever `node dist/merge-trusted.mjs` is run. The existing per-field `>20% of tickers` summary at the end is preserved.

## Null Coverage Snapshot (2026-07-09 run)

| Field | Null tickers | Source(s) | Root cause |
|---|---|---|---|
| `wacc` | 257/257 | FMP only | FMP backfill not yet run for any ticker |
| `roic` | 244/257 | FMP + Finnhub | FMP backfill not run for most tickers |
| `revenueGrowthYoyPrior` | 244/257 | FMP only | FMP backfill not run |
| `sharesOutstandingPrior` | 244/257 | FMP only | FMP backfill not run |
| `effectiveTaxRate` | 244/257 | FMP only | FMP backfill not run |
| `interestExpense` | 166/257 | FMP + Polygon | Mixed — Polygon covers some |
| `dividendYield` | 115/257 | Yahoo + Finnhub + FMP + AV | Many growth stocks pay no dividend (expected null) |
| `epsGrowth` | 70/257 | FMP + Finnhub | Partial backfill |
| `quarterlyOperatingCashFlow` | 65/257 | FMP + Polygon | Partial backfill |

**Source usage in current merge run:**
`yahoo=5861  finnhub=851  fmp=336  edgar=206  polygon=56  alpha_vantage=1`

## Key Insight: AV Is Already in FIELD_DEFS

Alpha Vantage is already wired into FIELD_DEFS as a priority tier for all 12 of its fields. The `alpha_vantage=1` contribution is because AV has only been backfilled for 14 tickers (A-ADYEN) at 25/day rate. No code change needed — continuing the backfill will improve coverage automatically.

## Key Insight: FMP Backfill Is the Critical Gap

`wacc`, `roic`, `revenueGrowthYoyPrior`, `sharesOutstandingPrior`, `effectiveTaxRate` are FMP-only fields. The FMP backfill needs to run to fill these. Once FMP backfill completes:
- `wacc` fills → enables `roicWaccSpread` metric in scoring
- `roic` fills → enables ROIC quality metric
- `revenueGrowthYoyPrior` fills → enables growth acceleration scoring
- `interestExpense` fills → enables interest coverage ratio

## How to Use

```bash
# After any merge-trusted run:
grep "FUND-NULL" merge-trusted-output.txt | sort | head -20

# Field frequency across all tickers (copy output to file first):
grep "FUND-NULL" output.txt | grep -oP '\b\w+(?=,|:|\s\()' | sort | uniq -c | sort -rn

# Live server null hits:
grep "\[FUND-NULL\]" /tmp/api-server.log | tail -50
```
