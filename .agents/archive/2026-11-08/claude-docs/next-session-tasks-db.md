# Next Session Tasks — DB/Backfill

Read phase-report-db-260704.md first for full context.

## Step 1 — Confirm universe growth 168 → 257 (REPORT ONLY, wait for confirmation)

List the 89 tickers added to fmp_fundamentals beyond the original 168. Identify which script wrote them by checking fetchedAt timestamps and cross-referencing with:
- backfill-fundamentals.ts (legacy, targets WATCHLIST + peer_group_members ~500 tickers)
- admin peer-group backfill scripts
- intentional universe expansion script from prior session

Do NOT treat "scripts query fmp_fundamentals dynamically" as an answer — that's the mechanism, not whether the 89 are intentional.

Wait for confirmation that 257 is correct (or needs rollback to 168) before Step 2.

## Step 2 — Enforce universe as a versioned artifact

- Create `artifacts/config/canonical-tickers.json` — static, version-controlled list
- Create `artifacts/api-server/src/scripts/validate-universe.ts` — compares file vs fmp_fundamentals, exits non-zero on mismatch
- Update backfill-fmp.ts, backfill-polygon.ts, backfill-av.ts, merge-trusted.ts to read ticker list from this file instead of live fmp_fundamentals query
- Future universe changes require explicit file edit — not incidental row inserts

## Step 3 — Audit drift risks

Report each as: enforced-in-code / documented-only / already-drifted. Fix drifted values only after reporting.

- ETF exclusion list (SMH, SOXX, IWM, QQQ, SPY, etc.) — is any excluded ETF currently in fmp_fundamentals?
- FIELD_DEFS priority table — confirm it exists in exactly one place (merge-trusted.ts), no duplicate/partial copy elsewhere
- Rate limit constants (FMP 250/day, AV 25/day, Polygon 5/min) — defined once and imported, or hardcoded per script?
- ticker_registry peer_group membership — could peer-group backfills have added tickers bypassing the original seed logic?
- schema/index.ts comments — check for stale writer comments beyond the two already fixed

## Step 4 — Wire Polygon/AV into merge-trusted.ts FIELD_DEFS

Currently neither source has any path to ticker_fundamentals (cross-validation only).

Add as lowest-priority fallbacks:
- Polygon: totalRevenue, netIncome, grossMargin, operatingMargin, totalDebt, totalStockholdersEquity, quarterlyOperatingCashFlow
- AV: peRatio, pegRatio, forwardPe, priceToBook, dividendYield, analystTargetPrice, netMargin, operatingMargin, returnOnEquity, totalRevenue, ebitda, beta

First resolve: do Yahoo/Edgar actually provide totalStockholdersEquity / quarterlyOperatingCashFlow under any field name in source_fundamentals? The skip-check bug fix excluded these but didn't answer whether they're genuinely uncovered by free sources.

Relevant field name mappings (from prior session audit):
- totalStockholdersEquity → Edgar writes "totalEquity"; Yahoo writes "annualTotalEquity"
- quarterlyOperatingCashFlow → Yahoo/Edgar both write "operatingCashFlow" (annual, not quarterly)

## Step 5 — Re-verify before any live backfill

- Re-run merge-trusted.ts on existing data (no new fetches); confirm Polygon/AV fields now appear as candidates in field_provenance
- Re-run dry runs for backfill-fmp/polygon/av against confirmed universe
- Report updated call-count projections
- Do NOT run any live API call until Steps 1–5 are confirmed

## Also pending (lower priority)

- Register provenanceCache in cache-registry.ts (admin cache panel)
- Verify provenance tooltip shows real data in UI after merge-trusted re-run
