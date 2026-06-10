---
name: technical-scorecard
description: Load when building or modifying the technical scorecard. Signals, ranking logic, UI layout, and data requirements. Read trader-context.md and signal-filters.md alongside this.
model: claude-sonnet-4-20250514
max_tokens: 2000
---

# Technical Scorecard

## Purpose
Judgment-support tool. Shows signals, ranks candidates, surfaces warnings.
Does NOT output a single score or make decisions. Covers steps 1-4 of trader's process — step 5 (conviction) is always theirs.

---

## Signals (all from yahoo-finance2 + technicalindicators npm)

### Primary — Oversold gate
| Signal | Calc | Green | Yellow | Red |
|---|---|---|---|---|
| RSI 14d | technicalindicators RSI | < threshold | within 3pts | above |
| MFI 14d | technicalindicators MFI | < 25 | 25-30 | > 30 |

PRIMARY SIGNAL = GO when both fire / WATCH when one fires / NO when neither

### Gate — Recent Move filter
5d return = (price - price_5d_ago) / price_5d_ago * 100
T1: warn > +3% / T2-3: warn > -2% / ALL: gray-out > +8%

### Context — Relative weakness
- 52w position: (current - 52w_low) / (52w_high - 52w_low) * 100  →  lower = better
- vs SPY 20d: stock_20d_return - spy_20d_return  →  negative = relatively weak = better

### Context — Volatility
- IV from options chain  →  > 50% = juicy premiums, flag it
- ATR 14d from technicalindicators  →  helps judge if strike is truly safe OTM

### Supporting — Momentum
- MACD (12/26/9): show BULLISH CROSS / BEARISH / NEUTRAL
- Stochastic (14,3): < 20 = oversold confirmation

---

## Ranking logic
1. GO tickers first, sorted by: (52w_position * -1) + (vs_SPY_20d * -1) + (IV * 0.5)
2. WATCH tickers next
3. NO + EXCLUDED tickers at bottom, grayed out
4. Boost known high-premium tickers (AAOI, POET, INTC, RDDT, OPEN, SMCI, IONQ, RKLB, JOBY) when IV confirmed elevated

---

## Card display order
Top (always visible): ticker + tier badge + price + 1d% + PRIMARY SIGNAL badge + rank#
Bottom (expand or show): RSI/threshold · MFI/25 · 5d return+RM result · 52w position · vs SPY · IV% · strike + expiry + income%

## Warning overlays (on card, not separate section)
- Yellow border: "⚠ UP +X% 5D — verify catalyst"
- Gray card: "EXCLUDED — up +X% in 5 days" (still show RSI/MFI for monitoring)
- Orange badge: "EARNINGS IN X DAYS"
- Single banner above ALL cards (not per-card): VIX > 20 yellow / VIX > 25 red

---

## UI — reuse fundamental analysis template
Same card grid, header, and metric row components. Only new components needed:
  PrimarySignalBadge, SignalRow, RankBadge

Before writing any UI code, run:
  grep -r "StockCard\|MetricRow\|ScoreCard\|CompareCard" src/ --include="*.tsx" -l
  grep -r "FundamentalAnalysis" src/ --include="*.tsx" -l

---

## Data needed per ticker (one API call covers all)
- 90d daily OHLCV + volume (indicators need 60d min, 30d warmup)
- Current price + 52w high/low
- Options chain slice — nearest weekly expiry (see options-pricer.md)
- Earnings date from yf2 calendar
- VIX + SPY 20d return — fetch once, apply to all tickers

## technicalindicators usage
  RSI:        new RSI({ period:14, values:closes }).getResult()
  MFI:        new MFI({ period:14, high, low, close, volume }).getResult()
  ATR:        new ATR({ period:14, high, low, close }).getResult()
  MACD:       new MACD({ fastPeriod:12, slowPeriod:26, signalPeriod:9, values:closes }).getResult()
  Stochastic: new Stochastic({ period:14, signalPeriod:3, high, low, close }).getResult()
Use last value of each result array. Feed 90d to ensure stable output.

## Premium history cache
Store last known weekly income% per ticker in scorecard_cache table.
Updated on each options chain fetch. Lets trader see historically juicy tickers at a glance.
