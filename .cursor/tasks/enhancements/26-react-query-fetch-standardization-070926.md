# react-query-fetch-standardization

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P2 |
| **Area** | api / ui |
| **Effort** | M (narrow: keys + defaults + 2–3 hot paths) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [openapi-orval](22-openapi-coverage-orval-migration-070926.md), [watchlist-monitor](16-watchlist-monitor-improvements-070926.md) |

### Resolution (2026-07-11)
W1–W3 shipped via enh/34 Wave B: `lib/query-keys.ts` created, App-level default `staleTime` set to 5m, and home + scanner unified onto a single `queryKeys.fundamentalsRankings` key (previously `["fundamentals-rankings"]` vs `["fundamentals","rankings"]` caused a real double-fetch on Home→Scanner navigation). W4 (unify the two "regime" query keys) was investigated and closed as N/A — they turned out to be two unrelated products (business-cycle regime vs intraday VIX-band regime) that happened to collide on the word "regime." Instead, the scanner's route was renamed to `/volatility/regime` to remove the naming confusion, with clarifying comments added to both route files.
