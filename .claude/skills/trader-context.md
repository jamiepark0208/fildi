---
name: trader-context
description: Load when building any scoring, ranking, or analysis feature. Trader's mental model — reference only, not a prompt.
model: claude-sonnet-4-20250514
max_tokens: 500
---

# Trader Mental Model

## Core thesis
Good company + temporarily beaten down + elevated IV + OTM strike pays ~1%/week.
Scorecard surfaces candidates. Final call is always the trader's.

## Entry signals (in order of importance)
1. RSI < per-ticker threshold AND MFI < 25 (see signal-filters.md)
2. Near 1mo/3mo lows, underperforming SPY 20d, sector/macro selloff (not stock-specific)
3. Strike >= 8-10% OTM pays >= 0.8%/week at current IV

## Red flags (show warnings, never auto-exclude)
- Stock-specific drop: insider selling, dilution, debt issuance, guidance cut
- Outlier rally > 8% in 5 days without catalyst
- Earnings miss + guidance cut together (miss alone is less concerning)

## Sectors of interest
Semis, AI infrastructure, software, fintech, speculative growth (AI/flying cars/quantum)
Macro tailwinds: AI capex cycle, OBB Bill stimulus, rate cut expectations

## Known high-premium tickers (check first)
AAOI, POET, INTC, RDDT, OPEN, SMCI, IONQ, RKLB, JOBY

## Known low-premium tickers (deprioritize)
AAPL, GOOGL, AMZN — need large moves for decent OTM premium

## Sentiment (supporting, not triggers)
- Market-wide selloff = opportunity (macro fear ≠ stock weakness)
- Gov announcements for AI/flying cars/quantum = T3 catalyst
- Index inclusion = price floor (ex: OPEN Russell 3000)
- StockTwits/news: confirm catalyst on outlier moves only
