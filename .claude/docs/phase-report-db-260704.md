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

---

## Stock DB Tooltip + Override Feature — Pre-build Audit (2026-07-04)

### A. Already exists / can reuse as-is

| What | Location | Notes |
|---|---|---|
| `source_fundamentals` table | `lib/db/src/schema/index.ts:975` | PK: (ticker, source, field). Has 11k+ rows. Not wired to any live API endpoint — script-only. |
| `Tooltip` + `Popover` UI components | `artifacts/stock-compare/src/components/ui/tooltip.tsx`, `popover.tsx` | Full Radix UI wrappers. StockDBTab currently uses plain HTML `title=` on `<td>` — neither component is used there yet. Popover is the right primitive for the rich cell overlay. |
| `compareTwo()` / `compareAll()` divergence logic | `artifacts/api-server/src/scripts/validate-sources.ts:40–75` | Computes PASS/FAIL/SCALE_MISMATCH between source values per field. Script-only stdout output — not stored anywhere queryable. |
| `ticker-mapping-overrides.json` | `artifacts/config/ticker-mapping-overrides.json` | Contains only 2 entries (IONQ, FSLY). This is **peer-group classification** overrides, not source-value overrides. Different concept entirely. |
| `source_ticker_map` table | `lib/db/src/schema/index.ts:664` | Maps ticker → source-specific symbol (e.g. BRK.B → BRK-B). Ticker symbol aliasing only — unrelated to what we're building. |

### B. Partially exists / needs extending

**`merge-trusted.ts` FIELD_DEFS** (`artifacts/api-server/src/scripts/merge-trusted.ts:29–85`)
The per-field source priority table is complete and correct. But `pickedSource` per field is tracked locally in `tickerSourceUsage` for console logging only — never persisted. To power the tooltip, merge-trusted needs to write `(ticker, field, winningSource, winningValue)` to a new `field_provenance` table or JSONB column. The priority logic itself should be reused directly.

**`ticker_fundamentals.discrepancyFlags`** (`lib/db/src/schema/index.ts:174`)
Already a `text` column storing comma-separated field names where FMP vs Yahoo diverged >20%. StockDBTab already reads it for cell highlight colors. Limitations: (1) only FMP vs Yahoo — not all source pairs, (2) doesn't store the actual diverging values, (3) written only by `stock-data-manager.ts`, not by `merge-trusted.ts`. Would need extending to cover all source pairs.

**`stock-data-manager.ts` `lastSource` write** (line 119)
Writes a single row-level `lastSource` string when its FMP/Yahoo waterfall runs. Not per-field. This is what the current StockDBTab tooltip reads.

### C. Genuinely new (no precedent)

- **`field_provenance` table** — needs to store `(ticker, field, winningSource, winningValue, fetchedAt)`. Nothing like this exists in schema or migrations.
- **`manual_overrides` table** — no override table, no override concept, no half-built UI. `ticker-mapping-overrides.json` is a different concept.
- **API endpoint for per-source field data** — `GET /fundamentals/stock-db` is the only fundamentals admin endpoint and returns only the merged `ticker_fundamentals` row. No endpoint exposes `source_fundamentals` or divergence data. Zero scaffolding.
- **Rich cell Popover in StockDBTab** — Radix `Popover` exists but is unused in this tab. Current tooltip is a plain `title=` string.

### Doc/code disagreements flagged

- Schema comment on `source_fundamentals` says "Populated by: snapshot-to-staging.ts" — that file does not exist; the actual script is `populate-source-fundamentals.ts`.
- `ticker_fundamentals` comment at line 166 still says "Written by the FMP refresh job" — inaccurate now that `merge-trusted.ts` is the writer.

---

## Stock DB Tooltip + Override Feature — Implementation (2026-07-04)

### Phase 1: Schema

Two new tables added to `lib/db/src/schema/index.ts` and migrated (migration `0009_modern_sabretooth.sql` applied directly via psql):

- **`field_provenance`** — PK: (ticker, field). Columns: winning_source, winning_value, is_override (bool), divergent (bool), fetched_at, updated_at. Written by merge-trusted.ts after each merge run. Read by `GET /api/fundamentals/provenance/:ticker`.
- **`manual_overrides`** — PK: (ticker, field). Columns: override_source, override_value (null = use best value from that source), note, created_at. Written by `PUT /api/fundamentals/override`, cleared by `DELETE`.

Two stale comments fixed in schema: `source_fundamentals` writer (`snapshot-to-staging.ts` → `populate-source-fundamentals.ts`); `ticker_fundamentals` writer (`FMP refresh job` → `merge-trusted.ts`).

### Phase 2: merge-trusted.ts refactor

- Exported `compareTwo` / `compareAll` from `validate-sources.ts` (made `compareAll` generic over `string` keys, not just `SourceName` tuple).
- `merge-trusted.ts` fully rewritten:
  - `resolveFromIndex(fieldDef, byField, override)` — internal batch resolver; collects all source values, computes `divergent` via imported `compareAll`, checks `manual_overrides` before priority walk, falls through if override source has no data.
  - `resolveField(ticker, field)` — exported public function; queries DB directly for a single (ticker, field); used by the API after PUT/DELETE override.
  - `writeProvenance(ticker, field, result, fetchedAt)` — exported upsert helper for `field_provenance`.
  - Batch `main()` now loads all `manual_overrides` upfront, passes them into `resolveFromIndex`, and batch-upserts `field_provenance` per ticker alongside the existing `ticker_fundamentals` upsert. Console logging preserved unchanged.

### Phase 3: API routes

New file `artifacts/api-server/src/routes/fundamentals-provenance.ts`, registered in `routes/index.ts`:

| Endpoint | Auth | Description |
|---|---|---|
| `GET /fundamentals/provenance/:ticker` | admin | Joins field_provenance + source_fundamentals for ticker. Returns per-field: winner value/source/age/isOverride/divergent + array of all sources with status (used/available/excluded+reason/no_data). |
| `PUT /fundamentals/override` | admin | Body: `{ticker, field, source, value?, note?}`. Upserts manual_overrides, immediately calls resolveField() and writes ticker_fundamentals + field_provenance. |
| `DELETE /fundamentals/override/:ticker/:field` | admin | Removes override row, re-resolves and re-persists via resolveField(). |

`EXCLUDED_REASONS` map in the route encodes why each source is excluded per field (period mismatch, definitionally incompatible, not tracked).

### Phase 4: StockDBTab UI

- Imports: added `useMutation`, `useQueryClient`, `Pin`, `TriangleAlert`, `Popover`, `PopoverContent`, `PopoverAnchor`.
- **Per-row hover fetch**: `onMouseEnter` on each `<tr>` sets `hoveredTicker`; `useQuery(["provenance", hoveredTicker])` fetches provenance with 60s staleTime. 2s debounce timer on `onMouseLeave` keeps the cache warm while clicking.
- **Single Popover**: one `<Popover>` rendered outside the table, anchored via a fixed-position invisible `<div>` repositioned to the clicked cell's `getBoundingClientRect()`. `activeCell: {ticker, field, rect}` state drives open/close.
- **Popover content**: header (ticker · field + pin/divergence icons), winner value/source/age, per-source breakdown table (source / value / age / status badge), override control (source dropdown, optional manual value input, note field, Save + Clear override buttons wired to PUT/DELETE mutations).
- Cell `title=` attribute removed; cells now `cursor-pointer` with `ring-1` highlight when active.
- Override mutations invalidate both `["provenance", ticker]` and `["admin-stock-db"]` query keys on success.

### Known gaps / next steps

- `field_provenance` is empty until `merge-trusted.ts` is re-run — provenance popover will show "Hover to load" until then.
- The FMP backfill (wacc, priceToSales, roic) is still blocked on quota reset (midnight UTC). Re-running merge-trusted after that backfill will populate field_provenance for those fields.
- `openCell` callback captures `activeProv` at click time for override form pre-fill — if provenance fetch is still in flight at click time, the form fields will be empty (non-blocking, user can still type).

---

## Provenance Tooltip — Performance & Reliability Hardening (2026-07-04)

### Audit findings (pre-fix)

- GET /fundamentals/provenance/:ticker hit DB directly (3 queries) on every call — no server cache.
- Hover fetch had no AbortController — late responses for rows the user left could land after moving on.
- `isError` was not destructured from the provenance `useQuery` — popover had no error branch.
- `TTLCache` had no `delete(key)` method — needed before per-ticker invalidation was possible.

### Changes made

**`lib/ttl-cache.ts`**: Added `delete(key: string)` method.

**`lib/provenance-cache.ts`** (new): Single shared `TTLCache<object>` instance with 15-minute TTL, named `"provenance"`. Exported from here so both the route and the batch script can import it without circular dependency.

**`routes/fundamentals-provenance.ts`**:
- GET handler now checks `provenanceCache.get(ticker)` before querying DB; stores result with `provenanceCache.set(ticker, payload)` on miss.
- PUT and DELETE handlers call `provenanceCache.delete(t)` after re-resolving and persisting, so the next hover fetch gets fresh data immediately.

**`scripts/merge-trusted.ts`**: Imports `provenanceCache` and calls `provenanceCache.delete(ticker)` inside the batch loop after each ticker's DB writes — every ticker touched by a merge run is evicted from cache before the next GET can serve stale data.

**`StockDBTab.tsx` (client)**:
- Provenance `useQuery` now passes React Query's built-in `signal` to `fetch()` — in-flight requests auto-cancel when `hoveredTicker` changes (row change).
- `staleTime` changed from 60s → 10 minutes. `refetchOnWindowFocus: true` added — catches batch merge runs that happened while the tab was in background.
- Override mutations already invalidate `["provenance", ticker]` explicitly — save reflects immediately regardless of staleTime.
- `isError` / `refetchProv` now destructured. Popover shows "Couldn't load source detail" + Retry button on fetch failure, instead of blank/loading fallback.

### Cache invalidation summary

| Trigger | Server cache | Client cache |
|---|---|---|
| Override PUT/DELETE | `provenanceCache.delete(ticker)` | `invalidateQueries(["provenance", ticker])` |
| merge-trusted.ts batch | `provenanceCache.delete(ticker)` per ticker | staleTime expires OR refetch-on-focus |
| TTL expiry | Auto (15 min) | Auto (10 min staleTime) |

---

## Part A Audit — Gap-targeted backfill (2026-07-04)

### A1. Backfill scripts — existence and scope

| Script | Exists? | Notes |
|---|---|---|
| `backfill-fmp.ts` | ❌ | Does not exist. Must be built. |
| `backfill-polygon.ts` | ❌ | Does not exist. Must be built. |
| `backfill-av.ts` | ❌ | Does not exist. Must be built. |
| `backfill-fundamentals.ts` | ✓ | 409 lines. **NOT gap-aware.** Blanket re-backfill: fetches all 7 FMP endpoints per ticker, writes directly to `ticker_fundamentals` (not source staging tables), skips only `isFresh(row) && nullCriticalCount===0`. Targets full WATCHLIST + peer-group members (~500+ tickers), not just canonical 169. |

`backfill-fundamentals.ts` cannot be repurposed as-is. The three new scripts must be built from scratch targeting the source-specific staging tables (`fmp_fundamentals`, `polygon_fundamentals`, `av_fundamentals`).

### A2. Current row counts

| Table | Rows |
|---|---|
| `fmp_fundamentals` | 169 |
| `polygon_fundamentals` | 0 (empty) |
| `av_fundamentals` | 0 (empty) |
| `source_fundamentals` | 11,386 |

`source_fundamentals` per source:

| Source | Tickers | Field rows |
|---|---|---|
| yahoo | 155 (in SF table, but only 46 overlap canonical 169) | 5,641 |
| finnhub | 157 | 2,817 |
| fmp | 169 | 1,517 |
| edgar | 119 | 1,411 |

### A3. Canonical universe overlap — critical finding

**Only 46 of the 169 canonical tickers have any Yahoo data in `source_fundamentals`.** The canonical 169-ticker universe is FMP-based. Yahoo's `yahoo_fundamentals` table covers different tickers. For 123 of the 169 canonical tickers, Yahoo is irrelevant — FMP must fill those gaps.

FMP has excellent balance sheet coverage for the canonical 169 but almost no valuation/metrics coverage:

| FMP endpoint category | Fields | FMP coverage (canonical 169) |
|---|---|---|
| Income/balance sheet | totalRevenue, netIncome, totalDebt, totalStockholdersEquity, operatingMargin | 157–169/169 ✓ |
| Quarterly cash flow | quarterlyOperatingCashFlow | 156/169 ✓ |
| Gross margin | grossMargin | 97/169 — partial |
| /ratios endpoint | peRatio, pegRatio, priceToBook, priceToSales, currentRatio, debtToEquity, effectiveTaxRate, earningsPerShare, freeCashFlow, etc. | 12–33/169 ✗ |
| /key-metrics endpoint | evEbitda, evRevenue, roic | 0/169 ✗ |
| /wacc endpoint | wacc | 0/169 ✗ |
| /financial-growth endpoint | revenueGrowthYoY, epsGrowth, revenueGrowthYoyPrior, dividendYield, beta | 12–33/169 ✗ |

The original backfill fetched income/balance sheet for all 169 tickers but hit rate limits on /ratios, /key-metrics, /wacc before covering most tickers.

### A4. Current null breakdown in `ticker_fundamentals` (canonical 169)

| Field | Null / 169 | Primary gap reason |
|---|---|---|
| wacc | 169/169 | FMP /wacc: 0 fetched (rate-limited day 1) |
| effectiveTaxRate, sharesOutstandingPrior, priceToSales, roic, revenueGrowthYoyPrior | 157/169 | FMP /ratios or /key-metrics: only 12 tickers |
| epsGrowth, dividendYield, interestExpense | 135–143/169 | Same; partial EDGAR coverage for interestExpense |
| debtToEquity, evEbitda, ebit, evRevenue, cashAndEquivalents, freeCashFlow, sharesOutstanding, revenueGrowthYoY, priceToBook, currentRatio, returnOnAssets, earningsPerShare | 120–124/169 | FMP /ratios: 12–33 tickers; no Polygon/AV yet |
| peRatio, pegRatio, forwardPe, analystTargetPrice, ebitda, returnOnEquity, netMargin, beta | 102–116/169 | FMP /ratios partially fetched; free sources thin on canonical universe |
| grossMargin | 62/169 | FMP has 97 tickers; remainder need /ratios backfill |
| quarterlyOperatingCashFlow | 13/169 | FMP has 156 ✓ |
| totalDebt, totalStockholdersEquity, netIncome | 10/169 | Near-complete ✓ |
| operatingMargin | 1/169 | Only CMPS is null |

**Gap-fill priority by FMP endpoint (1 call/ticker vs 7 for blanket):**
- `/wacc` (1 call × 169) → fills `wacc` for all 169
- `/key-metrics` (1 call × 169) → fills `evEbitda`, `evRevenue`, `roic` for all 169
- `/ratios` (1 call × ~140 gap tickers) → fills `peRatio`, `pegRatio`, `priceToBook`, `priceToSales`, `currentRatio`, `debtToEquity`, `effectiveTaxRate`, `earningsPerShare`, `freeCashFlow`, `dividendYield`
- `/financial-growth` (1 call × ~140 gap tickers) → fills `revenueGrowthYoY`, `epsGrowth`, `revenueGrowthYoyPrior`
- Total gap-targeted calls: ~618 vs 7×169=1183 blanket. **Saves ~565 calls (~48%).**

### A5. FMP budget — current state

**Over budget today.** `fmp_api_usage` shows 301 calls used on 2026-07-04 (limit: 220 conservative / 250 actual). Server startup FMP refresh consumed the quota. Backfill must wait for midnight UTC reset.

### A6. Open data quality issues

**`operatingMargin` (60% pass rate in last validation):** Currently only 1 null (CMPS — Compass Pathways, a pre-revenue biotech where operating margin is extreme). The 60% pass rate was a cross-source validation issue, not a coverage issue. No action needed for nulls.

**`priceToBook` (7% pass rate):** Mid-range values (10–50) fall outside both ratio (≤10) and large-number (≥1000) validation buckets, so they always fail the ±0.05 absolute threshold. This is a validation logic bug, not bad data. Values from FMP are likely correct but untestable with current validation thresholds. FMP /ratios backfill will fill the 121 nulls; divergence detection for this field remains unreliable.

**6 Yahoo zero-field tickers (ADYEN, CYBR, JNPR, PSTG, RDFN, SQ):**
- **ADYEN, CYBR, RDFN**: Not in `ticker_fundamentals` at all — outside the canonical 169-ticker universe. Not a bug.
- **JNPR, PSTG, SQ**: In canonical 169, but have 0 Yahoo fields and only 7 FMP fields (income/balance sheet only, no valuation ratios). These are targets for the /ratios and /key-metrics backfill. No investigation needed — they're simply tickers where the original FMP backfill ran out of budget before fetching valuation endpoints.

### A7. Polygon and AV assessment

**Polygon:** `polygon_fundamentals` is empty. Polygon's field overlap with FMP is high (totalRevenue, netIncome, grossMargin, operatingMargin, totalDebt, totalStockholdersEquity, quarterlyOperatingCashFlow). Since FMP already covers these better (169 tickers vs Polygon's more limited coverage), Polygon's primary value is cross-validation, not filling unique gaps. Worth building the backfill script, but field impact will be minimal for unique nulls.

**Alpha Vantage:** `av_fundamentals` is empty. AV's unique fields vs Yahoo/Finnhub/FMP: moderate overlap. At 25/day quota, AV covers 25 tickers/day. Its fields (peRatio, pegRatio, forwardPe, pbRatio, dividendYield, analystTargetPrice, netMargin, operatingMargin, returnOnEquity, totalRevenue, ebitda, beta) all have FMP as higher priority per FIELD_DEFS, so AV will only win the merge for tickers where FMP /ratios is also null. Given FMP backfill will fill most of those, AV's unique contribution post-FMP-backfill is likely small. Still worth building for completeness and cross-validation.

---

## Yahoo Coverage Discrepancy — Audit (2026-07-05)

### Root cause

The prior handoff stated "yahoo_fundamentals backfilled for 161 of 169 canonical tickers." This conflated the **total row count** of `yahoo_fundamentals` (161) with canonical overlap — these are different ticker universes. The actual canonical overlap was always only 49 tickers.

### yahoo_fundamentals — confirmed current state

| Metric | Value |
|---|---|
| Total rows | 161 |
| Distinct tickers | 161 (one row/ticker) |
| Fetched at | 2026-06-26 16:23–16:34 UTC |

### Canonical coverage breakdown

| Category | Count |
|---|---|
| Canonical tickers (fmp_fundamentals) | 169 |
| yahoo_fundamentals tickers matching canonical (exact symbol) | 49 |
| Of those 49: valid data written to source_fundamentals | **46** |
| Of those 49: all-null → excluded from source_fundamentals | **3** (JNPR, PSTG, SQ) |
| Canonical tickers with zero Yahoo coverage (not in yahoo_fundamentals) | **120** |

The 112 remaining yahoo_fundamentals rows cover non-canonical tickers in the broader peer-group/registry universe. `populate-source-fundamentals.ts` wrote all 155 non-null Yahoo tickers to source_fundamentals, but 109 of those are outside the canonical set and are ignored by `merge-trusted.ts` (fmp_fundamentals allowlist).

### Why JNPR, PSTG, SQ are absent from source_fundamentals

All three are in `yahoo_fundamentals` AND `fmp_fundamentals`, but every numeric column is NULL — Yahoo's API returned a timestamped row with no data. `populate-source-fundamentals.ts` skips null values (line 201: `if (val === null || val === undefined) continue`) and skips the ticker entirely if batch is empty (line 208). No bug — correct behavior.

### populate-source-fundamentals.ts — no ticker filtering

The script reads all 161 rows from `yahoo_fundamentals` with no join to `fmp_fundamentals`, no `source_ticker_map` lookup, and no casing filter. The 46-vs-155 split is entirely because 120 canonical tickers were never in `yahoo_fundamentals` to begin with.

### Impact on gap-fill plan

**The Part A gap-fill plan is still correct and requires no recalculation.** The A3 finding already stated this accurately: 46 canonical tickers have usable Yahoo data; 123 do not (120 absent + 3 all-null). The FMP backfill scope, per-endpoint priority order, and ~618-call gap-targeted estimate all remain valid. Proceed with backfill-fmp.ts after FMP quota resets at midnight UTC.

---

### Ready for Part B

Scripts to build (all new, targeting source staging tables, gap-aware):
1. `backfill-fmp.ts` — gap-targeted, per-endpoint, wraps into `fmp_fundamentals`
2. `backfill-polygon.ts` — wraps into `polygon_fundamentals`
3. `backfill-av.ts` — wraps into `av_fundamentals`

Run order after midnight UTC: backfill-fmp → backfill-polygon → populate-source-fundamentals → merge-trusted (AV on separate day per constraint).
