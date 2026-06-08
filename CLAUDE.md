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
working: [macro-tab]
completed: [scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix]
next: [options-comparison-table, strike-explorer-slider, fundamental-improvements, macro-data-live-feed]

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

### Phase 4 — Fundamental Scorer Switchover (DO NEXT)
**No backend changes. Pure frontend. No API rebuild needed.**

3 component edits + 1 script delete:

1. **`artifacts/stock-compare/src/pages/home.tsx`**
   - Change import: `computeRankings` → `computeRankingsV2`
   - Change call in useMemo: `computeRankings(validStocks)` → `computeRankingsV2(validStocks)`

2. **`artifacts/stock-compare/src/components/scorecard-breakdown.tsx`**
   - Change import: `SCORECARD_METRICS` → `SCORECARD_METRICS_V2`
   - Change the `.map()` call from `SCORECARD_METRICS` to `SCORECARD_METRICS_V2`
   - Update the hardcoded `isPercent` list (line ~45):
     ```tsx
     // OLD:
     const isPercent = ["revgrow","epsgrow","netmgn","roe","grossmgn","upside"].includes(metric.key);
     // NEW:
     const isPercent = ["earningsYield","fcfYield","revgrow","epsgrow","upside",
                        "grossmgn","operatingmgn","netmgn","roe","fcfmgn"].includes(metric.key);
     ```

3. **`artifacts/stock-compare/src/pages/scorecard-explanation.tsx`**
   - Change import + usage: `SCORECARD_METRICS` → `SCORECARD_METRICS_V2`

4. **Delete** `artifacts/stock-compare/scripts/compare-rankings.ts`

5. **Run typecheck + tests:**
   ```bash
   cd /home/runner/workspace/artifacts/stock-compare && pnpm typecheck && pnpm test
   ```

6. **Verify in browser:** leaderboard renders, Metric Breakdown table shows 13 rows with correct labels/percent formatting, no console errors.

### Macro tab charts fix (2026-06-03)
- **Treasury Yield Curve** — replaced 4-ticker Yahoo Finance fetch with US Treasury CSV API (`home.treasury.gov`); now returns 11 maturities (1M→30Y) with current + month-ago rates
- **VIX / rate history charts** — `yahooFinance.historical()` deprecated by Yahoo; replaced with `yahooFinance.chart()` across all three series (VIX, 3M T-bill as Fed Funds proxy, 10Y TNX); each returns 500+ data points
- **`dgs2Series` undefined bug** — `yield2yValue` was referencing an undefined variable; now derived from yield curve's 2Y point; 2s10s spread now computes correctly
- **Renamed** "Yield Curve" → "Treasury Yield Curve" in chart component
- **Cache location** — macro cache files live at `/home/runner/workspace/artifacts/` (not `artifacts/api-server/`); `ROOT = join(__dirname, "..", "..")` from `dist/` resolves to `artifacts/`

## NEXT SESSION — do these in order
1. **Phase 4 — fundamental scorer switchover** (see detail below — do this FIRST)
2. Options comparison table (per-ticker: nearest expiry, best strike, income%, IV)
3. Strike explorer slider (filter puts by OTM%, show premium/strike ratio)
4. Fundamental improvements (sector benchmarks, earnings strip)
5. Macro live feed — auto-refresh FRED data, PMI/ISM integration

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
