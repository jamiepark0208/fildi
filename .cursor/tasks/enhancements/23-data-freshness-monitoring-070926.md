# data-freshness-monitoring

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | data |
| **Effort** | S (enhance existing) — **not** greenfield M |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [polygon-av-backfill](24-polygon-av-backfill-completion-070926.md) if present, [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md), L-01 infra audit |
| **Type** | ENHANCE (gap-fill) — core already shipped |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — prior task assumed greenfield |

### Purpose
Admin-visible freshness / coverage / budget so stale fundamentals and empty bronze tables aren’t silent. **Most of this already exists** — close remaining gaps only.

### Cache / DB compliance
Read-only SQL aggregates on existing Tier A tables. **Never** trigger backfill from health endpoint. No new monitoring vendor. No Redis. Ticker universe = `ticker_registry WHERE fetch_fundamentals=true` — never hardcode counts.

---

## 1. Executive summary (RESCOped — audit first)

### Already shipped (do not rebuild)

| Piece | Evidence |
|---|---|
| `GET /api/admin/data-health` | `artifacts/api-server/src/routes/data-health.ts` L13–68 |
| Mounted | `routes/index.ts` imports `dataHealthRouter` |
| UI panel | `ApiMonitorTab.tsx` L92–101 fetch + L206–269 “Data Health” section |
| Metrics today | `totalActive`, `fresh` / `stale` / `neverFetched`, `staleDaysThreshold` (**14**), `divergentCount`, `topNullFields`, `lastEnrichmentRun`, `enrichmentRunning` |
| FMP/AV budget UI | Same tab — `/api/api-usage/history` pivot + 250/25 daily bars (L76–204) |
| Provenance detail | StockDBTab + `/api/fundamentals/provenance/:ticker` |
| Cache TTLs | Settings Cache Monitor — separate concern |

### Remaining gaps (this task’s real scope)

| Gap | Why it matters |
|---|---|
| G1 | No **bronze row counts** (`polygon_fundamentals`, `av_fundamentals`) — empty tables stay invisible |
| G2 | Health payload has **no per-source lastFetch / callsToday** (budget lives only in usage history UI) |
| G3 | Threshold in code is **14d**; original PRD said 48h warn / 7d critical — decide and document one SLA |
| G4 | Route uses `requireAuth` not `requireAdmin` — tighten if product wants admin-only |
| G5 | `data_sources` table exists in schema but is **not** what ApiMonitor uses (uses `api_usage`) — don’t dual-write; optional read later |

**Do not** create a second `data-health.ts` lib + route + StockDB panel that duplicates ApiMonitorTab.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Ops need freshness | Partially met — ApiMonitor Data Health |
| Bronze gaps silent | `polygon_fundamentals` / `av_fundamentals` in schema; health route doesn’t count them |
| Budget burn | Met via api-usage history in same tab |
| Original PRD greenfield | **Obsolete** — endpoint + UI already live |

---

## 3. What (build scope)

### In scope (gap-fill only)
| # | Work |
|---|---|
| W1 | Extend `GET /api/admin/data-health` JSON with `bronze: { polygon: number, av: number }` (COUNT(*)) |
| W2 | Optional: `fmpCallsToday` / `avCallsToday` from `api_usage` for today (dedupe display with usage table — or skip if redundant) |
| W3 | Document SLA in UI copy: current **14d** stale **or** change threshold + badges (48h / 7d) — pick one in PR |
| W4 | ApiMonitorTab: show bronze counts + red badge if 0 rows |
| W5 | Auth: switch to `requireAdmin` if non-admin shouldn’t see health (confirm product) |

### Out of scope
| Item | Reason |
|---|---|
| New `lib/data-health.ts` + new route file | Already have `routes/data-health.ts` |
| Second Settings tab / StockDB duplicate panel | Use ApiMonitorTab |
| PagerDuty / email | Forbidden v1 |
| Auto-remediation / backfill buttons | Forbidden — read-only |
| Rebuilding provenance explorer | StockDBTab owns detail |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Health route | `data-health.ts` — STALE_DAYS=14; FIELD_DEFS null ranking |
| UI | ApiMonitorTab Data Health L206–269 |
| Usage | `getApiUsageHistory` / `recordApiUsage` |
| Bronze tables | schema `polygonFundamentals`, `avFundamentals` |
| Lesson | L-01 — audit before greenfield infra |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/routes/data-health.ts` | Add bronze counts (+ optional usage today) |
| **P0** | `artifacts/stock-compare/src/components/settings/ApiMonitorTab.tsx` | Render bronze + SLA copy |
| **P1** | Auth middleware on route | requireAdmin if approved |
| — | New route/lib files | **Do not create duplicates** |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| StockDBTab | Per-ticker provenance |
| admin-cache.ts | TTL monitor — different job |
| merge-trusted FIELD_DEFS | Already used for null ranking |
| data_sources table | Legacy/unused by monitor — don’t revive without plan |

### 4.4 Paste-ready response delta

```ts
// Add to existing res.json({...})
bronze: {
  polygonRows: number; // SELECT count(*) FROM polygon_fundamentals
  avRows: number;
},
// Keep existing fields; do not rename breaking UI without updating ApiMonitorTab types
```

### 4.5 Acceptance criteria

- [ ] No second health endpoint or duplicate Settings panel
- [ ] Bronze row counts visible; 0 → critical/warn badge
- [ ] Still read-only (no backfill trigger)
- [ ] Universe from `fetch_fundamentals=true` (unchanged)
- [ ] Non-admin behavior documented (403 if requireAdmin)
- [ ] api-server + stock-compare typecheck

### 4.6 Suggested commit message

`feat(admin): surface bronze table counts on data-health monitor`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Backfill tasks | Soft — empty bronze motivates enh/24-style work |
| L-01 | Process — this rescope is the audit |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- One route + ApiMonitorTab types
- Rollback: revert fields; UI ignores unknown keys safely if coded defensively

### 2. Bug introductions
- COUNT(*) on large bronze tables — fine at current scale; index not required for admin
- Changing STALE_DAYS without UI copy update → confusion
- requireAdmin breaking existing non-admin fetch — check who can open API Monitor (tab already adminOnly in settings)
- Catch: empty polygon → badge; enrichment fields still show

### 3. Performance
- Two extra COUNT queries on admin poll (5 min interval) — acceptable

### 4. Workflow
- Ops sees “bronze empty” without SQL

### 5. Drift
- Paired: data-health route ↔ ApiMonitorTab ↔ api-usage (budget) ↔ StockDB provenance detail

**Do not:** greenfield dashboard; backfill buttons; PagerDuty; duplicate StockDB health panel.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready (rescope to gap-fill)  
**Was:** ready assuming greenfield. **Key:** endpoint + ApiMonitor Data Health **already shipped**; add bronze counts + SLA clarity only.
