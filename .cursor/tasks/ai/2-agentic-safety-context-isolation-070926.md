# agentic-safety-context-isolation

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~30–60 min coding once this pack is followed) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R2**, **R7** |
| **Type** | FIX / ENHANCE (thin delta) |
| **Impl research** | 2026-07-09 (this file) — **no app/product code**; Cursor harness only |

### Purpose
Stop Cursor agents from dual-writing Claude’s `.agents/context/state.md`, and make that rule **checkable at session wrap** — not only prose in docs.

### Cache / DB compliance
None. No Redis, no DB, no API.

---

## 1. Executive summary (rescoped)

**Do not** rebuild allow/deny essays. Policy already lives in `CURSOR.md`, `.cursor/rules/cursor.mdc`, and `.cursor/rules/product-manager.mdc`.

**Do** ship one real guard: `session-wrap-cursor.js` detects a dirty `.agents/context/state.md` (and optionally other denylist paths) and prints a clear warning. Reconcile one small inconsistency (PM rule vs CURSOR on who may edit `cursor-state.md`). Cross-link `ai/3` (secrets/lessons) and `ai/5` (MCP) — do not implement their scopes here.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Cursor never writes `.agents/context/state.md` | Research **R2**; CURSOR.md L45; cursor.mdc L10/L14 | Merge conflicts with Claude Code |
| Reads of `.agents/` stay allowed | Out of scope in original PRD; PM skill reads state for pulse | Over-restriction is a failure mode |
| Wrap should surface violations | Review 2026-07-09 | Wrap today only writes `session.md` |
| MCP allowlist | Research **R7** | Owned by **ai/5** — link only |
| Secrets out of lessons | Research / hygiene | Owned by **ai/3** — link only |
| No new security product | Original out of scope | No secret scanner, no encryption |

---

## 3. What (build scope — after research)

### In scope (implementer)
| # | Work |
|---|---|
| W1 | **Wrap guard** in `session-wrap-cursor.js`: after successful session update, check git porcelain (or mtime fallback) for denylist paths; warn if dirty; exit 0 still (fail-open) unless `--strict` later |
| W2 | **One reconcile table** in `CURSOR.md` under SESSION CONTEXT or END OF SESSION: Write allow / Write deny / Read OK — point at cursor.mdc + PM denylist; do not triplicate full lists |
| W3 | **Fix PM wording conflict**: `product-manager.mdc` currently denylists editing `cursor-state.md` unless user asks; CURSOR wrap flow **requires** updating `cursor-state.md` at end of normal Cursor sessions. Clarify: PM mode skips wrap/state; **build/default Cursor sessions** update `cursor-state.md` |
| W4 | **Cross-links only**: one line each to `ai/3` lesson hygiene + `ai/5` MCP selective |
| W5 | Tip line already at end of wrap — extend with state-isolation tip |

### Out of scope (do not touch in this PR)
| Item | Owner |
|---|---|
| MCP do-not-add policy / mcp.json changes | [ai/5](5-agentic-mcp-selective-070926.md) |
| Lesson cap, secrets-in-lessons, archive | [ai/3](3-agentic-lesson-memory-hygiene-070926.md) |
| New alwaysApply rule file | Rejected — cursor.mdc enough |
| Blocking `.agents/` reads | Forbidden |
| Claude `session-wrap.js` / `.claude/state.json` | Different runtime (ephemeral Claude state, not agents state.md) |
| App code under `artifacts/` / `lib/` | Never for this task |

---

## 4. Implementation research pack (for next coding agent)

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Cursor hooks = sessionStart only | `.cursor/hooks.json` |
| Wrap writes **only** `.cursor/context/session.md` | `session-wrap-cursor.js` L15–16, L80–86 — `writeFileSync(SESSION)` only |
| Wrap has **zero** state.md / git denylist check | Full file read — no `execSync`, no `.agents` path |
| Rehydrate already runs `git status --short` | `rehydrate-cursor.js` L42–50 — **reuse this pattern** (same `child_process.execSync`, cwd ROOT) |
| Policy prose exists | CURSOR.md L28–45; cursor.mdc alwaysApply; PM denylist `.agents/**` |
| Research parent | ai/1 §4 State row + §7 **R2** |
| mcp.json = codegraph only | `.cursor/mcp.json` — leave to ai/5 |
| Claude wrap ≠ Cursor wrap | `.claude/scripts/session-wrap.js` mutates `.claude/state.json` (local ephemeral), not `.agents/context/state.md` |

### 4.2 Files to modify (coding agent — this list is authoritative)

| Priority | Path | Change (English) |
|---|---|---|
| **P0** | [`.cursor/scripts/session-wrap-cursor.js`](../../scripts/session-wrap-cursor.js) | Add `checkWriteIsolation()` after session write; print WARN lines; optional count of denylist hits |
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Add compact Write allow / deny / read-OK table; keep existing “Do not edit state.md”; link ai/3 + ai/5. **Same PR can also land ai/4 rules inventory, ai/5 MCP policy, ai/8 skills table, ai/9 playbooks, ai/10 AGENTS link** (all touch CURSOR.md) |
| **P1** | [`.cursor/rules/product-manager.mdc`](../../rules/product-manager.mdc) | Clarify cursor-state: denylist applies in **PM ideation mode**; default Cursor build sessions still update cursor-state at wrap (per CURSOR.md) |
| **P2** | [`.cursor/rules/cursor.mdc`](../../rules/cursor.mdc) | Optional one bullet: “wrap warns if state.md dirty” — only if CURSOR table isn’t enough |
| **P2** | [`.cursor/tasks/INDEX.md`](../INDEX.md) | Mark this task `ready` → `done` when shipped (status already ready for build) |

### 4.3 Files to read but **not** modify

| Path | Why read |
|---|---|
| `.cursor/scripts/rehydrate-cursor.js` | Copy `git status --short` idiom (L42–50) |
| `.cursor/tasks/ai/1-agentic-workflow-research-070926.md` | R2 / R7 floors |
| `.cursor/tasks/ai/3-…` / `5-…` | Ensure no scope steal |
| `.cursor/mcp.json` | Confirm still codegraph-only (no edit) |
| `.agents/context/state.md` | Confirm path exists; **read-only** forever from Cursor |
| `.claude/scripts/session-wrap.js` | Do not port Claude state.json logic into Cursor wrap |

### 4.4 Recommended wrap algorithm (spec — not code)

```
ROOT = repo root (already: path.join(__dirname, '../..'))
DENY_WRITE_PATHS = [
  '.agents/context/state.md',
  # optional stretch: '.env', '.env.local' — only if they appear in git status
]

After writeFileSync(SESSION):
  try:
    porcelain = execSync('git status --short -- .agents/context/state.md', { cwd: ROOT })
    # or full `git status --short` and filter lines ending with denylist paths
  catch:
    print tip that git check skipped; return

  if porcelain has any line for state.md (M, A, D, ??, etc.):
    console.warn('ISOLATION WARN: .agents/context/state.md is dirty in git.')
    console.warn('Cursor must not edit this file — move handoff to .cursor/context/cursor-state.md')
    console.warn('Revert: git checkout -- .agents/context/state.md   (if change was accidental)')

  Always exit 0 (fail-open). Do not block wrap — human may need session.md updated anyway.
```

**Reuse:** Same `execSync` + `cwd: ROOT` as rehydrate. Prefer path-limited `git status --short -- <path>` to avoid scanning whole tree noise.

**Do not:** auto-checkout/revert files from wrap (destructive). Warn only.

### 4.5 Policy reconcile (exact inconsistency to fix)

| Doc | Says today | Desired |
|---|---|---|
| CURSOR.md END OF SESSION | Update `cursor-state.md` | Keep |
| product-manager.mdc denylist | Never edit `cursor-state.md` unless user asks | **PM mode only** — ideation sessions don’t wrap; build sessions follow CURSOR.md |
| cursor.mdc | Never write `state.md` | Keep; clarify read OK |

Suggested CURSOR.md table (implementer can paste/adapt):

| Action | Paths |
|---|---|
| **Write OK (Cursor)** | `.cursor/context/cursor-state.md`, `session.md`, `lessons.md`, `plans/*`, `.cursor/tasks/**` |
| **Write DENY** | `.agents/context/state.md`, `.env*`, secrets |
| **Read OK** | `.agents/**` (incl. state.md), `.claude/skills/*` |
| **MCP** | See task `ai/5` — default codegraph only |
| **Lessons/secrets** | See task `ai/3` |

### 4.6 Acceptance criteria (coding agent must hit)

- [ ] `node .cursor/scripts/session-wrap-cursor.js "test isolation"` updates session.md as today
- [ ] If `state.md` is intentionally dirtied in a throwaway way, wrap prints `ISOLATION WARN` (then restore file — do not leave dirty in shared branch)
- [ ] If `state.md` clean, wrap prints no isolation warn (existing tip OK)
- [ ] CURSOR.md has allow/deny/read table; still says never write state.md
- [ ] PM rule no longer contradicts “update cursor-state at wrap” for non-PM sessions
- [ ] No changes under `artifacts/`, `lib/`, `.agents/context/state.md` content, `mcp.json`
- [ ] Manual: agent told “update state.md” still steered to cursor-state by rules (doc-level; no hook enforcement required in v1)

### 4.7 Suggested commit message (when user asks to commit)

`fix(cursor): warn on dirty agents state.md at session wrap`

---

## 5. Data / “database” note

**No database work.** “State” here means markdown/git agent handoff files, not Postgres. Do not open Drizzle, migrations, or Redis (R6).

---

## 6. Dependencies

| Dep | Relation |
|---|---|
| ai/1 research | Reference only (done) |
| ai/3 lesson hygiene | Parallel — secrets policy |
| ai/5 mcp-selective | Parallel — MCP policy |
| ai/6 hooks-parity | Later — could eventually hook wrap; **not required** for this MVP |

---

## 10. Verification

| Check | Pass |
|---|---|
| Wrap + clean tree | No ISOLATION WARN |
| Wrap + dirty state.md | WARN printed; session.md still updated |
| CURSOR table | Allow/deny/read present |
| PM vs CURSOR | cursor-state conflict resolved in prose |
| mcp.json | Unchanged (codegraph only) |

---

## Impact & Risk Analysis

### 1. Blast radius / impact
- Touches: wrap script + CURSOR.md (+ small PM rule clarify)
- Who: Cursor agents / humans running wrap
- Rollback: revert those 2–3 files

### 2. Bug introductions
- False WARN if path spelling wrong — use exact `.agents/context/state.md`
- Agents stop reading `.agents/` — docs must say **read OK / write deny**
- Fail-closed wrap breaks session logging — **must fail-open**

### 3. Performance & cost
- One scoped `git status` ≪ 100ms; same class as rehydrate

### 4. Workflow changes
- Before: honor system only  
- After: wrap nags on violation  
- SKIP: nothing material for traders

### 5. Drift & consistency
- Paired: CURSOR.md ↔ cursor.mdc ↔ product-manager.mdc ↔ wrap script tip text
- Owner: any boundary change updates table + wrap DENY list together

### 6. Scalability
- DENY list can grow (`.env`) carefully; don’t WARN on entire `.agents/` (noise)

**Do not:** Cursor writes to state.md; Redis agent brain; auto-revert; new MCP (R2, R6, R7).  
**Floors:** R2, R7, R10.

---

## Review (2026-07-09) — task-reviewer

**Verdict:** APPROVE-WITH-NITS → nits applied via impl research pack; **Status ready** for coding agent

**Lenses:** PM Keep | UX N/A | Eng Rescope (thin delta) | BA Keep (acceptance now concrete) | User N/A

**Need:** Enforcement gap in wrap — not another policy essay.

**Better:** Warn-only git check reused from rehydrate pattern; reconcile PM/CURSOR cursor-state wording; defer MCP/secrets to ai/5 and ai/3.
