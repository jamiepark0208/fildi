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
phase: build
working: [options-comparison-table]
in-progress: none
completed: [scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix, fundamental-scorer-v2, fmp-phase1, fmp-phase2-helpers, fmp-phase3-scorer, fmp-phase4-verify, fmp-phase5-cleanup, technical-scorer-v2-phase1, technical-scorer-v2-phase2, technical-scorer-v2-phase3, technical-scorer-v2-phase4, technical-scorer-v2-phase5]
next: [options-comparison-table, strike-explorer-slider, fundamental-improvements, macro-data-live-feed]

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
Last completed (2026-06-09): Technical Scorer V2 — all 5 phases complete

### Technical Scorer V2 (2026-06-09)
Full phase report: `.claude/docs/phase-report-technical.md`

**New backend files:**
- `artifacts/api-server/src/lib/technicals-db.ts` — OHLCV computation + options fetch + DB helpers; computes 55-column `tickerTechnicals` row per ticker
- `artifacts/api-server/src/routes/technicals.ts` — POST /api/technicals/refresh, GET /api/technicals/status, GET /api/technicals/all

**DB:** `tickerTechnicals` table (lib/db/src/schema/index.ts). One row per ticker. Refreshed daily on startup (23h staleness). 31/31 at 100% coverage.

**OHLCV:** `cutoffStr()` extended from 290 → 420 calendar days (≈300 trading days) to support MA200 + percentile history.

**Scorer (`artifacts/stock-compare/src/lib/technical-rankings.ts`):**
- `computeTechnicalRankingsV2(rows: TechnicalRow[], tierMap?)` → `TechnicalScore[]`
- Self-relative: every component from own DB row only. INVARIANT to peer set.
- 6 components: oversoldDepth(0.25), reversalSignal(0.20), volatilityState(0.22), trendContext(0.18), optionsFlow(0.10), volumeConfirm(0.05)
- Gate: GO/WATCH/NO from rsi14Pct, mfi14Pct, macdDirection, rsiVelocity, fallingKnife, earningsDaysOut. BEARISH regime NEVER blocks GO.
- Helper functions: `percentileRank`, `zScoreVsHistory`, `macdTurnDirection`, `regimeFromPrice`, `fallingKnifeDetect`, `realizedVolatility`, `swingHighLow`, `vwap` in rankings-helpers.ts

**UI wired:**
- `technical.tsx`: fetches `/api/technicals/all`, computes V2 on all 31, signal badge uses `ts?.signal ?? d.signal`
- `options-scanner.tsx`: fetches `/api/technicals/all`, GO filter and signal sort use V2 rankings
- `home.tsx` BUG-01: background watchlistQueries for all 31 so fundamental z-score normalization is stable

**Tests:** 181 passing (0 failures). Includes invariance tests.

**Key Phase 4 results:** MRVL V1#1→V2#29 (RSI pct=82%, overbought), GOOGL V1#13→V2#2 (RSI pct=10%, very oversold), NFLX #1 with BEARISH regime + GO signal, RUM #23 (was near #1 in V1).

Last completed (2026-06-03): Macro tab, scorecard startup fix, indicators overhaul

### Macro tab (2026-06-03)
- New page `/macro` with Globe icon in sidebar nav under Analysis
- **Backend** `artifacts/api-server/src/lib/macro-data.ts` — fetches 11 FRED CSV series (no API key needed) + Yahoo Finance for VIX/yields; 4h file cache at `macro-data.json`
- **Routes** `artifacts/api-server/src/routes/macro.ts` — mounted at `/api/macro`; endpoints: `/data`, `/refresh`, `/fed-members`, `/events`, `/highlights` (GET + POST generate via Claude Haiku)
- **Fed members** — 17 FOMC members (10 voting, 7 non-voting) hardcoded with hawkish/neutral/dovish stance + context notes
- **Events calendar** — 16 upcoming events Jun–Jul 2026; filtered to future dates on request
- **AI Highlights** — user-triggered via "Generate" button; Haiku model; stored in `macro-highlights.json`; survives restarts
- **UI sections**: regime chips (VIX level, Core PCE trend, labor, Fed stance), market quick stats row, 6 metric cards (Inflation/Labor/Growth/Consumer/Rates/PMI), Fed members two-column grid, events calendar grouped by week
- **Key context embedded in card notes**: inflation preventing cuts, AI unemployment thesis, prefer institutional GDP forecasts, yield curve inversion watch

### Scorecard startup fix (2026-06-03)
- `getAllCachedIndicators` now batch-fetches `pricesHistorical` for all tickers in one query and computes `price`, `ivCurrent`, `ivPercentile`, `rsiYesterday`, `ma200` in memory (no Yahoo Finance calls)
- `technical.ts` scorecard route uses `getIndicatorsBatch` for any ticker missing today's cache so new-day startup auto-populates all 31 rows from stored OHLCV
- `enrichWithOHLCV` helper extracted for reuse

### Previous session (2026-06-02): Indicators overhaul, options scanner UX fixes

### Indicators overhaul (2026-06-02)
- **OHLCV lookback extended** — `cutoffStr()` changed from 90 → 290 calendar days (≈200 trading days) to support MA200
- **New `IndicatorResult` fields**: `rsiYesterday`, `price`, `ivCurrent` (30d realized vol %), `ivPercentile` (0–100), `ma200` (200d SMA or null)
- **RSI velocity bonus** — `rsiScore` in `technical-rankings.ts` adds up to +5pts based on day-over-day RSI drop as % of yesterday's RSI value
- **IV rank metric** (weight 8.0) — absoluteScore (IV level vs 20–100% range) + relativeScore (ivPercentile/10); max 16pts
- **MA200 buffer metric** (weight 5.0) — distance between implied strike (price × (1 − minOTM by tier)) and 200d MA; max 10pts; null when MA200 unavailable
- `rowToResult` returns safe defaults for new fields (cached rows before today get 0/50/null — refresh populates real values)
- **Bug fixed**: `return5d` and `vsSpy20d` were already stored as percentages; display code was doubling them with `* 100` → fixed

### Options scanner UX (2026-06-02)
- **Add/delete rows** — input field in controls bar to add any ticker; X button on each row removes it (watchlist tickers hidden, extra tickers removed from state)
- **IV in parent row** — now shows `ivCurrent` from scorecard data (always loaded on mount) instead of waiting for options chain expand
- **Sort by IV%** — default sort changed to IV%; IV sort uses `ivCurrent` from indicators, not options chain data (works without expanding)
- **return5d display bug fixed** — was multiplying by 100 twice in `buildReasoning` and `strikeSummary`

### Previous session (2026-06-02): Daily brief overhaul, watchlist→breakdown integration, build skill
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

### Fundamental Scorer V2 — Phases 1–3 complete (2026-06-08)
Phases 1–3 of the institutional factor-model scorer upgrade are done. **Phase 4 (switchover) is next.**

**New files:**
- `artifacts/stock-compare/src/lib/rankings-helpers.ts` — pure math: `safeDiv`, `winsorize`, `normalize` (auto z-score ≥8, ordinal <8); 34 tests pass
- `artifacts/stock-compare/src/lib/rankings-helpers.test.ts` — test runner: `node --experimental-strip-types --experimental-transform-types --no-warnings --test`
- `artifacts/stock-compare/scripts/compare-rankings.ts` — **TEMP, delete in Phase 4**

**Modified file:**
- `artifacts/stock-compare/src/lib/rankings.ts` — added `FamilyName`, `FamilyPreset`, `FAMILY_PRESETS`, `MetricDefV2`, `SCORECARD_METRICS_V2`, `computeRankingsV2`. Old `computeRankings` + `SCORECARD_METRICS` untouched.
- `artifacts/stock-compare/package.json` — added `"test": "node --experimental-strip-types --experimental-transform-types --no-warnings --test src/lib/rankings-helpers.test.ts"`

**V2 design (key decisions):**
- 4 families: VALUE 20 / GROWTH 25 / QUALITY 35 / SAFETY 20 = maxPossible 100 (constant)
- 13 metrics. Key replacements: earningsYield+fcfYield replace P/E+Price/FCF; netmgn recomputes from raw netIncome/totalRevenue (fixes Yahoo 0.00% floor on POET)
- PEG clamped null when epsGrowth≤0 or netIncome<0 (prevents negative-PEG-ranks-best bug)
- Whole-universe normalization (NOT sector-split — sector split created a 15-stock global group where JOBY's −963% margin made RKLB's −22% look neutral)
- Base-effect growth guard: if totalRevenue < $100M AND revgrow > 500%, score revgrow at 0.5 (catches ONDS 1079% on tiny base; doesn't touch epsGrowth)
- Null metric → excluded from family denominator (renormalized); zero-metric family → 0.5 neutral
- metricRanks computed from raw values, not normScores (rank badges unaffected by scoring overrides)
- Suspect flags: netmgn>100%, growth>1000%, |netIncome|>|totalRevenue|, earningsYield if same — display-only except growth guard

**StockScore extended (optional fields, backward-compat):** `familyScores?`, `dataQuality?`, `gateStatus?`, `suspectMetrics?`

**Phase 3 outcome (31 tickers):**
- NVDA: #1→#2 (no longer uncontested on null-only metrics)
- ONDS: #9→#7 (growth guard fires; was #2 before guard)
- POET: #16→#20 (Quality=20%, correctly near bottom; Safety=85% from CR 35.4 inflates overall)
- HOOD: #20→#18 (FCF null handled correctly; Quality=60%; Safety=30% is real brokerage risk)
- RKLB: #29→#17 (null=0 bias removed; Quality=50% neutral; Safety=52% from high CR+no debt)
- JOBY: #31→#23 (null=0 bias removed; Quality=37% correctly low; Safety=81% from cash pile)

### FMP + WACC/Safety Metrics — All 5 Phases Complete (2026-06-09)
Full details in `.claude/docs/phase-report.md`.

**Summary:** FMP stable endpoints replace Yahoo for fundamentals. 5 new Safety metrics (cashRunway, interestCoverage, dilutionRate, CR reweighted, D/E reweighted) + 1 new Quality metric (ROIC−WACC spread) added to computeRankingsV2. Daily API budget guard (220 calls/day max) protects against quota exhaustion. 8/31 tickers populated; 23 remain Yahoo-only pending tomorrow's refresh.

**Key arch decisions:**
- FMP stable (not v3 legacy) — 7 endpoints/ticker; beta from Yahoo (FMP profile rate-limited)
- FINANCIAL_TICKERS = {HOOD, SOFI} — excluded from roicWaccSpread (broker/bank capital structure)
- fmp_api_usage DB table tracks daily calls; resets on date change; MAX=220
- api-client-react dist/ must be rebuilt after any StockMetrics schema change: `cd lib/api-client-react && npx tsc --build`

### Macro tab charts fix (2026-06-03)
- **Treasury Yield Curve** — replaced 4-ticker Yahoo Finance fetch with US Treasury CSV API (`home.treasury.gov`); now returns 11 maturities (1M→30Y) with current + month-ago rates
- **VIX / rate history charts** — `yahooFinance.historical()` deprecated by Yahoo; replaced with `yahooFinance.chart()` across all three series (VIX, 3M T-bill as Fed Funds proxy, 10Y TNX); each returns 500+ data points
- **`dgs2Series` undefined bug** — `yield2yValue` was referencing an undefined variable; now derived from yield curve's 2Y point; 2s10s spread now computes correctly
- **Renamed** "Yield Curve" → "Treasury Yield Curve" in chart component
- **Cache location** — macro cache files live at `/home/runner/workspace/artifacts/` (not `artifacts/api-server/`); `ROOT = join(__dirname, "..", "..")` from `dist/` resolves to `artifacts/`

## NEXT SESSION — do this FIRST, before any other work

### ⚡ Technicals stale check (runs automatically on startup)
The server auto-refreshes stale technicals on startup. To force-refresh:
`curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true`
To check status: `curl -s http://localhost:8080/api/technicals/status | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.tickers.filter(t=>t.coveragePct>=90).length+'/31 at 90%+ coverage')"`

### Next features to build
- Options comparison table (per-ticker: nearest expiry, best strike, income%, IV)
- Strike explorer slider (filter puts by OTM%, show premium/strike ratio)
- Fundamental improvements (sector benchmarks, earnings strip)
- Macro live feed — auto-refresh FRED data, PMI/ISM integration

### Technical V2 remaining items (low priority — no blocker)
- ivRank/ivPercentile: upgrade from realized vol proxy to atmPutIv history once ~60 daily rows accumulate
- putCallVolumeRatio/basicSkew: upgrade to percentileRank when ~60d history accumulates
- scorecard-explanation.tsx: update to show V2 metric definitions (TECHNICAL_SCORECARD_METRICS_V2)
- Remove computeTechnicalRankings (V1) from technical-rankings.ts after next release

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
