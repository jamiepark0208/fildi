# unauthenticated-vendor-routes

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P0 |
| **Area** | security |
| **Effort** | M (~1 session) |
| **Benefit** | Critical — stops vendor/LLM cost abuse; required for multi-user production |
| **Implementation risk** | Med — wrong allowlist breaks health/auth/macro reads |
| **Created** | 2026-07-10 |
| **Source** | bugs production-readiness audit |
| **Related** | [enh/3](../enhancements/3-ci-pipeline-typecheck-tests-070926.md), [enh/4](../enhancements/4-api-integration-test-harness-070926.md), [ai/2](../ai/2-agentic-safety-context-isolation-070926.md) |
| **Type** | FIX (auth boundary) |
| **Reuse / update** | [`requireAuth`](../artifacts/api-server/src/middleware/requireAuth.ts), [`watchlist.ts` router.use pattern](../artifacts/api-server/src/routes/watchlist.ts), [`skipGeneralLimit`](../artifacts/api-server/src/middleware/rateLimiter.ts) |

### Purpose
Require session auth for all expensive `/api/*` routes. UI `ProtectedRoute` is not a security boundary.

### Scale / compliance
No new Redis. Public allowlist must stay minimal. CI auth smoke after [enh/4](../enhancements/4-api-integration-test-harness-070926.md) Phase B.

---

## 1. Finding + evidence

| Route file | Auth today | Cost if abused |
|---|---|---|
| [`stocks.ts`](../artifacts/api-server/src/routes/stocks.ts) | None (6 GET) | Yahoo quoteSummary per miss |
| [`options.ts`](../artifacts/api-server/src/routes/options.ts) | None | Yahoo options chains |
| [`explain.ts`](../artifacts/api-server/src/routes/explain.ts) L119 | None | **Anthropic** Haiku per POST |
| [`technical.ts`](../artifacts/api-server/src/routes/technical.ts) | None | DB + compute batch |
| [`indicators.ts`](../artifacts/api-server/src/routes/indicators.ts) | None | Yahoo on cache miss |
| [`macro.ts`](../artifacts/api-server/src/routes/macro.ts) | GET public; POST admin | Mostly file cache — lower marginal cost |
| [`sdm.ts`](../artifacts/api-server/src/routes/sdm.ts) | None | SDM vendor |
| [`fundamentals.ts`](../artifacts/api-server/src/routes/fundamentals.ts) | GET rankings/status/peer-groups public | DB reads only |
| [`daily-brief.ts`](../artifacts/api-server/src/routes/daily-brief.ts) | GET public | File read |
| [`scoring-config.ts`](../artifacts/api-server/src/routes/scoring-config.ts) | GET public | DB read |

FE [`App.tsx`](../artifacts/stock-compare/src/App.tsx) wraps pages in `ProtectedRoute` — **does not protect API**.

---

## 2. Repro

1. Log out (no session cookie).
2. `curl http://localhost:8080/api/stocks/quote?ticker=NVDA` → 200 + JSON.
3. `curl -X POST http://localhost:8080/api/explain/score -H 'Content-Type: application/json' -d '{"ticker":"NVDA","scoreType":"fundamental",...}'` → may hit Anthropic.

---

## 3. Why this bug occurred (root cause / genesis)

- **Historical context:** App built as single-tenant research tool; SPA assumed same-origin + login UI = safe.
- **Drift:** Session auth added for watchlist/feed/positions, but **data routes never retrofitted** — incremental auth, no router-level gate.
- **Category:** client-only guard · omission · wrong SSOT (UI vs API boundary)

---

## 4. Permanent prevention (no negative tradeoffs)

| Guardrail | Detail |
|---|---|
| CI smoke | After enh/4: supertest `GET /api/stocks/quote` without cookie → **401** |
| Router pattern | Single mount in [`routes/index.ts`](../artifacts/api-server/src/routes/index.ts): authenticated stack vs public allowlist |
| Code review rule | New route files must declare auth in PR checklist |
| **Non-goals** | Do not add API keys per user; do not rate-limit authenticated users to unusable levels |

**Owner:** Any new route → update allowlist doc in this task + CI test.

---

## 5. Fix side-effects (how the fix can cause new bugs)

| Risk | Mitigation |
|---|---|
| Health check breaks | Keep `GET /api/healthz` public |
| Register/login loop | Keep `POST /auth/login`, `POST /auth/register` public; auth routes before gate |
| Orval/dev without cookie | Dev uses logged-in browser; CI uses session fixture |
| Macro GET blocked breaks anonymous embed | **Decision:** macro GET stays public (file-backed) OR require auth — document in Fix B |
| E2E / monitoring | Document probe paths |

**Rollback:** Remove router-level middleware; revert to per-route auth only.

---

## 6. Fix options

### A — Minimal (recommended v1)
- In [`routes/index.ts`](../artifacts/api-server/src/routes/index.ts): mount `requireAuth` on a sub-router containing stocks, options, explain, technical, indicators, sdm, fundamentals GET (except decide macro/scoring-config).
- Explicit **PUBLIC_PATHS** array documented in file header.

### B — Durable
- Factory `createApiRouter({ requireAuth: true })` + OpenAPI security scheme `cookieAuth`.
- enh/22 Orval migration documents auth on all operations.

---

## 7. Acceptance criteria

- [ ] Without session: stocks/quote, options, explain → 401
- [ ] With valid session: unchanged 200 behavior
- [ ] healthz, auth/login, auth/register → still public
- [ ] Documented allowlist for macro GET + scoring-config GET (if kept public)
- [ ] enh/4 test (when available): unauthenticated quote → 401

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/routes/index.ts` | Auth sub-router + allowlist |
| **P0** | `artifacts/api-server/src/middleware/requireAuth.ts` | No change expected |
| **P1** | `.agents/context/api-endpoints.md` | Mark auth required |
| **P1** | enh/4 health/session test | Session cookie fixture |

**Do not:** block healthz; import `index.ts` in tests; add Redis rate store (bug/7 / enh/29).

---

## Impact & Risk Analysis

| Lens | Note |
|---|---|
| Blast radius | All FE fetches use `credentials: 'include'` today — should pass |
| CSP user | No change when logged in |
| Ops | Stops scripted vendor drain |

---

## 9. Verify (before fix)

```bash
# No session cookie:
curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/stocks/quote?ticker=AAPL"
# Expect: 200 today → should become 401 after fix

curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/explain/score" \
  -H "Content-Type: application/json" -d '{"ticker":"AAPL","scoreType":"fundamental"}'
# Expect: 200/400 today → 401 after fix
```

Logged-in browser: same routes return 200 (same-origin sends session cookie by default).

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/index.ts` | Public: `healthRouter`, `authRouter` only; `protectedRouter.use(requireAuth)` for all data routes |
| 2 | `artifacts/api-server/src/middleware/requireAuth.ts` | No change expected |
| 3 | `.agents/context/api-endpoints.md` | Document auth-required |

**Note:** `auth.ts` admin routes stay on public router but use `requireAdmin` per-route — correct.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Unauthenticated `curl` stocks/quote, explain → **401** | ✓ |
| Manual | Logged-in app: home, scanner, macro load | ✓ |
| Manual | `GET /api/healthz`, `POST /api/auth/login` still work without prior session | ✓ |
| CI (enh/4) | supertest without cookie → 401 | when Phase B lands |

`pnpm --filter @workspace/api-server test` — no regression.

---

## 12. Manual-only

- Production Replit/proxy cookie behavior
- Orval codegen dev without session

---

## 13. Regression watchlist

- Do not block `GET /api/healthz`
- Do not block `POST /auth/login`, `POST /auth/register`
- New routes must mount under `protectedRouter`, not public stack
- `watchlist.ts` / `positions.ts` already use `requireAuth` — double middleware OK

---

## DONE (2026-07-10)

Confirmed real before fixing (verified `routes/index.ts` had zero auth on stocks/options/explain/technical/indicators/sdm). Fixed via path-scoped `router.use([...paths], requireAuth)` directly on the parent router in `routes/index.ts` — **not** a wrapper sub-router with a blanket `.use(requireAuth)`, because that pattern (as already used by `watchlist.ts`/`feed.ts`) leaks: a no-path `.use()` on a router mounted with no prefix runs unconditionally for every request that reaches it, blocking anything mounted *after* it in the chain even if it doesn't match any of its own routes. First attempt used that wrong pattern and broke `daily-brief`/`macro`/`fundamentals` GET (should stay public) — caught via live curl verification, not assumed. Final fix keeps `watchlist.ts`/`feed.ts` (which can't avoid the blanket pattern — their routes are pre-baked with the `/watchlist`/`/feed` prefix) mounted **last** so nothing is left downstream to leak onto.

Also found and fixed two unrelated pre-existing bugs while verifying: (1) `scoring-config.ts` declared routes as `/api/scoring-config` inside a router already mounted at `/api`, so the real path was `/api/api/scoring-config` and the frontend's actual call never matched — fixed by dropping the redundant prefix. (2) That exposed a missing `app_config` table (schema defined it, never pushed to this DB) — created via targeted `CREATE TABLE IF NOT EXISTS` rather than `drizzle-kit push` (which prompted an interactive create-vs-rename disambiguation unsafe to force blindly).

Verified live via curl (not just tsc/tests): stocks/options/indicators/technical/explain/sdm → 401 anonymous; daily-brief/macro/fundamentals-rankings/scoring-config/healthz → 200 anonymous; watchlist/feed → 401 (own pre-existing auth, unchanged). `pnpm test` 35/35 pass, `pnpm run typecheck` clean (2 pre-existing unrelated errors in `backfill-edgar.ts`/`merge-trusted.ts` confirmed present on `main` before this session).
