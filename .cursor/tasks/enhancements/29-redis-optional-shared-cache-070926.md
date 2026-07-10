# redis-optional-shared-cache

| Field | Value |
|---|---|
| **Status** | backlog (deferred) |
| **Priority** | P3 |
| **Area** | infra |
| **Effort** | M if un-deferred |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [job-queue](28-job-queue-background-workers-070926.md), [data-freshness](23-data-freshness-monitoring-070926.md), L-01 / L-04, data-architecture skill |
| **Type** | DEFER — hard anti-pattern until multi-instance |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Optional Redis behind the same cache interface as in-memory `TTLCache` for multi-instance / restart survival. **Today: not provisioned; architecture forbids Redis.**

### Cache / DB compliance
**Current law:** `.claude/skills/data-architecture.md` — “No Redis — not provisioned; in-memory TTLCache is the shim.” Durable data stays PG (`ticker_fundamentals`, `indicator_cache`, breakdown, etc.). Sessions stay `connect-pg-simple` (PG) — **never** move sessions to Redis in this task. Env-gated only if un-deferred: no `REDIS_URL` ⇒ identical to today.

---

## 1. Executive summary — AUDIT FIRST (L-01 / L-04)

### Already shipped (sufficient for single instance)

| Piece | Evidence |
|---|---|
| In-memory TTLCache | `lib/ttl-cache.ts` — get/set/clear/stats |
| Named registry | `cache-registry.ts` + admin Cache Monitor |
| PG durable layers | fundamentals, technicals, indicator_cache, provenance |
| Macro file caches | On-disk JSON patterns (separate from TTLCache) |
| Breakdown | Server `breakdownCache` 2h TTL |

### Why Redis was proposed

| Claim | Counter |
|---|---|
| Cold start after deploy | Acceptable; PG warm paths for scores |
| Multi-replica | **Not deployed** — single Node |
| Unify macro files | Out of scope v1 even if Redis ships |

### Verdict
**Keep DEFERRED (hard).** Quantified benefit ≈ 0 on current topology. Building now adds a **third** cache pattern (memory + PG + Redis) and serialization footguns.

Un-defer **only** when: horizontal API scale **or** explicit cold-start SLA — plus user approval + data-architecture skill update.

---

## 2. Why (pitch vs reality)

| Pitch | Reality |
|---|---|
| Koyfin uses Redis | Different scale / multi-tenant |
| project.md “No Redis” | Still correct for prod |
| Survive restarts | PG already holds rankings inputs/scores |

---

## 3. What (only if user un-defers)

### In scope
| # | Work |
|---|---|
| W1 | `RedisTTLCache` implementing same surface as `TTLCache` |
| W2 | `createCache(name, ttlMs)` factory — `REDIS_URL` gate |
| W3 | Migrate **options** + **quote** named caches first (short TTL) |
| W4 | Admin clear = prefix delete `fildi:cache:{name}:*` — **not** FLUSHDB |
| W5 | Update data-architecture.md + cursor-state: Redis optional |

### Out of scope
| Item | Reason |
|---|---|
| Redis Cluster | Forbidden |
| Replace PG indicator_cache / fundamentals | Forbidden |
| Session store in Redis | Forbidden — keep PG sessions |
| Macro file cache migration v1 | Forbidden |
| Pub/sub streaming | Forbidden |
| Agent memory in Redis | ai floors forbid |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| TTLCache API | ttl-cache.ts L17–64 |
| Admin clear | admin-cache.ts clear by name |
| data-architecture | “No Redis” line ~62 |
| Lessons | L-01, L-04 — defer Redis |

### 4.2 Files to modify **if** un-deferred

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/redis-cache.ts` / `cache-factory.ts` | **New** |
| **P0** | `cache-registry.ts` | Factory |
| **P1** | package.json | ioredis/redis |
| **P1** | data-architecture.md | Optional Redis section |
| — | Session middleware | **Do not touch** |

### 4.3 Un-defer gates (all required)

- [ ] Explicit user approval to un-defer enh/29
- [ ] Multi-instance deploy plan **or** measured cold-start SLA breach
- [ ] data-architecture skill updated in same PR
- [ ] Serialization rules documented (JSON only; no Date objects)
- [ ] Memory limits / TTLs for options payloads reviewed

### 4.4 Paste-ready factory (reference only — do not implement while deferred)

```ts
export function createCache<T>(name: string, ttlMs: number): CacheLike<T> {
  if (process.env.REDIS_URL) return new RedisTTLCache<T>(name, ttlMs);
  return new TTLCache<T>(ttlMs, name);
}
// keys: fildi:cache:{name}:{key} via SETEX
```

### 4.5 Acceptance criteria (when built)

- [ ] Without REDIS_URL: behavior identical to today
- [ ] With Redis: options/quote survive process restart
- [ ] Admin clear removes prefix keys only
- [ ] Sessions still PG
- [ ] No FLUSHDB in admin paths

### 4.6 Suggested commit message

`feat(api): optional Redis backend for TTLCache (env-gated)`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Multi-instance hosting | Hard gate |
| enh/28 | Orthogonal — pg-boss ≠ Redis |
| L-04 | Process — waterfall before new cache layer |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- Every named cache consumer; admin monitor; deploy topology

### 2. Bug introductions
- JSON serialize Dates → string drift
- Huge options chains OOM Redis
- Accidental FLUSHDB wiping unrelated keys
- Split brain if some instances lack REDIS_URL

### 3. Performance
- Network hop vs memory — may be slower for tiny payloads

### 4. Workflow
- Only pays off with ≥2 API replicas

### 5. Drift
- Paired: TTLCache ↔ registry ↔ data-architecture “No Redis” ↔ L-04

**Do not:** implement while deferred; session-in-Redis; replace PG; ignore skill.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** DEFER (hard) — backlog  
**Key:** Architecture + lessons say no Redis; single-instance TTLCache + PG is enough. Un-defer only for horizontal scale with explicit approval.
