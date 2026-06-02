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
Last completed (2026-06-02): Major portfolio overhaul + AI daily brief + scorecard improvements

### Scorecard improvements
- Fixed negative P/E bug — OPEN's -468 PE no longer highlighted as "best value"
- Added `reason` field to `StockScore` — leaderboard shows data-driven explanation per stock
- New `technical-rankings.ts` — 8-metric technical scoring for the Technical tab (RSI, MFI, MACD, signal, etc.)
- Technical tab now shows rank chips, score bars, leaderboard, and metrics comparison table
- New `/scorecard-explanation` page — explains both scoring systems, metric weights, edge cases
- Added "Scorecard Guide" nav link in sidebar (General section, above Settings)

### Portfolio overhaul
- `PortfolioEntry` gains `portfolioName` field; `entryPortfolio()` helper falls back to legacy `notes` field
- `usePortfolio()` now manages a separate `portfolioNames` list (persisted to `fildi_portfolio_names_v1`)
- Default portfolios: IRA, FILDI, MOM (auto-created on first load)
- Per-portfolio boxes: each named portfolio gets its own collapsible card with sortable columns
- "Add Portfolio" button creates new portfolio boxes; "Add Position" per-box pre-selects that portfolio
- Position dialog: "Notes" field replaced with a "Portfolio" dropdown (select only, not free text)
- Legacy entries using `notes: "IRA"` still group correctly via `entryPortfolio()` fallback
- Columns fully sortable (ticker, type, qty, strike, value, pnl) with asc/desc toggle
- "shares" and "contracts" spelled out in full
- `cashCollateral()` = strike × 100 × qty for short puts — included in Total Portfolio Value
- Portfolio analysis component: allocation donut, sector donut, beta bar, DTE histogram, risk stats
- Covered call detection: when stock + short_call exist for same ticker, beta adjusted by δ×0.70
- New risk metrics: net portfolio delta (approx), annualized income yield, at-risk puts table
- Short Put Position Health table: strike, premium, break-even, current price, OTM%, Safe/Watch/At Risk

### AI Daily Brief
- New backend route `GET /api/daily-brief` — fetches VIX, SPY, QQQ, TNX, ES=F, NQ=F, GLD, UUP, TLT
- Pulls recent news headlines per ticker via Yahoo Finance search
- Calls Claude Haiku with market data + news + persistent context → structured 5-section brief
- 6-hour in-memory cache keyed by date + tickers
- `GET /api/daily-brief/context` — read persistent learning context
- `PATCH /api/daily-brief/context` — update context (clears cache automatically)
- `brief-context.json` on server: strategy, portfolios, macroFocus, watchSignals, riskRules, userNotes
- Frontend `DailyBrief` component: market chips row (9 instruments), AI brief sections, gear icon → inline context editor
- Added `@anthropic-ai/sdk` to api-server dependencies

## NEXT SESSION — do these in order
1. Options comparison table (per-ticker: nearest expiry, best strike, income%, IV)
2. Strike explorer slider (filter puts by OTM%, show premium/strike ratio)

## BACKEND BUILD RULE (critical — burned us this session)
After ANY change to api-server/src/**:
  cd artifacts/api-server && node build.mjs
Then restart the server process (it runs from dist/index.mjs, not live TypeScript).
The server does NOT hot-reload. Forgetting this causes 404s on new routes.

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
