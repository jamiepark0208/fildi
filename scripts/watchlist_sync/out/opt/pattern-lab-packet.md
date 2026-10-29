# S147 pattern lab v1 — indicators as context for lows/highs (daily, 340 names, 2018-10 → 2026-10, holdout 2025 →)
Harness: analysis/pattern_lab.py · skill .agents/skills/fildi-pattern-research · 37 features (momentum, S/R pivots, 60-d volume profile, volume, volatility, put/call IV skew, SPY context).
Label fixes found on the way: (1) a t−10…t+10 window label → AUC 0.89 by construction; (2) a label anchored on today's low → "closed near the high" won by construction. Final label anchored on the close, future only.
- Exact turning point (good low = next 10 d never > 0.5 ATR below the close and +1 ATR rally): combined model AUC 0.54 holdout; top decile 24.8 % vs bottom 17.8 % (base 21.2 %). Single features ≤ 1.14× lift. → daily single-name turning points are only weakly predictable.
- Path / put risk (further drop ≥ 2 ATR in 10 d, base 31 %), ratio vs base in H1 / H2 / holdout:
  - riskier: bearish RSI divergence at highs 1.18 / 1.17 / 1.27 · IV ÷ RV top quintile 1.32 / 1.15 / 1.19 · far above MA200 1.16 / 1.14 / 1.22 · far above 52-w low 1.16 / 1.13 / 1.23 · up-climax day 1.17 / 1.11 / 1.13
  - safer: IV ÷ RV bottom quintile 0.60 / 0.83 / 0.79 · IV falling 5 d 0.68 / 0.89 / 0.84 · ATR in top 20 % of own year 0.88 / 0.83 / 0.84 (ATR units)
- RSI < 30 alone (holdout): further drop 1.02 vs 1.30 ATR median, 10-d return +1.7 % vs +0.4 %, good-low odds 26 % vs 21 %.
- Model top decile: median further drop 1.14 vs 1.50 ATR in the bottom decile.
Next: intraday (day high/low on 5-m bars), condition on pullback days, Yahoo backfill to widen 2018–23 coverage, put-entry translation via put_benchmark.
