# agentic-agents-md-bridge

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | infra |
| **Effort** | XS (~15–20 min) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R2**, **R10** |
| **Type** | ENHANCE (docs pointer) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app code**; CURSOR.md only |

### Purpose
Point Cursor agents at [`.agents/AGENTS.md`](../../../.agents/AGENTS.md) for routing (verifier / data-agent / ui-agent) without duplicating the catalog into CURSOR.md or alwaysApply rules.

### Cache / DB compliance
None. Read-only bridge.

---

## 1. Executive summary (rescoped)

**Do not** fork AGENTS.md into `.cursor/` or alwaysApply the catalog.

**Do** add ≤20 lines to CURSOR.md: link + compressed decision tree + Cursor-specific constraints (Task tool ≠ orchestrator; read OK / write state.md deny).

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Agents invent ad-hoc subagent plans | Research R1 | token-efficiency forbids orchestrator fan-out |
| Verifier after features forgotten | AGENTS.md L24; ai/7/9 | Pointer must mention verify playbook |
| CURSOR has no AGENTS link today | Verified | `rg AGENTS.md CURSOR.md` → no matches |
| Cursor Task types ≠ Claude agent names | Cursor product | Map carefully — don’t pretend Task `verifier` == Claude `/verifier` without reading AGENTS |
| state.md write deny | R2 / ai/2 | Restate in bridge |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | CURSOR.md “Agent routing” section — paste §4.4 |
| W2 | Explicit: do not copy full AGENTS.md into rules |
| W3 | Note: Kiro/Claude differences stay in AGENTS.md |

### Out of scope
| Item | Reason |
|---|---|
| Fork AGENTS.md into `.cursor/` | Drift |
| Orchestrator wrapper | R1 |
| Editing AGENTS.md registry | Not this task unless broken link |
| alwaysApply AGENTS body | Token floor / ai/4 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| AGENTS.md exists with registry + decision tree | `.agents/AGENTS.md` L7–27 |
| Registry agents | sonnet, opus, haiku, **verifier**, **data-agent**, **ui-agent**, Kiro |
| Decision tree includes “Verify after any feature → verifier” | L24 |
| Context table points at state.md, skills, sessions | L59–67 |
| Guardrails: no delete macro JSON; Drizzle migration; no force-push | L71–76 |
| CURSOR.md | No “Agent routing”; no `AGENTS.md` string |
| Cursor Task tool | Has `verifier`, `data-agent`, `ui-agent` subagent_types (product) — **align names** with AGENTS registry; still **R1**: no multi-agent orchestration loops |

### 4.2 Files to modify

| Priority | Path | Change |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Add §4.4 section after CODEGRAPH or before CURSOR vs CLAUDE |
| **P2** | [INDEX.md](../INDEX.md) | Mark done when shipped |
| — | `.agents/AGENTS.md` | **Do not fork**; edit only if link target renamed |

### 4.3 Read but do not modify

| Path | Why |
|---|---|
| `.agents/AGENTS.md` | Source of truth for tree |
| `.claude/agents/verifier.md` | Spec link from registry |
| ai/2, ai/7, ai/9 | Cross-links |
| `.cursor/rules/token-efficiency.mdc` | R1 already alwaysApply |

### 4.4 Paste-ready CURSOR.md section

```markdown
## Agent routing
Canonical catalog: [`.agents/AGENTS.md`](.agents/AGENTS.md) — read when delegating; **do not** paste the full file into rules.

Compressed tree (detail in AGENTS.md):
- React component, no data/API logic → ui-agent
- Fetch/cache/cron scaffolding → data-agent
- After feature complete → verify ([Playbooks → Verify](#playbooks-copy-paste-from-repo-root) / ai/9)
- Architecture rewrite → opus (Claude) / escalate — not default Cursor chat
- Default implementation → main agent (sonnet-class)

**Cursor constraints:**
- Task/subagent fan-out as an orchestrator is **forbidden** (R1 / token-efficiency)
- Prefer one agent + playbooks over multi-Task chains
- `.agents/**` is **read OK**; **never write** `.agents/context/state.md` (ai/2)
- Kiro parallel work: see AGENTS.md handoff — do not invent a second registry
```

*(If Playbooks heading id differs, fix the anchor or use plain “see Playbooks / Verify”.)*

### 4.5 Acceptance criteria

- [ ] Link resolves to `.agents/AGENTS.md`
- [ ] Section ≤20 lines
- [ ] Restates R1 no orchestrator
- [ ] Restates state.md write deny
- [ ] Points at Verify playbook (ai/9) — not a second command list
- [ ] Does **not** alwaysApply AGENTS.md
- [ ] No fork under `.cursor/`

### 4.6 Suggested commit message

`docs(cursor): link AGENTS.md routing bridge`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **ai/9** | Verify playbook target (ship together in mega-PR OK) |
| **ai/2** | state.md deny |
| **ai/7** | verifier semantics |
| **ai/8** | skills ≠ agents (`data-agent.md` skill vs data-agent) |

---

## Impact & Risk Analysis

### 1. Blast radius
- CURSOR.md only; rollback trivial

### 2. Bug introductions
- Stale summary if registry changes — section says AGENTS.md is truth
- Agents treat pointer as license for Task storms — R1 line required
- Confusing Claude agent names with Cursor Task types — “align names; still no orchestrator”

### 3. Performance & cost
- Near-zero if not embedding full AGENTS.md

### 4. Workflow
- Before: Cursor-blind to catalog  
- After: one hop  
- SKIP if pointer already present — **verified absent today**

### 5. Drift
- Paired: AGENTS.md ↔ CURSOR bridge ↔ CLAUDE agent mentions
- Guardrail: link only

### 6. Scalability
- Registry grows; pointer stays one link

**Do not:** orchestrator; always-load AGENTS (R1).  
**Floors:** R1, R2, R10.

---

## Review (2026-07-09) — deep pass (ai/2 intensity)

**Verdict:** APPROVE — ready (XS)  
**Need:** Missing pointer confirmed.  
**Better:** ≤20 lines + R1/R2; mega-PR with ai/9.
