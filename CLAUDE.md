# TradeDash — Claude Code Config
> Pointers only. Full context in skills. Rehydrate runs on every session start.

## STARTUP (every session)
Run: node .claude/scripts/rehydrate.js
First time only: tell Claude "read .claude/skills/replit-setup.md and follow the steps"

## SKILLS INDEX (load one at a time — never all at once)
| Need | Skill |
|---|---|
| **Build + restart server** | **.claude/skills/build-and-run.md** |
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
working: [scorecard-improvements, portfolio-overhaul, daily-brief-ai]
in_progress: []
next: [options-comparison-table, strike-explorer-slider]

## CODEGRAPH (use at start of every task)
  codegraph sync                        — update index
  codegraph context "<task>"            — get relevant files/symbols before touching anything
  codegraph impact <symbol>             — check what breaks before changing a function
  codegraph callers <symbol>            — find all usages before refactoring
  codegraph affected [files]            — which tests need to run after a change

Never read source files to understand structure — use codegraph context first.

## READING RULES (always follow)
- Never use Explore agents for broad sweeps
- Read files directly and only when needed
- Before reading a file, state the name and reason
- Max 5 files per task without explicit approval
- Use find/grep to locate files before reading them

## SESSION LOG
Last completed (2026-06-02): Daily brief overhaul, watchlist→breakdown integration, build skill

### Daily Brief overhaul
- **On-demand only** — removed auto-fetch on mount; brief only generates when user clicks "Generate Today's Brief"
- **File-backed history** — `brief-history.json` stores up to 90 briefs; survives server restarts
- New `GET /api/daily-brief/market` — fetches live prices for 9 instruments with no AI; called on every page load so chips are always fresh
- `GET /api/daily-brief` (no `?refresh`) — returns today's stored brief from history or `{noData:true}`; zero AI cost
- `GET /api/daily-brief?refresh=true` — regenerates, saves/overwrites today's entry in history
- `GET /api/daily-brief/history` — returns full history array sorted newest-first
- **Minimizable Highlights** — collapse button (chevron) shows market chips + first bullet from Portfolio Implications as "Key takeaway"; expand shows full 5-section brief
- **Past Briefs tab** — "Past Briefs" tab fetches history; click any date to expand that day's brief + historical chips inline

### Watchlist → Stock Breakdown integration
- Clicking a watchlist ticker now renders full `StockBreakdown` (snowflake, valuation grid, analyst donut, news) in right panel
- `StockBreakdown` accepts optional `ticker` prop — when set, hides search bar and drives ticker from parent
- "Stock Breakdown" removed from sidebar nav (route `/breakdown` still exists by URL)
- Removed dead query hooks (`useGetStockQuote`, `useGetStockHistory`) from `WatchlistView` detail panel

### Build skill
- New `.claude/skills/build-and-run.md` — covers check-running, rebuild one-liner, failure mode table, routing rules
- Root cause of 502 errors: API server process dies between sessions and must be manually restarted
- CLAUDE.md updated with skill index entry (bolded) and exact rebuild one-liner in backend build rule

### Previous sessions (2026-06-02)
- Scorecard: negative P/E fix, `reason` field, technical-rankings.ts, scorecard-explanation page
- Portfolio: named portfolios (IRA/FILDI/MOM), per-portfolio cards, covered call detection, risk metrics
- AI Daily Brief (v1): initial implementation with in-memory cache

## NEXT SESSION — do these in order
1. Options comparison table (per-ticker: nearest expiry, best strike, income%, IV)
2. Strike explorer slider (filter puts by OTM%, show premium/strike ratio)

## BACKEND BUILD RULE (critical — causes 502s if skipped)
After ANY change to api-server/src/**, run the one-liner from build-and-run.md:
  pkill -f "api-server/dist/index" 2>/dev/null; sleep 0.3 && cd /home/runner/workspace/artifacts/api-server && node build.mjs && PORT=8080 node --enable-source-maps /home/runner/workspace/artifacts/api-server/dist/index.mjs >> /tmp/api-server.log 2>&1 & sleep 2 && curl -s "http://localhost:8080/api/daily-brief" | head -c 60
The server does NOT hot-reload. Forgetting this = 502 or 404 on all API calls.
See .claude/skills/build-and-run.md for diagnosis and all failure modes.

## RATE LIMIT RULES
- Max 3 bash tool calls per response
- After a build command: wait for output before next call
- Never chain more than 2 curl/test commands back to back
- If 429 error appears: stop, wait 60s, resume with single tool call

## ROUTING RULES (never repeat this bug)
- Route files define paths WITHOUT /api prefix (e.g. /indicators/:ticker)
- The router is mounted at /api in index.ts — prefix is added there only
- Vite proxy must have "/api" entry pointing to http://localhost:8080
- Check both of these whenever adding a new route file

## DEBUGGING RULES (follow strictly)
- When something is broken: codegraph context "<broken feature>" FIRST
- State the exact error or symptom before reading any file
- Read maximum 2 files before attempting a fix
- Fix one thing, verify it works, then move to next
- Never refactor while debugging — fix only
- If broken for >30min: stop, describe symptoms here, start fresh
