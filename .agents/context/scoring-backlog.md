# Scoring & Data-Quality Backlog
> Created 2026-08-27 from a holistic scoring review. This is the durable record of the
> analysis — do NOT summarize it into state.json (that gets resent every prompt).
> Read this file at the start of any scoring/rankings/tilt work.

## Context: what this review was actually about

The question was not "does the code run" but "are the scores any good?" — evaluated by
identifying each scorecard's goal, comparing the implementation to how practitioners do
it, and checking the input data for timeliness / accuracy / completeness.

Evidence base (all measured, not assumed, against the live DB on 2026-08-27):
- Scoring universe = **558 distinct tickers** in `ticker_fundamentals` (NOT the 273/276
  a stale comment claimed). `ticker_registry` is broader at 672 — do not conflate them.
- All 558 fundamentals rows were fetched on a **single date** (2026-08-23) with
  `STALE_DAYS = 7` → the whole universe expires simultaneously (thundering herd).
- `ticker_fundamentals_history` contains **exactly 1 row**. Any "self-historical"
  (is this stock's PE high vs its own past?) analysis has no data behind it today.
- `model_recs`: 1319 rows, 920 graded, from 2026-07-30 to 2026-08-20.

---

## DONE this session (for reference, don't redo)

1. **Dead fundamental-score cache** — `regime_at_score` was written only by
   `writeFundamentalsRow` (the data-fetch path, defaulting to null), never by the scorer.
   552/554 rows were NULL → `readPersistedScores`'s regime check never passed → every
   read fell through to a full cross-sectional recompute. Scorer now owns the column.
2. **Tilt objective** — `tiltFactor` now keys off `avgPnlPct` (anchor 0, span 0.25%),
   not `winRate` (anchor 0.70). `TILT_MIN_N` 8 → 20. Added `tilt.test.ts` (9 tests).
3. **Coverage gating + shrinkage** — `fundamentals-scoring-math.ts` (pure, tested):
   `score = 50 + (raw-50)*sqrt(coverage)`, family n/a below 0.5 coverage, ticker
   unranked below 0.4 total. Added `fundamentals-coverage.test.ts` (8 tests).
4. **Feed N+1** — 3 queries/ticker → 3 grouped queries in `/feed/buckets`.
5. **Portfolio reset** — now all-or-nothing with 409 blockers; previously created naked
   covered calls and free positions.
6. **`check-api-endpoints.js`** — fixed self-referential bug that shrank the catalog on
   every `--write`. Now 147/147, idempotent.
7. **Peer-group backfill** — `classifyUngroupedTickers()` added to nightly-enrichment.
   NOT YET RUN (see below).

---

## TASK 1 — Reconcile the two fundamental scorers  ⚠️ BLOCKER for Task 2

There are **two independent implementations** of family scoring:

| | server | client |
|---|---|---|
| file | `artifacts/api-server/src/lib/fundamentals-db.ts` | `artifacts/stock-compare/src/lib/rankings.ts` (768L) |
| entry | `computeAndPersistFundamentalScores` | `computeRankingsV2` |
| families | quality, growth, safety | **value**, quality, growth, safety |
| missing data | gates + shrinks toward neutral (NEW) | renormalizes over available (inflates) |
| coverage | real, per family | tracked, `lowCoverage: coverage < 0.6` |

They now diverge further than before this session, because only the server got shrinkage.
`rankings.tsx` uses the SERVER one for the fundamentals leaderboard; other views use the
client one. Same value, two compute paths — the exact pattern that has burned us before
(cf. the `live-quote.ts` consolidation).

**Do this first.** Pick the server as the source of truth (it has DB access, persistence,
and peer groups), port the client's `value` family + metric definitions into it, and
reduce `rankings.ts` to presentation. Check `SCORECARD_METRICS_V2` and `familyMetrics`
in rankings.ts for the metric list worth keeping.

## TASK 2 — Add the valuation family (server)

**Nothing valuation-related is scored today.** `SCORING_METRICS` is 11 metrics: 5 quality,
2 growth, 4 safety, **0 valuation** — despite `peRatio`, `pegRatio`, `forwardPe`,
`evEbitda`, `evRevenue`, `priceToBook`, `priceToSales` all being fetched and populated.
A great business at 200x earnings scores identically to the same business at 8x.

Framing: the current 3 families are recognizably AQR's **Quality Minus Junk**
(profitability + growth + safety). QMJ is explicitly designed to be *paired with price* —
"quality at a reasonable price." Greenblatt's Magic Formula, Piotroski, and Fama-French
HML all pair quality with cheapness for the same reason. Using QMJ alone as a stock
scorecard omits the value leg by construction.

Two legs are wanted (user's own framing, and both are correct practice):
- **Sector-peer-relative** — partially exists: `SECTOR_WEIGHT` blends peer-group and
  universe percentiles at 0.30–0.70. Extend to valuation metrics. Sector-relative matters
  more here than anywhere else (a utility's PE means nothing next to a software company's).
- **Self-historical** — is this stock's PE high/low vs its OWN history? **Blocked on
  Task 4** — `ticker_fundamentals_history` has 1 row.

No new fetching needed for the cross-sectional leg; the data is already in the table.

## TASK 3 — Fix two structurally broken safety metrics

Both are *undefined exactly when they matter*, and because null is excluded from the
denominator, the riskiest companies dodge the metric with no penalty.

**`cashRunway`** (weight 3.0 — the heaviest safety metric):
```ts
cash !== null && ocf !== null && ocf > 0 ? cash / (ocf * 4) : null
```
Runway is a *burn-rate* concept. It only computes when OCF is **positive** (where runway
is effectively infinite) and returns null when OCF is negative — i.e. for exactly the
companies whose runway is the question. **69 of 558 companies are burning cash and every
one dodges this metric.** 108 drop out total. Redefine: negative OCF → `cash / |quarterly
burn|` in quarters; positive OCF → cap at "best" rather than computing a cash/earnings ratio.

**`intCoverage`** (weight 2.5): requires `interestExpense > 0`. **82 tickers** drop out —
debt-free companies, which should score *best* on interest coverage, get no credit.
Should score at the boundary (best), not null.

These two are why **51 of 558 tickers now show safety = n/a** after the coverage gating.
Fixing the definitions is what actually recovers them.

## TASK 4 — Backfill `ticker_fundamentals_history`

Currently **1 row**. There is an admin endpoint `POST /fundamentals/import-history`
(requireAdmin, in `routes/fundamentals.ts`) that was never run at scale. Table has:
`ticker, year, pe_ratio, price_to_book, roic, gross_margin, operating_margin, net_margin,
revenue, ebitda, eps, source`.

Unblocks: the self-historical valuation leg (Task 2) and the backtest (Task 6).
Fit into the existing nightly workflow rather than a one-off — same pattern as the
peer-group backfill added this session.

## TASK 5 — Replace percentile ranks with winsorized z-scores

`percentileRanks()` in `fundamentals-db.ts` is outlier-robust (its one real virtue) but:
- **Destroys magnitude** — 90th vs 99th percentile might be 25% vs 300% revenue growth,
  scored nearly identically. AQR winsorizes then z-scores precisely to keep magnitude.
- **Not comparable over time** — a stock's score moves when its peers move, with zero
  change in its own business. Bad for a scorecard users track week to week.
- Ties get the *minimum* rank (`sorted.findIndex(s => s >= v)`), not the midpoint —
  standard practice is average rank for ties. Mild bias against tied top performers.
- `findIndex` inside `map` is O(n²) per metric (small at n=558, but it was running on
  every request while the cache was dead).

Proposed: winsorize each metric at 1st/99th percentile → z-score within peer group AND
within universe → blend at existing `SECTOR_WEIGHT` → map to 0–100 via normal CDF.
**Freeze winsorization bounds and σ per metric** rather than recomputing each run, or the
time-comparability problem stays.

## TASK 6 — Build the fundamentals backtest (score → forward return)

**Nothing measures whether fundamental scores predict anything.** `model_recs` grades
options recs, hotlist calls, and regime calls — genuinely good accountability — but the
biggest scoring surface in the app is entirely unvalidated. Blocked on Task 4.

Also: this is what should calibrate `TILT_SPAN_PNL_PCT` (currently 0.25, my judgment
call, not derived) and the shrinkage/gating thresholds.

## TASK 7 — Run the peer-group backfill

`classifyUngroupedTickers()` was added to `nightly-enrichment.ts` but **never executed** —
a one-off runner couldn't resolve `@workspace/db` without a build. It runs on the next
nightly. Verify afterward:
```sql
select tf.ticker from ticker_fundamentals tf
left join ticker_registry r using (ticker)
where r.primary_peer_group_id is null;
```
Was 7: ALOY, DRAM, IOND, MP, RGTI, SKHY, USAR — all lack name/sector metadata, so the
classifier's keyword tier can't fire either; some may need manual overrides in the
peer-groups admin tab. **Peer grouping is otherwise healthy: 48 groups, avg 11.5 members,
min 5** — the `MIN_SECTOR_PEERS = 3` concern was investigated and is NOT a real problem.

## TASK 8 — Smaller items

- **`pnpm typecheck` is RED repo-wide** — `scripts/src/analyze-move-coverage.ts` and
  `analyze-news-triggers.ts` fail on a missing `yahoo-finance2` dependency. Pre-existing
  (commit 9c916c6), unrelated to this session, but it means the gate catches nothing.
- **No `lint` script exists anywhere**, though `CLAUDE.md` defines
  `verifier = tsc + lint + tests`. A third of that contract silently no-ops.
- **Line ratchet failing**: `stocks.ts` 1101→1217, `profile.tsx` 792→1043,
  `nightly-enrichment.ts`, `stock-breakdown.tsx`, `settings.tsx` all grew.
- **`checkTriangulation` only logs.** It flags FMP vs Yahoo divergence >20% on 5 fields
  and then does nothing — a divergent value still scores at full weight. Consider gating
  or down-weighting flagged fields.
- **`computePerMetricScores` vs total-score inconsistency**: per-metric assigns `0` to
  missing metrics while the total *excludes* them, so the "Why" panel's contributions
  don't reconcile with the headline score for any ticker with gaps. Also it does not
  apply peer-group metric exclusions, while the main path does.
- **`portfolio/reset` ratchet**: `max(realizedPnl, 0)` means gains carry forward and
  losses are absorbed, with unlimited resets — a one-way ratchet (max leverage, reset
  when down, bank when up). Flagged as intentional in the code; confirm that's wanted.
- **Universe/comment drift**: never hardcode ticker counts (CLAUDE.md rule). A stale
  "273/276" comment in `fundamentals-db.ts` was the tell.

---

## Option scorer: the honest assessment (don't lose this)

**A ~90% win rate is meaningless for premium selling** — that's what selling ~0.15-delta
options produces by construction. It measures chosen strike distance, not skill. If the
UI ever shows it as "model accuracy," that is actively misleading.

Score-decile analysis of the 920 graded recs (P&L as % of strike):
- **Calls**: bucket 3 → +0.03%, bucket 4 → −0.03%, bucket 5 → **−0.20%**. Higher score,
  worse outcome — **inverted discrimination**.
- **Puts**: bucket 3 → −0.71%, bucket 4 → +0.37%, bucket 5 → **+0.47%**. Genuine positive
  discrimination.

Agrees with the persisted `avgPnlPct` signs (put +0.102, call −0.068).

**Caveat that must travel with these numbers:** 4 weeks, a single market regime, and
weekly *overlapping* snapshots on the same tickers → observations are not independent, so
effective n is far below 920. Suggestive, not conclusive. Task 6 is how this becomes real.

**Open question — the call scorer may need its own investigation.** The tilt fix stops the
loop amplifying the losing side, but it does not explain *why* call-side score correlates
negatively with return. Worth a dedicated look at `option-scorer.ts` component weights
for the call side once there's more graded data.
