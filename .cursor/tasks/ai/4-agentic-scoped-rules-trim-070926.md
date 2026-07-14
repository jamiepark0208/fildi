# agentic-scoped-rules-trim

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~15–30 min — **docs-only** unless a 4th alwaysApply appears) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floor **R1** |
| **Type** | FIX / ENHANCE (verify + document; trim only if drift) |
| **Impl research** | 2026-07-09 deep pass (ai/2-quality) — **no app code** |
| **Related** | [ai/2](2-agentic-safety-context-isolation-070926.md) CURSOR PR · [ai/3](3-agentic-lesson-memory-hygiene-070926.md) lessons not alwaysApply · [ai/8](8-agentic-skills-discovery-070926.md) skills ≠ rules · [ai/10](10-agentic-agents-md-bridge-070926.md) no AGENTS alwaysApply |

### Purpose
Keep Cursor **always-on** rules at a hard cap of **3** so every chat doesn’t pay a token tax — PM / lessons / task-reviewer / skills load on demand only.

### Cache / DB compliance
None.

---

## 1. Executive summary (rescoped)

**Goal already met in frontmatter.** Do **not** invent a “trim project.”

| alwaysApply | File | ~bytes |
|---|---|---|
| **true** (keep) | `cursor.mdc` | ~803 |
| **true** (keep) | `codegraph.mdc` | ~889 |
| **true** (keep) | `token-efficiency.mdc` | ~1578 |
| **false** (keep) | `lessons-learned.mdc` | ~1442 |
| **false** (keep) | `product-manager.mdc` | ~1933 |
| **false** (keep) | `task-reviewer.mdc` | ~1220 |

**Real gaps:**
1. `CURSOR.md` **PROJECT RULES** table lists only `codegraph` + `token-efficiency` — omits `cursor.mdc` and all three requestable rules → agents don’t know the full set
2. Policy sentence: **never add a 4th `alwaysApply: true` without explicit user approval** (R1)
3. Optional: `cursor.mdc` already thin (15 lines, pointer to CURSOR.md) — no meaningful prose trim left; skip unless duplication creeps back

---

## 2. Why (requirements)

| Requirement | Source | Notes |
|---|---|---|
| Cap always-on rules | Research **R1**; ai/1 gap “alwaysApply rule bloat” | Prefer ≤3 forever |
| codegraph always on | codegraph.mdc + project norm | **Forbidden** to turn off |
| token-efficiency always on | token-efficiency.mdc | Keep |
| cursor.mdc thin entry | Points at CURSOR.md | Keep alwaysApply — it’s the router |
| lessons / PM / task-reviewer on demand | Frontmatter false today | Must stay false (**ai/3**, PM mode, DoR) |
| Skills not rules | **ai/8** | Skills live in `.claude/skills` / stubs — never alwaysApply bodies |
| AGENTS.md not alwaysApply | **ai/10** | Pointer only |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Replace/expand `CURSOR.md` → **PROJECT RULES** with full inventory table (all 6 files + alwaysApply Y/N + one-line purpose + how to invoke if N) |
| W2 | Add **Policy:** new rules default `alwaysApply: false`; 4th always-on requires user OK |
| W3 | Verify frontmatter unchanged (no edits unless someone flipped a flag) |
| W4 | Optional: if `cursor.mdc` grows past ~25 lines of duplicated CURSOR content, cut back to pointer bullets only |

### Out of scope
| Item | Reason |
|---|---|
| Deleting or disabling `codegraph.mdc` / `token-efficiency.mdc` | Required |
| Porting CLAUDE.md into alwaysApply | Token bomb (R1) |
| New mega-rule (“all trading knowledge”) | R1 |
| Moving skill bodies into `.cursor/rules` | **ai/8** |
| Changing `lessons-learned` to alwaysApply | **ai/3** forbids |
| App / artifacts code | Never |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

```
.cursor/rules/
  cursor.mdc              alwaysApply: true   (15 lines — entry pointer)
  codegraph.mdc           alwaysApply: true   (31 lines)
  token-efficiency.mdc    alwaysApply: true   (50 lines)
  lessons-learned.mdc     alwaysApply: false  (35 lines)
  product-manager.mdc     alwaysApply: false  (46 lines)
  task-reviewer.mdc       alwaysApply: false  (34 lines)
```

**CURSOR.md today (incomplete):**

```markdown
## PROJECT RULES (auto-loaded from `.cursor/rules/`)
| Rule | Purpose |
| codegraph.mdc | ... |
| token-efficiency.mdc | ... |
```

Missing from that table: `cursor.mdc`, `lessons-learned.mdc`, `product-manager.mdc`, `task-reviewer.mdc`.

**ai/1 inventory** already said: `codegraph` + `token-efficiency` alwaysApply; lessons/PM on demand — matches disk; CURSOR.md just wasn’t updated to list all six.

**Duplicate prose:** `cursor.mdc` summarizes CURSOR workflows in 6 bullets — appropriate for always-on router; **not** a full copy of CURSOR.md. No trim required unless it balloons.

### 4.2 Target CURSOR.md table (implementer paste/adapt)

| Rule file | alwaysApply | Purpose | Invoke |
|---|---|---|---|
| `cursor.mdc` | **Y** | Entry: follow CURSOR.md; state.md never write | Auto |
| `codegraph.mdc` | **Y** | Codegraph before multi-file reads/refactors | Auto |
| `token-efficiency.mdc` | **Y** | Compress long prompts/responses | Auto |
| `lessons-learned.mdc` | N | Grep lessons before infra/vendor/scope mistakes | `@` / topic grep / wrap |
| `product-manager.mdc` | N | PM backlog → `.cursor/tasks/` | “PM mode” / @ |
| `task-reviewer.mdc` | N | DoR multi-lens PRD review | “task reviewer” / @ |

**Policy (add under table):**  
Default for any **new** `.mdc`: `alwaysApply: false`. Raising always-on count above **3** needs explicit user approval (token budget / R1).

### 4.3 Files to modify (authoritative)

| Pri | Path | Change (English) |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Expand PROJECT RULES to full 6-row table + policy sentence |
| **P1** | Same PR as [ai/2](2-agentic-safety-context-isolation-070926.md) | Prefer one CURSOR.md commit bundling ai/2 table + ai/4 inventory (+ later 5/8/9/10) |
| — | `.cursor/rules/*.mdc` frontmatter | **No change** (already correct) |
| — | `cursor.mdc` body | **No change** unless >~25 lines of duplication appears |

### 4.4 Files to read, not modify

| Path | Why |
|---|---|
| All six `.cursor/rules/*.mdc` | Confirm alwaysApply flags before claiming done |
| `ai/1` R1 | Floor |
| `ai/3` | lessons-learned must stay false |
| `ai/8` | skills discovery — not rules |
| `ai/10` | AGENTS bridge — not alwaysApply |

### 4.5 Acceptance criteria

- [ ] `rg -l 'alwaysApply: true' .cursor/rules/` returns **exactly 3** files: cursor, codegraph, token-efficiency
- [ ] CURSOR.md PROJECT RULES lists all **6** `.mdc` files with Y/N
- [ ] Policy line present (no 4th alwaysApply without approval)
- [ ] New chat without @PM / @task-reviewer does not behave as if those modes are loaded (manual smoke)
- [ ] No `artifacts/**` changes; no new `.mdc` files

### 4.6 Suggested commit message

`docs(cursor): inventory all rules with alwaysApply flags in CURSOR.md`

### 4.7 Effort reality

**Document-only.** If someone already flipped a requestable rule to `alwaysApply: true`, fix frontmatter back to `false` and note in PR — that would be the only code-adjacent change.

---

## 5. Data / database note

None.

---

## 6. Dependencies

| Dep | Relation |
|---|---|
| ai/1 | R1 reference |
| ai/2 | Share CURSOR.md PR |
| ai/3 | Protect lessons-learned false |
| ai/5 / 8 / 9 / 10 | Also edit CURSOR.md — coordinate to avoid thrash |
| ai/6 hooks | Independent; codegraph rule stays even if hooks incomplete |

---

## 10. Verification

| Check | Pass |
|---|---|
| Count alwaysApply true | = 3 |
| CURSOR table | 6 rows + policy |
| lessons / PM / task-reviewer | alwaysApply false |
| codegraph | still true |

Commands for coding agent:

```bash
rg -n "alwaysApply:" .cursor/rules/*.mdc
rg -n "PROJECT RULES|alwaysApply" CURSOR.md
```

---

## Impact & Risk Analysis

- Listing requestable rules in a table might tempt agents to "always load them" — the table must have an explicit Invoke (on-demand) column
- Removing codegraph from alwaysApply while "trimming" is forbidden
- Hard cap stays at 3 alwaysApply rules — reject any feature wanting a 4th; use skills (ai/8) or requestable rules instead
- Scoped to CURSOR.md (+ rare frontmatter fix); any new rule file must update the CURSOR table in the same PR

**Do not:** 4th alwaysApply; always-inject lessons/PM/task-reviewer/AGENTS/skills (R1).  
**Floors:** R1, R10.

---

## Review: batch pack confirmed; deep pass = document inventory + policy, not a refactor of rules. Cap already satisfied on disk.
