# analyst-data-persistence

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | data |
| **Effort** | L (Track 1 M; Track 2 M after spike) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research + user-request |
| **Skill** | `.claude/skills/data-agent.md`, `caching-patterns.md`, `db-patterns.md` |
| **Type** | ENHANCE (+ NEW tables) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **rescoped vs older draft** |

### Purpose
Persist analyst upgrade/downgrade history (Track 1) and per-firm dollar price targets (Track 2) so breakdown isn’t live-Yahoo-only and “Price Targets by Firm” can fill from DB.

### Cache / DB compliance
Tier A DB for events/PTs. No Redis. No serve-time Finviz. `breakdownCache` 2h stays; bump `BREAKDOWN_CACHE_VER` only when payload shape changes again. Consensus scalar stays `ticker_fundamentals.analystTargetPrice` via FIELD_DEFS — **unchanged**.

---

## 1. Executive summary (rescoped after 2026-07-09 verify)

**Already done (do not rebuild):**
- FMP `/price-target` on breakdown — **gone**. `stocks.ts` L734–735: `analystPriceTargets = []` with comment “unavailable on current FMP plan”
- `BREAKDOWN_CACHE_VER` — **already `5`** (L655). Next shape change → **6**

**Still the gap (this task):**
- U/D history is **live-only** on every breakdown cache miss (`upgradeDowngradeHistory` in quoteSummary L672; parse L705–723)
- **No** `yahoo_analyst_actions` / `analyst_events` / `analyst_price_targets` tables in schema
- Yahoo backfill (`yahoo-client.ts`) modules = financials only — **no** U/D module
- Frontend `catalysts-section.tsx` still duplicates `buildCatalysts` (server already attaches `catalysts[]` via `attachCatalysts`)

Ship **Track 1** first. Track 2 = Finviz spike → go/no-go → tables + backfill.

---

## 2. Why (requirements)

| Requirement | Evidence / notes |
|---|---|
| Durable U/D across restarts | Live parse only today |
| Skip U/D module when DB fresh | Saves Yahoo work on cache miss path |
| Fill “Price Targets by Firm” | UI exists (`stock-breakdown.tsx` ~340); array always empty |
| Single `buildCatalysts` | Server `lib/catalysts.ts` canonical; FE duplicate L53–91 |
| No FMP PT re-add | Already empty — keep it that way on free tier |

---

## 3. What (build scope)

### Track 1 — in scope
| # | Work |
|---|---|
| W1 | Drizzle: bronze `yahoo_analyst_actions` + gold `analyst_events` |
| W2 | Add U/D module to Yahoo backfill (same quoteSummary call — not second HTTP) |
| W3 | `getStaleAnalystTickers()` — **new**; do not reuse FMP `getStaleTickers()` |
| W4 | Breakdown DB-first for `analystActions` when fresh (&lt;7d); live Yahoo fallback |
| W5 | Prefer server `catalysts[]`; delete FE `buildCatalysts` duplicate |
| W6 | Rename UI panel copy to **Analyst Rating Changes** where appropriate |
| W7 | Bump `BREAKDOWN_CACHE_VER` to **6** if response shape/semantics change |

### Track 2 — in scope (after spike)
| # | Work |
|---|---|
| W8 | Spike 10 tickers Finviz PT coverage → document go/no-go in this file |
| W9 | If go: `analyst_price_targets` + Finviz backfill/cron only + wire breakdown |

### Out of scope
| Item | Reason |
|---|---|
| Re-adding FMP PT fetch | Already removed; free tier empty |
| FMP premium / FactSet / TipRanks | Separate if Finviz fails |
| Silver merge for events | Single-source list — no FIELD_DEFS |
| Full `buildMetrics` refactor | Separate PR |
| String blob for firm PTs | Normalized rows only |
| Redis | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Live U/D on breakdown | `stocks.ts` L672 module list; L705–723 parse |
| FMP PT call | **Absent** — L734–735 empty array |
| CACHE_VER | `const BREAKDOWN_CACHE_VER = 5` L655 |
| Server catalysts | `attachCatalysts` L645–651; `buildCatalysts` from `lib/catalysts.ts` |
| FE duplicate | `catalysts-section.tsx` L53–91 local `buildCatalysts`; prefers `catalysts` prop if present L106–107 |
| Yahoo backfill modules | `yahoo-client.ts` L76 — `financialData`, `defaultKeyStatistics`, `summaryDetail` only |
| Schema analyst event tables | **None** (`rg analyst_events` schema empty) |
| Consensus PT column | `analyst_target_price` on fundamentals; FIELD_DEFS yahoo→fmp→av |
| UI PT by firm | `stock-breakdown.tsx` “Price Targets by Firm” ~340; fed by empty array |

### 4.2 Files to modify (authoritative)

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/db/src/schema/index.ts` + Drizzle migration | Track 1 tables |
| **P0** | `artifacts/api-server/src/lib/firm-normalize.ts` | **New** |
| **P0** | `artifacts/api-server/src/lib/yahoo-analyst-client.ts` / extend yahoo-client | Fetch+upsert U/D |
| **P0** | `artifacts/api-server/src/lib/analyst-events-db.ts` | **New** — read fresh / stale helpers |
| **P0** | `artifacts/api-server/src/scripts/backfill-yahoo.ts` | Include U/D module |
| **P0** | `artifacts/api-server/src/routes/stocks.ts` | DB-first analystActions; CACHE_VER→6 if needed |
| **P1** | `artifacts/api-server/src/index.ts` | Optional stale analyst refresh withRetry (pattern like technicals) |
| **P1** | `catalysts-section.tsx` | Delete local `buildCatalysts`; require server `catalysts` |
| **P1** | `stock-breakdown.tsx` | Copy: Analyst Rating Changes |
| **P2** | Track 2 Finviz client + table | After spike |

### 4.3 Files to read but **not** modify (unless needed)

| Path | Why |
|---|---|
| `lib/catalysts.ts` | Canonical builder — keep SSOT |
| `merge-trusted.ts` FIELD_DEFS `analystTargetPrice` | Leave consensus alone |
| `data-agent.md` | Bronze→Gold patterns |
| enh/4 catalysts.test.ts | May cover parse helpers — don’t break |

### 4.4 Schema sketch (Track 1)

**Bronze `yahoo_analyst_actions`:** ticker, firm, firm_key, action, from_grade, to_grade, event_date, source_event_id (hash), fetched_at, raw jsonb. PK `(ticker, source_event_id)`.

**Gold `analyst_events`:** same + `source='yahoo'`. Upsert **same transaction** as bronze.

### 4.5 Breakdown algorithm (Track 1)

```
On GET /stocks/breakdown (cache miss):
  if analyst_events for ticker with MAX(fetched_at) within 7d:
    analystActions = DB rows (map to existing shape)
    quoteSummary modules = omit upgradeDowngradeHistory
  else:
    include upgradeDowngradeHistory; parse as today; optionally write-through upsert
  analystPriceTargets = [] until Track 2
  attachCatalysts(payload); cache with VER
Never call FMP price-target
```

### 4.6 Acceptance criteria

**Track 1**
- [ ] Migration applied; `SELECT count(*) FROM analyst_events WHERE ticker='NVDA'` > 0 after backfill
- [ ] Fresh DB: breakdown logs show no U/D module (or equivalent); actions still present
- [ ] Stale/missing DB: live Yahoo fallback works
- [ ] FE has no duplicate `buildCatalysts` implementation
- [ ] FMP PT still not called
- [ ] CACHE_VER bumped if shape changed (5→6)
- [ ] typecheck api-server + stock-compare

**Track 2**
- [ ] Spike coverage % for 10 tickers documented
- [ ] If go: backfill-only Finviz; breakdown reads DB; empty OK if no rows

### 4.7 Suggested commit messages

Track 1: `feat(data): persist Yahoo analyst upgrade/downgrade events`  
Track 2: `feat(data): Finviz analyst price targets backfill` (after spike)

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| data-agent skill | Patterns |
| enh/4 | Optional catalysts unit tests |
| new_app_features/12 stock-breakdown | Soft UI polish |
| ai/12 | Unrelated DQ chat |

---

## 5. Data tier & waterfall

| Data | Tier | Source | Notes |
|---|---|---|---|
| U/D events | A | Yahoo only | Combined module in backfill |
| Consensus PT | A | FIELD_DEFS | Unchanged |
| Per-firm PT | A | Finviz → last-resort paid | Cron only |
| Breakdown | B | breakdownCache 2h | Existing |

## 6. Impact & Risk Analysis

### 1. Blast radius
- Schema, Yahoo backfill, breakdown route, catalysts UI
- Rollback: feature-flag DB-first; keep live path

### 2. Bug introductions
- Gold/bronze drift — same transaction
- Cache stale after backfill — bump VER
- FE/server catalyst drift — delete FE copy
- firm_key collisions — shared normalizer
- Catch: NVDA backfill + breakdown with/without DB

### 3. Performance
- Fewer Yahoo modules on DB hit; backfill concurrency ≤3

### 4. Workflow
- Track 1 before Track 2; spike before Finviz client

### 5. Drift
- Paired: catalysts.ts ↔ FE props ↔ analyst_events shape

### 6. Scalability
- Per-ticker event rows; index (ticker, event_date)

**Do not:** Redis; FMP PT on free tier; blob columns; buildMetrics mega-refactor in Track 1.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — Track 1 ready; Track 2 after spike  
**Rescope:** FMP removal + CACHE_VER=5 **already shipped**. Focus = persistence + FE dedupe + Finviz spike.
