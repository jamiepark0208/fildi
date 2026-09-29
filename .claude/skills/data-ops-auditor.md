---
name: data-ops-auditor
description: Audit TradeDash fundamentals data pipelines for duplicate gold writers, constant drift, coverage, and enrichment health. Use when reviewing data quality, enrichment, StockDataManager, FIELD_DEFS, or FMP budgets.
---

# Data-ops auditor

## Canonical pipeline (only gold writer)

```
bronze fetch (SOURCE_ORDER: yahoo → edgar → finnhub → polygon → av → fmp)
  → populate-source-fundamentals
  → merge-trusted (FIELD_DEFS + DIVERGENCE_TOL → field_provenance)
  → ticker_fundamentals (gold)
  → fund_score recompute
```

Entry points:

- Scheduled: `nightly-enrichment` via `lib/scheduler.ts` (Sun+Thu 02:00 UTC)
- On-demand: `lib/enrich-and-merge.ts` (`enrichAndMergeTickers`)
- Queue UI: `routes/fundamentals-refetch-queue.ts` (same FETCH_FN + populate + merge)

**Forbidden:** writing `ticker_fundamentals` from a single-source waterfall (legacy SDM).
SDM may only **read** gold or call `enrichAndMergeTickers`.

## FactSet

`lib/factset-client.ts` + `lib/factset-referee.ts` — last-resort after free sources.
Nightly enrichment runs referee for nulls/divergences (budget-capped), writes
`source_fundamentals` (`source=factset`), then re-merges. FIELD_DEFS lists factset
last; when free sources diverge, merge prefers FactSet if present.

## Shared constants

All in `lib/data-ops-config.ts`:

- `STALE_DAYS`, `CALLS_PER_TICKER`, `FMP_MAX_DAILY_CALLS`, `COHORT_MODULUS`, `SOURCE_ORDER`

Do not redefine literals (`STALE_DAYS = 7`, FMP `* 7`) elsewhere.

## Checklist (run in order)

1. `node scripts/data-ops-audit.mjs` — constant drift + illegal gold writers
2. `GET /api/admin/data-health` — fresh/stale/neverFetched, topNullFields, divergentCount
3. `npx tsx artifacts/api-server/src/scripts/audit-coverage.ts --suspicious`
4. Confirm `enrichment_runs` last row coverage Δ and no silent spawn failures
5. Confirm scarce sources (fmp/av) use cohort preference in `processSource`
6. Peer universe: `peer_group_members` vs `ticker_registry.fetch_fundamentals` gap

## Improvement prompts

When proposing changes: prefer FIELD_DEFS priority edits, blank/zero-as-null rules,
budget caps, and cohort math — not a second merge path.
