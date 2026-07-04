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

## Step 8: validate-sources.ts + merge-trusted.ts (2026-07-04)

### Scripts
- `artifacts/api-server/src/scripts/validate-sources.ts`
- `artifacts/api-server/src/scripts/merge-trusted.ts`
- Log: `logs/validate-sources-2026-07-04.log`
- JSON: `logs/trusted-fields.json`

### Validation thresholds applied
- Ratio fields (abs(v) ≤ 10): PASS if |a − b| ≤ 0.05
- Large number fields (abs(v) ≥ 1000): PASS if min/max ≥ 0.80 (within 20%)
- Scale mismatch: max/min > 50 → flagged as SCALE_MISMATCH

### TRUSTED_FIELDS (pass rate ≥ 80%)

| Field | Pass rate | Preferred source | Fallback |
|---|---|---|---|
| returnOnEquity | 83% | yahoo | finnhub |
| sharesOutstanding | 82% | yahoo | edgar |

### DISPUTED_FIELDS (pass rate < 80%) — untouched in ticker_fundamentals

| Field | Pass rate | Issue |
|---|---|---|
| grossMargin | 68% | HIGH_DIVERGENCE (edgar annual vs TTM; EDGAR errors for AVGO/ADI where margin > 1) |
| operatingCashFlow | 69% | HIGH_DIVERGENCE (annual vs TTM period) |
| returnOnAssets | 68% | HIGH_DIVERGENCE (TTM gap) |
| netMargin | 61% | HIGH_DIVERGENCE (period gap) |
| operatingMargin | 56% | HIGH_DIVERGENCE (period gap) |
| beta | 54% | HIGH_DIVERGENCE (sampling period difference) |
| revenueGrowth | 54% | HIGH_DIVERGENCE (TTM vs annual growth measurement) |
| totalRevenue | 66% | HIGH_DIVERGENCE (fiscal year cutoff difference) |
| freeCashFlow | 33% | HIGH_DIVERGENCE (TTM vs annual; NVDA 46B vs 103B) |
| totalDebt | 45% | HIGH_DIVERGENCE (debt component definitions differ) |
| currentRatio | 26% | HIGH_DIVERGENCE (strict ±0.05 absolute threshold too tight for ratios 1–5) |
| priceToBook | 3% | HIGH_DIVERGENCE (P/B in 10–50 range falls outside both ratio/large-number buckets) |
| debtToEquity | 0% | SCALE_MISMATCH (yahoo uses total liabilities/equity, finnhub uses net debt/equity) |

### Key observations
- `priceToBook` always fails: values in 10–50 range fall into neither ratio (≤10) nor large-number (≥1000) bucket → uses abs(a-b) ≤ 0.05 fallback, which is too strict
- `debtToEquity` is definitionally incompatible across sources; needs source-specific treatment at reconciliation time
- `grossMargin` EDGAR computation has bugs for some tickers (AVGO=2.077, ADI=1.092 — margin > 1)
- Most HIGH_DIVERGENCE fields reflect TTM vs annual period differences, not data errors

### Merge results
- Tickers merged: 160
- Fields written: 312 (returnOnEquity + sharesOutstanding × 160 tickers)
- Fields null >20% of tickers: none
- Disputed fields: untouched in ticker_fundamentals (awaiting FMP backfill as tiebreaker)

## Step 9: Data cleanup + period-aware validation + per-field priority merge (2026-07-04)

### Step 9a — source_fundamentals cleanup (81 rows deleted)

| Rule | Rows deleted | Notable tickers |
|---|---|---|
| margin fields outside [-1, 1] | 76 | EDGAR grossMargin errors: ADI(1.09), AVGO(2.08), HUBS(18.2), MSFT(3.1), CRM(3.8), etc. Many pre-revenue companies (SPCE, ACHR, JOBY) with extreme margins |
| \|ROE/ROA\| > 2.0 | 4 | BOX(-5.76), REBN(-4.30), RDFN(-2.62), SUPX(-2.29) |
| negative currentRatio/priceToBook/peRatio | 1 | INTC fmp peRatio(-614.6) |

Rejection rules now baked into `populate-source-fundamentals.ts` — future backfills reject at write time.

### Step 9b — Period-aware re-validation (updated validate-sources.ts)

Key changes:
- TTM-only fields (grossMargin, netMargin, operatingMargin, returnOnEquity, returnOnAssets, revenueGrowth, totalRevenue, freeCashFlow, operatingCashFlow, ebitda): EDGAR excluded — period mismatch
- priceToBook: new mid-range bucket (10 < abs < 1000) uses relative 10% threshold instead of absolute ±0.05
- debtToEquity: SKIP_VALIDATION — definitionally incompatible across sources

| Field | Before | After | Change |
|---|---|---|---|
| grossMargin | 68% | 88% ✓ TRUSTED | +20pp — EDGAR errors removed |
| netMargin | 61% | 96% ✓ TRUSTED | +35pp — EDGAR errors removed |
| returnOnEquity | 83% | 85% ✓ TRUSTED | +2pp |
| sharesOutstanding | 82% | 82% ✓ TRUSTED | unchanged |
| operatingMargin | 56% | 60% DISPUTED | still below threshold |
| priceToBook | 3% | 7% DISPUTED | mid-range fix helps marginally |
| totalRevenue / freeCashFlow / operatingCashFlow | 66%/33%/69% | 0% | no comparable pairs after excluding EDGAR (finnhub doesn't carry these fields) |

Note: 0% disputed fields for totalRevenue etc. are informational only — merge uses hardcoded priority, not TRUSTED/DISPUTED list.

### Step 9c — Per-field priority merge (rewritten merge-trusted.ts)

Priority rules by field family (hardcoded, not driven by trusted-fields.json):
- Valuation: yahoo → finnhub → fmp
- Margins/returns: yahoo → finnhub → fmp (never edgar)
- Growth: yahoo(revenueGrowth) → finnhub → fmp(revenueGrowthYoY)
- debtToEquity: yahoo → fmp (never finnhub)
- Balance sheet: yahoo → finnhub → edgar → fmp
- Income statement: yahoo(annual) → fmp → edgar
- Cash flow: yahoo → fmp → edgar
- Market/other: yahoo → finnhub → fmp

**Results:**

| Metric | Value |
|---|---|
| Total tickers merged | 280 |
| Total fields written | 5103 |
| yahoo fields | 3585 (70%) |
| fmp fields | 1030 (20%) |
| finnhub fields | 273 (5%) |
| edgar fields | 215 (4%) |

**Fields still null >20% of tickers (FMP/Polygon/AV targets):**
wacc(280/280), priceToSales(268/280), roic(268/280), revenueGrowthYoyPrior(268/280), sharesOutstandingPrior(268/280), effectiveTaxRate(268/280), dividendYield(253/280), epsGrowth(191/280), interestExpense(186/280), peRatio(153/280), pegRatio(145/280), debtToEquity(135/280), evEbitda(132/280), ebit(129/280), evRevenue(126/280), sharesOutstanding(126/280), cashAndEquivalents(125/280), freeCashFlow(125/280), quarterlyOperatingCashFlow(124/280), priceToBook(123/280), returnOnAssets(121/280), revenueGrowthYoY(121/280), currentRatio(120/280), earningsPerShare(120/280), forwardPe(115/280), ebitda(113/280), analystTargetPrice(110/280), netMargin(106/280), returnOnEquity(105/280), beta(103/280)

Note: grossMargin(62/280) is the best-covered field. The high null counts reflect that 280 includes tickers tracked only by fmp/finnhub/edgar without full Yahoo coverage — FMP backfill will fill most of these.

## Step 10: Ticker universe audit + merge fix (2026-07-04)

### Root cause
`merge-trusted.ts` iterated over `index.keys()` = all tickers present in `source_fundamentals` (280), rather than the canonical 169-ticker universe. This caused 112 spurious INSERT rows in `ticker_fundamentals` for tickers covered by yahoo/finnhub/edgar but outside the original FMP backfill scope.

### Universe counts
| Table | Distinct tickers |
|---|---|
| peer_group_members | 550 (too broad — all peer group expansions) |
| ticker_registry | 581 (too broad) |
| fmp_fundamentals | 169 ← correct canonical universe |
| yahoo_fundamentals | 161 |
| finnhub_fundamentals | 158 |
| edgar_fundamentals | 158 |
| source_fundamentals (union) | 280 |
| ticker_fundamentals before fix | 281 (169 original + 112 bad inserts) |

### Fix applied
1. Deleted 112 spurious ticker_fundamentals rows (`NOT IN fmp_fundamentals`)
2. Fixed `merge-trusted.ts`: loads `fmp_fundamentals` ticker list as an explicit allowlist; skips any source_fundamentals ticker not in that set; iterates over the full 169-ticker canonical list so fmp-only tickers still get updated
3. Re-ran merge

### Corrected merge results (169 tickers)

| Metric | Bad run | Fixed run |
|---|---|---|
| Tickers | 280 | **169** |
| Fields written | 5103 | **2275** |
| yahoo | 3585 | 1078 |
| fmp | 1030 | 1030 |
| finnhub | 273 | 92 |
| edgar | 215 | 75 |

Note: yahoo field count dropped sharply (3585→1078) because 111 of the 280 "tickers" were yahoo/finnhub/edgar-only and now excluded. fmp unchanged at 1030 because all 169 fmp_fundamentals tickers were always in scope.

### Fields still null >20% of tickers (FMP/Polygon/AV targets)
wacc(169/169), priceToSales(157/169), roic(157/169), revenueGrowthYoyPrior(157/169), sharesOutstandingPrior(157/169), effectiveTaxRate(157/169), epsGrowth(143/169), dividendYield(142/169), interestExpense(135/169), evEbitda(124/169), debtToEquity(124/169), evRevenue(123/169), cashAndEquivalents(123/169), sharesOutstanding(123/169), ebit(123/169), freeCashFlow(123/169), priceToBook(121/169), revenueGrowthYoY(121/169), returnOnAssets(120/169), currentRatio(120/169), earningsPerShare(120/169), peRatio(117/169), pegRatio(113/169), forwardPe(107/169), analystTargetPrice(106/169), ebitda(105/169), netMargin(103/169), returnOnEquity(103/169), beta(102/169)

grossMargin is best covered at 62/169 null (107/169 = 63% have a value).

## Next steps

1. Write `backfill-fmp.ts` using `fmp-client.ts` → re-fetch and upsert into `fmp_fundamentals` (after quota reset)
2. Write `backfill-polygon.ts` using `polygon-client.ts` → insert into `polygon_fundamentals`
3. Write `backfill-av.ts` using `alpha-vantage-client.ts` → insert into `av_fundamentals` (25/day quota)
4. Wait for FMP/AV quota resets (midnight UTC) then run backfills
5. Cross-source reconciliation: compare all six sources against `ticker_fundamentals`
