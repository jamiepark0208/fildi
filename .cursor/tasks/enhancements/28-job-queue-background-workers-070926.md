# job-queue-background-workers

| Field | Value |
|---|---|
| **Status** | backlog (deferred) |
| **Priority** | P3 |
| **Area** | infra |
| **Effort** | M if un-deferred |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [precomputed-rankings](27-precomputed-rankings-materialization-070926.md), [polygon-av-backfill](24-polygon-av-backfill-completion-070926.md), [data-freshness](23-data-freshness-monitoring-070926.md), L-01 / L-04 |
| **Type** | DEFER — pg-boss optional later |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Reliable scheduled / retryable background work for seed, backfill, enrichment — **without** Redis/BullMQ. Today startup + in-process scheduler already cover the single-instance case.

### Cache / DB compliance
PostgreSQL only if pg-boss adopted (same `DATABASE_URL`). **No** Redis queue. FMP/AV jobs must keep `checkDailyBudget` / `api_usage` guards. Do not run heavy backfill on request threads.

---

## 1. Executive summary — AUDIT FIRST (L-01)

### Already shipped (do not double-wire)

| Piece | Evidence |
|---|---|
| Startup seed with retry | `index.ts` L34–36 — `withRetry(() => runSeed())` |
| Stale FMP refresh + budget | L38–59 — `checkFMPBudget` then `refreshFundamentals` |
| Stale technicals refresh | L61–68 |
| In-process schedule | `startScheduler()` L32 — Sun/Thu 02:00 UTC enrichment (`scheduler.ts`) |
| Seeder concurrency | `seeder.ts` — 3 workers, today’s `indicator_cache` skip |
| Manual backfills | `backfill-*.ts` CLI + AV cursor (enh/24) |
| Health visibility | `lastEnrichmentRun` / `enrichmentRunning` on data-health |

### Real gaps (justify un-defer later)

| Gap | Note |
|---|---|
| G1 | No durable job table / retry dashboard — failures are logs only |
| G2 | AV/Polygon backfill not auto-scheduled (cron/docs in enh/24) |
| G3 | Process crash mid-seed — partial fill until next boot `withRetry` |
| G4 | Multi-instance would double-run scheduler — **not** a today problem |

### Verdict
**Keep DEFERRED.** Single Replit/Node instance; startup refresh works. Un-defer when ops need job visibility, multi-job cron, or multi-instance **and** user approves.

**Risk if built now:** **double seed** if pg-boss schedule + `index.ts` withRetry both call `runSeed`.

---

## 2. Why (pitch vs reality)

| Pitch | Reality |
|---|---|
| Fire-and-forget seed forgotten | withRetry + logger on failure |
| Need Finviz pipelines | Twice-weekly enrichment already scheduled |
| Rankings need daily trigger | Fund scores persist on demand (enh/27) |

---

## 3. What (only if user un-defers)

### In scope
| # | Work |
|---|---|
| W1 | `pg-boss` + `lib/job-queue.ts` singleton |
| W2 | Jobs: `daily-indicator-seed`, `enrichment` (replace setInterval), optional `av-backfill-chunk` |
| W3 | **Remove or gate** duplicate startup paths — one owner for seed |
| W4 | `GET /api/admin/jobs/status` — depth, last success/fail |
| W5 | Idempotent keys: `seed:{date}`, `av:{date}:{cursor}` |

### Out of scope
| Item | Reason |
|---|---|
| BullMQ + Redis | Forbidden (enh/29) |
| Separate worker dyno v1 | Same process OK |
| Full job UI product | Status endpoint enough |
| Multi-region | Forbidden |

### Migration rule
```
IF pg-boss schedules daily-indicator-seed
THEN index.ts must NOT also withRetry(runSeed) unconditionally
— use “enqueue if incomplete” once OR disable boot seed behind flag
```

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| index startup | `artifacts/api-server/src/index.ts` L32–68 |
| scheduler | `lib/scheduler.ts` — 30m heartbeat, Sun/Thu |
| withRetry | `lib/retry.ts` |
| No pg-boss in package | Deferred — confirm before add |
| Lessons | L-01 audit infra; L-04 no premature queue |

### 4.2 Files to modify **if** un-deferred

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/job-queue.ts` | **New** |
| **P0** | `index.ts` | Start boss; **dedupe** seed |
| **P1** | `scheduler.ts` | Delegate to boss or delete interval |
| **P1** | admin jobs route | Status |
| — | Redis | Never |

### 4.3 Un-defer gates

- [ ] Explicit user approval
- [ ] Written plan to avoid double seed/enrichment
- [ ] At least one job beyond “nice logs” (e.g. AV daily chunk or multi-instance)
- [ ] pg-boss schema documented vs Drizzle migrations

### 4.4 Acceptance criteria (when built)

- [ ] Restart mid-job: retry or idempotent resume
- [ ] Duplicate same-day enqueue skipped
- [ ] FMP/AV budget checks unchanged
- [ ] Admin status 403 for non-admin
- [ ] Boot path does not double-run seed

### 4.5 Suggested commit message

`feat(api): add pg-boss job queue for seed and enrichment`

### 4.6 Dependencies

| Dep | Relation |
|---|---|
| enh/24 | Soft — AV chunk job consumer |
| enh/27 | Soft — rankings recompute job |
| enh/29 | Anti — no Redis queue |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- Startup behavior, enrichment timing, DB new pg-boss tables

### 2. Bug introductions
- Double seed / double FMP burn
- Cron TZ mistakes (ET vs UTC) — document
- pg-boss schema drift with Drizzle

### 3. Performance
- Neutral if replacing setInterval; watch connection pool

### 4. Workflow
- Ops visibility for failed backfills

### 5. Drift
- Paired: index withRetry ↔ scheduler ↔ enh/24 CLI ↔ data-health

**Do not:** BullMQ; ship alongside boot seed without gate; Redis.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** DEFER (confirmed) — backlog  
**Key:** `withRetry` + `startScheduler` already provide seed/enrichment orchestration. pg-boss is ops polish / scale — not missing core capability.
