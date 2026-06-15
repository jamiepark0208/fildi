# Next Session — Options Scanner Enhancement Q&A Context

> Load this file at the start of next session when the user has questions about the scorer changes.
> Full implementation history: `.claude/docs/phase-report-options-scanner-enhancement.md`

---

## What Was Built (Phases 1–5, all on 2026-06-15)

A two-layer scoring system replacing the old "max weeklyIncome" strike picker.

### Layer 1 — Stock Score (`stock-scorer.ts`)
Ranks *which stocks* are best put-selling candidates right now.
| Component | Weight | Input source |
|---|---|---|
| Technical score | 40% | `computeTechnicalRankingsV2` totalScore [0–100] |
| Fundamental score | 25% | `/api/fundamentals/rankings` totalScore [0–100] |
| Relative move | 20% | `computeRelativeMove()` — replaces old `return5d > 3` hard gate |
| Best option score | 10% | Output of Layer 2 (circular, bootstrapped) |
| Color tag | 5% | watchlist colorTag (green=1.0, blue=0.8, yellow/purple=0.5) |

`computeRelativeMove()` inputs: `priceZScore`, `priceVsMa50Atr`, `return5d`, `swingHigh20d`, `swingLow20d`, `spot`. A stock up +8% scores ~0.1 (bad entry); down 8% scores ~0.9 (good entry). **No hard gate.**

### Layer 2 — Option Score (`option-scorer.ts`)
Ranks *which strike/expiry* is best for a given stock.
| Component | Weight | What it measures |
|---|---|---|
| Income adequacy | 30% | Weekly yield vs regime target; peaks at target, gentle decay above |
| Buffer | 32% | Blend of delta band (60%) + SD buffer (40%) — regime-shifted sweet spot |
| IV relative | 10% | IV rank + IV percentile vs own history; bonus for IV > realized vol |
| IV absolute | 6% | Cross-watchlist IV percentile (capped at 85th) |
| Stock quality | 12% | 60% tech + 40% fundamental scores |
| Strike support | 6% | Is strike below swing lows / pivot S1? |
| DTE preference | 4% | ≤7d=1.0, ≤14d=0.8, ≤21d=0.6, >21d=0.4 |

Output: `optionScore` [0–100], `dataQuality` [0–1], `liquidity` result.

### Macro Regime (`/api/macro/regime`)
Fetches VIX + SPX/NDX/RUT daily change every 5 min.
- `LOW_VOL` VIX<15 | `BASELINE` 15–20 | `ELEVATED` 20–30 | `EXTREME` >30
- Shifts delta sweet spot (buffer component) and income target:
  - BASELINE: income target 1.0%/wk, delta sweet 0.10–0.15
  - ELEVATED: income target 1.25%/wk, delta sweet 0.12–0.20
  - EXTREME: income target 1.5%/wk, delta sweet 0.15–0.25

---

## Key UI Changes in `options-scanner.tsx`

### StrikeCard (expanded view)
Now shows per-strike: Δ delta, POP (1−|delta|), SD buffer (OTM% / IV×√(DTE/365)), option score (best only), data quality badge (partial/<80%, sparse/<50%), gamma-risk flag (DTE≤3 AND |delta|>0.20).

### MacroBanner
Appears above controls. Shows regime name, VIX, index direction (▲RALLY/▼CRASH/–NEUTRAL), income target range. Only renders when VIX data is available.

### Sort Options (left to right)
1. **Option Score** (default) — `bestOptionScoreMap`: runs `pickBestStrike` per ticker
2. **Stock Score** — `stockScoreMap`: runs `computeStockScore` per ticker
3. **IV%** — `scorecardMap.ivCurrent` (always loaded, no expand needed)
4. **Income%** — max weeklyIncome across all chains (exactDte-based)
5. **Buffer** — max SD buffer across all chains
6. **Signal** — GO > WATCH > NO

### BEST Strike Selection Logic (now)
`pickBestStrike()` scores every put across all chains; returns highest `optionScore`. Falls back to income argmax when `techRow` is null (extra tickers not in `/api/technicals/all`).

### Removed
- `USE_NEW_SCORER` feature flag (gone)
- `return5d > 3` hard gate on both `strikeSummary` and `buildReasoning`
- "excluded · RM filter" summary text

---

## Key Files
| File | Role |
|---|---|
| `src/lib/option-scorer-constants.ts` | All tunable weights, VIX bands, delta bands, income targets |
| `src/lib/option-scorer.ts` | 7 component scorers + `computeOptionScore` + `pickBestStrike` |
| `src/lib/stock-scorer.ts` | `computeRelativeMove` + `computeStockScore` |
| `src/lib/option-scorer.test.ts` | 75 unit tests covering all components |
| `src/pages/options-scanner.tsx` | Full frontend — MacroBanner, StrikeCard, sort, derived maps |
| `api-server/src/lib/options.ts` | Backend: delta via bsGreeks, exactDte, openInterest, spreadPct |
| `api-server/src/routes/macro-regime.ts` | `GET /api/macro/regime` — VIX + regime |

---

## Data Flow for a Single Ticker Row
1. `/api/technicals/all` → `TechnicalRow` (ivRank, swingLow20d, pivotS1, priceZScore, etc.)
2. `/api/options/:ticker` → `OptionsChainResult[]` (puts with delta, spreadPct, openInterest, exactDte)
3. `/api/macro/regime` → current VIX + regime
4. `/api/fundamentals/rankings` → fundTotalScore
5. `pickBestStrike(chains, stockCtx, regime, allWatchlistIVs)` → best strike + optionScore
6. `computeStockScore(...)` → stockScore for row ordering
