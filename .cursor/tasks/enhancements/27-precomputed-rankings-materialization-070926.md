# precomputed-rankings-materialization

| Field | Value |
|---|---|
| **Status** | backlog (deferred) |
| **Priority** | P3 |
| **Area** | data |
| **Effort** | L **if** un-deferred — much of fund path already shipped |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [job-queue](28-job-queue-background-workers-070926.md), fundamental-sector-scoring plan, [react-query](26-react-query-fetch-standardization-070926.md), L-01 / L-04 |
| **Type** | DEFER — enhance existing persist path when un-deferred |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Avoid recomputing peer-normalized rankings on every request at scale. **Do not** invent a parallel `rankings_snapshot` table while `ticker_fundamentals.fund_*` already materializes API rankings.

### Cache / DB compliance
Tier A: persist scores on PG (`ticker_fundamentals` fund columns). Inputs already in `indicator_cache` / `ticker_technicals`. **No** Redis (enh/29). **No** Finviz-scale inverted indexes. Respect ScoringPreferences overlay complexity before global snapshots.

---

## 1. Executive summary — AUDIT FIRST (L-01)

### Already shipped (do not rebuild)

| Piece | Evidence |
|---|---|
| Persist fund scores | `computeAndPersistFundamentalScores` in `fundamentals-db.ts` L322+ — writes `fundTotalScore`, family scores, `fundRank`, `regimeAtScore`, `fundScoreComputedAt` |
| Read path | `readPersistedScores` L441– — stale if >**48h** or regime mismatch |
| API | `GET /fundamentals/rankings` (`fundamentals.ts` L170–179) — **cached first**, recompute on miss |
| Peer-aware scoring | Uses `peerGroups.metricExclusions` + registry `primaryPeerGroupId` in compute path L329–341 |
| Tech inputs | `indicator_cache.scored_date`, `ticker_technicals` — seeder fills daily |

### Still true gaps (only these justify un-defer)

| Gap | Note |
|---|---|
| G1 | Home compare shelf still runs **client** `computeRankingsV2` over shelf tickers — different product from `/fundamentals/rankings` |
| G2 | No persisted **technical** rank snapshot analogous to fund_* columns (scanner may recompute V2 client-side) |
| G3 | Sector-scoring plan (`.cursor/context/plans/fundamental-sector-scoring*.md`) wants weekly batch `fund_score` vs **peer_group_members** (~558) — may extend **existing** columns / batch trigger, not a new snapshot table |
| G4 | User weight prefs (`ScoringPreferencesContext`) — global persisted scores ≠ per-user weights; overlay still required |

### Verdict
**Keep DEFERRED.** Benefit negligible at current watchlist scale. Un-defer only with explicit approval when G3 sector batch or profiling proves TTFB pain.

**Forbidden if un-deferred naively:** second `rankings_snapshot` table duplicating `fund_*` columns.

---

## 2. Why (original pitch vs reality)

| Original claim | Reality 2026-07-09 |
|---|---|
| Recompute every request | API path already persists + serves |
| Need rankings_snapshot table | Columns already on `ticker_fundamentals` |
| Finviz-scale | Overkill for single-tenant CSP tool |

---

## 3. What (only if user un-defers)

### In scope (gap-fill)
| # | Work |
|---|---|
| W1 | Document + optionally schedule `computeAndPersistFundamentalScores` after enrichment (hook scheduler / enh/28) — **reuse function** |
| W2 | If sector plan Phase 1: extend persist to peer-universe scoring per plan — **one** write path |
| W3 | Optional: persist tech ranks on `ticker_technicals` or thin table — only after measuring scanner cost |
| W4 | Admin “Refresh rankings” → call existing compute (no new schema) |

### Out of scope
| Item | Reason |
|---|---|
| New `rankings_snapshot` duplicating fund_* | Forbidden |
| Real-time tick updates | Forbidden |
| Per-user materialized prefs | Overlay at read time |
| Redis-backed rankings | enh/29 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Schema columns | `fundTotalScore`, `fundRank`, `regimeAtScore`, `fundScoreComputedAt` in schema ~L228–236 |
| SCORE_STALE_HOURS | 48 (`fundamentals-db.ts` L438) |
| Route | fundamentals.ts L170–179 |
| Home client scorer | `computeRankingsV2` in stock-compare `rankings.ts` |
| Sector plan | fundamental-sector-scoring.md Task 1.4 pre-compute |

### 4.2 Files to modify **if** un-deferred

| Pri | Path | Change |
|---|---|---|
| **P0** | `fundamentals-db.ts` / sector scorer | Extend persist — no duplicate table |
| **P1** | `scheduler.ts` or job worker | Trigger recompute after enrichment |
| **P1** | Admin settings | Manual refresh button |
| — | New rankings_snapshot migration | **Reject** unless fund_* proven insufficient |

### 4.3 Un-defer gates (all must be true)

- [ ] User explicitly says un-defer enh/27
- [ ] Either: sector peer scoring batch in flight **or** measured rankings TTFB > agreed SLA
- [ ] Plan written to extend existing persist — not parallel snapshot
- [ ] ScoringPreferences overlay strategy documented

### 4.4 Acceptance criteria (when built)

- [ ] No duplicate scoring tables for same fund metrics
- [ ] `/fundamentals/rankings` still prefers readPersistedScores
- [ ] Regime change invalidates / recomputes
- [ ] Never hardcode ticker counts

### 4.5 Suggested commit message (only after un-defer)

`feat(data): schedule fund score recompute after enrichment`

### 4.6 Dependencies

| Dep | Relation |
|---|---|
| Sector scoring plan | Hard for G3 |
| enh/28 | Soft schedule |
| enh/29 | Anti — do not use Redis |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- If wrongly built now: dual write paths, prefs bugs, migration churn

### 2. Bug introductions
- Snapshot ignoring user weights → wrong home scores
- Mixing FUNDAMENTAL_WATCHLIST with peer_groups mid-migration — plan forbids watchlist-as-peers

### 3. Performance
- Current: persist hit is cheap; client V2 on ~shelf size is fine

### 4. Workflow
- Ops: trust ApiMonitor / data-health for freshness, not a new rankings dashboard

### 5. Drift
- Paired: fund_* persist ↔ sector plan ↔ scheduler ↔ L-04 waterfall

**Do not:** rankings_snapshot clone; Redis; un-defer without approval.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** DEFER (confirmed) — backlog  
**Key:** Fund rankings **already materialized** on `ticker_fundamentals` + served by API. Task was pitched as greenfield — wrong. Revisit with sector batch or proven pain only.
