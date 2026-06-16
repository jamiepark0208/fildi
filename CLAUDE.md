# TradeDash — Claude Code Config
> Claude Code only. Full project context in .agents/. State restored on every prompt via rehydrate hook.

## STARTUP (every session)
Run: node .claude/scripts/rehydrate.js
First time only: read .claude/skills/replit-setup.md and follow the steps

## SKILLS (load one at a time — never all at once)
| Need | Skill |
|---|---|
| Build + restart server | .claude/skills/build-and-run.md |
| Data fetch and cache | .claude/skills/data-architecture.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| RSI/MFI/filter logic | .claude/skills/signal-filters.md |
| UI components | .claude/skills/ui-components.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| Trader strategy/scoring | .claude/skills/trader-context.md |
| Technical scorecard | .claude/skills/technical-scorecard.md |
| Feature planning | .claude/skills/feature-planner.md |
| Implementation planning | .claude/skills/writing-plans.md |
| Debugging any bug/failure | .claude/skills/systematic-debugging.md |
| End of session | .claude/skills/session-wrap.md |

## AGENTS
verifier = tsc + lint + tests | data-agent = fetch/cache | ui-agent = React components
Full catalog: .agents/AGENTS.md

## CODEGRAPH
Use before touching any source file. codegraph auto-runs on Edit/Write via hook.
- codegraph context "<task>" — symbols + callers before any edit
- codegraph impact <symbol> — what breaks before changing a function

**Fallback chain (in order — do NOT skip steps):**
1. codegraph tools first (codegraph_context, codegraph_node, codegraph_search)
2. If codegraph unavailable/returns nothing → grep/find for the specific symbol or pattern
3. If grep is insufficient → ASK THE USER before reading any file >100 lines
Never read large files (options-scanner.tsx, technical-rankings.ts, technicals-db.ts, etc.) without explicit user approval.

## HOOKS
Defined in .claude/settings.local.json — never in .claude/hooks/hooks.json (not read).
