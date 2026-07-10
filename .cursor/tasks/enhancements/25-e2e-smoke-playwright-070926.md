# e2e-smoke-playwright

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | infra |
| **Effort** | M (Phase A local; CI after enh/3) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [ci-pipeline](3-ci-pipeline-typecheck-tests-070926.md), [api-integration-test](4-api-integration-test-harness-070926.md), [home-dashboard](../new_app_features/4-home-dashboard-redesign-070926.md) |
| **Type** | NEW (test harness) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — prior audit thin |

### Purpose
Browser smoke for critical CSP paths: login → home → scanner → watchlist — catch auth/routing/hydration bugs unit tests miss.

### Cache / DB compliance
N/A for product caches. Tests hit local api-server + Vite. **Never** commit real passwords — `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` secrets. No production URL in CI v1.

---

## 1. Executive summary (rescoped)

**Already present:**
- Auth: `login.tsx` → `POST /api/auth/login`; `ProtectedRoute` in `App.tsx` L49–59
- healthz: `{ status: "ok" }` (enh/4)
- **No** Playwright config / `e2e/` specs in repo (glob 0)
- Claude rehydrate probes Playwright Chrome path — Cursor CI still needs explicit setup
- enh/3 CI pipeline — **no `.github/workflows` yet**; E2E job depends on that shipping first

**Do (Phase A — local first):**
1. Add `e2e/playwright.config.ts` + `e2e/smoke.spec.ts` at repo root (or `artifacts/stock-compare/e2e` — pick one; prefer **repo root** `e2e/`)
2. ≤5 smokes listed below
3. Document ports: API **8080**, FE preview/dev **8081** (or match actual Vite port in package scripts — verify in PR)
4. Add `data-testid` only where flaky (home rankings table) — coordinate new_app_features/4

**Phase B — CI:** after enh/3 workflow exists, add job: start servers → playwright → upload report on failure.

**Do not:** visual regression; full browser matrix; load tests; production E2E v1.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| No browser automation | No playwright.config in repo |
| Auth races historically | login.tsx comments / ProtectedRoute loading gate |
| UX backlog needs safety net | tours, home redesign, score popovers |
| CI dependency | enh/3 — workflows not present yet |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | Install `@playwright/test` (devDep root or stock-compare) |
| A2 | `e2e/playwright.config.ts` — baseURL, webServer optional |
| A3 | Smoke tests (max 5) |
| A4 | `.gitignore` playwright-report / test-results |
| A5 | README snippet: env vars + how to run |
| A6 | Minimal `data-testid="home-rankings"` (or similar) on home |

### Phase B — CI (after enh/3)
| # | Work |
|---|---|
| B1 | Job with secrets for test user |
| B2 | Artifact upload on failure |

### Smoke list (authoritative)
| ID | Assert |
|---|---|
| S1 | `request.get('/api/healthz')` → 200 + `status === "ok"` |
| S2 | Unauthenticated `/` or `/watchlist` → redirect `/login` |
| S3 | Login with E2E creds → lands on home |
| S4 | Home rankings / compare shelf shows ≥1 ticker row (`data-testid`) |
| S5 | `/options-scanner` loads (no fatal error toast; main landmark visible) |

Optional later: watchlist select ticker — only if stable.

### Out of scope
| Item | Reason |
|---|---|
| Visual / Percy | Forbidden v1 |
| Cross-browser matrix | Chromium only |
| Production URL | Forbidden v1 |
| >5 smokes | Keep green |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| ProtectedRoute | App.tsx L49–59 |
| Login form | login.tsx — email/password fields by `name` |
| healthz shape | enh/4 — `{ status: "ok" }` not `{ ok: true }` |
| No playwright files | glob 0 |
| CI | enh/3 pack — add workflows first |

### 4.2 Files to modify / create

| Pri | Path | Change |
|---|---|---|
| **P0** | `e2e/playwright.config.ts` | **New** |
| **P0** | `e2e/smoke.spec.ts` | **New** |
| **P0** | root or package `package.json` | `test:e2e` script |
| **P1** | `home.tsx` (or rankings component) | `data-testid` |
| **P1** | `.gitignore` | reports |
| **P2** | `.github/workflows/ci.yml` | After enh/3 |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/3, enh/4 | CI + healthz contract |
| app.ts session | Cookie auth — playwright must `storageState` or UI login |
| new_app_features/4 | Home markup may move — use testid |

### 4.4 Paste-ready smoke sketch

```ts
import { test, expect } from "@playwright/test";

test("healthz", async ({ request }) => {
  const res = await request.get("/api/healthz");
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("login → home", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', process.env.E2E_TEST_EMAIL!);
  await page.fill('input[name="password"]', process.env.E2E_TEST_PASSWORD!);
  await page.click('button[type="submit"]');
  await expect(page).not.toHaveURL(/login/);
  await expect(page.getByTestId("home-rankings")).toBeVisible({ timeout: 30_000 });
});
```

### 4.5 Acceptance criteria

**Phase A**
- [ ] `pnpm exec playwright test` (or documented script) green locally with env creds
- [ ] healthz assert uses `{ status: "ok" }`
- [ ] No secrets in git
- [ ] ≤5 tests; Chromium only
- [ ] Reports gitignored

**Phase B**
- [ ] CI job after enh/3; artifacts on failure

### 4.6 Suggested commit message

`test(e2e): add Playwright smoke for auth and home/scanner`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/3** | Hard for CI job; soft for local Phase A |
| Test user / invite | Hard — seed or documented invite |
| new_app_features/4 | Soft — testid placement |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- New e2e/ only + tiny testid
- Rollback: delete e2e; remove CI job

### 2. Bug introductions
- Flaky waits — prefer testid + explicit timeout over networkidle alone
- Wrong port/proxy on Replit — document BASE_URL
- Session cookie `secure` in prod vs local
- Catch: fail login password → S3 fails; break healthz shape → S1 fails

### 3. Performance
- Smoke suite < 3 min target

### 4. Workflow
- Safety net before shipping UX tours / home redesign

### 5. Drift
- Paired: enh/3 CI ↔ enh/4 healthz ↔ home testids ↔ auth cookie

**Do not:** visual regression; prod E2E; password in repo; >5 tests.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — Phase A ready; CI after enh/3  
**Was:** ready with “Revise after CI”. **Key:** zero Playwright today; local smokes unblocked; healthz `{ status: "ok" }`.
