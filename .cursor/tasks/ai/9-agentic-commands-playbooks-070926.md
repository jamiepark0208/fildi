# agentic-commands-playbooks

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~30–45 min docs once this pack is followed) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R2**, **R5**, **R10** |
| **Type** | ENHANCE (docs SSOT) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app code**; CURSOR.md + optional verifier.md note |
| **Absorbs** | [ai/7](7-agentic-verifier-gate-070926.md) Verify playbook text |

### Purpose
One-page playbooks for wrap / lesson / rehydrate / verify so agents and humans don’t invent conflicting commands.

### Cache / DB compliance
None. No Redis, no DB, no API.

---

## 1. Executive summary (rescoped)

**Do not** invent slash-command binaries or a second wrap script.

**Do** add one `## Playbooks` section to `CURSOR.md` with four copy-paste blocks that match scripts **as they exist today**, plus the monorepo Verify block from ai/7. END OF SESSION already lists steps — playbooks make them agent-proof and absorb verify (missing today).

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Cursor wrap ≠ Claude wrap | R2; CURSOR vs CLAUDE table | Claude: `.claude/scripts/session-wrap.js` → `.claude/state.json`; Cursor: `session-wrap-cursor.js` → `session.md` only |
| Wrap does **not** auto-update cursor-state | Verified wrap source | Humans/agents must edit `cursor-state.md` separately (playbook must say so) |
| Lesson cap 15 + grep-first | ai/3; lesson script | `MAX_ACTIVE = 15`; dupe check on title/trigger |
| Verify monorepo filters | ai/7; enhancements/3 | Not raw `npx` from verifier.md |
| sessionStart may miss banner | CURSOR STARTUP L6 | Rehydrate fallback already documented — promote into playbook |
| No state.md writes | R2 / ai/2 | Playbook restates deny |

---

## 3. What (build scope — after research)

### In scope (implementer)
| # | Work |
|---|---|
| W1 | `CURSOR.md` → `## Playbooks` with **Rehydrate / Wrap / Lesson / Verify** (paste §4.4) |
| W2 | Keep existing END OF SESSION; playbooks may replace or sit under it — **one** command SSOT, not two conflicting lists |
| W3 | After ship: thin [ai/7](7-agentic-verifier-gate-070926.md) to pointer |
| W4 | Optional P2: one-line note in `.claude/agents/verifier.md` pointing at CURSOR Verify playbook |

### Out of scope
| Item | Owner / reason |
|---|---|
| Isolation WARN in wrap | [ai/2](2-agentic-safety-context-isolation-070926.md) |
| Hook sessionEnd reminder | [ai/6](6-agentic-cursor-hooks-parity-070926.md) |
| CI YAML | [enhancements/3](../enhancements/3-ci-pipeline-typecheck-tests-070926.md) |
| Auto-wrap every turn | Noise / R1 |
| Writing state.md | R2 ban |
| Custom Cursor slash-command binary | Docs suffice |

---

## 4. Implementation research pack (for next coding agent)

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| CURSOR has END OF SESSION steps, **no** `## Playbooks` | `CURSOR.md` L38–45 |
| No AGENTS / Verify playbook section | Full CURSOR.md read — skills end ~L64; no Verify block |
| Wrap writes **only** `session.md` | `session-wrap-cursor.js` L15–16, L80–81 — `writeFileSync(SESSION)` only; **no** `cursor-state` string in file |
| Wrap usage | `"summary"` required; optional `--lessons L-id,L-id`; validates IDs against `lessons.md` (`### ${id}:`) |
| Wrap tip today | L86: grep lessons — **no** isolation WARN yet (ai/2) |
| Rehydrate | `rehydrate-cursor.js` — banner from cursor-state + session; `--json` for sessionStart; `git status --short` L45 |
| Lesson CLI | `list` / `grep` / `add --title --trigger --mistake --fix [--verify]`; `MAX_ACTIVE = 15`; auto-archive oldest; dupe exit 1 |
| Verifier.md commands | cwd-naive `npx tsc` / `npm test` — **do not paste as-is** |
| Package scripts | `@workspace/api-server`: typecheck only; `@workspace/stock-compare`: typecheck + test (3 files, node native runner) |
| Claude wrap | Different path — playbook must name **Cursor** script explicitly |

### 4.2 Files to modify (authoritative)

| Priority | Path | Change (English) |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Add `## Playbooks` (or fold END OF SESSION into it). Paste §4.4 blocks. Link ai/2 isolation WARN expectation; ai/3 lesson rules; ai/7 for verify research |
| **P1** | [ai/7](7-agentic-verifier-gate-070926.md) | After ship: status note + “see CURSOR Playbooks” |
| **P2** | [`.claude/agents/verifier.md`](../../../.claude/agents/verifier.md) | Optional: “TradeDash monorepo: use CURSOR Verify playbook (pnpm filters)” |
| **P2** | [INDEX.md](../INDEX.md) | Mark ai/9 done when shipped |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `.cursor/scripts/session-wrap-cursor.js` | Confirm usage / no cursor-state write |
| `.cursor/scripts/session-lesson-cursor.js` | Exact add flags |
| `.cursor/scripts/rehydrate-cursor.js` | Fallback command |
| `.claude/agents/verifier.md` | Report template only |
| ai/2, ai/3, ai/7 packs | Cross-links; don’t steal scope |
| `.claude/scripts/session-wrap.js` | Do not document as Cursor path |

### 4.4 Paste-ready CURSOR.md playbooks (implementer can drop in)

```markdown
## Playbooks (copy-paste from repo root)

### Rehydrate (banner missing)
```bash
node .cursor/scripts/rehydrate-cursor.js
```
sessionStart normally injects this via `.cursor/scripts/session-start.js`.

### Wrap (end of Cursor session)
```bash
node .cursor/scripts/session-wrap-cursor.js "one-line summary"
# optional: --lessons L-2026-07-09-01,L-2026-07-09-02
```
Then **manually** update `.cursor/context/cursor-state.md` (phase / active / next) — wrap does **not** write it.
Expect **ISOLATION WARN** if `.agents/context/state.md` is dirty once [ai/2](tasks/ai/2-…) ships — fail-open; still updates session.md.
**Never** run Claude’s `session-wrap.js` from Cursor for handoff. **Never** edit `.agents/context/state.md`.

### Lesson (only after real correction)
```bash
# grep first
node .cursor/scripts/session-lesson-cursor.js grep "keyword"
node .cursor/scripts/session-lesson-cursor.js list

node .cursor/scripts/session-lesson-cursor.js add \
  --title "short title" \
  --trigger "when to apply" \
  --mistake "what went wrong" \
  --fix "guardrail" \
  [--verify "how to confirm"]
```
Max **15** active; script auto-archives oldest. No secrets/API keys in lessons ([ai/3](tasks/ai/3-…)).

### Verify (after feature complete — not mid-spike)
```bash
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/stock-compare typecheck
pnpm --filter @workspace/stock-compare test
```
Report with VERIFY template (typescript / lint / tests / STATUS).
- `lint:` use **SKIP** until a package lint script or [enhancements/3](tasks/enhancements/3-…) CI adds it — missing lint ≠ PASS
- `tests:` SKIP for api-server until a test script exists
- SKIP ≠ PASS for checks the feature was supposed to cover
- Verifier **never** auto-fixes ([ai/7](tasks/ai/7-…); `.claude/agents/verifier.md`)
- Prefer this shell playbook over spawning Task verifier unless user asks
```

*(Fix relative task links to match repo path style used elsewhere in CURSOR.md — e.g. `.cursor/tasks/ai/…`.)*

### 4.5 Acceptance criteria

- [ ] Four playbooks exist in **one** place in CURSOR.md (not duplicated long-form in ai/7)
- [ ] Wrap playbook states cursor-state is a **separate** manual step
- [ ] Distinguishes Cursor `session-wrap-cursor.js` vs Claude `session-wrap.js`
- [ ] Mentions ai/2 isolation WARN (or “coming”) and never write state.md
- [ ] Lesson playbook: grep/list/add flags + max 15
- [ ] Verify uses pnpm filters from ai/7 §4.2 — not verifier.md `npx`/`npm` as-is
- [ ] Copy-paste from repo root: wrap + rehydrate exit 0 with throwaway summary
- [ ] No changes under `artifacts/`, no new scripts unless bugfix

### 4.6 Suggested commit message (when user asks)

`docs(cursor): add playbooks for wrap, lesson, rehydrate, verify`

(Same mega-PR as ai/2+4+5+8+10 CURSOR.md edits is OK.)

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **ai/7** | Verify research SSOT; this file is ship vehicle |
| **ai/2** | Isolation WARN text in wrap playbook |
| **ai/3** | Lesson hygiene / secrets |
| **ai/6** | Hook may remind to run wrap — commands stay here |
| enhancements/3 | CI becomes truth; keep filters in sync |

---

## 5. Data note
No database. Session/lesson files are markdown only.

## 6. Impact & Risk Analysis

### 1. Blast radius
- `CURSOR.md` (+ optional verifier.md one-liner)
- Who: Cursor agents/humans
- Rollback: revert docs

### 2. Bug introductions
- Two END OF SESSION lists diverge — merge or make playbooks the only command block
- Agents run Claude wrap path — explicit naming required
- False verify green via SKIP — playbook rules above
- Catch: run each playbook once

### 3. Performance & cost
- Docs only; verify block may cost 30–120s when run — document **when**

### 4. Workflow changes
- Before: tribal / partial END OF SESSION  
- After: four copy-paste playbooks  
- SKIP: plan-only sessions need not Verify

### 5. Drift & consistency
- Paired: scripts ↔ CURSOR playbooks ↔ ai/7 ↔ enhancements/3
- Owner: script flag change updates playbook same PR

### 6. Scalability
- More playbooks OK if &lt;1 page each; reject second CLAUDE.md

**Do not:** auto-wrap; dual wrap writing state.md (R2).  
**Floors:** R2, R5, R10.

---

## Review (2026-07-09) — deep pass (ai/2 intensity)

**Verdict:** APPROVE — ready  
**Lenses:** Eng Keep (docs; wrap≠cursor-state is the non-obvious finding) | BA Keep | PM Keep

**Need:** One Playbooks SSOT with verified commands.  
**Better:** Paste §4.4; absorb ai/7; don’t trust verifier.md cwd.
