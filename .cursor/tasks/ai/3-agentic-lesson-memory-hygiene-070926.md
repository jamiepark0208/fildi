# agentic-lesson-memory-hygiene

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~30–45 min once this pack is followed) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R5**, **R6** |
| **Type** | ENHANCE (thin delta — runtime mostly shipped) |
| **Impl research** | 2026-07-09 deep pass (ai/2-quality) — **no app code** |
| **Related** | [ai/2](2-agentic-safety-context-isolation-070926.md) secrets · [ai/9](9-agentic-commands-playbooks-070926.md) lesson playbook · [ai/13](13-product-ai-trade-journal-loop-070926.md) journal ≠ lessons · [ai/4](4-agentic-scoped-rules-trim-070926.md) not alwaysApply |

### Purpose
Keep Cursor **dev** lessons capped, greppable, and **separate** from (a) Claude `.agents/memory/*` and (b) trader journal / P&L — without rebuilding the lesson script.

### Cache / DB compliance
None. File memory only. No vector DB / Redis (R6).

---

## 1. Executive summary (rescoped)

**Already shipped (do not rebuild):**
- `session-lesson-cursor.js` — `list` / `grep` / `add`, `MAX_ACTIVE = 15`, auto-archive oldest, duplicate title/trigger reject
- `lessons.md` — when-to-add rules + 5 active lessons today (**5/15**)
- `lessons-learned.mdc` — `alwaysApply: false`; grep cheat sheet
- `rehydrate-cursor.js` — last **2** `**Fix:**` lines only in banner
- `session-wrap-cursor.js` — optional `--lessons L-id` linkage

**Real gaps (this task’s build):**
1. **Sync map** — document that `.agents/memory/*` ≠ Cursor lessons (different content, no auto-sync)
2. **Boundary banners** — journal/P&L and secrets must never enter `lessons.md` (R5 + ai/2 handoff)
3. **Grep coverage** — `grep` today searches **active lessons file only**, not archive and not `.agents/memory` (docs + optional script tip)
4. **Playbook hook** — ai/9 will own copy-paste commands; this task supplies the policy text those playbooks cite

---

## 2. Why (requirements)

| Requirement | Source | Notes |
|---|---|---|
| Max 15 active | Research **R5**; lessons.md header | Enforced in script |
| Add only on real corrections | lessons.md + lessons-learned.mdc | Already strict |
| Not always-on context | **R1**; lessons-learned `alwaysApply: false` | Keep |
| Separate trader journal | **R5**; ai/13 out of scope | Must be explicit in lessons header |
| No secrets in lessons | ai/2 owns denylist; this task owns lesson-side ban | API keys / `.env` values |
| Claude memory coexistence | `.agents/memory/MEMORY.md` index | Topic tips for Claude — not Cursor lesson IDs |
| No merge into state.md | **R2** | ai/2 |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Add **Memory map** section to `lessons.md` (and/or CURSOR.md SESSION CONTEXT): three columns — Cursor lessons / Claude `.agents/memory` / Trader journal |
| W2 | Extend lessons.md “Do not add” with: trade P&L, journal tags, API keys, `.env`, passwords |
| W3 | Extend `lessons-learned.mdc`: before `add`, also skim `.agents/memory/MEMORY.md` (or `ls .agents/memory`) so we don’t restate Claude-only tips as Cursor lessons |
| W4 | Optional script polish (only if cheap): after failed/successful `grep`, print tip `Also check: .agents/memory/ and lessons-archive.md` — **do not** auto-merge those stores |
| W5 | Confirm archive path + restore note (one paragraph in lessons.md) |

### Out of scope
| Item | Owner / reason |
|---|---|
| Rewrite `session-lesson-cursor.js` cap logic | Already correct |
| Vector / embedding memory | SKIP (ai/1) |
| Auto-lesson on every wrap | Noise |
| Implementing trader journal schema | [ai/13](13-product-ai-trade-journal-loop-070926.md) |
| Writing `.agents/context/state.md` | [ai/2](2-agentic-safety-context-isolation-070926.md) |
| Making lessons-learned alwaysApply | Forbidden (**ai/4**, R1) |
| Syncing/mirroring files between Cursor lessons ↔ Claude memory | Drift magnet — map only |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Cap constant | `session-lesson-cursor.js` L23 `MAX_ACTIVE = 15` |
| Auto-archive on overflow | L146–160 → `lessons-archive.md`, status → deprecated |
| Duplicate guard | L127–135 — rejects if title/trigger already in any entry chunk |
| Commands | `list` \| `grep` \| `add` (L167–175) |
| Active lessons | L-2026-07-09-01 … 05 — **5/15** |
| Archive file | exists; essentially empty placeholder (~4 lines) |
| Rehydrate Fix lines | `rehydrate-cursor.js` `readRecentGuardrails()` — filter active, map `**Fix:**`, `slice(0, 2)` |
| Rule not alwaysApply | `lessons-learned.mdc` L3 `alwaysApply: false` |
| CURSOR already mentions lessons | SESSION CONTEXT + END OF SESSION add/grep |
| Claude memory contents | `MEMORY.md` indexes: port conflict, express route order, yahoo-finance2 options, feedback reading, response style — **orthogonal** to L-2026-07-09-* audit lessons |
| `grep` scope gap | `cmdGrep` reads **only** `LESSONS` path (L100) — not archive, not `.agents/memory` |

### 4.2 Sync map (paste target for implementer)

| Store | Path | Purpose | Who writes | Never contains |
|---|---|---|---|---|
| **Cursor lessons** | `.cursor/context/lessons.md` | Mistake → guardrail (ID `L-YYYY-MM-DD-NN`) | Cursor agents via `session-lesson-cursor.js add` after real correction | Trade P&L, journal tags, secrets, always-on essays |
| **Cursor archive** | `.cursor/context/lessons-archive.md` | Overflow / deprecated | Script auto-archive | (same bans) |
| **Claude memory** | `.agents/memory/*.md` + `MEMORY.md` | Claude Code topic tips | Claude sessions | Not a mirror of Cursor lesson IDs; Cursor may **read** for dedupe, not rewrite as policy |
| **Trader journal** | App DB / feed close / portfolio (future ai/13) | CSP outcome learning | Product UI | Must never be copied into lessons.md |

### 4.3 Files to modify (authoritative)

| Pri | Path | Change (English) |
|---|---|---|
| **P0** | [`.cursor/context/lessons.md`](../../context/lessons.md) | After “When to add” / “Do not add”: insert **Memory map** table (above); ban journal + secrets; one line on archive restore (`grep` archive file manually) |
| **P0** | [`.cursor/rules/lessons-learned.mdc`](../../rules/lessons-learned.mdc) | Add row/bullet: before `add`, check `.agents/memory/MEMORY.md` for overlapping tip; never promote lessons → alwaysApply (already there); link ai/13 boundary in one clause |
| **P1** | [`CURSOR.md`](../../../CURSOR.md) | Under SESSION CONTEXT lessons row: “see Memory map in lessons.md; ≠ trader journal (ai/13); ≠ `.agents/memory`” — **can share PR with ai/2 CURSOR table** |
| **P2** | [`.cursor/scripts/session-lesson-cursor.js`](../../scripts/session-lesson-cursor.js) | Optional: end of `cmdGrep` / `cmdList` print tip about archive + `.agents/memory`; **do not** change cap/archive algorithm unless bug |
| **P2** | [`.cursor/tasks/ai/9-…`](9-agentic-commands-playbooks-070926.md) | When ai/9 builds: lesson playbook must cite this Memory map (no duplicate policy) |

### 4.4 Files to read, not modify

| Path | Why |
|---|---|
| `.cursor/scripts/rehydrate-cursor.js` | Confirm 2-Fix behavior stays |
| `.cursor/scripts/session-wrap-cursor.js` | `--lessons` linkage already OK |
| `.agents/memory/MEMORY.md` + topic files | Dedupe awareness only |
| `ai/1` §7 R5 | Floor text |
| `ai/2` § secrets owned by ai/3 | Deliver ban text here |
| `ai/13` | Must keep “never write lessons.md” |

### 4.5 Suggested `lessons.md` “Do not add” additions (copy)

```markdown
Also never add:
- Trader journal / closed-trade tags / P&L / position sizes (see task ai/13)
- API keys, tokens, `.env` values, passwords (see task ai/2 denylist)
- Restatements of `.agents/memory/*` tips — link or leave in Claude memory
- Anything that belongs in alwaysApply rules (use rules/skills instead)
```

### 4.6 Acceptance criteria

- [ ] Memory map present in `lessons.md` (and/or CURSOR.md) with all four stores
- [ ] Do-not-add includes journal + secrets
- [ ] `node .cursor/scripts/session-lesson-cursor.js list` still shows ≤15 and current 5 actives
- [ ] `lessons-learned.mdc` still `alwaysApply: false`; mentions `.agents/memory` check
- [ ] Rehydrate banner still ≤2 Fix lines (no change required if untouched)
- [ ] No writes to `.agents/memory/*` or `state.md` in this PR
- [ ] No `artifacts/**` changes

### 4.7 Suggested commit message (when user asks)

`docs(cursor): document lessons vs agents memory vs trader journal map`

### 4.8 Effort reality check

If implementer only edits `lessons.md` + `lessons-learned.mdc` (+ optional CURSOR one-liner), this is **docs-only S**. Script tip is optional. **Do not** expand into journal schema or Claude memory rewrite.

---

## 5. Data / “database” note

No Postgres. “Memory” = markdown files. Trader journal persistence is **ai/13** / enhancements/8 — out of scope here.

---

## 6. Dependencies

| Dep | Relation |
|---|---|
| ai/1 | R5 reference |
| ai/2 | Secrets denylist; CURSOR allowlist lists lessons.md as write-OK |
| ai/4 | Keep lessons-learned not alwaysApply |
| ai/9 | Lesson playbook cites this map |
| ai/13 | Must not write lessons; this task defines the ban they rely on |

**Build order tip:** Ship **ai/3 docs** in the same CURSOR.md PR as **ai/2** if convenient; script changes optional/later.

---

## 10. Verification

| Check | Pass |
|---|---|
| `session-lesson-cursor.js list` | `5/15` (or ≤15) + titles |
| `grep "redis"` | Hits L-01 / L-04 style entries |
| Add duplicate title | Exits 1 “Likely duplicate” |
| Memory map | Visible in lessons.md |
| alwaysApply | `lessons-learned.mdc` false |

---

## Impact & Risk Analysis

- Sync map must explicitly say "do not mirror" — otherwise agents copy Claude memory into lessons wholesale
- Secret ban must target values, not the topic — an over-broad ban would block legitimate "don't commit .env" lessons
- Don't touch rehydrate unless necessary — an accidental edit there could inject full lessons instead of the capped set
- Scoped to docs (+ optional one console.log in lesson script); rollback is a markdown revert

**Do not:** vector memory; auto-lessons every wrap; journal→lessons; alwaysApply lessons (R1, R5, R6).  
**Floors:** R1, R5, R6, R10.

---

## Review: prior batch pack upgraded to this deep pass. Cap/script = keep. Value = boundaries + map, not a new platform.
