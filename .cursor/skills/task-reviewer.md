---
name: task-reviewer
description: Multi-lens backlog/PRD review — PM + product + eng + BA + trader-user. Review tasks for need, deficiencies, better solutions, bug risk. Invoke when user says task reviewer / review tasks / DoR.
---

# Task reviewer (Definition of Ready review)

**Real-world analog:** Not a code “verifier.” This is a **multi-stakeholder requirements / PRD review** before build — like sprint refinement + design-doc review + BA walkthrough in one pass.

| Lens | Asks |
|---|---|
| **Product manager** | Priority vs goals? In/out of scope clear? Enhances existing or invents parallel? |
| **Product / UX** | Trader job-to-be-done? First-viewport clutter? Compete or confuse with existing UI? |
| **Tech / eng** | Codegraph reality — does baseline exist? Cache/DB/TTL ok? Drift with Cursor/Claude or dual APIs? |
| **Business analyst** | Acceptance criteria testable? Dependencies/seq right? Risks/rollback named? |
| **User (CSP trader)** | Would I use this when picking a put? Noise? Trust (scores vs AI narrative)? |

TradeDash = **put-selling research**. Score anything that doesn’t help CSP/wheel decisions harder.

---

## Startup (≤6 reads)

1. Hook: `cursor-state.md` + `session.md`
2. [`.cursor/tasks/INDEX.md`](../tasks/INDEX.md) — pick folder + seq
3. Grep lessons: `node .cursor/scripts/session-lesson-cursor.js grep "<topic>"`
4. Load **this** skill only (not product-manager unless rewriting the PRD)
5. Per task: read the PRD file; **one** `codegraph_explore` for claimed baseline symbols/files
6. Optional: related seq N±1 in same folder for dependency sense

**Write allowlist:** task markdown (status/review section), `INDEX.md`, review notes under `.cursor/tasks/` if needed.  
**Denylist:** app code unless user says build; `.agents/context/state.md`.

---

## Per-task procedure

For **each** task file:

### A. Why was this suggested?
One sentence from Research/Source/Parent. If missing → flag **orphan pitch**.

### B. Five-lens verdict (score each: Keep / Rescope / Defer / Cut)

Fill a short table in the review output. Hard questions:

1. **Need:** If we never built it, what breaks for a CSP trader or for safe agent work?
2. **Already exists:** Codegraph — are we duplicating feed/explain/provenance/hooks/calendar?
3. **Enhance vs greenfield:** Prefer enhance; greenfield must justify empty baseline.
4. **Bugs / regressions:** False confidence (AI vs scores), double-fetch, dual state.md, rate limits, race.
5. **Better shape:** Smaller MVP? Merge with another seq? Delete section? Change UX form factor?
6. **Seq:** Must prior `#` in folder finish first? Cross-folder deps (`ai/11` ↔ `new_app_features/3`)?

### C. Deficiencies checklist
- Missing Impact & Risk (required for `ai/*`) or thin §10 only when high blast radius
- Vague acceptance criteria
- Out of scope not naming the rejected gold-plate
- Cache/DB/token floors violated (Redis agent memory, second explain API, N+1)
- Confuses **dev lessons** vs **trader journal**

### D. Recommendation (pick one)
| Verdict | Meaning |
|---|---|
| **APPROVE** | Ready to build as written |
| **APPROVE-WITH-NITS** | Build after small PRD edits listed |
| **RESCOPE** | Rewrite What/How; keep intent |
| **MERGE** | Fold into another task (name target seq) |
| **DEFER** | Valid later; wrong now (deps/P3) |
| **CUT** | Not needed / harmful / duplicate |

### E. Write-back (when user wants edits)
Add to the task file (top or end):

```markdown
## Review (YYYY-MM-DD)
**Verdict:** …
**Lenses:** PM … | UX … | Eng … | BA … | User …
**Nits / rescope:** …
**Bug risks to keep in PRD:** …
```

Update INDEX status if verdict changes readiness (`draft` → `ready`, or `cut` / `deferred`).

---

## Session batching (token-safe)

- Review **one folder at a time**, seq order (filename `#-`).
- Default batch: **3–5 tasks** per turn; summarize folder before next.
- Do **not** spawn orchestrator subagents for review.
- Skip re-reading research parents every time — skim once per folder.

Suggested next-session order (user can override):
1. `ai/` 1→13 (floors first — cuts cascade)
2. `new_app_features/` 1→9
3. `enhancements/` 1→29 (or 1→12 then rest)

---

## Output format (per task — keep tight)

```
### {seq}-{slug}
Verdict: APPROVE-WITH-NITS | …
Need: [1 line]
Code reality: [exists / missing / duplicate of X]
Enhance?: [yes path | no — cut/merge]
Bugs if shipped wrong: [2 bullets max]
Better: [1 alternative or "as written"]
PRD edits: [bullets or none]
```

End of folder: **Keep / Rescope / Cut counts** + suggested seq changes.

---

## Anti-patterns

- Rubber-stamping because we wrote the PRD
- Inventing new greenfield while reviewing
- Expanding scope “while we’re here”
- Treating eng “verifier” (tsc/lint) as this skill — different job (`agentic-verifier-gate`)
