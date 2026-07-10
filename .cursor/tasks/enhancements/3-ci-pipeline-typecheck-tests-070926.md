# ci-pipeline-typecheck-tests

## ✅ DONE — 2026-07-10

**What was implemented:**
- `.github/workflows/ci.yml` — runs on push to main and all PRs. Steps: checkout → pnpm@10 + Node 24 setup with pnpm cache → frozen install → typecheck api-server → typecheck stock-compare → test api-server (unit) → test stock-compare (unit).
- No secrets, no live vendor calls. Both test suites run clean without DATABASE_URL.
- `catalysts.test.ts` was already not present in `src/lib/` (confirmed); the test script explicitly lists files so it is never accidentally included.

---

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~30–60 min) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |
| **Related** | [api-integration-test-harness](4-api-integration-test-harness-070926.md), [ai/7](../ai/7-agentic-verifier-gate-070926.md), [ai/9](../ai/9-agentic-commands-playbooks-070926.md) |
| **Type** | NEW (workflow) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app product logic**; CI YAML + docs only |

### Purpose
Add GitHub Actions CI that typechecks api-server + stock-compare and runs existing stock-compare unit tests on every PR/push — so scoring regressions aren’t “manual QA only.”

### Cache / DB compliance
None. CI must not need live API keys or a real Postgres for v1 (unit tests only).

---

## 1. Executive summary (rescoped)

**Do not** build deploy pipelines, Playwright, or api-server integration tests here.

**Do** create `.github/workflows/ci.yml` that mirrors the Verify playbook filters ([ai/7](../ai/7-agentic-verifier-gate-070926.md) / [ai/9](../ai/9-agentic-commands-playbooks-070926.md)). Wire api-server `pnpm test` **only after** [enh/4](4-api-integration-test-harness-070926.md) adds a working script.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| No CI today | Verified: no `.github/workflows` | Gap is real |
| Typecheck both apps | package scripts exist | `@workspace/api-server`, `@workspace/stock-compare` |
| Run stock-compare tests | 3 lib tests in package.json `test` | Node native runner |
| No secrets in workflow | Security | Unit tests need no keys |
| Align local verify | ai/7 / ai/9 | Same pnpm filters |
| Don’t run broken catalysts test | Untracked + bad import path | Exclude until fixed (enh/4) |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `.github/workflows/ci.yml` on `push` + `pull_request` to `main` (and optionally all PRs) |
| W2 | Steps: checkout → pnpm setup → install frozen → typecheck both → stock-compare test |
| W3 | One-line note in CURSOR.md or Verify playbook: “CI runs these on PR” |
| W4 | After enh/4: add api-server test step (same PR or follow-up) |

### Out of scope
| Item | Owner |
|---|---|
| Deploy / release | Separate |
| Playwright E2E | enhancements/25 |
| Full api integration suite | enhancements/4 |
| Coverage thresholds | Later |
| Lint gate | No package lint script today — SKIP (same as ai/7) |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| No workflows | `ls .github/workflows` → missing |
| Root typecheck | `package.json` L9 — libs + `./artifacts/**` filters |
| api-server | `"typecheck": "tsc -p tsconfig.json --noEmit"`; **no** `test` script |
| stock-compare | typecheck + `test` listing 3 files: rankings-helpers, option-scorer, chart-levels |
| Test files on disk | Those 3 + untracked `artifacts/api-server/src/lib/catalysts.test.ts` |
| catalysts.test.ts | Import `from "../src/lib/catalysts.ts"` is **wrong** for a file already under `src/lib/` — do **not** add to CI until relocated/fixed |
| Lockfile | `pnpm-lock.yaml` present — use `--frozen-lockfile` |
| Package manager | Root `preinstall` forces pnpm |
| Node engines | No `.nvmrc` / engines field found — pick LTS in workflow (recommend **Node 22**) and document |

### 4.2 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) | **New** — §4.5 |
| **P1** | [`CURSOR.md`](../../../CURSOR.md) or ai/9 Verify playbook | “CI on PR runs same filters” |
| **P2** | [INDEX.md](../INDEX.md) | Mark enh/3 done when merged |
| — | `artifacts/**` product code | **No change** |
| — | `catalysts.test.ts` | Fix under enh/4 — not this task |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `artifacts/stock-compare/package.json` | Exact test command |
| `artifacts/api-server/package.json` | Confirm no test yet |
| `pnpm-workspace.yaml` | Workspace layout; note `minimumReleaseAge` — CI install must use pnpm |
| ai/7 §4.5 | Command SSOT |
| enhancements/4 | When to add api-server test step |

### 4.4 CI design notes

- **Do not** use `pnpm -r test` — api-server has no test script; `--if-present` OK only if intentional
- Prefer explicit filters (fail loudly if package renamed)
- `pnpm/action-setup` + `actions/setup-node` with `cache: pnpm`
- No `env:` secrets for v1
- Optional: also run root `pnpm typecheck` — heavier (includes libs). **v1 recommendation:** filter only the two app packages (matches ai/7). Add root typecheck later if lib drift bites.

### 4.5 Paste-ready workflow (implementer adapt)

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @workspace/api-server typecheck
      - run: pnpm --filter @workspace/stock-compare typecheck
      - run: pnpm --filter @workspace/stock-compare test
      # After enhancements/4:
      # - run: pnpm --filter @workspace/api-server test
```

Confirm pnpm major version against repo (lockfile / packageManager field if present).

### 4.6 Acceptance criteria

- [ ] Workflow file exists; runs on PR
- [ ] Intentional type error in api-server or stock-compare → job fails
- [ ] Green tree → typecheck + stock-compare test pass
- [ ] No secrets / `.env` committed in workflow
- [ ] `catalysts.test.ts` **not** invoked by CI until fixed
- [ ] Local `pnpm --filter @workspace/stock-compare test` matches CI step
- [ ] CURSOR / Verify playbook mentions CI (one line)
- [ ] No product behavior change under `artifacts/`

### 4.7 Suggested commit message

`ci: add GitHub Actions typecheck + stock-compare tests`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/4** | Adds api-server test step later |
| **ai/7 / ai/9** | Local commands must stay in sync with CI |
| enhancements/25 | E2E separate |

---

## 5. Data note
No DB in CI v1.

## 6. Impact & Risk Analysis

### 1. Blast radius
- New workflow only (+ tiny docs)
- Rollback: delete workflow file

### 2. Bug introductions
- Wrong Node version → install/tsc fail — pin 22 and document
- Frozen lockfile fail on outdated PR — expected; regenerate lock locally
- Accidentally running live-API tests — don’t add until enh/4 mocks
- Catch: open PR with deliberate type error

### 3. Performance
- Target &lt;10 min cold; cache pnpm

### 4. Workflow
- Before: no gate  
- After: PR blocked on type/test fail  
- SKIP lint until script exists

### 5. Drift
- Paired: CI YAML ↔ ai/9 Verify ↔ package.json scripts
- Owner: script rename updates all three

### 6. Scalability
- Add api-server test after enh/4; don’t explode matrix yet

**Do not:** deploy; secrets; live vendor calls in CI.  
**Floors:** align with ai/7 SKIP≠PASS for missing lint.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Need:** Real CI YAML matching monorepo filters.  
**Better:** Exclude broken catalysts test; defer api-server test to enh/4.
