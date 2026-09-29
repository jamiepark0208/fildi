# Fundamentals refresh cadence (why we don't hit every field daily)

Industry pattern for multi-vendor market data under rate limits: **tiered TTL +
gap-driven fetch**, not full-universe every day. TradeDash already does most of this.

## What we already do (good)

| Mechanism | Where | Effect |
|---|---|---|
| `STALE_DAYS = 7` | `data-ops-config` | Don't re-hit a source if bronze staging is fresh |
| Null/gap targeting | `nightly-enrichment` `buildFetchTargets` | Only fetch tickers that still have null gold fields that source can fill |
| Skip if silver already has values | same | Re-merge instead of re-fetch |
| Cohort rotation (14d) | FMP / Alpha Vantage | Scarce budgets rotate across universe |
| Cheap → scarce order | yahoo → edgar → finnhub → polygon → AV → FMP | Burn expensive APIs last |
| FactSet referee only | drain / nightly optional | Not a daily full scan |
| Derive over fetch | PEG, margins, PE… | Zero API cost |

**You should NOT query every field for every ticker every day.** Fundamentals (margins, debt, shares) change on earnings/filings cadence — weekly bronze refresh is appropriate. Prices/technicals are the high-frequency layer (separate pipeline).

## Recommended cadence (steady state)

| Layer | Cadence | Sources |
|---|---|---|
| Prices / technicals | Daily (market days) | Yahoo OHLCV |
| Fundamentals bronze | Weekly stale + nulls | Yahoo/Finnhub first; FMP/AV cohort |
| FactSet referee | Budgeted drip (≤40–80/day) | Divergent / null only |
| Earnings history | ~30d stale | Already separate |
| Merge + derives | After every enrich / weekly check | 0 API |

## Remaining DB polish (not blockers)

1. BRK.B / BF.B Yahoo symbol aliases (tech missing)
2. Scorer unify after 7d green §1 targets
3. Optional: event-driven refresh on earnings date (future) instead of only stale timer

## Operator loop

`node scripts/weekly-data-ops-check.mjs` + value log — prove NR/coverage deltas without re-exploring the pipeline.
