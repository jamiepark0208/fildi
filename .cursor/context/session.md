# Cursor Session Context
> Cursor-only — not shared with Claude Code / Kiro. Update at end of each Cursor session.

**Last updated:** 2026-06-15

## Last session summary
- Cursor bootstrap complete: token-efficiency + codegraph rules/MCP, CURSOR.md entry, sessionStart hook, rehydrate-cursor.js, .cursorignore, removed git user rules, .cursor/context/session.md for Cursor-only continuity
- Audited token usage: removed heavy git/PR user rules; added `token-efficiency.mdc`
- Created `.cursorignore`, enabled codegraph MCP (`.cursor/mcp.json`), `codegraph.mdc` rule
- Created `CURSOR.md` + `cursor.mdc` + `sessionStart` hook + `rehydrate-cursor.js`
- Added `session-wrap-cursor.js` + wired rehydrate to read this file on new chat

## Active Cursor setup
| Item | Location |
|---|---|
| Entry doc | `CURSOR.md` |
| Rules | `.cursor/rules/cursor.mdc`, `codegraph.mdc`, `token-efficiency.mdc` |
| MCP | `.cursor/mcp.json` → codegraph |
| Hooks | `.cursor/hooks.json` → `sessionStart` → `rehydrate-cursor.js` |
| Ignore | `.cursorignore` |
| Session log | `.cursor/context/session.md` (this file) |
| Wrap script | `node .cursor/scripts/session-wrap-cursor.js "summary"` |

## Notes for next Cursor session
- Reload MCP if codegraph missing (Settings → MCP)
- User handles git manually unless explicitly asked
- `sessionStart` injects this file + `.agents/context/state.md` on new chat
- No orchestrator hook — token-efficiency rule handles prompt/response compression in-agent
- Say "wrap session" before closing

## History
- 2026-06-15 — Cursor bootstrap complete: token-efficiency, codegraph, CURSOR.md, session tracking
- 2026-06-15 — Cursor workflow bootstrap (rules, hooks, CURSOR.md, token efficiency)
