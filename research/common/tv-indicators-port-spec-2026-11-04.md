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

---
# Phase 2 — add-an-indicator design + track record (Jamie 11-04: "we will keep adding indicators; track each one's success/fail; tell me which are good/bad; table in Settings")
Start only after phase 1's commit passes Claude review.

## A. One home, plug-in shape (adding an indicator = 1 file + 1 registry line + 1 .pine)
- Move `artifacts/stock-compare/src/lib/tv-indicators/` (+ utBot/superTrend from `tv-intraday.ts`) into workspace package `lib/indicators` (`@workspace/indicators`, same setup as `lib/option-scoring`). UI and api-server import it; no copies.
- Contract per indicator file: `export const def: IndicatorDef = { id, label, version, source: {url, author, license, pinePath}, defaults, timeframes: ["5m","15m","1h"], pane, compute(bars, opts) → { series: Record<string, number[]>, events: Event[] } }`, `Event = { time, side: "buy"|"sell"|"neutral", kind: string, price, note?: string[] }`. Charts render `series` by `pane` and `events` as markers — no per-indicator chart code.
- `lib/indicators/ADDING.md` (≤ 25 lines): fetch Pine via pine-facade (`/pine-facade/get/PUB%3B<id>/last`, id from `pubscripts-suggest-json?search=`), save to `research/sources/tradingview/`, port line by line on `pine.ts` primitives, add no-look-ahead + fixture tests, register. Bump `version` whenever logic or defaults change (grades are per version).

## B. Track record (nightly, server side)
- Table `indicator_events` (indicator_id, version, ticker, tf, time, side, kind, price, atr) and `indicator_grades` (event id → fwd 30m/60m/close return in the signal's direction, MFE/MAE in ATR, hit = +0.5 ATR before −0.5 ATR, same session only).
- Universe: SPY, QQQ, IWM + the Live hotlist names; tf 5m/15m/1h; history = Yahoo 5m (60 d) now, Polygon 1-min backfill later (Cursor A-row) for power.
- Scorecard `indicator_scorecard` per (indicator, version, kind, tf): n, hit %, placebo hit % (random bars, same ticker × time-of-day), lift pts, day-clustered t, sign in both halves, min detectable effect.
- Verdict (fixed rule, no judgment): **likely useful** = lift ≥ 3 pts, |t| ≥ 2, same sign both halves · **likely noise** = |lift| < 1.5 with MDE ≤ 3 (enough data to say no) · **too early** = otherwise (show "needs ~N more signals"). Wording = odds, never certainty.
- Job: api-server worker or `scripts/watchlist_sync` stage after close; deadline + cap per vendor (AGENTS.md 8c).

## C. Settings › Indicators tab
- Table: indicator · source (link, author) · version · timeframes · signals (n) · hit vs placebo · lift · verdict chip · best tf · last graded · default on/off toggle (feeds both charts' default menu).
- Row hover/expand: per kind (Buy / Sell / BoS / CHoCH / sweep) and per tf rows. One-line tooltips only.
- Data via `GET /api/indicators/scorecard` (catalog row in `.agents/context/api-endpoints.md`).

### C v2 (Claude 11-04 evening — supersedes the hit/placebo columns above; grader a33a1c20)
- Answer first per indicator row (cell kind=ALL, tf=ALL): **verdict chip** (direction) · **confidence** `p_win` with band `p_win_lo–p_win_hi` vs `random_win_pct` · **best structure** (`best_structure`, else "no edge yet") · n · days · last graded.
- Expand: rows per `kind` incl. `… · up` / `… · down` cells × tf; for each, the 4 families from `structures` jsonb (direction %/trade, bracket pts, vol |move| %, premium pts): signal vs random, lift, t, both-halves tick, verdict. Old `hit_pct/placebo_hit_pct` = small grey "old ATR test" column.
- Header line (fixed text): "Stock-path test, vs vol-matched random entries; structures over 60 min. Option-priced test = S152 (A334)."
- Default on/off toggle per indicator (feeds both charts' default menu) — keep from v1.
- API: `GET /api/indicators/scorecard` returns all `indicator_scorecard` rows (+ registry meta: label, source url/author, version, timeframes from `@workspace/indicators` INDICATORS) — DB read only, cache 10 min in `lib/ttl-cache.ts`; add the api-endpoints.md row.

## Acceptance
tsc 0 both apps; tests pass; scorecard populated for ≥ 1 night on SPY/QQQ; Settings tab renders; adding a dummy indicator touches only its file + registry line (prove in the report); ship check ok.
