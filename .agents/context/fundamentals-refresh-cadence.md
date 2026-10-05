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
| FactSet referee only | `drain-needs-review` via daily maintain | ≤40/day when rem≥60 — not a full scan |
| Earnings window | `enrich-earnings-window` + nightly priority | ±1/+2d reporters, 1d stale, max 40/day |
| Missing gold | `enrich-missing-fundamentals` | New registry adds, max 30/day |
| Derive over fetch | PEG, margins, PE… | Zero API cost |
| Full nightly catch-up | `maintain --enrich-if-due` | Only if last `enrichment_runs` success ≥ **4 days** |

**You should NOT query every field for every ticker every day.** Fundamentals change on earnings/filings cadence. Prices/technicals/options are **ad-hoc on UI click** (correct) — not in LaunchAgent.

## Recommended cadence (steady state)

| Layer | Cadence | Sources |
|---|---|---|
| Prices / technicals / options | On click (not scheduled) | Yahoo / options routes |
| Fundamentals bronze (bounded) | Daily maintain @10:30 | missing ≤30 + earnings ≤40 |
| Full-universe enrich | ≥4d since last success | `nightly-enrichment.ts` |
| FactSet referee | Budgeted drip ≤40/day if rem≥60 | Divergent / null only |
| Merge + fund_score (+10% sector opportunity layer) | After daily maintain writes | 0 API (`post-merge-scores.ts`); uses Finnhub mcap for peer-group size |
| Peer heal | Daily maintain | `peer-health-check.ts` |

## Operator loop

- Daily: LaunchAgent `com.fildi.maintain` → `/tmp/fildi-logs/maintain-last.json`
- Weekly: `node scripts/weekly-data-ops-check.mjs` + value log
- Retrieval map: `.agents/context/INDEX.md`
