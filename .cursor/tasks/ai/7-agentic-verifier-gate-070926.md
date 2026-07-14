# agentic-verifier-gate

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~20–40 min — **docs via ai/9**; optional verifier.md one-liner) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R10** |
| **Related** | [ci-pipeline](../enhancements/3-ci-pipeline-typecheck-tests-070926.md), [api-integration-test-harness](../enhancements/4-api-integration-test-harness-070926.md) |
| **Ship via** | [ai/9](9-agentic-commands-playbooks-070926.md) (command SSOT) |
| **Type** | ENHANCE (docs; no new CI) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app code**; no CI YAML |

### Purpose
Make “run verifier after every feature” a habit in Cursor via playbook + optional Task `verifier` — not a new CI system.

### Cache / DB compliance
None.

---

## 1. Executive summary (rescoped)

**Do not** implement `.github/workflows` here (enhancements/3) or auto-fix from verifier.

**Do** supply the **canonical Verify command block** (this file §4.5) for ai/9 to paste into CURSOR.md. After ai/9 ships, collapse this task to a pointer.

**Critical finding:** `.claude/agents/verifier.md` commands (`npx tsc`, `npm test`) are **cwd-naive** for this monorepo — playbook must use `pnpm --filter`.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Verify after features | AGENTS.md; verifier.md | Habit gap in Cursor |
| Report-only | verifier.md constraints | Never fix code |
| Monorepo filters | package.json names | `@workspace/api-server`, `@workspace/stock-compare` |
| Align with future CI | enhancements/3 | Same filters |
| SKIP ≠ PASS | Review | Especially lint/tests missing scripts |
| Single SSOT | ai/9 | Do not duplicate long playbook in two tasks after ship |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Keep this file as research + acceptance for Verify |
| W2 | ai/9 pastes §4.5 into CURSOR Playbooks |
| W3 | Optional: verifier.md note pointing at CURSOR playbook |
| W4 | After ship: thin this file to pointer |

### Out of scope
| Item | Owner |
|---|---|
| CI YAML | enhancements/3 |
| Verifier auto-fix | Forbidden |
| Inventing api-server test PASS | No script today |
| Second verifier script | Drift |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| verifier.md report-only | `.claude/agents/verifier.md` — tools Bash/Read/Grep; “Never fix code” |
| verifier.md commands | `npx tsc --noEmit`; `npx eslint src …`; `npm test -- --run` — assume single-package cwd |
| api-server scripts | `"typecheck": "tsc -p tsconfig.json --noEmit"` — **no** `test` / `lint` |
| stock-compare scripts | `typecheck` + `test` (3 lib files, **node native** runner — not vitest) |
| Package names | `@workspace/api-server`, `@workspace/stock-compare` |
| enhancements/3 CI pseudo | Same pnpm filters + stock-compare test |
| CI YAML on disk | **Absent** — local verify advisory until enhancements/3 |

### 4.2 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) **via [ai/9](9-agentic-commands-playbooks-070926.md)** | Verify playbook = §4.5 |
| **P2** | [`.claude/agents/verifier.md`](../../../.claude/agents/verifier.md) | Optional: “TradeDash root: use CURSOR Verify playbook” |
| **P2** | This file after ship | Pointer only |
| — | `.github/workflows/ci.yml` | **Do not create here** |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `artifacts/*/package.json` | Confirm scripts before claiming PASS |
| enhancements/3 | Keep filters in sync when CI lands |
| ai/9 | Ship vehicle |
| ai/10 | AGENTS lists verifier |

### 4.4 When / when not

| Run Verify | Skip Verify |
|---|---|
| Feature complete; before “done”; before PR | Mid-debug spike; plan-only; docs-only (unless claiming green CI) |

Prefer **shell playbook** over Task verifier unless user asks (cost).

### 4.5 Canonical commands (paste into ai/9 / CURSOR)

From **repo root**:

```bash
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/stock-compare typecheck
pnpm --filter @workspace/stock-compare test
# api-server test: SKIP until package script / harness exists — do not invent PASS
```

**Lint:** `SKIP (no package lint script)` until enhancements/3 or a real script exists — missing lint ≠ PASS.

**Report template** (keep verifier.md shape):

```
VERIFY — [feature] — [time]
typescript: PASS | FAIL (N errors)
lint:       PASS | FAIL (N warnings) | SKIP
tests:      PASS | FAIL (N/M) | SKIP
STATUS: ALL PASS or NEEDS FIX
ERRORS:
  file:line: message (max 10 lines)
```

**Rules:** SKIP ≠ PASS for checks the feature was supposed to cover; never auto-fix; once CI exists, match CI step-for-step.

### 4.6 Acceptance criteria

- [ ] Playbook exists **once** (ai/9 / CURSOR) with §4.5 commands
- [ ] States when / when not
- [ ] States never auto-fix
- [ ] States SKIP ≠ PASS; lint SKIP until script/CI
- [ ] Links enhancements/3–4
- [ ] Package names correct
- [ ] This task thinned to pointer after ship — no second SSOT
- [ ] No `artifacts/**` changes from this task alone

### 4.7 Suggested commit message

`docs(cursor): add verify playbook with monorepo pnpm filters`  
(same commit as ai/9 OK)

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **ai/9** | **Ship vehicle** |
| enhancements/3 | CI becomes truth |
| enhancements/4 | Integration tests later |
| ai/10 | Registry link |

---

## 5. Data note
None.

## 6. Impact & Risk Analysis

- Playbook rules must prevent false green via SKIP
- Require `--filter` from repo root — a wrong cwd can produce an empty "success"
- Verifier must stay report-only — never auto-fix code
- Docs/playbooks only (unless a verifier.md one-liner); runs 30-120s once per feature, not per edit

**Do not:** auto-fix; hide failures (R1).  
**Floors:** R1, R10.

---

## Review: APPROVE — implement via ai/9. One Verify playbook with real monorepo commands; don't trust verifier.md's `npx`/`npm` as written.
