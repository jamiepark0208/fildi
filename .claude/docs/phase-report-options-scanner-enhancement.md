# Options Scanner Enhancement — Phase Report

---

## Phase 2 — Scorer Constants + Helpers + Tests ✅ (2026-06-15)

### Files created
- `artifacts/stock-compare/src/lib/option-scorer-constants.ts` — all named constants (weights, VIX bands, delta bands, income targets, liquidity thresholds, tag bonuses)
- `artifacts/stock-compare/src/lib/option-scorer.ts` — 7 pure component scorers + `computeOptionScore()` + `pickBestStrike()` + `buildCandidate()`
- `artifacts/stock-compare/src/lib/stock-scorer.ts` — `computeRelativeMove()` + `computeStockScore()` + `tagBonus()`
- `artifacts/stock-compare/src/lib/option-scorer.test.ts` — 75 unit tests

### Verified
- 257 total tests (75 new + 182 existing), 0 failures; `tsc --noEmit` 0 errors

---

## Phase 3 — Integration (feature flag = false) ✅ (2026-06-15)

### Changes made

**`artifacts/stock-compare/src/lib/technical-rankings.ts`**
- `TechnicalRow` extended with 7 fields already returned by `/api/technicals/all` but not previously typed: `swingLow20d`, `swingHigh20d`, `swingLow50d`, `swingHigh50d`, `pivotS1`, `atr14`, `impliedMoveWeekly`

**`artifacts/stock-compare/src/pages/options-scanner.tsx`**
- Local `OptionRow` type updated: added `openInterest`, `delta`, `spreadPct`
- Local `OptionsChainResult` type updated: added `exactDte`
- `MacroRegimeResult` interface added inline
- `pfNum()` helper added (parses Postgres numeric strings)
- Imports: `pickBestStrike`, `StockContext` from option-scorer; `computeRelativeMove`, `computeStockScore` from stock-scorer; `MacroRegime` from constants
- `USE_NEW_SCORER = false` feature flag constant added
- `viableStrikes()` now uses `exactDte`-based weeklyIncome: `incomePct / (exactDte / 7)` (fixes ceiling-of-weeks bug)
- `ScannerRowProps` extended with optional: `techRow`, `fundTotalScore`, `macroRegime`, `allWatchlistIVs`
- `ScannerRow` wires `pickBestStrike` via `useMemo` when `USE_NEW_SCORER = true`; falls back to existing reduce when false — **no behavior change yet**
- New `useQuery` for `/api/macro/regime` (5min staleTime)
- New `useQuery` for `/api/fundamentals/rankings` (Infinity staleTime)
- New derived maps: `techRowMap`, `fundScoreMap`, `allWatchlistIVs`
- New props passed to `ScannerRow` in render

### Verified
- `tsc --noEmit`: 0 errors; 257 tests pass

---

## Phases 4 & 5 — UI Switchover + Cleanup ✅ (2026-06-15)

### Changes made (`artifacts/stock-compare/src/pages/options-scanner.tsx`)

- `USE_NEW_SCORER` flag removed; new scorer always active (falls back to income argmax only when `techRow` is null)
- `SortKey` expanded: added `"optionScore"` (new default) and `"buffer"` (SD-based OTM buffer)
- `SORT_LABELS` updated: "Option Score", "Stock Score", "IV%", "Income%", "Buffer", "Signal"
- Default sort state: `"optionScore"`
- `strikeSummary()`: removed `indicator` param and `"excluded · RM filter"` hard gate
- `buildReasoning()`: added `macroRegime` param; regime appended to GO messages; `return5d > 3` hard gate removed (soft message at >5%)
- `StrikeCard`: overhauled — now shows `optionScore`, `dataQuality` badge, Δ delta, POP%, SD buffer, gamma-risk flag (DTE≤3 + |delta|>0.20); uses `exactDte` for weeklyIncome
- `MacroBanner` component added above controls: shows regime, VIX, index direction, income target range
- `newScorerBest` useMemo: now always active, exposes `dataQuality` in return value
- `canOverride`: removed `.startsWith("excluded")` guard (RM filter no longer hard-gates)
- `bestOptionScoreMap` derived map: runs `pickBestStrike` per ticker for sort + `stockScoreMap` input
- `stockScoreMap` derived map: runs `computeStockScore` per ticker combining tech + fund + relMove + bestOption + tag
- Sort cases added: `"optionScore"` (from `bestOptionScoreMap`), `"buffer"` (max SD buffer across chains), `"score"` updated to use `stockScoreMap`
- `REGIME_INCOME_TARGET`, `REGIME_INCOME_FLOOR` imported from constants (used by MacroBanner)

### Verified
- `tsc --noEmit`: 0 errors; 257/257 tests pass

---

## Phase 1 — Backend Data Layer ✅ (2026-06-15)

### Changes made

**`artifacts/api-server/src/lib/options.ts`**
- `OptionRow` — added `openInterest: number | null`, `delta: number | null`, `spreadPct: number | null`
- `OptionsChainResult` — added `exactDte: number` (fractional calendar days, no ceiling)
- `RawContract` — added `openInterest?: number` (yahoo-finance2 does return it)
- New module-level constants: `FLAT_MIN_OTM = 0.03`, `FLAT_MAX_OTM = 0.22`, `RISK_FREE_RATE = 0.045`
- `buildRows()` — now computes delta via `bsGreeks()` per strike, adds openInterest/spreadPct, uses flat OTM band, `meetsGate = bid > 0` (income gate moved to Option Scorer)
- `exactDaysUntil()` helper — fractional days without ceiling rounding
- DTE filter changed: `>= 1 && <= 28`, up to **3** expiries (was 2–21 days, max 2)
- `TIER_CONFIG` import removed (tier still on result for bonus signal only)

**`artifacts/api-server/src/routes/macro-regime.ts`** (new)
- `GET /api/macro/regime` — fetches `^VIX`, `^GSPC`, `^IXIC`, `^RUT` from yahoo-finance2
- Returns: `{ vix, spxChange1d, ndxChange1d, rutChange1d, regime, indexDirection, fetchedAt }`
- VIX bands: LOW_VOL (<15), BASELINE (15–20), ELEVATED (20–30), EXTREME (>30)
- Index direction: RALLY/CRASH if |change| > 1%, else NEUTRAL
- 5-min in-memory cache; falls back to BASELINE regime on fetch failure (never 500)

**`artifacts/api-server/src/routes/index.ts`** — mounted `macroRegimeRouter`

### Verified
- Build: `⚡ Done in 475ms`, zero TS errors
- `GET /api/options/NVDA` → `exactDte: 1.12`, `delta: -0.027`, `spreadPct: 0.054`, `openInterest: 2435`, `numChains: 3`
- `GET /api/macro/regime` → `{ vix: 16.2, regime: "BASELINE", indexDirection: "RALLY" }`
- Frontend `tsc --noEmit`: 0 errors

---

## Pre-Phase-1: Current "BEST" Strike/Expiry Selection Logic

**As of 2026-06-15.** Documents the existing implementation before any scoring enhancements.

---

### Key Files

| File | Role |
|---|---|
| `artifacts/api-server/src/lib/constants.ts` | Tier config: OTM bounds, income minimums per ticker |
| `artifacts/api-server/src/lib/options.ts` | Fetches option chains, filters by OTM band, computes `incomePct` and `meetsGate` |
| `artifacts/api-server/src/lib/indicators.ts` | Computes RSI, MFI, ivCurrent, ivPercentile, return5d, ma200 from OHLCV |
| `artifacts/api-server/src/routes/options.ts` | `GET /api/options/:ticker` and `GET /api/options/position-quote` |
| `artifacts/api-server/src/routes/technical.ts` | `GET /api/technical/scorecard` — serves signal/RSI/MFI/IV per ticker |
| `artifacts/stock-compare/src/pages/options-scanner.tsx` | Options Scanner frontend: computes BEST, renders StrikeCard |
| `artifacts/stock-compare/src/lib/technical-rankings.ts` | V2 self-relative scorer (6-component totalScore) and GO/WATCH/NO gate |
| `artifacts/stock-compare/src/lib/rankings.ts` | Fundamental scorer (V2/V3) — NOT used by Options Scanner |

---

### Pipeline: How BEST Is Determined

#### Step 1 — Tier Assignment (`constants.ts`)
Each ticker is hardcoded to Tier 1, 2, or 3, which controls the allowed OTM band and minimum income gate:

| Tier | Example Tickers | OTM Band | Min Weekly Income |
|---|---|---|---|
| 1 | NVDA, AAPL, TSLA | 5–10% below spot | 0.8%/wk |
| 2 | Mid-vol names | 10–15% below spot | 1.0%/wk |
| 3 | JOBY, IONQ, RKLB | 15–20% below spot | 1.2%/wk |

#### Step 2 — Strike Filtering (server-side, `options.ts → buildRows`)
- Only expiries with **2–21 DTE** are eligible (up to 2 chains: nearest weekly + biweekly)
- Strike band: `lo = spot * (1 - maxOTM)`, `hi = spot * (1 - minOTM)`
- Per strike: `incomePct = (bid / strike) * 100`
- `meetsGate = incomePct / weeksOut >= minIncome` (minIncome is weekly rate; scaled by weeks to expiry)

#### Step 3 — RM Exclusion (frontend, `options-scanner.tsx`)
If `return5d > 3%` (stock up >3% in last 5 days), the entire row is excluded — no strikes shown regardless of chain quality.

#### Step 4 — BEST = Max Weekly Income (frontend, `ScannerRow`)
```
bestStrike = strikes.reduce((a, b) => a.weeklyIncome > b.weeklyIncome ? a : b)
```
- `weeklyIncome = incomePct / weeksOut`
- **BEST = highest bid/strike yield per week.** No other factor.

---

### What Technical & Fundamental Scores Currently Do

| Signal | Role in Scanner |
|---|---|
| V2 Technical totalScore (6-component) | Display + sort only — does NOT affect BEST selection |
| GO / WATCH / NO signal | Shown on each row — does NOT filter or weight strikes |
| Fundamental scores (V2/V3) | Completely absent from Options Scanner |
| IV (put.iv from Yahoo chain) | Shown in StrikeCard for reference — does NOT affect BEST |
| ivCurrent / ivPercentile (realized vol) | Used in V2 volatilityState component — display only |

---

### The Gap (Pre-Enhancement)

The current system finds the highest-yielding put within the tier's OTM band but is blind to:
- Whether the stock's GO/WATCH/NO signal is favorable
- IV rank (selling at high vs. low IV — critical for premium sellers)
- Strike distance quality within the band (5% OTM vs. 9% OTM treated equally aside from raw income)
- Fundamental quality of the underlying

---

### V2 Technical Score Components (for reference)

| Component | Weight | What It Measures |
|---|---|---|
| oversoldDepth | 25% | Avg of (1 − RSI pct, 1 − MFI pct, 1 − Stoch pct) — self-relative |
| reversalSignal | 20% | MACD direction + RSI velocity + proximity to nearest support |
| volatilityState | 22% | IV rank + IV/realized vol ratio + Bollinger squeeze |
| trendContext | 18% | Regime + price vs MA50 in ATR units + vs VWAP |
| optionsFlow | 10% | Put/call vol ratio + put skew + IV term structure |
| volumeConfirm | 5% | 20d volume ratio percentile |

---

### GO/WATCH/NO Gate Logic (`computeGateV2` in `technical-rankings.ts`)

**GO** requires all five:
1. `rsi14Pct < 0.30` (RSI in bottom 30th percentile of own history)
2. `mfi14Pct < 0.35` OR `stochPct < 0.35`
3. MACD direction UP OR `rsiVelocity > 0`
4. Not a falling knife (`fallingKnife !== 1`)
5. No earnings within 7 days

**WATCH** if partial GO conditions (RSI < 40th pct, MACD turning UP, or `priceZScore < -1.5`)

**NO** otherwise

---

### Next: Enhancement Goals

To be defined — likely incorporating IV rank, signal strength, and/or distance quality into the BEST scoring formula. See session notes from 2026-06-15.
