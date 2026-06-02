# TradeDash — Claude Code Config
> Pointers only. Full context in skills. Rehydrate runs on every session start.

## STARTUP (every session)
Run: node .claude/scripts/rehydrate.js
First time only: tell Claude "read .claude/skills/replit-setup.md and follow the steps"

## SKILLS INDEX (load one at a time — never all at once)
| Need | Skill |
|---|---|
| First-time setup | .claude/skills/replit-setup.md |
| Feature planning | .claude/skills/feature-planner.md |
| Data fetch and cache | .claude/skills/data-architecture.md |
| Options chain fetch | .claude/skills/options-pricer.md |
| RSI/MFI/filter logic | .claude/skills/signal-filters.md |
| UI components | .claude/skills/ui-components.md |
| DB schema and queries | .claude/skills/db-patterns.md |
| End of session | .claude/skills/session-wrap.md |

## MODEL ROUTING
haiku  = data fetching, cache boilerplate, scaffolding, verifier
sonnet = UI, filter logic, API design, debugging (default)
opus   = /opus flag only, architecture rewrites

## AGENTS
verifier   = tsc + lint + tests after every feature (.claude/agents/verifier.md)
data-agent = yfinance + Redis work (.claude/agents/data-agent.md)
ui-agent   = React components (.claude/agents/ui-agent.md)

## APP SUMMARY
Sell weekly OTM puts on 31 watchlisted stocks (3 tiers) when RSI < per-ticker threshold AND MFI < 25.
App: signal status per ticker, narrow options chain slice finding put strike where premium/strike >= 0.8-1%/week, RM filter result, execution log.
Phase 2: social 1%/week challenge.

## STATE
phase: scaffold
working: []
in_progress: []
next: [data-layer, watchlist-ui]

## READING RULES (always follow)
- Never use Explore agents for broad sweeps
- Read files directly and only when needed
- Before reading a file, state the name and reason
- Max 5 files per task without explicit approval
- Use find/grep to locate files before reading them

## SESSION LOG
Last completed: hooks wired, alpha vantage dropped, DB schema written (5 tables)
Data source decision: yahoo-finance2 + technicalindicators (no external API keys needed)

## NEXT SESSION — do these in order
1. Fix TS error in stocks.ts:381 (type assertion on yahooFinance.search())
2. Install technicalindicators, add RSI/MFI endpoints to API server
3. Options chain fetch via yf2.options() using narrow slice from options-pricer.md

## RATE LIMIT RULES
- Max 3 bash tool calls per response
- After a build command: wait for output before next call
- Never chain more than 2 curl/test commands back to back
- If 429 error appears: stop, wait 60s, resume with single tool call
