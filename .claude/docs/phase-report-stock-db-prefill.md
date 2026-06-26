# Stock DB Prefill — Phase Report
> Last updated: 2026-06-26

---

## What This Is

A data backfill pipeline to populate `ticker_fundamentals` for all ~550 distinct tickers across the watchlist and peer group universe. The goal is to eliminate null values in the Stock DB Settings tab so scoring, rankings, and comparisons are complete.

---

## Scripts Built This Session

### `artifacts/api-server/src/scripts/test-av-polygon.ts`
Smoke-test for the two new data sources. Run manually before any batch.
- Calls Polygon + Alpha Vantage for NVDA, AAPL, PLTR
- Logs results and expected `source_ticker_map` entries
- Verified working: Polygon fills 7 fields/ticker, AV fills 11-12 fields/ticker

### `artifacts/api-server/src/scripts/backfill-fundamentals.ts`
The main backfill script. **Do not run automatically — invoke manually after FMP and AV daily limits reset at midnight UTC.**

**What it does:**
1. Collects all distinct tickers from `watchlist` + `peer_group_members` tables
2. Builds a priority-sorted work queue: tickers with no DB row first, then by descending null CRITICAL field count
3. Skips tickers whose row is fresh (< 7 days) AND has zero null CRITICAL fields
4. For each ticker, runs the waterfall: **Polygon → Alpha Vantage → FMP**
   - Each source merges into the existing DB row — never overwrites filled fields with nulls
   - Polygon/AV results persisted via `writeFundamentalsRow` with merge
   - FMP gated by `checkFMPBudget()` before each batch
5. Updates `source_ticker_map` (active=true/false) after every Polygon/AV attempt
6. Batches 5 tickers, max 3 concurrent per batch
7. Logs a `BATCH` line per batch + `SESSION COMPLETE` at end (data-agent.md format)

**Source coverage per ticker:**
| Source | Fields Filled | Daily Limit | Notes |
|--------|--------------|-------------|-------|
| Polygon | 7 (income stmt + balance sheet) | None (5/min) | totalRevenue, netIncome, grossMargin, operatingMargin, totalDebt, totalStockholdersEquity, quarterlyOperatingCashFlow |
| Alpha Vantage | 11-12 (ratios + margins) | **25/day** | peRatio, forwardPe, pbRatio, netMargin, operatingMargin, returnOnEquity, totalRevenue, ebitda, beta, dividendYield, analystTargetPrice |
| FMP | Full (~30 fields) | **250 calls/day** (~35 tickers at 7 calls/ticker) | Most complete source; free tier covers ~35 tickers/day |

---

## Current Run Status (2026-06-26)

**Started:** 14:10 UTC | **Still running as of ~14:30 UTC**

| Metric | Value |
|--------|-------|
| Total tickers | 548 (4 skipped as fresh+complete) |
| Processed so far | ~335/548 (~61%) |
| Got ≥1 field filled | ~103 |
| Got 0 fields (all sources failed) | ~232 |
| FMP status | **Exhausted** — 616 calls used before script ran |
| AV status | **Exhausted** — 25/day used by test run (NVDA/AAPL/PLTR) + first batch |
| Polygon status | Working but rate-limiting (429 on ~70% of concurrent calls) |

**Why so many `filled:0` results:**
- Running 3 concurrent Polygon calls at 300ms spacing hits the 5/min cap immediately
- After 3 retries with exponential backoff all fail → ticker recorded as 0 filled
- Data IS available from Polygon — it's a concurrency/pacing issue, not a coverage issue

---

## Why the UI Still Shows Null Values

### Root cause 1: FMP exhausted before backfill ran
FMP is the richest free source (~30 fields per ticker). Its free tier allows ~35 tickers/day (250 calls ÷ 7 endpoints/ticker). Today's 616 calls were already consumed before the backfill script was run, so FMP contributed nothing this run.

**Fix:** Run again after midnight UTC when FMP resets. Prioritize tickers with the most null CRITICAL fields.

### Root cause 2: AV exhausted after 3-ticker smoke test
Alpha Vantage's 25/day limit was consumed by the test run (NVDA/AAPL/PLTR = 3 calls) plus the first backfill batch (~22 calls). AV fills the valuation ratio fields Polygon doesn't cover (peRatio, forwardPe, beta, etc.).

**Fix:** Reserve AV budget exclusively for backfill (don't run the test script on production keys on the same day).

### Root cause 3: Polygon concurrency too aggressive
3 concurrent calls per batch + 300ms between batches = ~10 calls/minute, which exceeds Polygon's 5/min free tier. The exponential backoff (1s → 2s → 4s) handles occasional bursts but not sustained concurrency.

**Fix (already staged in script):** Reduce `MAX_CONCURRENT` to 1 for Polygon-heavy runs, or add a per-ticker sleep of 13s+ to stay under 5/min.

### Root cause 4: Polygon doesn't cover valuation ratios
Even when Polygon succeeds, it only returns income statement and balance sheet data. It does NOT provide:
- `peRatio`, `pegRatio`, `forwardPe`, `evEbitda`, `evRevenue`
- `beta`, `dividendYield`, `analystTargetPrice`
- `revenueGrowthYoY`, `revenueGrowthYoyPrior`, `epsGrowth`

These fields require FMP or AV. Both are exhausted today.

---

## What's Wired in the Production Waterfall (stock-data-manager.ts)

Priority order when `getFundamentals(ticker)` is called:
1. FactSet (env-gated, paid)
2. SimFin (env-gated)
3. SEC EDGAR (always available)
4. Finnhub (env-gated)
5. FMP (250/day budget)
6. **Polygon** ← NEW this session
7. **Alpha Vantage** ← NEW this session

Both new sources use `patchFundamentals()` (merge into existing row) rather than full overwrite.

---

## Next Steps to Resolve Nulls

1. **Tonight (after midnight UTC):** Run `backfill-fundamentals.ts` with `MAX_CONCURRENT=1` and `sleep(13000)` between Polygon calls to stay under 5/min
2. **FMP budget (~35 tickers/day):** Prioritize tickers with the most null CRITICAL fields — script already sorts the work queue this way
3. **AV budget (25/day):** Reserve entirely for backfill; script correctly gates this via budget check
4. **After 2-3 days of backfill runs:** Most tickers should have CRITICAL fields covered; IMPORTANT fields (forwardPe, evEbitda, etc.) will take longer given AV's 25/day cap
5. **EDGAR fallback:** Not yet wired — could cover any remaining gaps with no daily limit

---

## Field Coverage by Source (Reference)

```
CRITICAL (scoring blockers — highest priority):
  grossMargin          → Polygon ✓, FMP ✓, AV ✓
  netMargin            → Polygon (computed), FMP ✓, AV ✓
  operatingMargin      → Polygon ✓, FMP ✓, AV ✓
  totalRevenue         → Polygon ✓, FMP ✓, AV ✓
  netIncome            → Polygon ✓, FMP ✓
  freeCashFlow         → FMP ✓ only
  ebitda               → FMP ✓, AV ✓
  ebit                 → FMP ✓ only
  totalDebt            → Polygon ✓, FMP ✓
  cashAndEquivalents   → FMP ✓ only
  returnOnEquity       → FMP ✓, AV ✓
  revenueGrowthYoY     → FMP ✓ only

IMPORTANT (scoring quality):
  forwardPe            → FMP ✓, AV ✓
  evEbitda             → FMP ✓ only
  evRevenue            → FMP ✓ only
  priceToBook          → FMP ✓, AV ✓
  dividendYield        → FMP ✓, AV ✓
  wacc                 → FMP ✓ only
  revenueGrowthYoyPrior→ FMP ✓ only
  epsGrowth            → FMP ✓ only
```

Several CRITICAL fields (`freeCashFlow`, `ebit`, `cashAndEquivalents`, `revenueGrowthYoY`) and most IMPORTANT fields are **FMP-only**. These will remain null until FMP resets.
