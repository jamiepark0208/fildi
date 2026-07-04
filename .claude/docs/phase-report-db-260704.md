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

## Next steps

1. Write `backfill-fmp.ts` using `fmp-client.ts` → insert into `fmp_fundamentals`
2. Write `backfill-polygon.ts` using `polygon-client.ts` → insert into `polygon_fundamentals`
3. Write `backfill-av.ts` using `alpha-vantage-client.ts` → insert into `av_fundamentals`
4. Wait for FMP/AV quota resets (midnight UTC) then run backfills
5. Cross-source reconciliation: compare all six sources against `ticker_fundamentals`
