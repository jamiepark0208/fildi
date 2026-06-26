# Stock DB Prefill — Phase Report
> Last updated: 2026-06-26 14:42 UTC

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

## Run #1 Results (2026-06-26) — COMPLETED

**Started:** 14:10 UTC | **Completed:** 14:41 UTC (~31 minutes)

| Metric | Value |
|--------|-------|
| Total tickers processed | 548 |
| Fields filled total | 787 |
| Tickers with ≥1 field filled | 145 (Polygon) + 22 (AV) |
| Tickers with 0 fields filled | 391 |
| FMP status | **Exhausted** — 616 calls used before script ran (contributed 0) |
| AV status | **Exhausted** — 25/day limit hit by test run + first batch only |
| Polygon status | 145 successes; rest rate-limited (429 on all 3 retries) |
| Top remaining null fields | evEbitda(170), evRevenue(170), wacc(170), freeCashFlow(166), revenueGrowthYoyPrior(166) |

**Bugs found and fixed during this run:**

### Bug 1: Wrong ticker universe (548 vs 158)
The backfill script queried the `watchlist` DB table + ALL `peerGroupMembers` rows globally, yielding 548 tickers. The Stock DB UI tab only shows ~158 tickers (derived from the hardcoded `WATCHLIST` constant in `constants.ts` → their peer groups via `tickerRegistry`). The script was filling data for tickers that don't appear in the UI at all.

**Fix applied:** `getAllTargetTickers()` now mirrors the `/fundamentals/stock-db` route exactly — `WATCHLIST` constant → `tickerRegistry.primaryPeerGroupId` → `peerGroupMembers` for those group IDs only.

### Bug 2: Polygon concurrency too high (3 concurrent → 429 on everything)
`MAX_CONCURRENT=3` with `sleep(300ms)` between Polygon calls = ~10 req/min, double the 5/min free-tier limit. After exhausting 3 retries with exponential backoff, tickers fell through with `filled:0` and were recorded as failed in `source_ticker_map` (incorrectly — Polygon has the data, we just overran the rate limit).

**Fix applied:** `MAX_CONCURRENT=1` + `sleep(13000)` per Polygon call = 4.6 req/min, safely under the cap.

### Bug 3: AV budget burned by smoke test
Running `test-av-polygon.ts` on the same day consumed 3 of the 25 daily AV calls before the backfill ran. The first backfill batch used ~22 more, exhausting the budget after batch 1.

**Fix:** Do not run `test-av-polygon.ts` on production keys on the same day as a backfill run. AV budget is now reserved exclusively for the backfill script.

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

**Run #2 (tonight, after midnight UTC) — estimated outcome:**
- ~158 tickers (correct universe)
- Polygon succeeds on all ~158 (MAX_CONCURRENT=1, sleep 13s) → 7 income-stmt fields per ticker
- AV fills ~25 tickers with valuation ratios (forwardPe, peRatio, beta, etc.)
- FMP fills ~35 tickers with full 30-field coverage including FMP-only fields

**Run #3+ (subsequent nights):**
- Work queue shrinks as tickers get CRITICAL fields filled; FMP/AV budget used on most-null tickers
- After ~5 nightly runs: all 158 tickers should have CRITICAL fields covered
- IMPORTANT fields (evEbitda, evRevenue, wacc, revenueGrowthYoyPrior) are FMP-only — 35 tickers/night = ~5 nights for full coverage

**Other actions:**
- Do NOT run `test-av-polygon.ts` on production keys on a backfill day
- EDGAR fallback not yet wired — could cover any remaining gaps with no daily limit
- Once CRITICAL fields are fully populated, re-run scoring pipeline to eliminate null-driven score suppression

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
