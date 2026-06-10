---
name: technical-scorecard
description: Load when building or modifying the technical scorecard UI, technical scoring logic, or any component that reads from tickerTechnicals. Covers V2 scorer architecture, DB schema, endpoint, and UI layout.
model: claude-sonnet-4-20250514
max_tokens: 2000
---

# Technical Scorecard — V2 Architecture

## How V2 Works (read this first)
V2 is pre-computed and stored. The UI does NOT call yahoo-finance2 directly.

```
prices_historical (OHLCV, 420d)
        ↓
computeTechnicalRankingsV2()    ← artifacts/api-server/src/lib/technical-rankings.ts
        ↓
tickerTechnicals (DB table, 55 cols)
        ↓
GET /api/technicals/all          ← returns all tickers in one call
        ↓
technical.tsx + options-scanner.tsx
```

**Never add direct yahoo-finance2 calls to UI components.** All technical data flows through the DB.

---

## Scorer: computeTechnicalRankingsV2

6 components, weights sum to 100%:

| Component | Weight | What it measures |
|---|---|---|
| oversoldDepth | 25% | How far RSI/MFI are below their thresholds — deeper = better |
| reversalSignal | 20% | MACD cross + Stochastic confirmation of bottom |
| volatilityState | 22% | IV rank + ATR relative to recent range |
| trendContext | 18% | MA200 buffer, 52w position, vs-SPY relative weakness |
| optionsFlow | 10% | Put/call ratio, basic skew |
| volumeConfirm | 5% | Volume spike on down days (accumulation signal) |

All scores are **self-relative** (z-score normalized within the watchlist universe). Adding/removing a ticker changes all scores.

## DB: tickerTechnicals (55 columns)
Key columns agents need:
```sql
ticker, scored_at, technicalScore,          -- top-level
oversoldDepth, reversalSignal, volatilityState, trendContext, optionsFlow, volumeConfirm,  -- component scores
rsi14, mfi14, rsiThreshold,                 -- RSI/MFI raw values
macdSignal, stochasticK,                    -- reversal signals
ivRank, ivPercentile, atr14,               -- volatility
ma200Buffer, position52w, vsSpyReturn20d,  -- trend context
putCallVolumeRatio, basicSkew,             -- options flow
volumeSpike,                               -- volume confirm
atmPutIv, atmPutStrike, nearestExpiry      -- options chain snapshot
```

**Known proxy issue**: `ivRank`/`ivPercentile` currently use realized vol as IV proxy. Will upgrade to true IV rank after ~60d of `atmPutIv` history accumulates.

## Refresh
```bash
# Check if stale (auto-checked on startup)
curl -s http://localhost:8080/api/technicals/all | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tickers'][0]['scoredAt'])"

# Force refresh
curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true
```

---

## Fundamental Scorer: computeRankingsV2

4 families, stored in tickerFundamentals:

| Family | Weight | Key metrics |
|---|---|---|
| Value | 20% | P/E, P/S, P/FCF, EV/EBITDA, PEG (clamped — no negative EPS) |
| Growth | 25% | Revenue growth YoY/3Y, EPS growth YoY (base-effect guard) |
| Quality | 35% | ROE, ROIC, gross margin, FCF margin, ROIC-WACC spread |
| Safety | 20% | Debt/equity, current ratio, interest coverage, Altman Z, beta |

Data source: FMP API (weekly refresh). Budget guard: 220 calls/day via `fmp_api_usage`.
Financial tickers HOOD/SOFI excluded from roicWaccSpread.

Endpoint: `GET /api/fundamentals/rankings` — returns all tickers ranked.

---

## UI: what reads what

| Component | Data source | Endpoint |
|---|---|---|
| `technical.tsx` | tickerTechnicals | GET /api/technicals/all |
| `options-scanner.tsx` | tickerTechnicals + options chain | GET /api/technicals/all + GET /api/options/:ticker |
| `rankings-leaderboard.tsx` | tickerFundamentals | GET /api/fundamentals/rankings |
| `scorecard-explanation.tsx` | **Still V1** — needs update | mixed |
| `scorecard.tsx` | combined | GET /api/scorecard/:ticker |

**scorecard-explanation.tsx still shows V1 metrics** — update in next UI pass.

---

## Purpose (unchanged from V1)
Judgment-support tool. Shows signals, ranks candidates, surfaces warnings.
Does NOT output a single score or make decisions. Covers steps 1-4 of trader's process — step 5 (conviction) is always theirs.

## Primary signal (still applies at UI level)
GO = oversoldDepth ≥ threshold AND reversalSignal firing
WATCH = one of the two
NO = neither

## Warning overlays (unchanged)
- Yellow border: "⚠ UP +X% 5D — verify catalyst"
- Gray card: "EXCLUDED — up +X% in 5 days"
- Orange badge: "EARNINGS IN X DAYS"
- Single VIX banner above ALL cards (not per-card): > 20 yellow / > 25 red

## Before modifying any scorer or UI
```bash
codegraph context "technical scorer"
codegraph impact computeTechnicalRankingsV2
```
Check `.claude/docs/phase-report-technical.md` for the full V2 design rationale.
