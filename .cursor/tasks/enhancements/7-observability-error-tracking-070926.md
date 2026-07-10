# observability-error-tracking

## ✅ DONE — 2026-07-10

**What was implemented:**
- `requestId` middleware: generates UUID or propagates `x-request-id` header; echoes it on every response; runs before all other middleware
- `@sentry/node` init in `app.ts` (no-op when `SENTRY_DSN` unset); `setupExpressErrorHandler` wired before `errorHandler`
- `errorHandler.ts` captures 5xx exceptions in Sentry with `requestId`, `method`, `url` tags; Zod 400s and 4xx stay local only
- `@sentry/react` init in `main.tsx` with `ErrorBoundary` wrapping `<App />`; graceful fallback message on crash
- `custom-fetch.ts` lazy-imports `@sentry/react` on 5xx API responses; attaches `x-request-id` from response header as tag

**Activation:** set `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (frontend) env vars. Both are no-op when unset.

---

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~1 session) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Add optional **Sentry** (API + SPA) with request-ID correlation so production 500s and React crashes are alertable — without replacing Pino.

### Cache / DB compliance
None. `SENTRY_DSN` optional — no-op when unset. No Redis. No new vendor market-data calls.

---

## 1. Executive summary (rescoped)

**Do not** build Datadog APM or a custom metrics product.

**Do** wire `@sentry/node` + `@sentry/react` behind env DSN; ensure every API response can carry `x-request-id`; capture 5xx in `errorHandler` and unhandled FE errors. Pino already redacts cookies/auth — keep that; extend scrubbing for Sentry breadcrumbs.

**Already present (reuse):**
- `pino-http` serializes `req.id` in `app.ts` L20–25
- `logger.ts` redacts `authorization`, `cookie`, `set-cookie`
- `errorHandler.ts` logs 5xx via Pino only — **no** external capture
- No Sentry packages; no React ErrorBoundary in `main.tsx`

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| 5xx only in local logs | `errorHandler.ts` L23–25 |
| No FE crash reporting | `main.tsx` = bare `createRoot` |
| Correlate user report → log | Need stable request id on response + Sentry tag |
| Local/dev without DSN | Must not crash |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Request ID middleware: set `req.id` from `x-request-id` or `randomUUID()`; echo header; ensure pino-http sees it |
| W2 | Sentry Node init when `SENTRY_DSN` set; `setupExpressErrorHandler` after routes |
| W3 | `errorHandler` → `Sentry.captureException` for status ≥500 (and optionally tagged Zod? **no** — 400s stay local) |
| W4 | `@sentry/react` in stock-compare; ErrorBoundary at App root |
| W5 | `custom-fetch.ts`: on 5xx, capture with response `x-request-id` if present |
| W6 | Document `SENTRY_DSN` in env example / CURSOR note |
| W7 | Scrub: cookies, passwords, `SESSION_SECRET`, API keys |

### Out of scope
| Item | Reason |
|---|---|
| Full APM / Datadog | Cost / scope |
| Performance tracing v1 | Optional later (10% sample) |
| Source map upload CI | Phase 2 |
| Log aggregation vendor | Later |
| Custom metrics dashboard | Later |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| errorHandler | Logs 5xx; returns generic “Server error”; no Sentry |
| logger redact | `logger.ts` L7–11 |
| pino-http req.id | `app.ts` serializer uses `req.id` — **confirm** Express/pino-http actually assigns id (may already); middleware should set header explicitly |
| custom-fetch | Central Orval mutator — good 5xx hook point |
| main.tsx | No ErrorBoundary |
| Sentry deps | Absent from api-server + stock-compare package.json |
| Env example | Check/add `SENTRY_DSN=` empty |

### 4.2 Files to modify (authoritative)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/middleware/requestId.ts` | **New** — set id + header early (before routes) |
| **P0** | `artifacts/api-server/src/app.ts` | Use requestId; Sentry init + error handler order |
| **P0** | `artifacts/api-server/src/middleware/errorHandler.ts` | captureException on ≥500 when DSN set |
| **P0** | `artifacts/api-server/package.json` | `@sentry/node` (respect pnpm minimumReleaseAge) |
| **P0** | `artifacts/stock-compare/src/main.tsx` (+ maybe `App.tsx`) | Sentry init + ErrorBoundary |
| **P0** | `artifacts/stock-compare/package.json` | `@sentry/react` |
| **P1** | `lib/api-client-react/src/custom-fetch.ts` | Report 5xx + request id tag |
| **P1** | `.env.example` or docs | `SENTRY_DSN=` |
| — | Prod secrets | Never commit DSN with auth tokens embedded carelessly |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `lib/logger.ts` | Keep redact list; optionally share scrub helpers |
| rateLimiter / validate | Don’t double-report 429 as Sentry errors |
| enh/3 CI | Don’t require Sentry in CI |

### 4.4 Init order (API)

```
1. Sentry.init({ dsn, enabled: !!process.env.SENTRY_DSN, ... })  // no-op if unset
2. requestId middleware
3. existing helmet / pino / cors / session / routes
4. Sentry.setupExpressErrorHandler(app)  // before or with care vs errorHandler
5. errorHandler (capture + respond)
```

Confirm Sentry Express v8+ recommended order against installed SDK docs at implement time.

### 4.5 Acceptance criteria

- [ ] Without `SENTRY_DSN`: server + SPA start; no throw
- [ ] With staging DSN: intentional 500 appears in Sentry with `requestId` tag
- [ ] Response includes `x-request-id`
- [ ] Cookies / passwords not present in Sentry event payloads (spot-check)
- [ ] 400 Zod validation **not** spamming Sentry
- [ ] typecheck both packages

### 4.6 Suggested commit message

`feat(obs): optional Sentry + request-id correlation`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| None hard | Independent |
| pnpm minimumReleaseAge | May delay brand-new Sentry release by 1 day |

---

## 5. Data note
No DB. Errors may contain ticker symbols — OK; scrub account numbers if ever logged.

## 6. Impact & Risk Analysis

### 1. Blast radius
- app bootstrap + FE entry + custom-fetch
- Rollback: unset DSN / revert packages

### 2. Bug introductions
- **PII leak** — scrub cookies, auth headers, body passwords
- Double error handlers fighting — test 500 path once
- Sentry init before env load — load dotenv order
- Catch: local unset DSN; staging throw route

### 3. Performance
- Negligible; sample 100% errors only v1

### 4. Workflow
- Before: Pino only  
- After: optional Sentry alerts  

### 5. Drift
- Paired: request id header ↔ Sentry tag ↔ pino child

### 6. Scalability
- Add tracing later; don’t enable 100% transactions now

**Do not:** send secrets; require DSN in CI; Datadog in this task.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Need:** Optional Sentry + explicit `x-request-id`.  
**Better:** Reuse pino redact; don’t treat 4xx as Sentry events.
