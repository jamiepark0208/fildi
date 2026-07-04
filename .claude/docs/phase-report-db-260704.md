# DB Phase Report — 2026-07-04

## Step 1: Existing staging tables verified

| Table | Row count |
|---|---|
| yahoo_fundamentals | 161 |
| edgar_fundamentals | 158 |
| finnhub_fundamentals | 158 |

## Step 2: Client interface summary

**fmp-client.ts** — `FMPFundamentalsData` (37 fields):
- Valuation: peRatio, pegRatio, forwardPe, evEbitda, evRevenue, priceToBook, priceToSales, analystTargetPrice
- Growth: revenueGrowthYoY, revenueGrowthYoyPrior, epsGrowth, earningsPerShare
- Margins/Returns: grossMargin, operatingMargin, netMargin, returnOnEquity, returnOnAssets, effectiveTaxRate
- Income: totalRevenue, netIncome, ebitda, ebit, interestExpense, freeCashFlow
- Balance sheet: currentRatio, debtToEquity, totalDebt, totalStockholdersEquity, cashAndEquivalents, wacc, roic
- Cash flow: quarterlyOperatingCashFlow
- Share data: sharesOutstanding, sharesOutstandingPrior, dividendYield, beta

**polygon-client.ts** — `PolygonFundamentalsData` (8 fields):
- totalRevenue, netIncome, interestExpense
- grossMargin (computed), operatingMargin (computed)
- totalDebt, totalStockholdersEquity, quarterlyOperatingCashFlow

**alpha-vantage-client.ts** — `AVFundamentalsData` (12 fields):
- Valuation: peRatio, pegRatio, forwardPe, pbRatio, dividendYield, analystTargetPrice
- Margins/Returns: netMargin, operatingMargin, returnOnEquity
- Income: totalRevenue, ebitda
- Risk: beta

## Step 3: Schema additions (lib/db/src/schema/index.ts)

Three new pgTable definitions appended after `finnhub_fundamentals`:
- `fmpFundamentals` → `fmp_fundamentals` (38 cols, `fmp_` prefix)
- `polygonFundamentals` → `polygon_fundamentals` (10 cols, `polygon_` prefix)
- `avFundamentals` → `av_fundamentals` (14 cols, `av_` prefix)

Each follows the same pattern as yahoo/edgar/finnhub:
- `ticker text PRIMARY KEY`
- `fetched_at timestamp with time zone DEFAULT now() NOT NULL`
- All data columns `numeric`, nullable
- Zod insert schema with `fetchedAt` omitted
- `Insert*` and `*Row` type exports

Types auto-exported via `export * from "./schema"` in `lib/db/src/index.ts` — no changes needed there.

## Step 4: Migration

Generated: `lib/db/drizzle/0007_bizarre_susan_delgado.sql`
Applied via: `psql $DATABASE_URL -f ...` (drizzle-kit push requires TTY)

## Step 5: All six staging tables confirmed

| Table | Row count |
|---|---|
| yahoo_fundamentals | 161 |
| edgar_fundamentals | 158 |
| finnhub_fundamentals | 158 |
| fmp_fundamentals | 0 (empty — awaiting backfill after FMP quota reset) |
| polygon_fundamentals | 0 (empty — awaiting backfill) |
| av_fundamentals | 0 (empty — awaiting backfill after AV quota reset) |

## Step 6: snapshot-to-staging.ts run results (2026-07-04)

Script: `artifacts/api-server/src/scripts/snapshot-to-staging.ts`
Source: `ticker_fundamentals` (170 rows)
Routing: all 170 rows had `lastSource = 'fmp'` (the original/default source)

| Destination | Tickers | Fields written |
|---|---|---|
| fmp_fundamentals | 170 | 1529 |
| polygon_fundamentals | 0 | 0 |
| av_fundamentals | 0 | 0 |
| Skipped (all null) | 0 | — |

**Notes:**
- All rows routed to `fmp_fundamentals` — expected, since FMP was the original data source and `lastSource` defaults to `'fmp'`
- Field counts vary per ticker (5–30) reflecting partial FMP coverage from prior backfill
- `polygon_fundamentals` and `av_fundamentals` will be populated after midnight UTC quota resets via dedicated backfill scripts

## Step 7: source_fundamentals table + population (2026-07-04)

### Schema
`source_fundamentals` added to `lib/db/src/schema/index.ts`:
- PK: (ticker, source, field)
- Columns: ticker TEXT, source TEXT, field TEXT, value NUMERIC NOT NULL, fetched_at TIMESTAMPTZ
- Migration: `drizzle/0008_loose_iron_man.sql` applied via psql

### fmp_fundamentals cleanup
- Before: 170 rows. Deleted 1 row (FSLR — only 2 non-null fields, placeholder from ticker_fundamentals snapshot)
- After: 169 rows, avg 9.0 non-null fields/ticker

### population from staging tables
Script: `artifacts/api-server/src/scripts/populate-source-fundamentals.ts`

| Source | Tickers | Field rows |
|---|---|---|
| yahoo | 155 | 5658 |
| finnhub | 157 | 2839 |
| fmp | 169 | 1527 |
| edgar | 119 | 1443 |
| **TOTAL** | — | **11,467** |

### NVDA cross-source sample (101 rows)
Notable divergences visible for same canonical field:
- `grossMargin`: edgar=0.711, fmp=0.711, finnhub=0.742, yahoo=0.741 ✓ (TTM vs annual period explains gap)
- `netMargin`: edgar=0.556, fmp=0.556, finnhub=0.630, yahoo=0.630
- `debtToEquity`: edgar=n/a, fmp=0.073, finnhub=0.001, yahoo=6.555 (definitional differences)
- `totalRevenue`: edgar=215.9B, fmp=215.9B, yahoo=253.5B (fiscal year cutoff difference)
- `beta`: finnhub=2.25, yahoo=2.20 (expected agreement ✓)

## Next steps

1. Write `backfill-fmp.ts` using `fmp-client.ts` → re-fetch and upsert into `fmp_fundamentals` (after quota reset)
2. Write `backfill-polygon.ts` using `polygon-client.ts` → insert into `polygon_fundamentals`
3. Write `backfill-av.ts` using `alpha-vantage-client.ts` → insert into `av_fundamentals` (25/day quota)
4. Wait for FMP/AV quota resets (midnight UTC) then run backfills
5. Cross-source reconciliation: compare all six sources against `ticker_fundamentals`
