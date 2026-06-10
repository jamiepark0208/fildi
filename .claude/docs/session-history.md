# Session History Archive
> Sessions older than 2026-06-08. Moved from CLAUDE.md to keep it concise.

---

## Macro tab charts fix (2026-06-03)
- **Treasury Yield Curve** — replaced 4-ticker Yahoo Finance fetch with US Treasury CSV API (`home.treasury.gov`); now returns 11 maturities (1M→30Y) with current + month-ago rates
- **VIX / rate history charts** — `yahooFinance.historical()` deprecated by Yahoo; replaced with `yahooFinance.chart()` across all three series (VIX, 3M T-bill as Fed Funds proxy, 10Y TNX); each returns 500+ data points
- **`dgs2Series` undefined bug** — `yield2yValue` was referencing an undefined variable; now derived from yield curve's 2Y point; 2s10s spread now computes correctly
- **Renamed** "Yield Curve" → "Treasury Yield Curve" in chart component
- **Cache location** — macro cache files live at `/home/runner/workspace/artifacts/` (not `artifacts/api-server/`); `ROOT = join(__dirname, "..", "..")` from `dist/` resolves to `artifacts/`

---

## Macro tab (2026-06-03)
- New page `/macro` with Globe icon in sidebar nav under Analysis
- **Backend** `artifacts/api-server/src/lib/macro-data.ts` — fetches 11 FRED CSV series (no API key needed) + Yahoo Finance for VIX/yields; 4h file cache at `macro-data.json`
- **Routes** `artifacts/api-server/src/routes/macro.ts` — mounted at `/api/macro`; endpoints: `/data`, `/refresh`, `/fed-members`, `/events`, `/highlights` (GET + POST generate via Claude Haiku)
- **Fed members** — 17 FOMC members (10 voting, 7 non-voting) hardcoded with hawkish/neutral/dovish stance + context notes
- **Events calendar** — 16 upcoming events Jun–Jul 2026; filtered to future dates on request
- **AI Highlights** — user-triggered via "Generate" button; Haiku model; stored in `macro-highlights.json`; survives restarts
- **UI sections**: regime chips (VIX level, Core PCE trend, labor, Fed stance), market quick stats row, 6 metric cards (Inflation/Labor/Growth/Consumer/Rates/PMI), Fed members two-column grid, events calendar grouped by week
- **Key context embedded in card notes**: inflation preventing cuts, AI unemployment thesis, prefer institutional GDP forecasts, yield curve inversion watch

---

## Scorecard startup fix (2026-06-03)
- `getAllCachedIndicators` now batch-fetches `pricesHistorical` for all tickers in one query and computes `price`, `ivCurrent`, `ivPercentile`, `rsiYesterday`, `ma200` in memory (no Yahoo Finance calls)
- `technical.ts` scorecard route uses `getIndicatorsBatch` for any ticker missing today's cache so new-day startup auto-populates all 31 rows from stored OHLCV
- `enrichWithOHLCV` helper extracted for reuse

---

## Indicators overhaul (2026-06-02)
- **OHLCV lookback extended** — `cutoffStr()` changed from 90 → 290 calendar days (≈200 trading days) to support MA200
- **New `IndicatorResult` fields**: `rsiYesterday`, `price`, `ivCurrent` (30d realized vol %), `ivPercentile` (0–100), `ma200` (200d SMA or null)
- **RSI velocity bonus** — `rsiScore` in `technical-rankings.ts` adds up to +5pts based on day-over-day RSI drop as % of yesterday's RSI value
- **IV rank metric** (weight 8.0) — absoluteScore (IV level vs 20–100% range) + relativeScore (ivPercentile/10); max 16pts
- **MA200 buffer metric** (weight 5.0) — distance between implied strike (price × (1 − minOTM by tier)) and 200d MA; max 10pts; null when MA200 unavailable
- `rowToResult` returns safe defaults for new fields (cached rows before today get 0/50/null — refresh populates real values)
- **Bug fixed**: `return5d` and `vsSpy20d` were already stored as percentages; display code was doubling them with `* 100` → fixed

---

## Options scanner UX (2026-06-02)
- **Add/delete rows** — input field in controls bar to add any ticker; X button on each row removes it (watchlist tickers hidden, extra tickers removed from state)
- **IV in parent row** — now shows `ivCurrent` from scorecard data (always loaded on mount) instead of waiting for options chain expand
- **Sort by IV%** — default sort changed to IV%; IV sort uses `ivCurrent` from indicators, not options chain data (works without expanding)
- **return5d display bug fixed** — was multiplying by 100 twice in `buildReasoning` and `strikeSummary`

---

## Daily brief overhaul + watchlist→breakdown + build skill (2026-06-02)
- **On-demand only** — removed auto-fetch on mount; brief only generates when user clicks "Generate Today's Brief"
- **File-backed history** — `brief-history.json` stores up to 90 briefs; survives server restarts
- New `GET /api/daily-brief/market` — fetches live prices for 9 instruments with no AI; called on every page load so chips are always fresh
- `GET /api/daily-brief` (no `?refresh`) — returns today's stored brief from history or `{noData:true}`; zero AI cost
- `GET /api/daily-brief?refresh=true` — regenerates, saves/overwrites today's entry in history
- `GET /api/daily-brief/history` — returns full history array sorted newest-first
- **Minimizable Highlights** — collapse button (chevron) shows market chips + first bullet from Portfolio Implications as "Key takeaway"; expand shows full 5-section brief
- **Past Briefs tab** — "Past Briefs" tab fetches history; click any date to expand that day's brief + historical chips inline
- **Watchlist → Stock Breakdown**: clicking a watchlist ticker renders full `StockBreakdown` in right panel; `StockBreakdown` accepts optional `ticker` prop
- **Build skill**: new `.claude/skills/build-and-run.md`; root cause of 502 errors documented

---

## Previous sessions (2026-06-02)
- Scorecard: negative P/E fix, `reason` field, technical-rankings.ts, scorecard-explanation page
- Portfolio: named portfolios (IRA/FILDI/MOM), per-portfolio cards, covered call detection, risk metrics
- AI Daily Brief (v1): initial implementation with in-memory cache
