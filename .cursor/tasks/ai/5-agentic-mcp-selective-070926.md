# agentic-mcp-selective

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | infra |
| **Effort** | S (~20–40 min — **docs-only**; optional wrap WARN with ai/2) |
| **Created** | 2026-07-09 |
| **Source** | agentic-workflow-research |
| **Research** | [agentic-workflow-research](1-agentic-workflow-research-070926.md) — floors **R1**, **R6**, **R7** |
| **Type** | ENHANCE (policy) |
| **Impl research** | 2026-07-09 deep pass (ai/2-quality) — **no app code**; **do not edit mcp.json** unless someone already added servers |
| **Related** | [ai/2](2-agentic-safety-context-isolation-070926.md) wrap / CURSOR PR · [ai/1](1-agentic-workflow-research-070926.md) R6/R7 · [ai/4](4-agentic-scoped-rules-trim-070926.md) token budget · L-01 Redis infra lesson |

### Purpose
Keep the **project** MCP surface at **one server (codegraph)** by default, and write an explicit **default-deny + exception** policy so agents/humans don’t bolt on memory/DB/SaaS MCPs that burn tokens and widen exfil surface.

### Cache / DB compliance
None. **No Redis MCP / agent-memory MCP** (R6). Product Redis (enhancements/29) is unrelated and still P3.

---

## 1. Executive summary (rescoped)

**Runtime already correct.** `.cursor/mcp.json` has a single `codegraph` entry. **Do not** “implement MCP” or add servers.

**Real gap:** `CURSOR.md` MCP section only lists what codegraph can do — it lacks:
1. Default-deny policy (prefer zero *new* servers)
2. Do-not-add list (concrete banned categories)
3. Exception checklist (when a new server is allowed)
4. Distinction: **project** `mcp.json` vs **IDE-provided** tools (e.g. browser) vs **user global** Cursor MCP settings vs **Kiro** empty mcp

**Optional enforcement:** when coding **ai/2** wrap, WARN if project `mcp.json` parses to `Object.keys(mcpServers).length !== 1` or key ≠ `codegraph` — owned as P1 here / implemented in ai/2 script.

---

## 2. Why (requirements)

| Requirement | Source | Notes |
|---|---|---|
| Prefer zero new MCP | Research **R7**; ai/1 inventory | codegraph stays primary |
| No Redis/agent memory MCP | **R6**; L-01 infra audit | Separate from eng Redis task |
| Token cost of tool schemas | **R1** | Each MCP dumps schemas into context |
| Exfil / secret surface | ai/2 isolation story | DB dumps, vaults, Slack = risk |
| Browser for UI verify | Product need | IDE browser ≠ project mcp.json; **only when user asks** |
| Prefer CLI / existing APIs | Engineering norm | `gh`, codegraph CLI, app APIs before new MCP |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Expand `CURSOR.md` → **MCP** section with current state + policy (below) |
| W2 | Do-not-add list (banned categories) |
| W3 | Exception checklist (4 questions) |
| W4 | Clarify project vs IDE vs user-global vs `.kiro/settings/mcp.json` |
| W5 | Cross-link ai/2: optional wrap WARN for server count ≠ 1 |

### Out of scope
| Item | Reason |
|---|---|
| Changing `.cursor/mcp.json` | Already correct — leave alone |
| Adding Notion / Slack / Linear / DB MCP | Explicitly rejected |
| Redis agent-memory MCP | R6 |
| Removing codegraph | Required |
| Configuring Kiro MCP | Different product (`.kiro/settings/mcp.json` is **empty** today) |
| Forcing user to disable IDE browser MCP globally | Document usage policy only |
| App / artifacts code | Never |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

**Project Cursor MCP** — [`.cursor/mcp.json`](../../mcp.json):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Server count = **1**. Name = `codegraph`.

**CURSOR.md today** (thin — keep tool list, add policy after):

```markdown
## MCP (`.cursor/mcp.json`)
| Server | Use |
| codegraph | context, search, callers, node, explore |
Reload MCP in Cursor Settings if codegraph is missing after clone.
```

**Other configs:**
| Location | State | Relevance |
|---|---|---|
| `.cursor/mcp.json` | codegraph only | **This task’s SSOT** |
| `.kiro/settings/mcp.json` | `mcpServers: {}` | Do not manage here; note “Kiro separate” |
| IDE browser / app-control MCPs | Provided by Cursor IDE, not in project file | Use when user asks UI verify — not “add to mcp.json” |
| User global Cursor MCP | Can shadow/add servers outside repo | Document: check Settings → MCP if mystery tools appear |

**Wrap today:** `session-wrap-cursor.js` does **not** read mcp.json (ai/2 may add WARN).

**Floors:** ai/1 **R6** (no Redis agent memory), **R7** (default zero new MCP).

### 4.2 Target CURSOR.md MCP section (implementer paste/adapt)

Keep existing codegraph table, then add:

```markdown
### Policy (default-deny)

- **Project allowlist:** exactly one server — `codegraph` in `.cursor/mcp.json`.
- **Prefer:** codegraph CLI / MCP tools you already have; `gh`; existing TradeDash APIs. Do **not** add an MCP because it’s convenient.
- **Do not add** (without explicit user approval + checklist below):
  - “Memory” / vector / Redis / session-brain MCPs
  - Generic DB / Postgres dump MCPs
  - Secrets vault / password managers as agent tools
  - Slack / Notion / Linear / Drive “connect everything” MCPs
  - Second code-intel MCP that duplicates codegraph
- **IDE browser MCP:** not configured in project `mcp.json`. Use only when the user asks to verify UI; never as a default research loop.
- **User global MCP:** if unexpected tools appear, check Cursor Settings → MCP (may be outside this repo).
- **Kiro:** `.kiro/settings/mcp.json` is separate — do not “fix” Cursor by editing Kiro.

### Exception checklist (all must be yes)

1. **Need:** User explicitly requested this capability for TradeDash work.
2. **Alternative:** CLI, existing API, or codegraph cannot do it reasonably.
3. **Token cost:** Tool schema + likely call volume acceptable (estimate).
4. **Auth / exfil:** No secrets in prompts; least privilege; no full-DB dump tools.

If approved: add to `.cursor/mcp.json`, document in CURSOR.md table same PR, note in session.md.
```

### 4.3 Files to modify (authoritative)

| Pri | Path | Change (English) |
|---|---|---|
| **P0** | [`CURSOR.md`](../../../CURSOR.md) | Expand MCP section per §4.2; keep codegraph row |
| **P1** | [`.cursor/scripts/session-wrap-cursor.js`](../../scripts/session-wrap-cursor.js) | **Prefer implement under ai/2:** after isolation check, `JSON.parse` mcp.json; if keys.length ≠ 1 or sole key ≠ `codegraph`, `console.warn('MCP WARN: …')` — fail-open |
| **P1** | Same CURSOR.md PR as [ai/2](2-agentic-safety-context-isolation-070926.md) / [ai/4](4-agentic-scoped-rules-trim-070926.md) | Avoid thrashing CURSOR.md |
| — | [`.cursor/mcp.json`](../../mcp.json) | **No change** |
| — | `.kiro/settings/mcp.json` | **No change** |

### 4.4 Optional wrap algorithm (if bundled with ai/2)

```
MCP_JSON = .cursor/mcp.json
try parse
  keys = Object.keys(mcpServers || {})
  if keys.length !== 1 || keys[0] !== 'codegraph':
    warn: project MCP allowlist violated — expected only codegraph
catch: warn parse failed / missing file
exit 0 always
```

### 4.5 Files to read, not modify

| Path | Why |
|---|---|
| `.cursor/mcp.json` | Confirm still 1× codegraph before/after |
| `ai/1` R6/R7 + do-not-build | Floors |
| `ai/2` | Owns wrap; cross-link only |
| L-01 in lessons.md | Redis/infra — reinforce no memory MCP |

### 4.6 Acceptance criteria

- [ ] CURSOR.md has default-deny, do-not-add list, exception checklist, IDE/global/Kiro notes
- [ ] `jq '.mcpServers \| keys' .cursor/mcp.json` → `["codegraph"]` (or equivalent)
- [ ] No new servers added by this task
- [ ] If wrap WARN implemented: dirty multi-server mcp.json prints MCP WARN; clean tree silent
- [ ] No `artifacts/**` changes

### 4.7 Suggested commit message

`docs(cursor): MCP default-deny policy (codegraph-only allowlist)`

### 4.8 Effort reality

**Docs-only S** if wrap WARN deferred to ai/2. Do not expand into installing new MCPs “for completeness.”

---

## 5. Data / database note

No DB. “Memory MCP” and “DB dump MCP” are explicitly **banned** categories — not features to build.

---

## 6. Dependencies

| Dep | Relation |
|---|---|
| ai/1 | R6/R7 |
| ai/2 | CURSOR PR + optional wrap WARN implementation home |
| ai/4 | Shared token discipline |
| enhancements/29 redis | Unrelated product cache — still not an MCP |

---

## 10. Verification

| Check | Pass |
|---|---|
| mcp.json keys | Only `codegraph` |
| CURSOR policy | Deny list + checklist present |
| Browser note | IDE ≠ project file |
| Wrap (if done) | WARN on ≠1 server |

```bash
cat .cursor/mcp.json
rg -n "default-deny|Do not add|Exception checklist" CURSOR.md
```

---

## Impact & Risk Analysis

- Policy must still allow browser MCP when the user explicitly asks for UI verification — don't over-deny
- False WARN risk if mcp.json gets reformatted with extra metadata — keep the check limited to `mcpServers` keys only
- Editing Kiro's mcp config "to match Cursor" is out of scope — document the separation instead
- Scoped to CURSOR.md (+ optional wrap script via ai/2); hard preference to stay at 1 server (codegraph)

**Do not:** memory/Redis/DB-dump/SaaS MCPs; remove codegraph; dual code-intel MCP (R1, R6, R7).  
**Floors:** R1, R6, R7, R10.

---

## Review: deep pass confirms policy docs are the deliverable; mcp.json is already compliant. Bundle CURSOR.md with ai/2/ai/4. Optional enforcement lives in ai/2 wrap.
