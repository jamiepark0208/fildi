# DB Phase Report — 2026-07-04/05

## Current state (as of 2026-07-05 ~20:00 UTC)

### Table row counts

| Table | Rows | Notes |
|---|---|---|
| fmp_fundamentals | 257 | Canonical universe. 168 original + 89 added 2026-07-05 (88-ticker peer-group expansion + IONQ separate INSERT). Phase report previously said 256 — miscounted. |
| yahoo_fundamentals | 281 | 161 original + 120 canonical backfill |
| finnhub_fundamentals | 158 | |
| edgar_fundamentals | 158 | |
| polygon_fundamentals | 0 | Empty — awaiting backfill |
| av_fundamentals | 0 | Empty — awaiting backfill |
| source_fundamentals | ~15,809 | Silver layer. All sources, canonical field names. |
| ticker_fundamentals | 257 | Gold layer. Merged via merge-trusted.ts. |
| field_provenance | 6,726 | Populated by last merge run 2026-07-05 17:52 UTC |
| manual_overrides | 0 | |

### Stale/renamed tickers (handled 2026-07-05)
- JNPR deleted (acquired by HPE, delisted)
- DISH → ECHO, PSTG → P, SQ → XYZ (in-place rename across all 9 tables)
- source_ticker_map updated: ticker=new symbol, source_ticker=old symbol, notes=rename date

### Yahoo canonical coverage
164 / 257 tickers have usable Yahoo data in source_fundamentals.
Zero-data tickers: HBI (fetched, all-null). ECHO/P/XYZ re-fetched after rename — all now have data.

---

## Data layer architecture

**Pipeline: Bronze → Silver → Gold**
1. Bronze staging (fmp/yahoo/finnhub/edgar/polygon/av_fundamentals) — one row/ticker, source-prefixed cols
2. `populate-source-fundamentals.ts` → silver (`source_fundamentals`, PK: ticker+source+field)
3. `merge-trusted.ts` → gold (`ticker_fundamentals` + `field_provenance`)

**merge-trusted.ts FIELD_DEFS priority (hardcoded, single source of truth):**
- Valuation: yahoo → finnhub → fmp
- Margins/returns: yahoo → finnhub → fmp (never edgar — period mismatch)
- debtToEquity: yahoo → fmp (never finnhub — definitional mismatch)
- Balance sheet: yahoo → finnhub → edgar → fmp
- Income statement: yahoo → fmp → edgar
- Cash flow: yahoo → fmp → edgar
- wacc, roic, priceToSales, effectiveTaxRate, revenueGrowthYoyPrior, sharesOutstandingPrior: fmp only
- **Polygon and AV: NOT in FIELD_DEFS — cross-validation only, no path to ticker_fundamentals**

---

## Backfill scripts (api-server/src/scripts/)

| Script | Skip logic | Rate limit | Dry-run result |
|---|---|---|---|
| backfill-fmp.ts | Staleness: fmp_wacc/fmp_roic non-null AND fetchedAt < 7d | 9 calls/ticker; checkFMPBudget/recordFMPCalls | 247 fetch / 10 skip / 2223 calls |
| backfill-polygon.ts | Yahoo+Edgar cover 6 checkable fields in source_fundamentals | 3 concurrent, 1s between batches | 175 fetch / 82 skip |
| backfill-av.ts | Staleness: av_fundamentals.fetchedAt < 7d | 25/day; cursor in logs/av-cursor.json | 257 fetch / 0 skip (empty table) |

All support `--dry-run`. Build: `node build-script.mjs src/scripts/<name>.ts`

**Polygon skip-check uses only 6 of 8 fields:** totalRevenue, netIncome, grossMargin, operatingMargin, interestExpense, totalDebt. Excluded: `totalStockholdersEquity` (Yahoo→"annualTotalEquity", Edgar→"totalEquity") and `quarterlyOperatingCashFlow` (Yahoo/Edgar→"operatingCashFlow") — different canonical names, never satisfiable.

**AV field-coverage skip removed:** peRatio + dividendYield never appear in Yahoo source_fundamentals, so "all covered by Yahoo" could never fire.

---

## Critical field-name mapping facts

Yahoo writes to source_fundamentals under names that differ from ticker_fundamentals cols:
- `totalStockholdersEquity` → Yahoo: `annualTotalEquity`; Edgar: `totalEquity`
- `quarterlyOperatingCashFlow` → Yahoo/Edgar: `operatingCashFlow`
- `revenueGrowthYoY` → Yahoo: `revenueGrowth`
- `cashAndEquivalents` → Yahoo: `totalCash`
- `earningsPerShare` → Yahoo: `trailingEps`
- `peRatio` → not in Yahoo source_fundamentals
- `dividendYield` → not in Yahoo source_fundamentals

merge-trusted FIELD_DEFS handles this via per-field source+fieldname pairs, e.g.:
`{ tfCol: "totalStockholdersEquity", priority: [["edgar","totalEquity"], ["fmp","totalStockholdersEquity"]] }`

---

## Stock DB tooltip + override system (complete)

- `field_provenance` (PK: ticker+field): winning_source, winning_value, is_override, divergent
- `manual_overrides` (PK: ticker+field): override_source, override_value, note
- API: GET/PUT/DELETE `/fundamentals/provenance/:ticker` + `/fundamentals/override`
- StockDBTab: per-cell Radix Popover, source breakdown table, override form
- Server: provenanceCache (TTLCache 15min), invalidated on override save and merge batch
- Client: AbortController via react-query signal, 10min staleTime, refetchOnWindowFocus
- **field_provenance needs re-run of merge-trusted after universe expansion (current rows pre-expansion)**

---

## Pending null coverage (canonical 257, post-Yahoo backfill)

FMP backfill targets: wacc(257/257), priceToSales(~245/257), roic(~245/257), revenueGrowthYoyPrior(~245/257), sharesOutstandingPrior(~245/257), effectiveTaxRate(~245/257), epsGrowth(~230/257), dividendYield(~225/257), interestExpense(~215/257)

---

## Run order for live backfills (after midnight UTC)

1. `backfill-fmp.mjs` — repeat daily (~10 days, 247 tickers × 9 calls / 250 budget)
2. `backfill-polygon.mjs` — one shot (175 tickers)
3. `populate-source-fundamentals.mjs`
4. `merge-trusted.mjs` — refreshes field_provenance
5. `backfill-av.mjs` — 25/day, resumable (~11 days)

---

## Next session tasks

Full task list: `.claude/docs/next-session-tasks-db.md`

1. Confirm whether 257-ticker expansion is intentional (Step 1 — report only, wait for confirmation)
2. Create `canonical-tickers.json` + `validate-universe.ts`; wire scripts to read from it
3. Audit ETF exclusion, FIELD_DEFS duplication, rate-limit constants, peer-group drift, schema comments
4. Wire Polygon/AV into merge-trusted.ts FIELD_DEFS as lowest-priority fallbacks
5. Re-run merge-trusted + dry runs against confirmed universe before any live API call
