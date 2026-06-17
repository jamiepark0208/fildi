# Cursor Session Context
> Cursor-only — not shared with Claude Code / Kiro. Update at end of each Cursor session.

**Last updated:** 2026-06-17

## Last session summary
- Macro AI highlights overhaul, profile stock picks UI, cursor-state.md split from shared state.md
- cursor-state.md split: wrap syncs Cursor tasks separately from shared state.md
- Macro AI Highlights overhaul (news-first JSON + panel); Profile tab UI (Bullish/Neutral/Bearish picks API, compact TradeCard); session-wrap now writes cursor-YYYY-MM-DD.md
- Merged PR #1 (scorecard guide + admin weights + Watchlist chart S/R zones) to main; git branch/push/conflict resolution; main pulled at 61b6b53
- Cursor bootstrap complete: token-efficiency + codegraph rules/MCP, CURSOR.md entry, sessionStart hook, rehydrate-cursor.js, .cursorignore, removed git user rules, .cursor/context/session.md for Cursor-only continuity

## Active Cursor setup
| Item | Location |
|---|---|
| Entry doc | `CURSOR.md` |
| Rules | `.cursor/rules/cursor.mdc`, `codegraph.mdc`, `token-efficiency.mdc` |
| MCP | `.cursor/mcp.json` → codegraph |
| Hooks | `.cursor/hooks.json` → `sessionStart` → `rehydrate-cursor.js` |
| Ignore | `.cursorignore` |
| Session log | `.cursor/context/session.md` (this file) |
| Cursor task state | `.agents/context/cursor-state.md` (wrap syncs; not shared `state.md`) |
| Shared session file | `.agents/sessions/cursor-YYYY-MM-DD.md` (via wrap script) |
| Wrap script | `node .cursor/scripts/session-wrap-cursor.js "summary"` |

## Notes for next Cursor session
- Reload MCP if codegraph missing (Settings → MCP)
- User handles git manually unless explicitly asked
- `sessionStart` injects this file + `cursor-state.md` + shared `state.md` on new chat
- No orchestrator hook — token-efficiency rule handles prompt/response compression in-agent
- Say "wrap session" before closing

## History
- 2026-06-17 — Macro AI highlights overhaul, profile stock picks UI, cursor-state.md split from shared state.md
- 2026-06-17 — cursor-state.md split: wrap syncs Cursor tasks separately from shared state.md
- 2026-06-17 — Macro AI Highlights overhaul (news-first JSON + panel); Profile tab UI (Bullish/Neutral/Bearish picks API, compact Trade
- 2026-06-17 — Merged PR #1 (scorecard guide + admin weights + Watchlist chart S/R zones) to main; git branch/push/conflict resolution;
- 2026-06-15 — Cursor bootstrap complete: token-efficiency, codegraph, CURSOR.md, session tracking
- 2026-06-15 — Cursor workflow bootstrap (rules, hooks, CURSOR.md, token efficiency)
