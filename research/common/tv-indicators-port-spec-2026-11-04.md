# Spec — exact TradingView indicator port + chart menus (Jamie 11-04)

Jamie: add BigBeluga Market Structure Oscillator, Ichimoku, Squeeze Momentum, Liquidity Sweep Hunter (+ existing UT Bot / SuperTrend) to BOTH the Stock Breakdown chart and the Live chart Indicators menus; logic must equal TradingView; compute on 5m / 15m / 1h (resample), never "we only have daily".

## Sources (port line by line — no paraphrase)
- `research/sources/tradingview/market-structure-oscillator-bigbeluga.pine` (v6)
- `research/sources/tradingview/liquidity-sweep-hunter-algoalpha.pine` (v6, MPL-2.0 — keep the © line in the TS header)
- `research/sources/tradingview/squeeze-momentum-lazybear.pine` (v1). Keep LazyBear's quirk: BB dev uses `multKC` (1.5), not `mult`.
- Ichimoku = TradingView built-in: conversion 9, base 26, lagging span 26, leading span B 52, displacement 26 (leading spans drawn 26 bars ahead, lagging 26 bars back).
- UT Bot / SuperTrend already in `artifacts/stock-compare/src/lib/tv-intraday.ts` (utBot, superTrend) — reuse, don't twin.

## Build
1. `artifacts/stock-compare/src/lib/tv-indicators/`:
   - `pine.ts` — Pine-exact primitives: sma, ema (seed = sma of first n, per Pine docs), rma, stdev (biased/population like ta.stdev), linreg(src, n, 0), highest/lowest, change(src, n), tr, crossover/crossunder, pivothigh/pivotlow(left, right) (value known at bar i, pivot at i−right), nz/na semantics as NaN.
   - `resample.ts` — 5m bars → 15m / 1h buckets aligned to the US RTH open (09:30 ET; 1h = 09:30, 10:30 …, last partial bucket kept), OHLC + volume summed.
   - `ichimoku.ts`, `squeeze.ts`, `mso.ts`, `lsh.ts` — each returns plain arrays + event lists (e.g. MSO: osc, trendFilteredOsc, BoS/CHoCH events with price/time, divergences; LSH: active liquidity levels per lookback, sweep events, buy/sell signals as the script's alertconditions define them; skip dashboards/projections/tables). Inputs = script defaults, exposed as an options object.
   - `index.ts` — one registry `TV_INDICATORS` {id, label, pane: "price"|"sub", title (≤ 1 line, what the marks mean), compute(bars)} that both charts consume.
2. Tests `src/lib/tv-indicators/*.test.ts` (runner: `npm test` in stock-compare, node --test): primitives vs hand-computed arrays (ema seed, stdev biased, linreg, pivots confirm delay); squeeze quirk; resample bucket edges; each indicator on a fixed fixture (SPY 5m JSON under `src/lib/tv-indicators/__fixtures__/`, fetch once from Yahoo chart API `interval=5m&range=5d`) — no NaN after warm-up, event counts > 0, no look-ahead (value at bar i unchanged when bars after i are removed — test this for every indicator).
3. UI — one shared menu component (e.g. `components/charts/indicator-menu.tsx`) used by:
   - `components/price-chart.tsx` (Breakdown): append the new ids to `INDICATOR_META` / the existing Indicators dropdown; sub-pane ones use the same pane pattern as RSI/MACD there.
   - `components/live/regime-session-chart.tsx` (Live Fildi chart): replace the single "UT/ST" toggle with the same Indicators dropdown (UT Bot, SuperTrend, Ichimoku, Squeeze, MSO, LSH, RSI, MACD) + a timeframe pick 5m / 15m / 1h for indicator computation (resampled from the 5m bars already fetched — `histBars` 1M/5m + `bars`). Keep the odds strip + per-signal hover notes working for UT. Sub-panes via lightweight-charts v5 panes. Selection remembered per chart in localStorage (try/catch).
   - Markers: buy/sell/BoS/CHoCH/sweep as series markers on the candle series; hover shows the event's own facts (no repeated boilerplate).
4. Performance: compute in `useMemo` keyed on bars + enabled ids + timeframe; only enabled indicators compute; O(n) or O(n·len) loops, no per-bar array copies.

## Acceptance (all must pass)
- `cd artifacts/stock-compare && npx tsc --noEmit -p .` → 0 errors; `npm test` → new tests pass, existing baseline unchanged.
- `bash scripts/agent-ship-check.sh` stock-compare part ok (api-server typecheck errors from other agents' dirty files are not yours — note, don't fix).
- No-look-ahead test passes for every indicator.
- Commit only your files with `git add <paths>`; message trailer `Agent: claude`; then `scripts/agent-git-sync.sh`. Never stash/reset/checkout others' files.
- Final report ≤ 20 lines: files, test counts, any Pine construct you could not port exactly (name the line) and what you did instead.
