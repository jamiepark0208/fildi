# openapi-coverage-orval-migration

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | api |
| **Effort** | L (phased; one page per PR) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [react-query-fetch-standardization](26-react-query-fetch-standardization-070926.md), [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md), [api-integration-test-harness](4-api-integration-test-harness-070926.md) |
| **Type** | ENHANCE (codegen coverage) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — prior audit was thin “Revise” |

### Purpose
API-first discipline: expand OpenAPI → Orval clients → migrate high-traffic raw `fetch` pages so FE/BE contracts don’t drift.

### Cache / DB compliance
No new vendor calls or caches. Spec documents existing routes only. `custom-fetch.ts` must keep `credentials: "include"`. Never hand-edit `generated/`.

---

## 1. Executive summary (rescoped)

**Already present:**
- `lib/api-spec/openapi.yaml` — **5 paths only**: `/healthz`, `/stocks/quote|history|compare|search`
- Orval: `lib/api-spec/orval.config.ts`; script **`pnpm --filter @workspace/api-spec codegen`** (not `generate`)
- Clients: `@workspace/api-client-react` + `@workspace/api-zod`
- ~**11** stock-compare files import api-client-react; **26** route modules under `artifacts/api-server/src/routes/`
- Raw `fetch(` counts (2026-07-09): macro **14**, feed **10**, settings **8**, options-scanner **6**, profile **3** (profile lower than original claim of 8)

**Do (phased):**
1. **Phase A:** Spec + regen for macro + watchlist + options read paths (highest leverage)
2. **Phase B:** Migrate **macro.tsx** only in first app PR
3. **Phase C:** feed → settings → options-scanner → profile (one PR each)
4. Optional CI: openapi validate in enh/3 pipeline

**Pair with enh/26:** Orval migration supplies typed hooks; enh/26 owns query-key / staleTime conventions — don’t fight each other (prefer Orval keys once migrated).

**Do not** big-bang all routes; skip admin-only paths in v1; no public API product.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Spec tiny vs surface | openapi.yaml L14–151 — 5 paths; 26 route files |
| Macro raw-fetch heavy | 14 `fetch(` in macro.tsx |
| Codegen works | `useGetStockQuote` / healthCheck already generated |
| healthz shape | `{ status: "ok" }` — enh/4; OpenAPI `HealthStatus` must match |
| Hand-edit risk | generated/ must stay regen-only |

---

## 3. What (build scope)

### Phase A — Spec
| # | Work |
|---|---|
| A1 | Inventory routes → checklist in this task or `openapi-inventory.md` under `.cursor/tasks/` |
| A2 | Add paths: macro data/charts/events/fed-members/bank-research, cot summary/history, watchlist CRUD, options scan reads, feed list (auth cookie security scheme) |
| A3 | `pnpm --filter @workspace/api-spec codegen` + typecheck libs |
| A4 | Document streaming/non-JSON as out-of-spec |

### Phase B — First migration
| # | Work |
|---|---|
| B1 | Replace macro.tsx fetches with generated hooks (keep staleTimes behavior) |
| B2 | Manual parity: Regime + Volatility tabs load |

### Phase C — Follow-ups
| Page | Notes |
|---|---|
| feed.tsx | Cookie auth in securitySchemes |
| settings.tsx | Admin routes optional v1 — can stay raw |
| options-scanner.tsx | Coordinate enh/26 keys |
| profile.tsx | Lower priority (3 fetches) |

### Out of scope
| Item | Reason |
|---|---|
| All admin routes in v1 | Defer |
| Public third-party API | Forbidden |
| gRPC | Forbidden |
| Hand-edits in generated/ | Forbidden |
| One mega-PR for all pages | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| OpenAPI paths | healthz + 4 stock ops |
| Codegen script | `lib/api-spec/package.json` → `"codegen": "orval --config ./orval.config.ts && …"` |
| custom-fetch | credentials / ApiError typing |
| Route count | 26 files in `routes/*.ts` |
| Fetch ranking | macro 14 > feed 10 > settings 8 > scanner 6 > profile 3 |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/api-spec/openapi.yaml` | Expand paths + schemas |
| **P0** | `lib/api-client-react/src/generated/*` | Regen only |
| **P0** | `lib/api-zod/src/generated/*` | Regen only |
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` | First consumer PR |
| **P1** | CI workflow (enh/3) | Optional swagger-cli / redocly lint |
| — | `custom-fetch.ts` | Only if auth header gap |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/26 | Query-key policy |
| enh/4 | healthz `{ status: "ok" }` |
| Route handlers | Source of truth for response shapes |

### 4.4 Paste-ready migration pattern

```ts
// Before
const { data } = useQuery({
  queryKey: ["macro-data"],
  queryFn: () => fetch("/api/macro/data").then(r => r.json()),
  staleTime: 30 * 60 * 1000,
});

// After (names from Orval operationId)
import { useGetMacroData } from "@workspace/api-client-react";
const { data, isLoading, error } = useGetMacroData({
  query: { staleTime: 30 * 60 * 1000, refetchOnWindowFocus: false },
});
```

### 4.5 Spec security note

```yaml
components:
  securitySchemes:
    cookieAuth:
      type: apiKey
      in: cookie
      name: connect.sid  # confirm actual session cookie name in auth middleware
```

### 4.6 Acceptance criteria

**Phase A**
- [ ] Macro + watchlist + ≥1 options path in openapi.yaml
- [ ] `codegen` clean; no hand-edits in generated/
- [ ] HealthStatus matches `{ status: "ok" }`

**Phase B**
- [ ] macro.tsx uses generated hooks for previously raw GETs
- [ ] Visual/data parity on macro tabs
- [ ] stock-compare + libs typecheck

**Phase C**
- [ ] One page per PR; checklist updated

### 4.7 Suggested commit messages

Phase A: `feat(api-spec): expand OpenAPI for macro and watchlist`  
Phase B: `refactor(macro): migrate fetches to Orval hooks`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/26** | Soft — standardize keys after/with migration |
| **enh/3** | Soft — CI validate spec |
| enh/4 | Soft — healthz contract |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- Spec + generated clients (wide type surface) + one page at a time
- Rollback: revert page PR; regen from previous yaml if needed

### 2. Bug introductions
- Wrong response schema → runtime Orval parse / TS lies — validate against real JSON fixtures
- Losing `credentials: "include"` → 401 on session routes
- operationId renames break imports — stable ids
- Catch: macro Regime loads; network tab shows same `/api/macro/*` URLs

### 3. Performance
- Neutral if staleTimes preserved; enh/26 may improve dedupe later

### 4. Workflow
- Safer refactors; fewer silent FE breaks

### 5. Drift
- Paired: openapi.yaml ↔ routes ↔ Orval ↔ enh/26 query keys

**Do not:** big-bang; hand-edit generated; skip cookie auth on feed.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready (incremental)  
**Was:** ready with thin audit. **Key:** only 5 OpenAPI paths; codegen script is `codegen`; migrate macro first; profile is 3 fetches not 8.
