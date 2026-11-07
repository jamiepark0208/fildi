---
name: fildi-pattern-research
description: How to test technical / options indicators as trading context (swing lows/highs, support/resistance, liquidity zones, momentum, volume, skew) — lift tables, confluence and a combined model, graded in tiers, never a single pass/fail. Use for any "does indicator X help find lows/highs / entries / exits" question.
---
# Pattern research — indicators as context (Jamie 10-29)

Jamie: "I never asked for indicators to lead to long-term gains. I asked for patterns to find the lows and highs of a period
using momentum, support/resistance, liquidity zones, volume, options skew. Nobody said they were perfect — it's a framework
to build on." Every indicator study since A279/A314 was graded one at a time, on the wrong outcome (rest-of-day drop odds,
put breach, bp/week), with "must add over the existing risk score at |t| ≥ 2 in both halves" as a gate. That design
rejects almost any context signal by construction. This skill replaces it for indicator / pattern questions.

## 1. Grade the claim the indicator makes
- Swing tools (RSI, stochastic, divergence, Bollinger, support, volume nodes, hammer closes, skew spikes) claim **"price is
  near a turning point"**. Outcome = a **forward-only** turning-point label, e.g. good low = the next N days never trade
  > 0.25 ATR below today's low AND rally ≥ 1 ATR above the close (mirror for good high). Also report the path: further
  drop (ATR), rise (ATR), N-day return.
- **Never** use a window that includes past bars in the label ("lowest low of t−10 … t+10"): it matches "near a 20-day
  low" features by construction (10-29 smoke run: AUC 0.89 → 0.59 once forward-only).
- Trend / regime tools claim persistence; grade those on continuation odds, not on reversals.

## 2. Report probabilities, not verdicts
- **Lift table** per feature: quintile (or on/off) → P(outcome) ÷ base rate, per half, clustered by month. Tier on the
  weaker half: **strong ≥ 1.5× · useful ≥ 1.25× · weak ≥ 1.1× · none**, same direction in both halves.
- A weak/useful tier is a **result** ("closing in the top 14 % of the range: good-low odds 44 % vs 32 %"), not a fail.
  Lead with it (memory lead-with-what-works).
- Overlap with another feature is not a reason to drop it; the combined model sorts that out.

## 3. Combine — confluence and a model
- Confluence count (how many low-side conditions fire) → odds and path at each count.
- One combined model (sklearn HistGradientBoosting; all features; fit 2016–2022, check 2023–24, holdout 2025 → once):
  AUC, decile table (odds + forward path), permutation importance, and a comparison with the simple rule (RSI < 30 alone).
- The useful output is a **score Jamie can read**: "this name is in the top decile for a good low today (38 % vs 18 %
  bottom decile, base 29 %)".

## 4. Then (and only then) the trade translation
- Put entry: sell on top-decile good-low days vs any day → breach rate, premium, P&L per trade (`put_benchmark.py`).
- Call / covered call: top-decile good-high days.
- That step decides **how to use it** (timing, strike distance, sizing), not whether the indicator "exists".

## 5. Harness + data
- `scripts/watchlist_sync/analysis/pattern_lab.py` (daily, 565 names × 2016 →, `lseg_research.daily_history` OHLCV +
  30-d put/call IV). Smoke on ~10 names first (`--tickers=A,B --model`), then full (`--rebuild`).
- Intraday (day high/low): `optlab.bars_5m` (220 names, 2024-10 →) + `optlab.breadth_5m` — same design, label = the
  rest-of-day low/high holds.
- Options context: `optlab.skew_survey` (strike ladders, 10-19 →), `watchlist_sync.gex_daily` (walls, flip).
- Add a feature = add a column in `features()` + its name in `FEATS`. Cite the source (TradingView script, paper).

## 6. Keep from fildi-quant-research
Holdout once, both halves ([study contract](../../dispatch/_study-contract.md) §3–5), no look-ahead in features, numbers reproduce from the script, INDEX row after. The adoption bar
there still applies to **changing what the Model List / put engine picks** — not to whether a pattern is shown as context.
