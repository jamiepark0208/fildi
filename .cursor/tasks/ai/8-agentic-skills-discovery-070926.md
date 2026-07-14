# agentic-skills-discovery

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~20–30 min — **docs-only**; table-only v1) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R10** |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app code**; no skill body forks |
| **Related** | [ai/4](4-agentic-scoped-rules-trim-070926.md) · [ai/9](9-agentic-commands-playbooks-070926.md) · [ai/10](10-agentic-agents-md-bridge-070926.md) |

### Purpose
Make `.claude/skills/*` discoverable from Cursor without loading all skills into every session.

### Cache / DB compliance
None.

---

## 1. Executive summary (rescoped)

**Do not** copy skill bodies into `.cursor/skills/` or alwaysApply any skill markdown.

**Do** complete the CURSOR.md skills table to parity with disk (18 Claude skills) + Cursor-only extras. Prefer **table-only**; stubs only if table fails in practice.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| One skill at a time | CLAUDE.md / CURSOR intro | Never bundle |
| Cache/API/DB patterns encoded in skills | caching-patterns, api-design, db-patterns | Agents miss them → reinvent |
| CURSOR table incomplete | Verified vs disk | See §4.1 |
| Skills ≠ rules ≠ agents | ai/4, ai/10 | Separate discovery surfaces |
| Cursor wrap script ≠ Claude session-wrap skill | ai/9 | Table row must prefer Cursor script |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Replace CURSOR.md skills table with §4.5 |
| W2 | Note one-at-a-time; full `.claude/skills/…` paths preferred |
| W3 | Claude-only note for `replit-setup` |
| W4 | Keep existing `.cursor/skills/task-reviewer.md` + `product-manager.md` |

### Out of scope
| Item | Reason |
|---|---|
| Body-copy stubs | Drift |
| alwaysApply skill bodies | R1 / ai/4 |
| New trading strategy skills | Separate features |
| Editing Claude skill bodies | Not this task |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

**Disk:** 18 files under `.claude/skills/`.  
**Cursor stubs:** `product-manager.md`, `task-reviewer.md` only.  
**CURSOR.md today:** lists ~10 needs with bare filenames; **missing** vs disk/CLAUDE:

| Missing from CURSOR table | In CLAUDE.md? |
|---|---|
| `caching-patterns.md` | yes |
| `api-design-patterns.md` | yes |
| `writing-plans.md` | yes |
| `session-wrap.md` | yes |
| `file-reading-strategy.md` | yes |
| `replit-setup.md` | yes (first-time) |
| `startup.md` | on disk; not in CLAUDE table |
| `data-agent.md` | on disk; not in CLAUDE table |

**Already in CURSOR:** build-and-run, data-architecture, options-pricer, signal-filters, ui-components, db-patterns, trader-context, technical-scorecard, feature-planner, systematic-debugging, task-reviewer, product-manager.

### 4.2 Files to modify (authoritative)

| Priority | Path | Change |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Replace skills section with §4.5 |
| **P2** | `.cursor/skills/*` new stubs | **Skip v1** unless table fails |
| — | `.claude/skills/*` bodies | **Never fork** |
| — | alwaysApply rules | **Do not** load skills |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `CLAUDE.md` skills table | Parity reference |
| `.claude/skills/*.md` | Confirm filenames only |
| `.cursor/skills/product-manager.md` | Keep; pointer pattern |
| ai/4, ai/9, ai/10 | Cross-links |

### 4.4 Stub policy

v1 = **table-only**. If later stubs: ≤15 lines, path + one-line purpose, **zero** copied sections from Claude bodies. Cap ≤10 stubs.

### 4.5 Paste-ready CURSOR.md skills table

```markdown
## SKILLS (load one at a time — never all at once)
Same files as Claude Code — read the path when relevant. Cursor-only extras under `.cursor/skills/`.

| Need | Skill |
|---|---|
| Build + restart server | `.claude/skills/build-and-run.md` |
| Data fetch strategy / tiers / TTL | `.claude/skills/data-architecture.md` |
| Yahoo Finance / TTLCache | `.claude/skills/caching-patterns.md` |
| New API route or middleware | `.claude/skills/api-design-patterns.md` |
| Options chain fetch | `.claude/skills/options-pricer.md` |
| RSI/MFI/filter logic | `.claude/skills/signal-filters.md` |
| UI components | `.claude/skills/ui-components.md` |
| DB schema and queries | `.claude/skills/db-patterns.md` |
| Trader strategy/scoring | `.claude/skills/trader-context.md` |
| Technical scorecard | `.claude/skills/technical-scorecard.md` |
| Feature planning | `.claude/skills/feature-planner.md` |
| Implementation planning | `.claude/skills/writing-plans.md` |
| Debugging | `.claude/skills/systematic-debugging.md` |
| End of session (Claude skill) | Prefer `node .cursor/scripts/session-wrap-cursor.js` (Playbooks); skill: `.claude/skills/session-wrap.md` |
| Reading images/PDFs/large JSON | `.claude/skills/file-reading-strategy.md` |
| Data-agent patterns | `.claude/skills/data-agent.md` |
| Startup checklist (Claude) | `.claude/skills/startup.md` |
| Replit first-time setup | `.claude/skills/replit-setup.md` — **Claude/Replit only; skip on Cursor** |
| PRD / backlog review (DoR) | `.cursor/skills/task-reviewer.md` |
| PM ideation / write tasks | `.cursor/skills/product-manager.md` |
```

### 4.6 Acceptance criteria

- [ ] Every `.claude/skills/*.md` in CURSOR table **or** explicit Claude-only/skip note
- [ ] `caching-patterns`, `api-design-patterns`, `writing-plans`, `file-reading-strategy`, `session-wrap`, `data-agent`, `startup` listed
- [ ] Cursor-only skills still listed
- [ ] No new alwaysApply skill bodies
- [ ] No stub body forks
- [ ] No `artifacts/**` changes

### 4.7 Suggested commit message

`docs(cursor): complete skills discovery table vs Claude skills`

(Mega-PR with ai/2+4+5+9+10 OK.)

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **ai/4** | Token floor |
| **ai/9** | session-wrap → Cursor script |
| **ai/10** | agents ≠ skills |

---

## 5. Data note
None.

## 6. Impact & Risk Analysis

- Acceptance must list every file to catch stale paths after a rename
- Forbid body-fork drift — no copies of skill content, table only
- Intro must explicitly forbid agents always-loading all skills
- Scoped to CURSOR.md, zero always-on token increase, trivial rollback; a new skill must update both the CLAUDE.md and CURSOR tables in the same PR

**Do not:** always-load skills; fork bodies (R1).  
**Floors:** R1, R10.

---

## Review: APPROVE — ready (table-only). Complete CURSOR skills table with full paths + replit skip note; no body copies.
