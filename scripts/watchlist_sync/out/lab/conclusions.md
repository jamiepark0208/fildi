# Scorecard lab conclusions (2026-10-05): are our scorecards good, and how to improve them

Evidence: `report.md` (6-criteria report cards), `pca.md`, `weights.md`. Live engines replayed on 2020-02 → 2026-10
(252 names, 81 monthly + 349 weekly dates, 87k rows), graded against what each scorecard claims. Nothing live was changed.

## What "good" means here (strategy-neutral)
Each scorecard makes a claim about the stock; strategies (puts, calls, wheel) only decide how to use it.
| scorecard | claim | target |
|---|---|---|
| Technicals: trend | strength persists | return vs peers, 21 / 63 days |
| Technicals: entry timing | smaller near-term drop | worst drop over 21 days ÷ the vol that followed (σ units) |
| Options: pricing | options are rich vs what the stock then does | IV − realized vol next 21 days; worst drop / best rise in implied-σ units |
| Fundamentals | business / expectations improving → outperforms | return vs peers, 63 / 126 days |
Pass = 1 predictive (IC > 0, |t| ≥ 2, hit > 55%) · 2 monotonic quintiles · 3 stable (both halves, selloff and normal) ·
4 a weight change must beat the champion out of sample (paired t ≥ 2) · 5 beats a one-feature baseline · 6 not redundant.
Sanity checks passed: placebo IC +0.006; volatility mechanics removed (raw % drops and trailing-vol scaling both produced fake signals).

## Findings
**Technicals (v2 = UI/snapshots, v4 = options scanner)**
1. **Neither total score predicts anything** we tested: peer-relative return at 5/21/63 days, σ-normalized drawdown, or (v4 call)
   the stock running through a call. All |t| < 1.6. Weight variants don't help (no variant differs from the champion, `weights.md`).
2. **The only technical signal that passes is long-term trend** (price vs 200-day average in ATR units, already computed live but
   unused, plus 12-1 momentum): IC +0.042 (t 2.6) at 63 days, +0.049 (t 2.9) in 2024–26 alone; stable; not redundant.
   It fails in broad selloffs (top-trend names lag the bottom by 0.3% in those months vs +0.9% ahead normally): momentum-crash pattern.
3. Short-term parts (oversold depth, reversal, MA50 context, volume, relative pressure) show no edge; reversal is slightly negative.
4. **v2 and v4 are near-duplicates** (shared components correlate 0.89–1.00). Two engines = two places for the same logic.
5. **Volatility State isn't technical: it measures option richness.** It predicts realized VRP (IC +0.10, t 7.2), not stock moves.
6. **Live v2 uses a realized-vol proxy for "IV rank" that is wrong-signed** for option richness (IC −0.030, t −2.4 with IV fixed);
   true IV rank (LSEG history) is +0.084.
7. **Live drift bug:** percentile inputs are computed over *every stored bar*, so backfills silently change live scores. The 10/05 rows
   were computed on ~289 bars; the same day on today's ~340 bars moves rsi14Pct / mfi / stoch / BB-width by up to 0.12. Level
   fields (RSI, MA distances, regime, MACD, falling knife) reproduce exactly (60/60), so the replay itself is faithful.

**Options**
8. **IV/RV is the best single pricing signal** (VRP IC +0.128, t 8.9, 86% of months). The combined **0.7 · IV/RV + 0.3 · IV rank**
   (today's Model List PREMIUM) passes every criterion: VRP IC +0.137 (t 10.1, 90% of months; quintiles 1.1 → 6.1 pts),
   put breach +0.052 (t 3.5), call breach +0.054 (t 3.6). BB squeeze adds nothing.
9. Calls: **don't sell calls into 20-day relative strength** (−20d vs SPY IC +0.040, t 2.4); RSI "overbought" doesn't help (−0.020).
   This is the measurable part of the HOOD lesson. The v4 call score doesn't predict call risk (−0.022).
10. Contract-level parts (income, buffer, delta, DTE, liquidity) can't be backtested without chain history; graded live by grade_ledger.

**Fundamentals** (only the analyst-expectations family has point-in-time history)
11. Revision breadth and estimate drift predict 63-day peer-relative return (t 2.7 / 3.5) but **add ~nothing beyond trend**
    (+0.008, t 0.6 with trend held fixed): revisions mostly follow price.
12. **SUE (avg of last 4) and estimate dispersion show no edge** (−0.006 / −0.017).
13. Quality / value / growth / safety are **not testable yet**: filed-date statement history covers 20 names.

**Regime**
14. Rich market VRP (SPY IV − RV > 4 pts): 19% of stocks fall more than one implied σ vs 28% in panic months (realized > implied).
    Broad selloffs switch the trend factor off. The regime layer earns a place as a **dial** (size, delta, trend weight), not a stock score.

## Proposed changes (each needs your approval; scorecard edits are Cursor's lane per A15)
| # | owner | change | evidence |
|---|---|---|---|
| T1 | Cursor | Fix live drift: compute percentile inputs on a fixed 252-bar window | finding 7 |
| T2 | Cursor | One technical engine (merge v2/v4); side flip moves to the Model List | 4 |
| T3 | Cursor | Add TREND (price vs MA200 ATR + 12-1 momentum) as the technical score's main component | 2 |
| T4 | Cursor | Short-term parts → displayed "entry timing" context at weight 0, re-enable only if live grades prove them | 1, 3 |
| O1 | Cursor | Move Volatility State out of technicals; options PRICING = 0.7 IV/RV + 0.3 true IV rank, single home | 5, 8 |
| O2 | Cursor | Replace the RV-proxy IV rank with LSEG IV history (daily_history) everywhere; drop BB squeeze | 6, 8 |
| O3 | Cursor | Remove stock-quality from the option score (the Model List combines lanes) | layering |
| F1 | Cursor | Drop or redesign ibesSue; keep breadth/drift in fundamentals | 11, 12 |
| F2 | Cursor | Data: filed-date statement history for the universe (SEC companyfacts) so the other 4 families can be graded | 13 |
| M1 | Claude | Model List reads lane outputs only: ownership = fund + TECH TREND (weighted jointly, not double-counted), pricing = options PRICING, regime dial | 2, 8, 11, 14 |
| M2 | Claude | Covered-call guard: no calls on top-quintile 20-day relative strength; prefer high IV/RV | 9 |
| R1 | you + Cursor | Who owns the regime dial (it touches options VIX bands, market_regime, Model List pause) | 14 |

## How to re-test (≈ 1.5 minutes end to end, no vendor calls)
1. `artifacts/api-server`: `pnpm exec tsx src/scripts/lab-replay-technicals.ts` (+ `--freq=week`), 9 s / 33 s. Rows are keyed by an
   engine digest, so an engine edit replays side by side with the old one; `--variant=ivhist` tests a changed input.
2. `scripts/watchlist_sync`: `.venv/bin/python analysis/lab_outcomes.py` (20 s, only when new dates exist), `analysis/lab_fund_features.py` (1 s).
3. `.venv/bin/python analysis/lab.py [report|pca|weights] [--engine DIGEST]`: 2 s from cache.
4. Fidelity: `pnpm exec tsx src/scripts/lab-fidelity-technicals.ts --source=ph` (should match levels 100%; percentiles match once T1 ships).
