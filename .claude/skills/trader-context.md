---
name: trader-context
description: Load when building any scoring, ranking, or analysis feature. Trader's mental model — reference only, not a prompt.
model: claude-sonnet-4-20250514
max_tokens: 500
---

# Trader Mental Model
> Rewritten 2026-10-06 to match the backtests (user approved). Evidence: `scripts/watchlist_sync/out/lab/conclusions.md`,
> `out/step4/conclusions.md`, `out/step8/conclusions.md`, `out/proto/gate1.md`. Factor homes: `scripts/watchlist_sync/FACTOR_MAP.md`.

## Core thesis
Sell puts on stocks I'd be happy to own, when the option is priced rich vs how the stock actually moves.
The average sold option is ≈ break-even; the edge is selection. Scorecard surfaces candidates. Final call is always the trader's.
Judge results by **wheel P&L** (options + assigned stock + dividends, `scripts/watchlist_sync/wheel.py`), not option win rate.
(2026-10: OPEN +$2.3k options, −$7.7k stock.)

## What to own (ranks the stock; strongest evidence)
1. Long-term uptrend: price above the 200-day average, positive 12-1 momentum.
2. Analyst support: StarMine alpha / IBES revisions top half (proxy for "I have a thesis"; my written thesis counts too).
3. Lower stock-specific volatility. Assigned high-vol names tend to keep falling.
4. A deep drawdown is a buy only with 1 + 2 (HOOD Feb 2026). Drawdown alone is a negative.

## When the option pays (ranks the contract)
- IV rich vs realized vol (IV/RV 70% + IV rank 30%). High IV level alone has no edge.
- Market insurance rich (SPY implied − realized > 4 pts): fewer losses. Selloff + rich VRP paid (2020, 2025, 2026);
  grinding bear where realized beats implied lost (2022).
- Earnings inside the window raise blow-up risk (keep the block).
- Size strike/delta to the win-rate table (Model List), not to a weekly income target.

## Entry timing: my own edge (S011, display only)
- My record (1,513 trades, 2026): puts sold after a 5-day drop ≥ 3% or near the 20-day low ended ITM 17% vs 26.5% without a dip;
  calls after a ≥ 3% rally got run over ~10% vs ~20%. Same sign both halves; P&L gap not yet significant. Model List shows a setup tag.
- Universe-wide, RSI / MFI / stochastics oversold and short-term reversal show no edge 2020–26 (S004) and dip-buying did worse in broad
  selloffs (S003). So: timing refines *when* on names I'd own; it never makes a name worth owning.

## Not edges (never a reason to trade)
- Falling knife alone (doesn't hurt put sellers once IV is accounted for).
- "~1%/week": chasing it pushes toward high-vol names (point 3 above).

## Covered calls
A cost, not income: on average CC − hold ≈ −0.8%/month. Worst after crashes and on 1-month momentum leaders.
If selling: near 52w highs, high IV/RV, ~0.10Δ after a rebound; never on core holdings (HOOD) or below cost basis.

## Red flags (show warnings, never auto-exclude)
- Stock-specific drop: insider selling, dilution, debt issuance, guidance cut
- Earnings miss + guidance cut together (miss alone is less concerning)
- Model List verdict red (Avoid): other surfaces defer to it

## Sectors of interest
Semis, AI infrastructure, software, fintech, speculative growth (AI/flying cars/quantum).
Speculative names: smaller size; they carry the stock-specific vol penalty.
Macro tailwinds: AI capex cycle, OBB Bill stimulus, rate cut expectations

## Sentiment (supporting, not triggers)
- Market-wide selloff = opportunity only when insurance is rich (VRP), not by itself
- Gov announcements for AI/flying cars/quantum = T3 catalyst
- Index inclusion = price floor (ex: OPEN Russell 3000)
- StockTwits/news: confirm catalyst on outlier moves only
