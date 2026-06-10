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
TradeDash — institutional-grade put-selling research tool.

Architecture:
- Frontend: React/Tailwind SPA on port 8081 (artifacts/stock-compare)
- Backend: Node/Express API on port 8080 (artifacts/api-server)
- DB: PostgreSQL via Drizzle ORM (lib/db)

Two independent scoring layers (both self-relative, peer-set invariant):
- Fundamental scorer (computeRankingsV2): 4 families (Value 20%, Growth 25%, Quality 35%, Safety 20%), FMP data source, weekly refresh, tickerFundamentals DB table
- Technical scorer (computeTechnicalRankingsV2): 6 components (oversoldDepth 25%, reversalSignal 20%, volatilityState 22%, trendContext 18%, optionsFlow 10%, volumeConfirm 5%), Yahoo OHLCV, daily refresh, tickerTechnicals DB table

Options scanner: combines both scores + options chain data to surface put candidates by premium/strike ratio, signal, and combined score.
Watchlist: 31 tickers across 3 tiers. Tags: blue (holding/assigned), green (long conviction), yellow (moderate/income), purple (market context).
Data sources: FMP (fundamentals, weekly), Yahoo chart() (OHLCV, daily), Yahoo options() (chain, 10min cache), FRED (macro, 4h cache), Treasury.gov (yield curve).

## STATE
phase: build
working: [options-comparison-table]
in-progress: none
completed: [scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix, fundamental-scorer-v2, fmp-phase1, fmp-phase2-helpers, fmp-phase3-scorer, fmp-phase4-verify, fmp-phase5-cleanup, technical-scorer-v2-phase1, technical-scorer-v2-phase2, technical-scorer-v2-phase3, technical-scorer-v2-phase4, technical-scorer-v2-phase5]
next: [options-comparison-table, strike-explorer-slider, fundamental-improvements, macro-data-live-feed]

## ROADMAP
Living task file: FILDI_ROADMAP.md (root of repo — create if not present)
Read before starting any new feature to understand what is pending, what is known-broken, and what the architectural decisions are.

## TECHNICAL SCORER V2 — COMPLETE (all 5 phases done 2026-06-09)
Full phase report: .claude/docs/phase-report-technical.md
Architecture: self-relative, invariant to peer set
DB: tickerTechnicals (55 cols), refreshed daily, GET /api/technicals/all
Scorer: computeTechnicalRankingsV2 in technical-rankings.ts (alongside V1)
OHLCV window: 420 calendar days (≈300 trading days), supports MA200
UI: technical.tsx + options-scanner.tsx wired to V2; home.tsx BUG-01 fixed
Known remaining items:
  - ivRank/ivPercentile: still use realized vol as IV proxy (upgrade when ~60d of atmPutIv history accumulates)
  - putCallVolumeRatio/basicSkew: absolute mapping (upgrade to percentileRank when ~60d history accumulates)
  - Remove computeTechnicalRankings (V1) after one release
  - scorecard-explanation.tsx: still shows V1 metrics — update in next UI pass

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
Last: 2026-06-10

### Technical Scorer V2 (2026-06-09) — COMPLETE
Full report: `.claude/docs/phase-report-technical.md`
Self-relative V2. DB: tickerTechnicals (55 cols). Scorer: computeTechnicalRankingsV2. Tests: 181 passing.
UI: technical.tsx + options-scanner.tsx wired to V2. home.tsx BUG-01 fixed.
Known items: ivRank still uses realized vol proxy; V1 removal pending; scorecard-explanation.tsx still shows V1 metrics.

### FMP + WACC/Safety Metrics (2026-06-09) — COMPLETE
Full report: `.claude/docs/phase-report.md`
FMP stable endpoints replace Yahoo. 6 new metrics (5 Safety + ROIC-WACC spread). Budget guard: 220 calls/day (fmp_api_usage table).
FINANCIAL_TICKERS = {HOOD, SOFI} excluded from roicWaccSpread. api-client-react dist/ must rebuild after StockMetrics changes.

### Fundamental Scorer V2 (2026-06-08) — COMPLETE
V2 scorer: 4 families, 13 metrics, whole-universe z-score normalization.
Key design: PEG clamp (no negative EPS), base-effect growth guard, null renormalization per family.
Added: rankings-helpers.ts (pure math), computeRankingsV2 in rankings.ts (V1 untouched, backward-compat).

### AI Score Explanations + Options Scanner Persistence (2026-06-10) — COMPLETE
New: POST /api/explain/score (artifacts/api-server/src/routes/explain.ts) — Haiku, 200 tokens, no storage.
Frontend: "Explain ▾" button in both Rankings Leaderboard (rankings-leaderboard.tsx) and Technical Leaderboard (technical.tsx); session-cached per ticker.
Options Scanner: extraTickers + hiddenTickers now persisted to localStorage (fildi_scanner_extra, fildi_scanner_hidden) — survive tab close.
CLAUDE.md: cleaned (273→157 lines), SESSION LOG archived to .claude/docs/session-history.md, ui-components.md stub created.

Older sessions (pre-2026-06-08): archived → `.claude/docs/session-history.md`

## NEXT SESSION
1. User management system — design pending (brainstorm interrupted; independent watchlists per user, session auth, admin-only refresh)
2. POST /api/fundamentals/refresh — populate remaining 23 FMP tickers (check budget first: GET /api/fundamentals/status)
3. Options comparison table + strike explorer slider

Technicals stale check (auto on startup). Force-refresh: `curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true`

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

## SKILL AUTO-TRIGGER RULES
When about to work on any of these areas, load the relevant skill BEFORE reading any code:
- Options chain, strike selection, income%  → .claude/skills/options-pricer.md
- RSI, MFI, RM filter, tier thresholds      → .claude/skills/signal-filters.md
- Any UI component or new page              → .claude/skills/ui-components.md
- Any new feature (planning phase)          → .claude/skills/feature-planner.md
- Data fetching, caching, refresh logic     → .claude/skills/data-architecture.md
- DB schema or migration                    → .claude/skills/db-patterns.md
- Trader strategy, scoring, ranking         → .claude/skills/trader-context.md
- Technical scorecard UI or signals         → .claude/skills/technical-scorecard.md
- Server build or 502 errors               → .claude/skills/build-and-run.md
- End of session                           → .claude/skills/session-wrap.md

## HOOKS LOCATION
All hooks are defined in .claude/settings.local.json under the "hooks" key.
Never create or modify .claude/hooks/hooks.json — that file is not read.
To add a new hook: edit .claude/settings.local.json directly.
