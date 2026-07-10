# api-integration-test-harness

## ✅ DONE — 2026-07-10 (re-confirmed + completed)

**What is shipped:**
- `src/scripts/merge-trusted.priority.test.ts` — 15 tests: `resolveFromIndex` algorithm + FIELD_DEFS priority locks. No DB/network.
- `src/lib/catalysts.test.ts` — 20 tests covering all pure functions: `yahooEpochToMs`, `yahooEpochToDateStr`, `parseEarningsDate`, `buildCatalysts` (earnings urgency labels, analyst action filtering, 90-day cutoff, keyword news filter, 6-item cap).
- Test script uses `'src/**/*.test.ts'` glob — new test files auto-discovered.
- Total: 35/35 pass, 0 fail.

**Import note:** test files use `.ts` extension imports (not `.js`) because `--experimental-strip-types` runner doesn't resolve `.js` → `.ts`.

**Phase B deferred:** healthz supertest route smoke — `app.ts` constructs a Postgres session store on import; requires `SESSION_SECRET` + `DATABASE_URL`. Defer until a testable seam (MemoryStore flag) is added.

---

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | api |
| **Effort** | M (~1–2 sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md) |
| **Type** | ENHANCE (harness + first fixtures) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Add a minimal API test harness (Node test runner + optional supertest) so merge/scoring/health regressions fail in CI — without live Yahoo/FMP calls.

### Cache / DB compliance
**Never** call live FMP/Yahoo in CI. Prefer pure unit fixtures for merge/FIELD_DEFS. Route tests must not require production DB; mock session/DB or skip route layer until mockable.

---

## 1. Executive summary (rescoped)

**Do not** “extract createApp()” — [`app.ts`](../../../artifacts/api-server/src/app.ts) already exports the Express app; [`index.ts`](../../../artifacts/api-server/src/index.ts) is listen + startup side effects only.

**Do** add `test` script + first **fixture** tests (merge/FIELD_DEFS priority, fix/fold `catalysts.test.ts`). Add **one** healthz smoke only if session/DB can be mocked or bypassed — importing `app.ts` today constructs a **Postgres session store** (`connect-pg-simple` + `pool`) and requires `SESSION_SECRET`.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| No api-server test script | package.json | Gap |
| Protect FIELD_DEFS / merge | merge-trusted.ts | Moat |
| healthz exists | routes/health.ts | `{ status: "ok" }` via Zod |
| CI must stay green without secrets | enh/3 | Mock/fixture only |
| catalysts.test untracked + broken import | Verified | Fix or don’t ship |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `"test"` script on `@workspace/api-server` (node:test) |
| W2 | Pure unit tests for FIELD_DEFS priority / merge helpers (no DB) |
| W3 | Fix `catalysts.test.ts` import path; move under agreed location; include in test script |
| W4 | Optional: healthz via supertest **only if** app can boot without real PG (memory session store under `NODE_ENV=test`) |
| W5 | Wire `pnpm --filter @workspace/api-server test` into [enh/3](3-ci-pipeline-typecheck-tests-070926.md) CI |

### Out of scope
| Item | Reason |
|---|---|
| Full route coverage | Later |
| Live vendor calls in CI | Forbidden |
| Playwright | enhancements/25 |
| Load testing | Later |
| Re-extracting app from index | Already done |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| `app.ts` exists | Default export Express; mounts `/api` router L58; **no** `createApp()` factory |
| Session store | L40–54 — `connectPgSimple` + `pool` from `@workspace/db`; `SESSION_SECRET!` required |
| `index.ts` | L1 import app; L24 `listen`; L32+ `runSeed` / fundamentals / technicals refresh — **side effects only after listen** |
| Importing `app` alone | Still initializes PG session middleware at module load — **needs DB or test seam** |
| healthz | `GET /healthz` → `HealthCheckResponse.parse({ status: "ok" })` — **not** `{ ok: true }` |
| api-server scripts | typecheck only — no test |
| merge-trusted | `export const FIELD_DEFS`; `resolveField` is **async DB** — unit-test priority tables / pure helpers, don’t hit DB in CI |
| catalysts.test.ts | Untracked; imports `../src/lib/catalysts.ts` from `src/lib/` (broken); uses node:test |
| stock-compare pattern | Explicit file list in `test` script — copy that style |
| supertest | Not in package.json yet |

### 4.2 Recommended v1 strategy (authoritative)

**Phase A (ship first — unblocks CI):**
1. Pure unit tests colocated or under `src/lib/*.test.ts` / `src/scripts/*.test.ts`
2. FIELD_DEFS: assert a known field’s priority order (e.g. FMP before Yahoo) from exported `FIELD_DEFS` — no network
3. Fix catalysts tests to `from "./catalysts.js"` or `./catalysts.ts` per project ESM convention; add to test script
4. `"test": "node --experimental-strip-types --experimental-transform-types --no-warnings --test <explicit files>"` (match stock-compare flags)

**Phase B (optional same PR or follow-up):**
1. Add test seam: e.g. `createApp({ sessionStore: MemoryStore })` **or** `NODE_ENV=test` branch using `memorystore` / `session.MemoryStore`
2. Then supertest `GET /api/healthz` → 200 + `{ status: "ok" }`
3. Do **not** run `runSeed` in tests — never import `index.ts` in tests

### 4.3 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/package.json` | Add `test` script; optional `supertest` + types if Phase B |
| **P0** | `artifacts/api-server/src/scripts/merge-trusted.priority.test.ts` (or similar) | **New** — FIELD_DEFS fixture asserts |
| **P0** | `artifacts/api-server/src/lib/catalysts.test.ts` | Fix import; track in git; add to test script |
| **P1** | `artifacts/api-server/src/app.ts` | **Only if** Phase B — testable session store seam (minimal) |
| **P1** | `artifacts/api-server/src/__tests__/health.test.ts` | Phase B only |
| **P1** | [enh/3 CI](3-ci-pipeline-typecheck-tests-070926.md) | Uncomment/add api-server test step |
| — | `index.ts` | Do not import from tests; keep listen-only side effects |

### 4.4 Files to read but **not** modify (unless seam requires)

| Path | Why |
|---|---|
| `app.ts` | Session/DB coupling |
| `routes/health.ts` | Exact response shape |
| `scripts/merge-trusted.ts` | FIELD_DEFS export |
| `middleware/rateLimiter.ts` | Optional later smoke — env-gated |
| stock-compare `package.json` test script | Pattern |

### 4.5 healthz assert (when Phase B ships)

```typescript
// expect — NOT { ok: true }
assert.equal(res.status, 200);
assert.equal(res.body.status, "ok");
```

### 4.6 Acceptance criteria

- [ ] `pnpm --filter @workspace/api-server test` exits 0 locally
- [ ] At least one FIELD_DEFS/priority fixture test; no network
- [ ] catalysts tests pass with corrected imports **or** explicitly deferred with note
- [ ] Tests never import `index.ts` (no listen/seed)
- [ ] If healthz test present: works without production DB **or** documented `TEST_DATABASE_URL` local-only (not CI)
- [ ] CI (enh/3) runs api-server test after this lands
- [ ] No live FMP/Yahoo in test code paths

### 4.7 Suggested commit message

`test(api-server): add node:test harness + FIELD_DEFS fixtures`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/3** | CI consumes test script |
| ai/7 / ai/9 | Verify playbook can drop api-server test SKIP |

---

## 5. Data note
No production DB required for Phase A. Phase B must not assume Replit Postgres in GitHub Actions.

## 6. Impact & Risk Analysis

### 1. Blast radius
- api-server package.json + new tests; optional app.ts session seam
- Rollback: remove test script / tests

### 2. Bug introductions
- Importing app in CI without DB → flaky red — **Phase A first**
- Wrong healthz shape `{ ok: true }` — use `{ status: "ok" }`
- Seed on test import — never import index
- Catch: run tests with `DATABASE_URL` unset for Phase A

### 3. Performance
- Unit suite should be &lt;30s

### 4. Workflow
- Before: no api tests  
- After: local + CI fixture gate  
- SKIP full route matrix

### 5. Drift
- Paired: test script ↔ CI ↔ Verify playbook
- FIELD_DEFS change updates priority test same PR

### 6. Scalability
- Grow `__tests__/` per high-value lib; mock vendors always

**Do not:** live APIs in CI; re-extract app; run seed in tests.  

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — Phase A first; Phase B needs session seam  
**Need:** Real test script + FIELD_DEFS fixtures; fix catalysts import.  
**Better:** Audit was right that createApp exists as `app.ts` — but **supertest isn’t free** until PG session is mocked.
