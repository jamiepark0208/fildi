# Cursor Session Context
> Cursor-only — not shared with Claude Code / Kiro. Update at end of each Cursor session.

**Last updated:** 2026-06-24

## Last session summary
- Fundamental sector-relative scoring: canonical plan in `.cursor/context/plans/fundamental-sector-scoring.md` (APPENDIX I = current prod scoring)
- Decisions: ~558 Robinhood tickers pre-seeded; watchlist irrelevant; pre-compute fund_score; unify duplicate scorers
- Cursor handoff split: `cursor-state.md` (write) vs `state.md` (read-only) to avoid merge conflicts

## Active Cursor setup
| Item | Location |
|---|---|
| Entry doc | `CURSOR.md` |
| Rules | `.cursor/rules/cursor.mdc`, `codegraph.mdc`, `token-efficiency.mdc` |
| MCP | `.cursor/mcp.json` → codegraph |
| Hooks | `.cursor/hooks.json` → `sessionStart` → `rehydrate-cursor.js` |
| Ignore | `.cursorignore` |
| Session log | `.cursor/context/session.md` (this file) |
| Cursor state | `.cursor/context/cursor-state.md` (phase, tasks — Cursor writes here only) |
| Wrap script | `node .cursor/scripts/session-wrap-cursor.js "summary"` |

## Notes for next Cursor session
- Reload MCP if codegraph missing (Settings → MCP)
- User handles git manually unless explicitly asked
- `sessionStart` injects `session.md` + `cursor-state.md`; read `.agents/context/state.md` but **never edit it**
- No orchestrator hook — token-efficiency rule handles prompt/response compression in-agent
- Say "wrap session" before closing

## History
- 2026-06-24 — Sector scoring plan committed; APPENDIX I current-state baseline; cursor-state handoff (no state.md writes)
- 2026-06-24 — Fundamental sector-relative scoring planned: Robinhood JSON→DB peer groups, not watchlist; handoff .agents/tasks/2026-06
- 2026-06-19 — Session wrap: resolved state.md rebase conflict; watchlist-stock-analysis shipped (Competitors 50/50 tech+fund, catalyst
- 2026-06-18 — Watchlist stock analysis: Competitors (50/50 tech+fund, DB-first peers), Event Risk/Catalysts, overview fix
- 2026-06-18 — Profile bucket ticker autocomplete + Scorecard Guide UI refresh (badges, shadcn tables, larger text)
- 2026-06-17 — Merged PR #1 (scorecard guide + admin weights + Watchlist chart S/R zones) to main; git branch/push/conflict resolution;
- 2026-06-15 — Cursor bootstrap complete: token-efficiency, codegraph, CURSOR.md, session tracking
- 2026-06-15 — Cursor workflow bootstrap (rules, hooks, CURSOR.md, token efficiency)
