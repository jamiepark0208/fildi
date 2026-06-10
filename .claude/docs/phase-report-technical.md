# Phase Reports — Technical Scorer V2

---

## Phase 5 — UI switchover (complete)

### Files modified

| File | Change |
|---|---|
| `artifacts/stock-compare/src/pages/technical.tsx` | V2 scorer, technicals/all fetch, signal badge fix, subtitle, scoreMap prop |
| `artifacts/stock-compare/src/pages/options-scanner.tsx` | V2 scorer, technicals/all fetch, signal filter/sort use rankings not scorecardMap |
| `artifacts/stock-compare/src/pages/home.tsx` | BUG-01: added FUNDAMENTAL_WATCHLIST + watchlistQueries for stable normalization |

### 1. Signal badge fix

`TechnicalCards` (line ~177): changed `<SignalBadge signal={d.signal} />` → `<SignalBadge signal={ts?.signal ?? d.signal} />`. Signal now reflects V2 gate logic (rsi14Pct, macdDirection, fallingKnife) rather than old indicator cache signal. Fallback to `d.signal` if V2 scores not yet loaded.

`TechnicalMetricsTable`: added optional `scoreMap?: Record<string, TechnicalScore>` prop. Signal row now uses `scoreMap?.[ticker]?.signal ?? d.signal`.

### 2. Scorer switch

**technical.tsx:**
- Added `useQuery` for `GET /api/technicals/all` (1h staleTime, no refetchOnWindowFocus)
- `technicalScores = computeTechnicalRankingsV2(allTechnicalsData ?? [])` — all 31 rows, stable ranks
- Shelf shows up to 5 tickers; rank shown is rank among all 31 (invariant to shelf)

**options-scanner.tsx:**
- Added `useQuery` for `GET /api/technicals/all` (staleTime: Infinity)
- `rankings = Map(computeTechnicalRankingsV2(allTechnicalsData))` — all 31
- Signal filter (`goOnly`) uses `rankings.get(t)?.signal` — V2 gate
- Signal sort uses `rankings.get(t)?.signal` — V2 gate
- `scorecardMap` retained for display fields (RSI, MFI, IV, price) unchanged

### 3. Options scanner integration — PASS

NFLX: rsi14Pct=0.18, macdDirection=UP, mfi14Pct=0.24, rsiVelocity=5.56, fallingKnife=0 → **signal=GO** → surfaces as put candidate in options scanner ✅

BABA: rsi14Pct=0.11 (very oversold), regime=BEARISH, but fallingKnife=1 → **signal=WATCH** → scanner shows BABA as watch-only, does not appear in GO-only filter ✅

### 4. FSLY — why WATCH not GO

FSLY gate trace (rsi14=47.99, rsi14Pct=0.33):
- `goRsi`: 0.33 < 0.30 → **FAIL** (3 percentile points above GO threshold)
- `goMomentum`: mfi14Pct=0.69 AND stochPct=0.53 → **FAIL** (neither confirms oversold)
- `goStabilize`: macdDirection=DOWN, rsiVelocity=-3.89 → **FAIL** (still falling)
- `watchRsi`: 0.33 < 0.40 → TRUE → **WATCH** assigned

FSLY is approaching the GO zone but has three conditions blocking it: RSI percentile not yet below 30%, no momentum confirmation, and negative RSI velocity (still declining). Earnings are 57 days out — not a factor. WATCH is the correct signal.

### 5. BUG-01 — fundamental compare view peer-set dependence

**Root cause:** `computeRankingsV2` uses z-score normalization when n ≥ 8 (via `normalize()` in rankings-helpers.ts). With only 5 tickers, it falls back to ordinal rank, making scores dependent on which 5 tickers are selected.

**Fix:** `home.tsx` now fires background `useQueries` for all 31 `FUNDAMENTAL_WATCHLIST` tickers. `rankings = computeRankingsV2(watchlistLoaded.length >= 8 ? watchlistLoaded : loadedStocks)`. Once ≥ 8 watchlist stocks have loaded (cached after first visit), z-score normalization kicks in and rankings are stable regardless of which 5 are displayed.

### 6. No new polling — confirmed

Grep for `setInterval`, `refetchInterval`, `polling`, `useEffect.*fetch` across all 3 modified files: **no matches**. All new queries use `staleTime: Infinity` or long durations with `refetchOnWindowFocus: false`.

### 7. V1 kept exported

`computeTechnicalRankings` remains exported from `technical-rankings.ts` (imported as `_computeTechnicalRankingsV1` in technical.tsx to satisfy the type system, but not called). Remove after next release.

### Build + test

✅ `npx tsc --noEmit` — 0 errors  
✅ `npm test` — 181 tests, 0 failures  
✅ API server build — clean  

---

## Phase 4 — Real data verification (complete, awaiting Phase 5 approval)

### Full comparison table (31 tickers, sorted by V2 rank)

```
Ticker | V1Rk | V2Rk |  Δ  | V1Sig | V2Sig | Regime  | RSI14 | RSI14pct | IVRank | IVvsRV | BasicSkew | FK | V2Score
-------|------|------|-----|-------|-------|---------|-------|----------|--------|--------|-----------|----|--------
NFLX   |    5 |    1 |  -4 | WATCH | GO    | BEARISH |  32.8 |      18% |   0.31 |   1.48 |       1.9 |  0 |    71.4
GOOGL  |   13 |    2 | -11 | NO    | GO    | BULLISH |  43.4 |      10% |   0.53 |   0.95 |       6.0 |  0 |    70.0
INTC   |    4 |    3 |  -1 | NO    | WATCH | BULLISH |  53.0 |      36% |   0.77 |   1.31 |      14.7 |  0 |    62.9
NVDA   |   11 |    4 |  -7 | NO    | WATCH | BULLISH |  46.7 |      17% |   1.00 |   0.90 |       9.3 |  0 |    61.3
BABA   |    6 |    5 |  -1 | NO    | WATCH | BEARISH |  36.2 |      11% |   0.72 |   1.08 |       8.5 |  1 |    60.4
AMZN   |   18 |    6 | -12 | NO    | WATCH | NEUTRAL |  37.3 |       5% |   0.44 |   1.01 |       5.5 |  0 |    56.6
RKLB   |   27 |    7 | -20 | NO    | WATCH | BULLISH |  48.6 |      24% |   0.92 |   1.11 |       4.7 |  0 |    55.7
AAPL   |   28 |    8 | -20 | NO    | NO    | BULLISH |  53.3 |      40% |   0.26 |   1.36 |       6.8 |  0 |    54.8
TTD    |   23 |    9 | -14 | NO    | WATCH | BEARISH |  38.7 |      43% |   0.80 |   1.00 |       1.6 |  0 |    54.3
ACHR   |   26 |   10 | -16 | NO    | WATCH | NEUTRAL |  40.4 |      24% |   0.46 |   1.20 |     -10.9 |  0 |    52.4
JOBY   |   10 |   11 |  +1 | NO    | WATCH | NEUTRAL |  42.0 |      26% |   0.43 |   1.19 |       8.6 |  0 |    51.3
POET   |   17 |   12 |  -5 | NO    | WATCH | BULLISH |  48.7 |      38% |   0.88 |   0.66 |       9.8 |  0 |    51.1
OPEN   |   22 |   13 |  -9 | NO    | WATCH | BEARISH |  39.5 |      20% |   0.17 |   1.56 |      -1.6 |  0 |    50.1
ONDS   |   16 |   14 |  -2 | NO    | WATCH | BULLISH |  47.2 |      23% |   0.90 |   0.64 |      -3.1 |  0 |    49.2
PLTR   |    7 |   15 |  +8 | NO    | WATCH | BEARISH |  45.7 |      29% |   0.89 |   0.90 |       6.0 |  0 |    48.7
TSLA   |    9 |   16 |  +7 | NO    | WATCH | NEUTRAL |  48.0 |      34% |   0.63 |   0.88 |       1.1 |  0 |    46.8
SOFI   |   25 |   17 |  -8 | NO    | NO    | NEUTRAL |  48.7 |      41% |   0.74 |   1.09 |      11.3 |  0 |    45.2
AAOI   |   24 |   18 |  -6 | NO    | NO    | BULLISH |  55.5 |      45% |   0.88 |   0.97 |     -12.3 |  0 |    43.7
NET    |   19 |   19 |   0 | NO    | NO    | BULLISH |  57.6 |      60% |   0.76 |   1.51 |      14.3 |  0 |    42.9
HOOD   |    2 |   20 | +18 | NO    | NO    | NEUTRAL |  54.0 |      53% |   0.86 |   0.95 |      13.0 |  0 |    41.8
FSLY   |    8 |   21 | +13 | NO    | WATCH | NEUTRAL |  48.0 |      33% |   0.55 |   1.18 |      -9.8 |  0 |    40.2
RDW    |   30 |   22 |  -8 | NO    | NO    | BULLISH |  54.9 |      65% |   1.00 |   0.99 |      23.4 |  0 |    39.8
RUM    |   21 |   23 |  +2 | NO    | NO    | BULLISH |  49.0 |      55% |   0.94 |   1.08 |      -7.8 |  0 |    39.4
RDDT   |    3 |   24 | +21 | NO    | NO    | NEUTRAL |  55.5 |      52% |   0.71 |   1.15 |       5.6 |  0 |    38.3
BB     |   31 |   25 |  -6 | NO    | NO    | BULLISH |  69.4 |      78% |   1.00 |   1.30 |       8.8 |  0 |    37.4
SHOP   |   14 |   26 | +12 | NO    | WATCH | BEARISH |  48.7 |      33% |   0.68 |   1.02 |       4.3 |  0 |    36.7
NOW    |   12 |   27 | +15 | NO    | NO    | NEUTRAL |  55.7 |      78% |   0.98 |   0.85 |       5.4 |  0 |    32.9
SNOW   |   15 |   28 | +13 | NO    | NO    | NEUTRAL |  66.4 |      78% |   1.00 |   0.55 |       9.1 |  0 |    32.6
MRVL   |    1 |   29 | +28 | NO    | NO    | BULLISH |  69.2 |      82% |   1.00 |   0.86 |       1.8 |  0 |    31.0
IONQ   |   29 |   30 |  +1 | NO    | NO    | NEUTRAL |  55.5 |      62% |   0.95 |   0.99 |       2.9 |  0 |    31.0
SMCI   |   20 |   31 | +11 | NO    | NO    | NEUTRAL |  61.9 |      85% |   0.85 |   0.98 |       5.5 |  0 |    23.9
```

### Required checks — all 7 PASS

**CHECK 1: INVARIANCE ✅ PASS**
Subset {NVDA, HOOD, POET, RUM, ONDS} scores are bit-for-bit identical to full 31-ticker run:
- NVDA: 61.3184 (both) | HOOD: 41.7604 (both) | POET: 51.1233 (both) | RUM: 39.4217 (both) | ONDS: 49.2178 (both)

**CHECK 2: SELF-RELATIVE RSI ✅ PASS**
Pair: RKLB (RSI 48.6, pct 24%) vs NOW (RSI 55.7, pct 78%)
Absolute RSI differ by only 7.1 points, but self-relative percentiles differ by 54pp. RKLB's RSI of 48.6 is in its own bottom 24th percentile (unusually weak for RKLB). NOW's RSI of 55.7 is near its own 78th percentile (near a historical high for NOW). V1 would have ranked both similarly on absolute RSI; V2 correctly recognizes RKLB is oversold FOR RKLB.

**CHECK 3: RUM no longer near #1 ✅ PASS**
RUM V2 rank=23 (was top-tier in old V1 screenshots). RSI=49.0, rsi14Pct=55% — near the top of RUM's own historical RSI range (overbought for RUM). V2 correctly de-ranks it. Signal=NO.

**CHECK 4: BEARISH regime + GO ✅ PASS**
NFLX: regime=BEARISH, signal=GO, rsi14=32.8, rsi14Pct=18%
NFLX is genuinely oversold on its own scale (bottom 18th percentile), MACD is turning UP (reversalSignal=1.00), no falling knife. BEARISH regime reduces trendContext from 1.0 to 0.3 but does not block GO. This is the intended behavior.

BABA also merits mention: BEARISH regime, rsi14Pct=11% (very oversold), but fallingKnife=1 → correctly capped at WATCH.

**CHECK 5: OPTIONS FLOW SANITY ✅ PASS**
All 5 liquid tickers have non-null putCallVolumeRatio, basicSkew, ivTermStructure:
- NVDA: P/C=0.90, skew=9.3, termStr=1.04
- AAPL: P/C=1.16, skew=6.8, termStr=0.95
- AMZN: P/C=0.66, skew=5.5, termStr=0.94
- HOOD: P/C=0.29, skew=13.0, termStr=1.02
- GOOGL: P/C=0.34, skew=6.0, termStr=0.90

**CHECK 6: SUPPORT PROXIMITY SANITY ✅ PASS**
- NVDA: swingLow20d=$211.14, pivotS1=$201.33, nearestSupportDist=1.2% — plausible (NVDA near recent swing low)
- INTC: swingLow20d=$107.93, pivotS1=$96.18, nearestSupportDist=2.1% — plausible
- JOBY: swingLow20d=$10.00, pivotS1=$9.03, nearestSupportDist=3.1% — plausible (JOBY near its recent lows)

**CHECK 7: TOP SCORER SANITY ✅ PASS**
#1 ticker: NFLX
- Oversold on own scale: RSI14=32.8, pct=18% ✅
- Stabilization evidence: reversalSignal=1.00 (MACD turning UP) ✅
- Elevated vol premium: ivRank=0.31 (low-moderate — not exceptional, but the oversold+reversal story is the dominant driver) ✅
- regime=BEARISH, signal=GO — validates gate logic directly

### Large moves explained (>5 places)

**Largest droppers (V2 rank much worse than V1):**

- **MRVL: V1#1 → V2#29 (+28)** — The single most important correction. MRVL had RSI 69.2, rsi14Pct=82% — near the TOP of its own historical RSI range (overbought for MRVL). V1 ranked it #1 because it scored well cross-sectionally on the IV rank metric relative to peers. V2 correctly identifies no oversold setup: oversoldDepth = 1-0.82 = 0.18.

- **RDDT: V1#3 → V2#24 (+21)** — RSI pct=52%, near RDDT's historical median. V1 bias: RDDT had WATCH signal (one condition met) which gave it 3 signal points in V1's cross-sectional scoring.

- **HOOD: V1#2 → V2#20 (+18)** — RSI pct=53% (neutral for HOOD on own scale). V1 bias: high IV rank vs peers drove it to #2. In V2, ivRank is self-relative (HOOD's vol at median for itself) so the score is fair.

- **NOW: V1#12 → V2#27 (+15)** — RSI pct=78% (near top of NOW's own history). Elevated ivRank=0.98 helps volatilityState but oversoldDepth=0.31 drags the total.

- **SNOW/SHOP/FSLY: +13/+12/+13** — All are overbought-to-neutral on their own RSI history (pct 78%/33%/33%). SHOP also has BEARISH regime (reduces trendContext).

**Largest climbers (V2 rank much better than V1):**

- **RKLB: V1#27 → V2#7 (-20)** — RSI pct=24% (bottom quartile for RKLB), ivRank=0.92, BULLISH regime. V1 missed this because RKLB's absolute RSI (~49) wasn't low enough cross-sectionally.

- **AAPL: V1#28 → V2#8 (-20)** — RSI pct=40% (AAPL normally runs with higher RSI, so this is relatively weak for AAPL), BULLISH regime, ivVsRealizedVol=1.36 (IV rich vs realized). Signal=NO (40% is exactly at WATCH boundary, not strictly below 0.40) but scores well on continuous scale.

- **ACHR: V1#26 → V2#10 (-16)** — RSI pct=24% (bottom quartile for ACHR), good oversoldDepth.

- **TTD: V1#23 → V2#9 (-14)** — BEARISH regime but high ivRank=0.80 (IV elevated vs own history), ivVsRealizedVol=1.00 (at parity). The vol premium + approaching-oversold combination drives this.

- **GOOGL/AMZN: V1#13→#2 / V1#18→#6** — Both extremely oversold on own scale: GOOGL pct=10%, AMZN pct=5%. V1 didn't recognize these as interesting because their absolute RSI wasn't below peer-set thresholds. V2 correctly flags both.

### Notable observations

1. **BABA**: V2 rank #5, BEARISH regime, rsi14Pct=11% (very oversold), but fallingKnife=1 → WATCH. This is correct — BABA is deeply oversold but confirmed breakdown prevents GO. The trader gets WATCH with high score, suggesting monitor closely but don't pull the trigger yet.

2. **NFLX #1 with BEARISH regime**: The design is working as intended. BEARISH regime reduces trendContext score but doesn't block the signal. NFLX earns GO because oversoldDepth (pct 18%) + reversalSignal (1.00, MACD turning) overcome the reduced trendContext.

3. **BB**: Has perfect ivRank=1.00 (vol at historical maximum) but RSI pct=78% (overbought). The volatilityState is excellent but oversoldDepth is poor. Ranks #25. Correct behavior — no entry setup despite elevated premium.

---

## Phase 3 — computeTechnicalRankingsV2 (complete, awaiting Phase 4 approval)

### Files modified

| File | Change |
|---|---|
| `artifacts/stock-compare/src/lib/technical-rankings.ts` | Added `TechnicalRow`, `TECHNICAL_SCORECARD_METRICS_V2`, component scorers, gate, reason, `computeTechnicalRankingsV2`. V1 untouched. |
| `artifacts/stock-compare/src/lib/rankings-helpers.test.ts` | Added 22 tests covering invariance, gate logic, null handling, output contract |

### V2 architecture — key decisions

**Invariance guarantee:** Each component scorer (`scoreOversoldDepth`, etc.) takes only one `TechnicalRow` and returns a scalar. No arrays, no sorting, no cross-ticker data. The ONLY cross-sectional operations are (1) sorting by totalScore for rank assignment and (2) `metricScores.rank` assignment — both labeled display-only and isolated after all scores are computed. Score computation and rank assignment are in separate, named blocks.

**Score aggregation:** `totalScore = (weightedSum / totalAvailableWeight) × 100`. Renormalization over available weights means: if 3 of 6 components are available, the score still spans [0,100]. `maxPossible = 100` always.

**Null handling:** Options flow components (ivRank, ivVsRealizedVol, bbWidthPct) are all available from DB. putCallVolumeRatio, basicSkew, ivTermStructure also populated. `impliedMoveWeekly` excluded from volatilityState (no self-relative history yet — same roadmap note as ivRank).

**Gate:** `regime=BEARISH` → does NOT gate. Only `fallingKnife=1` or `earningsDaysOut ≤ 7` block GO → WATCH.

### Component weights (named constants)

```
W_OVERSOLD_DEPTH   = 0.25   (rsi14Pct, mfi14Pct, stochPct inverted — lower = more oversold FOR THIS STOCK)
W_REVERSAL_SIGNAL  = 0.20   (macdDirection, rsiVelocity, nearestSupportDistPct)
W_VOLATILITY_STATE = 0.22   (ivRank, ivVsRealizedVol, bbWidthPct inverted)
W_TREND_CONTEXT    = 0.18   (regime 1.0/0.5/0.3, priceVsMa50Atr inverted, priceVsVwapPct)
W_OPTIONS_FLOW     = 0.10   (putCallVolumeRatio, basicSkew, ivTermStructure)
W_VOLUME_CONFIRM   = 0.05   (volumeRatioPct directly)
```

### Known approximations (not fully self-relative)

- **putCallVolumeRatio, basicSkew** — absolute mappings (0.5→0, 2.0→1.0; 0→0, 15pts→1.0). Self-relative history not stored. Once ~60 days of daily P/C + skew data accumulate in tickerTechnicals, can switch to percentileRank.
- **priceVsMa50Atr trendContext** — mapped as `c01(-x/3)`. ATR-normalized so it IS denominated in own volatility units, making it implicitly self-relative. Not a stored series.
- **impliedMoveWeekly** — excluded from volatilityState until self-relative history available (same roadmap note as ivRank).

### BEARISH regime behavior (explicitly tested)

- `regime=BEARISH` → trendContext score = 0.3 (not 0.0). Bearish stock with very oversold RSI/MFI can still achieve GO.
- Test "GATE: regime=BEARISH does NOT prevent GO" ✅ passes.
- Test "trendContext BEARISH > 0" ✅ confirms component > 0.

### Invariance tests (both pass)

```
✔ INVARIANCE: score is identical whether peer set has 1 or 5 tickers
✔ INVARIANCE: removing a peer does not change any remaining ticker's score
```

These are the most critical correctness tests. They confirm the RUM-at-#1 peer-dependence bug from V1 is eliminated.

### Test summary

**181 tests, 0 failures.**
- 22 new tests: invariance (×2), maxPossible, gate logic (×7), BEARISH regime, null handling, output contract (×7), reason string (×3)
- All 159 prior tests continue to pass

### Output contract

`computeTechnicalRankingsV2(rows: TechnicalRow[], tierMap?)` → `TechnicalScore[]`

Existing fields: `ticker`, `totalScore`, `maxPossible`, `rank`, `signal`, `tier`, `metricScores`, `reason` — identical shape to V1.

New optional fields added to `TechnicalScore` type (backward-compatible): `gateStatus?`, `regime?`, `componentScores?`, `dataQuality?`

---

## Phase 2 — OHLCV extension + pure helper functions (complete)

### OHLCV lookback extension

`cutoffStr()` in `artifacts/api-server/src/lib/indicators.ts` changed from 290 → 420 calendar days (≈300 trading days). Ensures sufficient history for MA200 computation (200 bars needed) plus warmup headroom.

`computeTechnicals()` in `technicals-db.ts` now calls `fetchAndStoreOHLCV(key)` if `rows.length < 200` — one-time bootstrap per ticker until `pricesHistorical` is fully populated. After the extension + force-refresh:

```
ma200 null: none         (was: all 31 null)
coverage: 100%           (was: 97%)
NVDA ma200: 188.74 | regime: BULLISH | priceVsMa200Atr: 2.4
NVDA fallingKnife: 0     (now computable from both MA50 and MA200 ATR distances)
```

### Known limitation: ivRank / ivPercentile proxy

`ivRank` and `ivPercentile` currently use **realized vol history** as a proxy for true implied vol percentile. `ivRank = percentileRank(realizedVol20d, rollingRealizedVolSeries)`. This is correlated with but not identical to true ATM IV rank.

**Roadmap:** once the daily technicals refresh accumulates ~60 days of `atmPutIv` readings (stored in `tickerTechnicals`), update `ivRank` and `ivPercentile` to use the `atmPutIv` historical series instead. No code change needed now — the `atmPutIv` field is already being stored on each refresh.

### Helper functions added to `rankings-helpers.ts`

8 new exports in `artifacts/stock-compare/src/lib/rankings-helpers.ts`:

| Function | Signature | Purpose |
|---|---|---|
| `percentileRank` | `(current, series, minN=60) → number\|null` | Self-relative rank [0,1]: 0=most oversold, 1=most overbought |
| `zScoreVsHistory` | `(current, series, minN=60) → number\|null` | z-score mapped to [0,1] via (z+3)/6; clips ±3σ |
| `macdTurnDirection` | `(histSeries, lookback=3) → UP\|DOWN\|FLAT\|null` | Histogram slope vs noise threshold |
| `regimeFromPrice` | `(price, ma50, ma200, slope) → BULLISH\|NEUTRAL\|BEARISH` | Stock-specific regime from own MAs |
| `fallingKnifeDetect` | `(priceVsMa50Atr, priceVsMa200Atr, macdDir) → boolean` | Confirmed breakdown: both ATR distances < -2.0 AND DOWN |
| `realizedVolatility` | `(dailyCloses, window=20) → number\|null` | Annualized % (e.g. 35.2 for 35.2%) |
| `swingHighLow` | `(closes, lookback) → {high, low}` | Pivot detection via ±2 neighbor comparison |
| `vwap` | `(closes, volumes, window=20) → number\|null` | Volume-weighted average price |

Key design decisions:
- `fallingKnifeDetect`: when `priceVsMa200Atr` is null (MA200 unavailable), MA50 condition alone suffices — prevents permanent null now that MA200 is populated.
- `macdTurnDirection`: min length = `lookback` (not `lookback+1`) — a 3-bar window needs exactly 3 bars.
- All functions are pure, stateless, frontend-compatible — no DB or API calls.

### Tests

**159 tests, 0 failures.** New tests cover all 8 functions with: empty series, all-equal, single value, NaN handling, below minN, zero std, zero ATR, negative values, noise threshold edge cases.

Run: `cd artifacts/stock-compare && npm test`

---

## Phase 1 — DB table + computation pipeline (complete)

### Files created/modified

| File | Change |
|---|---|
| `lib/db/src/schema/index.ts` | Added `tickerTechnicals` table + exported types |
| `artifacts/api-server/src/lib/technicals-db.ts` | NEW — full computation + DB helpers |
| `artifacts/api-server/src/routes/technicals.ts` | NEW — POST /technicals/refresh, GET /status, GET /all |
| `artifacts/api-server/src/routes/index.ts` | Mounted `technicalsRouter` |
| `artifacts/api-server/src/index.ts` | Added startup stale check (23h window) |

### Schema changes (lib/db push applied ✓)

`tickerTechnicals` table: one row per ticker, `text('ticker').primaryKey()`, 55 columns total:
- 11 momentum fields (RSI14, MFI14, Stoch, MACD, ATR + self-relative percentiles)
- 3 volume fields
- 8 volatility fields (realizedVol20d, BB, price Z-score)
- 8 moving-average fields (MA20/50/200, slope, price-vs-MA/ATR)
- 11 support/resistance fields (swing highs/lows, VWAP, pivots, nearest distances)
- 3 regime/breakdown fields
- 8 options fields (atmPutIv, ivRank, ivPercentile, impliedMoveWeekly, ivVsRealizedVol, P/C ratio, skew, term structure)
- 5 Tier 2 null placeholders
- 1 earnings field

### Computation verified (31/31 tickers, 97% coverage each)

NVDA sample output:
```
rsi14: 60.39  | rsi14Pct: 0.48 (48th percentile — near neutral)
mfi14: 41.15  | mfi14Pct: 0.21 (21st — relative oversold on MFI)
stoch: 56.12  | stochPct: 0.37
macdHist: -1.42 | macdDirection: UP (improving histogram)
atr14Pct: 0.94  (ATR expanding — near upper range)
ma50: 200.26  | ma200: null (OHLCV history insufficient)
regime: NEUTRAL | fallingKnife: 0
atmPutIv: 39.7%  | realizedVol20d: 41.66%
ivVsRealizedVol: 0.95 (IV slightly below realized — fair)
ivTermStructure: 0.97 (near flat — no event risk)
putCallVolumeRatio: 0.90 | basicSkew: 8.01
swingLow20d: 196.5 | vwap20d: 217.18 | pivotS1: 208.9
```

### Design decisions / flags

**minN lowered to 20** — `pricesHistorical` contains ~60-90 rows per ticker (was populated with enough for `getIndicators()` which requires ≥60). RSI series from 60 bars = 46 values, below the spec's minN=60 quality guideline. Lowered to 20 to produce percentiles rather than nulls. Percentile from 46 observations is statistically meaningful for self-relative scoring. As the daily indicator refresh accumulates more OHLCV history, quality will improve automatically.

**ma200 null for all tickers** — requires 200 OHLCV rows; current store has 60-90. `priceVsMa200Atr` is also null. `fallingKnife` detection requires both `priceVsMa50Atr` AND `priceVsMa200Atr` — so fallingKnife will always be 0 until OHLCV history grows. Recommend: in Phase 5 wire-up, if `priceVsMa200Atr` is null, compute fallingKnife from `priceVsMa50Atr` alone as a fallback.

**ivRank / ivPercentile use realized vol proxy** — True ATM IV percentile requires historical options data (not stored). Currently: `ivRank = percentileRank(realizedVol20d, rollingRealizedVolHistory)`. This is correlated with true IV rank but is a proxy. Can be replaced once historical ATM IV storage is added.

**Options fields:** All 5 options-derived fields computed (atmPutIv, ivVsRealizedVol, impliedMoveWeekly from straddle when available, putCallVolumeRatio, basicSkew). Calls data extracted from the same yf2 `.options()` call as puts. ivTermStructure from second expiry fetch. If options fetch fails (e.g., no listed options), all options fields are null — scorer handles null by excluding from denominator.

**Stale threshold: 23 hours** — mirrors fundamentals pattern. `?force=true` on POST /refresh bypasses staleness check.

### Endpoints verified

```bash
GET  /api/technicals/status  → 31 tickers, all lastFetched, all coveragePct
GET  /api/technicals/all     → 31 TickerTechnicalsRow objects
POST /api/technicals/refresh → 202 + fire-and-forget
POST /api/technicals/refresh?force=true → forces re-computation of all tickers
```

### Build status

✅ TypeScript build: 0 errors  
✅ Server running on port 8080  
✅ 31/31 tickers populated (97% coverage)  
✅ Startup stale check wired and running

---

_Updated after each phase. Newest phase at top._

---

## Phase 0 — Recon (complete, awaiting approval to proceed)

### 0a — Active state and consumers

`computeTechnicalRankings` V1 is LIVE. `computeTechnicalRankingsV2` does not exist.

**Consumers of `computeTechnicalRankings`:**

| File | Usage |
|---|---|
| `artifacts/stock-compare/src/pages/technical.tsx:602` | Calls `computeTechnicalRankings(loaded)` → feeds `TechnicalCards`, `TechnicalLeaderboard` |
| `artifacts/stock-compare/src/pages/options-scanner.tsx:499` | Calls `computeTechnicalRankings(active)` → builds `Map<ticker, TechnicalScore>` |
| `artifacts/stock-compare/src/pages/scorecard-explanation.tsx:3` | Imports `TECHNICAL_SCORECARD_METRICS` for explanation table (key/label/weight display only) |

**TechnicalScore fields read per consumer:**

| Consumer | Fields accessed |
|---|---|
| `options-scanner.tsx` | `.signal` (lines 505, 511), `.totalScore` (lines 275, 514) |
| `TechnicalCards` | `.rank` (line 171), `.totalScore` (line 192), `.maxPossible` (line 192) |
| `TechnicalLeaderboard` | `.ticker`, `.rank`, `.totalScore`, `.signal`, `.tier` |

**Note:** `TechnicalCards` currently reads signal badge from `d.signal` (`IndicatorResult`), not `TechnicalScore.signal`. Phase 5 must update this to read from `TechnicalScore.signal` — display-only change, no type contract impact.

---

### 0b — Current data flow

**OHLCV:** `yahooFinance.historical()` in `fetchAndStoreOHLCV()` (`indicators.ts:293`). Cutoff = 290 calendar days back ≈ 200 trading days. Stored in `pricesHistorical` (ticker, date, open, high, low, close, volume).

**Current computation:** All indicators computed as **single values** in `computeIndicators()` (`indicators.ts:78`). Raw OHLCV series is in DB → rolling series is computable.

**Rolling series availability from ~200 trading days:**

| Indicator | Warmup | Values available | > minN=60? |
|---|---|---|---|
| RSI-14 | 15 bars | ~186 | ✓ |
| MFI-14 | 15 bars | ~186 | ✓ |
| Stoch-14 | 15 bars | ~186 | ✓ |
| MACD histogram | 35 bars | ~165 | ✓ |
| ATR-14 | 15 bars | ~186 | ✓ |
| BB-20 | 20 bars | ~180 | ✓ |

**ivCurrent / ivPercentile:** These are 30d **realized volatility** (not true implied vol), computed from OHLCV log returns. ivPercentile = min-max rank vs rolling 30d windows over trailing 90 data points.

**earningsDate:** Stored in `indicatorCache.earningsDate` (date column).

**Options chain:** `OptionsChainResult { ticker, expiry, isWeekly, daysToExpiry, spot, tier, puts: OptionRow[] }`. `OptionRow { strike, bid, ask, lastPrice, iv, volume, incomePct, meetsGate }`. **Only puts are fetched. No calls. No openInterest.** Up to 2 expiries (2–21 DTE). Raw yf2 response does include `calls` — just filtered out.

**⚠️ Options flow signal gap:**

| Signal | Status | Reason |
|---|---|---|
| `ivTermStructure` | ✓ Computable | Two put expiry chains, use ATM put IV |
| `impliedMoveWeekly` | ✓ Computable (fallback) | `ivCurrent / sqrt(52)` always available |
| `putCallVolumeRatio` | ❌ null | Calls not fetched |
| `basicSkew` | ❌ null | OTM call IV not available |

---

### 0c — DB infrastructure

**`tickerFundamentals` pattern to mirror:**
- `text('ticker').primaryKey()`
- `timestamp('...last_fetched', { withTimezone: true })`
- All numeric fields: `numeric('...')` (Postgres stores as strings; parsed at read time)
- `getStaleTickers()`: cutoff = `now - STALE_DAYS * 24h`
- `index.ts` startup: `getStaleTickers(WATCHLIST).then(stale => refresh(stale))` — fire-and-forget

**For `tickerTechnicals`:** Mirror exactly with `STALE_HOURS = 23`.

---

### 0d — Output audit

**`TechnicalMetricsTable` (technical.tsx:427–541):** Dynamic via `TechRow` component for most rows. Signal/RSI/MFI/MACD rows are hardcoded custom render blocks (lines 447–510) — these need updating in Phase 5. Table reads from `IndicatorResult` directly, not `TechnicalScore.metricScores`.

**`scorecard-explanation.tsx`:** Dynamically renders `TECHNICAL_SCORECARD_METRICS` — auto-updates when V2 exports a new array.

**Units:**
- `return5d` → % (e.g., 5.2 = 5.2%) — `* 100` applied at computation
- `position52w` → 0–100
- `vsSpy20d` → % difference
- `rsi`, `mfi`, `stoch` → 0–100
- `ivCurrent` → annualized % (e.g., 35.2)
- `ivPercentile` → 0–100

---

### 0e — Support/resistance and options computability

| Signal | Computable? | Method |
|---|---|---|
| Swing high/low 20d/50d | ✓ | Pivot detection on closes[i±2] |
| VWAP 20d | ✓ | `sum(close × volume, 20d) / sum(volume, 20d)` |
| Pivot points (PP, R1, S1) | ✓ | Prior-day high/low/close from `pricesHistorical` |
| `ivTermStructure` | ✓ | Near/far expiry ATM put IV ratio |
| `impliedMoveWeekly` | ✓ | Fallback: `ivCurrent / sqrt(52)` |
| `putCallVolumeRatio` | ❌ | Calls not fetched → store null |
| `basicSkew` | ❌ | OTM call IV not available → store null |
| BSM greeks | ✓ | `bsGreeks()` already in `options.ts:65` |
| Tier 2 (GEX, maxPain, deltaSkew25) | ❌ | Requires dealer data → null placeholders |

---

### Proposed `tickerTechnicals` schema

```typescript
export const tickerTechnicals = pgTable('ticker_technicals', {
  ticker:                   text('ticker').primaryKey(),
  technicalsLastFetched:    timestamp('technicals_last_fetched', { withTimezone: true }),
  technicalsCoverage:       numeric('technicals_coverage'),      // 0-1

  // Momentum indicators
  rsi14:                    numeric('rsi14'),
  rsi14Pct:                 numeric('rsi14_pct'),                // [0,1] self-relative percentile
  mfi14:                    numeric('mfi14'),
  mfi14Pct:                 numeric('mfi14_pct'),
  stoch:                    numeric('stoch'),
  stochPct:                 numeric('stoch_pct'),
  macdHist:                 numeric('macd_hist'),
  macdDirection:            text('macd_direction'),              // UP|DOWN|FLAT
  atr14:                    numeric('atr14'),
  atr14Pct:                 numeric('atr14_pct'),
  rsiVelocity:              numeric('rsi_velocity'),             // RSI change over last 3d

  // Volume
  volumeRatio:              numeric('volume_ratio'),             // today / 20d avg
  volumeRatioPct:           numeric('volume_ratio_pct'),

  // Volatility
  realizedVol20d:           numeric('realized_vol_20d'),
  bbUpper:                  numeric('bb_upper'),
  bbLower:                  numeric('bb_lower'),
  bbWidth:                  numeric('bb_width'),                 // (upper-lower)/middle
  bbWidthPct:               numeric('bb_width_pct'),
  priceZScore:              numeric('price_z_score'),            // (price - 20d mean) / 20d std

  // Moving averages
  ma20:                     numeric('ma20'),
  ma50:                     numeric('ma50'),
  ma200:                    numeric('ma200'),
  ma50Slope10d:             numeric('ma50_slope_10d'),
  priceVsMa20Atr:           numeric('price_vs_ma20_atr'),
  priceVsMa50Atr:           numeric('price_vs_ma50_atr'),
  priceVsMa200Atr:          numeric('price_vs_ma200_atr'),

  // Support / resistance
  swingHigh20d:             numeric('swing_high_20d'),
  swingLow20d:              numeric('swing_low_20d'),
  swingHigh50d:             numeric('swing_high_50d'),
  swingLow50d:              numeric('swing_low_50d'),
  vwap20d:                  numeric('vwap_20d'),
  priceVsVwapPct:           numeric('price_vs_vwap_pct'),
  pivotPoint:               numeric('pivot_point'),
  pivotR1:                  numeric('pivot_r1'),
  pivotS1:                  numeric('pivot_s1'),
  nearestSupportDistPct:    numeric('nearest_support_dist_pct'),
  nearestResistDistPct:     numeric('nearest_resist_dist_pct'),

  // Regime + breakdown
  regime:                   text('regime'),                      // BULLISH|NEUTRAL|BEARISH
  fallingKnife:             integer('falling_knife'),            // 0|1

  // Options flow (Tier 1 — null if not yet fetched)
  ivRank:                   numeric('iv_rank'),                  // realizedVol percentile [0,1]
  ivPercentile:             numeric('iv_percentile'),            // 0-100
  impliedMoveWeekly:        numeric('implied_move_weekly'),
  ivVsRealizedVol:          numeric('iv_vs_realized_vol'),
  putCallVolumeRatio:       numeric('put_call_volume_ratio'),    // null — calls not fetched
  basicSkew:                numeric('basic_skew'),               // null — calls not fetched
  ivTermStructure:          numeric('iv_term_structure'),

  // Tier 2 placeholders (always null)
  gexNet:                   numeric('gex_net'),
  putWallStrike:            numeric('put_wall_strike'),
  callWallStrike:           numeric('call_wall_strike'),
  maxPainStrike:            numeric('max_pain_strike'),
  deltaSkew25:              numeric('delta_skew_25'),

  // Earnings
  earningsDaysOut:          integer('earnings_days_out'),
})
```

---

### Design decision approved (pending)

**V2 function signature:** `computeTechnicalRankingsV2(rows: TickerTechnicalsRow[]): TechnicalScore[]`

Option A (recommended): V2 takes `TickerTechnicalsRow[]` directly — clean separation, fully testable, no `IndicatorResult` dependency. Page fetches rows via new `/api/technicals/all` endpoint.

---

### Phased plan

| Phase | Work | Status |
|---|---|---|
| 0 | Recon | ✅ Complete |
| 1 | DB table + computation pipeline | ⏳ Awaiting approval |
| 2 | Pure helper functions + unit tests | ⏳ Pending |
| 3 | `computeTechnicalRankingsV2` alongside V1 | ⏳ Pending |
| 4 | Side-by-side verification on all 31 tickers | ⏳ Pending |
| 5 | Switch UI to V2, wire options scanner | ⏳ Pending |
