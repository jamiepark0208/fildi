# Phase Report: Sector-Relevant Fundamental Scoring Enhancement

**Date:** 2026-06-25  
**Status:** Complete (pending DB migration in Replit shell)

---

## Overview

Added sector/peer-group awareness to the fundamental scoring pipeline so that stocks are evaluated against contextually appropriate peers and metric sets, rather than a flat cross-sectional universe.

---

## Step 1 — Peer Group Infrastructure

### Schema additions (`lib/db/src/schema/index.ts`)

| Table | Purpose |
|---|---|
| `peer_groups` | id (PK), name, scoring_mode, metric_exclusions[], benchmarks[], low_confidence |
| `peer_group_members` | group_id FK + ticker, composite PK — junction table |
| `unmapped_tickers` | ticker PK, seen_at — tickers classifyTicker could not place |
| `ticker_registry.primary_peer_group_id` | FK → peer_groups.id, new column on existing table |

Migrations generated: `0002_peer_groups.sql`, `0003_unmapped_tickers.sql`

### Seed script (`scripts/src/seed-peer-groups.ts`)

- 48 peer groups seeded across Technology, Financials, Healthcare, Industrials, Energy, Materials, Real Estate, Utilities, Telecom, and Speculative Thematic sectors
- ETF tickers excluded from membership (SMH, SOXX, IWM, QQQ, SPY, BIZD, JBBB, NVDY, SPCK, PSUS, HOOY, ARKG, CANE)
- Dual-membership tickers (e.g. NVDA, TSLA, SHOP, COIN) get canonical primary group via override map
- Idempotent via `onConflictDoUpdate` / `onConflictDoNothing`
- Run with: `pnpm --filter @workspace/scripts seed:peers`

### Server-side peer classifier (`api-server/src/lib/peer-classifier.ts`)

`classifyTicker(ticker)` → `{ groupId, confidence, metricExclusions }` via priority chain:

1. **mapped** — `ticker_registry.primary_peer_group_id` already set
2. **auto (peer overlap)** — fetches peer list via `resolvePeers()`, counts `peer_group_members` overlaps; ≥2 hits → auto-classify, upsert registry, append to `artifacts/config/ticker-mapping-overrides.json`
3. **auto (keyword map)** — Yahoo `assetProfile` sector + industry matched against a 60-entry keyword map covering all major Yahoo sector/industry strings
4. **unmapped** — inserts into `unmapped_tickers`, returns `groupId: "__global__"`

### New API endpoints (`api-server/src/routes/fundamentals.ts`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /fundamentals/peer-groups?tickers=X,Y,Z` | public | Resolves peer group + metricExclusions for each ticker; used by home.tsx to build peerGroupMap before scoring |
| `GET /fundamentals/unmapped` | admin | Returns unmapped_tickers rows for manual review |

---

## Step 2 — Scoring Pipeline Improvements

### 1. Tighter winsorization (`rankings-helpers.ts`)

Added `MIN_TIGHT_N = 20`. `normalize()` now selects winsorization percentiles based on group size:

| Group size | Winsorization | Path |
|---|---|---|
| n ≥ 20 | 2nd / 98th percentile | z-score |
| 8 ≤ n < 20 | 5th / 95th percentile (existing) | z-score |
| n < 8 | — | ordinal rank |

### 2. Structural nulls (`rankings.ts`, `computeRankingsV2`)

Inserted a pipeline block between raw value extraction and suspect detection. Applied **only** in direction-inversion cases — all other negatives remain in the pool and score low naturally:

| Condition | Metric nulled | Reason |
|---|---|---|
| `peer_groups.metric_exclusions` for this group | per group definition | scoring_mode excludes it entirely |
| `netIncome < 0` | `pe_ratio` | Negative P/E inverts "lower = cheaper" direction |
| `netIncome < 0` OR `epsGrowth ≤ 0` | `peg` | Mathematically undefined |
| `totalStockholdersEquity < 0` AND `netIncome > 0` | `roe` | Equity sign flip makes ROE directionally broken |

`earningsYield` is intentionally kept for loss-making companies — negative yield scores low, which is the correct signal.

### 3. WACC sourced from FMP (`fmp-client.ts` + `rankings.ts`)

- Added `/stable/wacc` fetch to `fetchFMPFundamentals` (8th parallel endpoint)
- Result stored to `ticker_fundamentals.wacc` via existing `stock-data-manager.ts` write path
- `roicwacc` metric in scorer now uses `s.wacc ?? approxWACC(...)` — DB value preferred, CAPM approximation kept as fallback until all rows are populated from next refresh cycle

### 4. peerGroupMap threaded through scorer (`rankings.ts`)

`computeRankingsV2` signature updated:
```
computeRankingsV2(stocks, preset?, intraWeightOverrides?, peerGroupMap = {})
```

- `stockGroupKeys` now maps tickers to real group IDs from `peerGroupMap`
- Each returned `StockScore` carries `peerGroupId` and `peerGroupConfidence`
- `peerGroupMap` value type: `{ groupId, confidence, metricExclusions? }`

---

## Pending / Next Steps

1. **Apply DB migrations** — run `drizzle-kit migrate` from Replit shell with `DATABASE_URL` set (migrations 0001 → 0003)
2. **Seed peer groups** — `pnpm --filter @workspace/scripts seed:peers` after migrations applied
3. **Wire home.tsx** — call `GET /fundamentals/peer-groups?tickers=...` and pass result into `computeRankingsV2` as `peerGroupMap`
4. **FMP WACC refresh** — trigger `/fundamentals/refresh` to populate `wacc` column for all watchlist tickers
5. **Review unmapped** — check `GET /fundamentals/unmapped` after first production run; add manual overrides to `artifacts/config/ticker-mapping-overrides.json` as needed

---

## Files Changed

| File | Change type |
|---|---|
| `lib/db/src/schema/index.ts` | Added peer_groups, peer_group_members, unmapped_tickers tables; primaryPeerGroupId column on ticker_registry |
| `lib/db/drizzle/0002_peer_groups.sql` | Generated migration |
| `lib/db/drizzle/0003_unmapped_tickers.sql` | Generated migration |
| `scripts/src/seed-peer-groups.ts` | New — 48-group seed with ETF exclusions and dual-membership overrides |
| `scripts/package.json` | Added `seed:peers` script and `@workspace/db` dependency |
| `artifacts/api-server/src/lib/peer-classifier.ts` | New — classifyTicker() with 3-tier priority chain |
| `artifacts/api-server/src/lib/fmp-client.ts` | Added /stable/wacc fetch |
| `artifacts/api-server/src/routes/fundamentals.ts` | Added /peer-groups and /unmapped endpoints |
| `artifacts/stock-compare/src/lib/rankings-helpers.ts` | Added MIN_TIGHT_N; tighter winsorization for n≥20 |
| `artifacts/stock-compare/src/lib/rankings.ts` | peerGroupMap param, structural nulls pipeline, DB WACC preference, StockScore fields |
| `artifacts/config/ticker-mapping-overrides.json` | New — auto-classification output file |
