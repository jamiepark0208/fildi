# TradeDash — Cursor Config
> Cursor only. Full project context in `.agents/`. Session state restored on new chat via `sessionStart` hook.

## STARTUP (every new chat)
1. Context is auto-injected by `.cursor/hooks/session-start.js` (phase, tasks, git, codegraph)
2. If banner missing, run: `node .cursor/scripts/rehydrate-cursor.js`
3. For task-specific code context: **codegraph** MCP → `context` tool (or `codegraph context "<task>"`)

## PROJECT RULES (auto-loaded from `.cursor/rules/`)
| Rule | Purpose |
|---|---|
| `codegraph.mdc` | Codegraph before multi-file reads or refactors |
| `token-efficiency.mdc` | Compress long prompts/responses safely |

Do not duplicate these in chat. Load **one** skill at a time when needed (see below).

## MCP (`.cursor/mcp.json`)
| Server | Use |
|---|---|
| `codegraph` | `context`, `search`, `callers`, `node`, `explore` — before reading source files |

Reload MCP in Cursor Settings if codegraph is missing after clone.

## SESSION CONTEXT
| Scope | Where | What |
|---|---|---|
| **Cursor-only** | `.cursor/context/session.md` | Hooks/rules/MCP changes, Cursor workflow notes |
| **Cursor tasks** | `.agents/context/cursor-state.md` | Working / in-progress / next tasks (Cursor wrap syncs this) |
| **All agents** | `.agents/context/state.md` | Phase, infra, project-wide tasks (Claude `session-wrap.js` — do not edit from Cursor) |
| Architecture | `.agents/context/project.md` | |
| Build/routing | `.agents/context/workflow.md` | |
| Session history | `.agents/sessions/INDEX.md` | Cursor: `cursor-YYYY-MM-DD.md` · Claude: `YYYY-MM-DD.md` |

New chat reads `session.md`, `cursor-state.md`, and shared `state.md` via `sessionStart` hook.

## END OF SESSION
1. `node .cursor/scripts/session-wrap-cursor.js "what we did"` — updates `session.md`, syncs `cursor-state.md`, appends `.agents/sessions/cursor-YYYY-MM-DD.md`
2. Optional flags: `--working "a,b"`, `--progress "c"`, `--next "task one,task two"`
3. Do **not** edit `.agents/context/state.md` from Cursor — that file is owned by Claude Code session-wrap

## SKILLS (load one at a time — never all at once)
Same files as Claude Code — read `.claude/skills/<name>.md` when relevant:

| Need | Skill |
|---|---|
| Build + restart server | `build-and-run.md` |
| Data fetch and cache | `data-architecture.md` |
| Options chain fetch | `options-pricer.md` |
| RSI/MFI/filter logic | `signal-filters.md` |
| UI components | `ui-components.md` |
| DB schema and queries | `db-patterns.md` |
| Trader strategy/scoring | `trader-context.md` |
| Technical scorecard | `technical-scorecard.md` |
| Feature planning | `feature-planner.md` |
| Debugging | `systematic-debugging.md` |

## CODEGRAPH
Before touching source files:
- MCP: `context` with your task description
- CLI: `codegraph context "<task>"` · `codegraph impact <symbol>` · `codegraph sync` after bulk edits

## CURSOR vs CLAUDE
| | Cursor | Claude Code |
|---|---|---|
| Entry | `CURSOR.md` + `.cursor/rules/` | `CLAUDE.md` + `.claude/settings.local.json` |
| Hooks | `.cursor/hooks.json` | `.claude/settings.local.json` |
| Ephemeral state | `.cursor/state.json` (local) | `.claude/state.json` (local) |
| Cross-agent state | `.agents/` (git) | `.agents/` (git) |
