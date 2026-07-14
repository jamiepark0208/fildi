# agentic-cursor-hooks-parity

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | M (~1–2 hrs after spike; spike **done** in this pack) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R2**, **R10** |
| **Depends** | [ai/2](2-agentic-safety-context-isolation-070926.md) before sessionEnd wrap reminder |
| **Type** | ENHANCE (real scripts + hooks.json) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — **no app/product code**; Cursor harness only |

### Purpose
Make Cursor enforce the same *deterministic* gates Claude already has (codegraph before edits, session wrap hygiene) without inventing a second agent platform.

### Cache / DB compliance
None. Hooks/scripts only. No Redis, no app API.

---

## 1. Executive summary (rescoped)

**Do not** copy [`.claude/hooks/codegraph-precheck.js`](../../../.claude/hooks/codegraph-precheck.js) as a shared binary — Claude stdin/stdout schema and hardcoded Replit `cwd` make it non-portable.

**Do** add Cursor-native `preToolUse` (fail-open codegraph inject) and optional `sessionEnd` wrap reminder. Keep existing `sessionStart` → `session-start.js` → rehydrate as the **only** session banner path.

---

## 2. Why (requirements gathered)

| Requirement | Source | Notes |
|---|---|---|
| Codegraph before multi-file edits | R1; codegraph.mdc alwaysApply | Hook reduces blind reads; rule is safety net |
| Cursor hooks underused | ai/1 inventory | `.cursor/hooks.json` = sessionStart only |
| Wrap forgettable | Claude Stop vs Cursor manual | Non-blocking reminder only |
| Never write state.md from hooks | R2 / ai/2 | Hard ban |
| Fail-open when codegraph down | Engineering | Never `failClosed: true` on codegraph |
| No orchestrator / auto-commit | R1 | Out of scope |

---

## 3. What (build scope — after research)

### In scope (implementer)
| # | Work |
|---|---|
| W1 | New `.cursor/hooks/codegraph-precheck-cursor.js` — Cursor JSON I/O, repoRoot cwd |
| W2 | Wire `preToolUse` in `.cursor/hooks.json` (matcher Write/Edit; timeout ~8s) |
| W3 | Optional `.cursor/hooks/session-end-wrap-reminder.js` + `sessionEnd` (**after ai/2**) |
| W4 | `CURSOR.md` + `session.md` hook inventory table |
| W5 | Smoke: sessionStart still works; Write under artifacts gets context or warn |

### Out of scope
| Item | Owner / reason |
|---|---|
| Editing Claude precheck as “shared” | Different I/O + `/home/runner/workspace` cwd |
| Prompt-type LLM hooks every edit | Cost / non-deterministic |
| `failClosed: true` on codegraph | Blocks Agent mode |
| Auto-run wrap / auto-commit | Dangerous |
| Writing `.agents/context/state.md` | R2 |
| MCP / shell gates | ai/5 / later |
| SubagentStart orchestrator | R1 |

---

## 4. Implementation research pack (for next coding agent)

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Cursor hooks = sessionStart only | `.cursor/hooks.json` — single `sessionStart` → `.cursor/scripts/session-start.js` |
| session-start fail-open | `session-start.js` L12–14 — non-zero / empty → `exit 0` |
| Claude precheck behavior | `.claude/hooks/codegraph-precheck.js` — Read guard &gt;150 lines; Edit/Write inject structural `codegraph context`; strip from `\n### Code`; slice 1200; silent catch |
| Claude cwd hardcode | Same file L51 — `cwd: '/home/runner/workspace'` |
| Claude output schema | `hookSpecificOutput.additionalContext` — **not** Cursor |
| Cursor events available | create-hook skill: `preToolUse`, `sessionEnd`, `stop`, `beforeReadFile`, … |
| Cursor fail-open | Non-zero (≠2) fail-open unless `failClosed: true` |
| ai/4 safety net | `codegraph.mdc` alwaysApply even if hook missing |

### 4.2 Spike result — event map (DONE — do not re-spike)

| Need | Claude | Cursor | Action |
|---|---|---|---|
| Session banner | rehydrate | `sessionStart` | **Keep** |
| Pre-edit codegraph | PreToolUse Edit\|Write | `preToolUse` matcher `Write\|Edit` | **Add** |
| Large Read warn | same Claude script | `beforeReadFile` / Read matcher | **P2 optional** |
| Wrap nag | Stop | `sessionEnd` (prefer over `stop` loops) | **Add after ai/2** |

### 4.3 Files to modify (authoritative)

| Priority | Path | Change (English) |
|---|---|---|
| **P0** | [`.cursor/hooks/codegraph-precheck-cursor.js`](../../hooks/codegraph-precheck-cursor.js) | **New** — see §4.5 algorithm |
| **P0** | [`.cursor/hooks.json`](../../hooks.json) | Add `preToolUse` entry; keep sessionStart |
| **P1** | [`.cursor/hooks/session-end-wrap-reminder.js`](../../hooks/session-end-wrap-reminder.js) | **New** — print reminder only; never run wrap |
| **P1** | `.cursor/hooks.json` | Add `sessionEnd` after ai/2 |
| **P1** | [`CURSOR.md`](../../../CURSOR.md) | Hook inventory: event → script → fail-open |
| **P2** | [`.cursor/context/session.md`](../../context/session.md) | One-liner sync |
| — | `.claude/hooks/codegraph-precheck.js` | **Do not modify** in this task |

### 4.4 Files to read but **not** modify

| Path | Why |
|---|---|
| `.claude/hooks/codegraph-precheck.js` | Behavior reference only |
| `.cursor/scripts/session-start.js` / `rehydrate-cursor.js` | Do not double-inject banner |
| `.cursor/scripts/session-wrap-cursor.js` | Reminder points here; ai/2 owns WARN |
| create-hook skill (agent-local) | Output field cheat sheet |
| ai/2, ai/4, ai/5, ai/9 | Cross-links; no scope steal |

### 4.5 Recommended precheck algorithm (spec — not code)

```
ROOT = path.resolve(__dirname, '../..')   # if script under .cursor/hooks/
Read stdin JSON; parse fail → exit 0

Resolve file path from tool payload (confirm field on first smoke:
  tool_input.file_path | path | … — log once if missing, exit 0)

If path not under artifacts/api-server/src/ OR artifacts/stock-compare/src/ → exit 0

try:
  out = execSync(`codegraph context "<path>"`, { cwd: ROOT, timeout: 5000 })
  structural = strip from "\n### Code"; slice(0, 1200)
  stdout JSON: permission allow + agent_message with [CODEGRAPH:path]…[/CODEGRAPH]
catch:
  exit 0   # fail-open — optional agent_message warn

Never: failClosed, permission deny for missing codegraph, write state.md, call Claude script as child
```

**hooks.json sketch:**

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": ".cursor/scripts/session-start.js" }],
    "preToolUse": [{
      "command": ".cursor/hooks/codegraph-precheck-cursor.js",
      "matcher": "Write|Edit",
      "timeout": 8
    }]
  }
}
```

Start matcher simple; if it never fires in Agent mode, document gap — do not fake success. Prefer `sessionEnd` reminder over `stop` + `loop_limit`.

### 4.6 Acceptance criteria

- [ ] Spike table (§4.2) reflected in CURSOR.md hook inventory
- [ ] Write under `artifacts/*/src/` with codegraph up → structural snippet (or documented equivalent)
- [ ] Codegraph missing/timeout → edit still allowed
- [ ] sessionStart banner still works; no double rehydrate dump
- [ ] sessionEnd reminder (if shipped) does **not** auto-run wrap
- [ ] No `.agents/context/state.md` writes from hooks
- [ ] Claude precheck file unchanged
- [ ] No `artifacts/**` app logic changes

### 4.7 Suggested commit message (when user asks)

`feat(cursor): add fail-open codegraph preToolUse hook`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **ai/2** | Wrap reminder after isolation WARN exists |
| **ai/4** | alwaysApply codegraph remains |
| **ai/5** | Do not expand MCP via hooks |
| **ai/9** | Playbooks cite hook inventory |

---

## 5. Data note
No database. Hooks are local Node scripts.

## 6. Impact & Risk Analysis

- Keep a single sessionStart path — avoid double session injection
- Port the I/O schema carefully; Claude's and Cursor's differ
- Never hardcode the Replit cwd by reusing the Claude file directly — forbidden
- If codegraph is down during a Write, warn rather than lock the hook
- Cap injected context at ≤1200 chars, p95 <2s, no LLM in hooks
- Scoped to `.cursor/hooks.json`, new hook scripts, CURSOR/session docs; rollback to sessionStart-only in <5 min

**Do not:** orchestrator, auto-commit, state.md writes (R1, R2).  
**Floors:** R1, R2, R10.

---

## Review: APPROVE — ready. Cursor-native precheck + optional sessionEnd; fail-open; artifacts-only; never share the Replit cwd script.
