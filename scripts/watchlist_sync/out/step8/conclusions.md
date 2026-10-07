# Step 8 conclusions (2026-10-05): what makes a trade good — factors ranked with evidence

Data: 17,310 reconstructed monthly ~0.20Δ 30-day puts, 259 names, Mar 2020 → Sep 2026 (`factor_pca.md`, robustness without HOOD in
`factor_pca_ex_HOOD.md` — no material change). Script: `analysis/factor_pca.py`. Read-only; no model params changed.

## Method
1. **"Good trade" graded four ways**, because a put does two jobs: income (put premium kept), ownership (wheel campaign: put → assigned →
   hold 3 months; stock vs strike 3 months after assignment; stock vs sector peers 3 months), plus covered call vs holding.
   All are volatility-neutral (premium units or vs peers). Raw returns are not: an unexpired put just returns premium/strike, so
   high-IV names "win" by construction (first pass showed fake ICs of 0.4–0.7 from this).
2. **PCA** on 14 point-in-time features (monthly cross-sectional ranks): 6 components explain 82%.
   PC1 trend/position (52w drawdown, MA50, MA200) 30% · PC2 risk (IV, idio vol, beta) 20% · PC3 vol event (earnings, IV rank, IV/RV) 11% ·
   PC4 long-term momentum 11% · PC5 IV rich-vs-realized 6% · PC6 short-term reversal 5%.
   Market PCA (76 months): MPC1 = market drawdown/stress 53%.
3. **Importance** = Fama-MacBeth monthly rank IC with IV held fixed (Newey-West t), walk-forward out-of-sample IC (train < year, test 2022–26),
   and scenario tables (regimes, named episodes, decision rules).

## Ranked factors

| # | Factor (theme) | Job it predicts | Evidence | Strength |
|---|---|---|---|---|
| 1 | **Analyst revisions (StarMine alpha)**, the closest point-in-time proxy for "I have a thesis" | Ownership: stock recovers after assignment | IC +0.157 (t 3.1); vs peers +0.034 (t 2.1) | strongest stock factor |
| 2 | **Long-term trend** (above MA200, 12-1 momentum) | Ownership | after assignment +0.089 (t 2.9); vs peers +0.043 (t 3.2), +0.032 (t 2.3) | strong, stable in both halves |
| 3 | **Idiosyncratic vol / IV level** | Ownership (negative) | after assignment −0.125 (t −2.7), −0.136 (t −2.8) | strong: assigned high-vol names keep falling |
| 4 | **Market variance premium** (SPY implied − realized) | When to sell | VRP > 4 pts: puts lose 9% of the time vs 17% baseline; campaign +2.63% vs +1.46%; stock +7.2% vs strike after assignment | strong in scenarios; time-series t ≈ 1–2 (76 months) |
| 5 | **52w drawdown** | Ownership: *closer* to the high recovers better | after assignment +0.110 (t 2.6) | a deep drawdown alone is a negative, not a buy signal |
| 6 | IV rich vs realized (IV/RV) | Income | premium kept +0.030 (t 1.7); Step 4: t 4 on risk-adjusted return | modest |
| 7 | Earnings in window, short-term trend, RSI | — | |t| < 2 once IV is held fixed | weak / redundant (same PC as trend) |

**Premium kept is barely predictable from stock factors** (walk-forward OOS IC −0.05, n.s.). The ownership outcome is predictable
(OOS IC +0.036, t 3.0). For put selling, which names you'd be happy to own matters more than how rich the premium is.

## Your HOOD logic, tested
- **Deep drawdown + thesis works; deep drawdown alone does not.** Deep drawdown in a 12-month uptrend: stock −5.0% vs strike after assignment.
  Same plus analyst support (top half): **+3.3% after assignment, +10.4% vs peers, campaign +2.71%** (54 assignments, so suggestive).
  HOOD in Feb 2026: 20th-percentile drawdown, 92nd-percentile 12-month momentum, 58th-percentile alpha, plus your own thesis.
- **Market conditions: breadth, not SPY.** In Feb 2026 the median stock was −21% from its high while SPY was −2.6%. Selloff entries paid
  when insurance was rich: Covid 2020 campaign +3.8%, 2025 tariff shock +5.0%, Feb–Mar 2026 +4.5%. They lost in the grinding 2022 bear
  (−2.1%, 30% of puts lost money), where realized vol kept beating implied. A selloff alone isn't the signal; selloff + rich VRP is.
- **Covered calls:** on average CC − hold = −0.79%/month. Worst after crashes (SPY > 20% down: −3.76%, 34% of calls lose) and in
  1-month momentum leaders (−1.26%). Least costly near 52w highs (−0.40%). HOOD's expensive calls were sold during a rebound off a deep low,
  which is the costly regime (Daniel-Moskowitz rebound; Israelov-Nielsen: a CC is short the stock's upside).

## Proposed Model List changes (need your approval; nothing applied)
1. **Split the put score into Ownership × Pricing.** Ownership = analyst alpha + long-term trend − idio vol (+ your conviction flag).
   Pricing = IV/RV + IV rank. Rank puts on ownership first; use pricing for strike and size.
2. **Deep drawdown needs a thesis.** Only reward a 52w drawdown when alpha is top half (or you've flagged conviction); otherwise treat it as neutral.
3. **Regime dial from breadth + VRP.** Rich VRP → normal or larger size. Calm (SPY IV < 13: 23% put losses, campaign +0.2%) or
   realized > implied → smaller size or further OTM.
4. **Covered-call guard.** After a deep-low rebound or a broad-market rebound, suggest ~0.10Δ calls or skip; mark core holdings (HOOD) "don't cap".
5. **learn.py targets:** add stock-after-assignment and vs-peers outcomes next to premium kept (A24), with before/after and approval as usual.
6. **Conviction field (new idea):** a per-ticker thesis note and score you set (like your HOOD reasons). Qualitative theses can't be backtested;
   StarMine is the quantitative cross-check.

## Caveats
Simulated trades (monthly, 0.20Δ, ATM IV, no skew), so real fills and strikes differ. StarMine is a proxy for a thesis, not your thesis.
Regime results rest on 76 months (scenario tables are clearer than the t-stats). Not testable yet: fundamentals/valuation history, size,
skew/term structure.

## Sources used as the starting factor set
Fama & French (1993, 2015) · Carhart (1997) momentum · Jegadeesh (1990) short-term reversal · Jegadeesh & Titman (1993) ·
George & Hwang (2004) 52-week high · Goyal & Saretto (2009) IV − historical vol and option returns · Carr & Wu (2009) and
Bollerslev, Tauchen & Zhou (2009) variance risk premium · Ang, Hodrick, Xing & Zhang (2006) idiosyncratic vol · Cao & Han (2013) option
returns and idio vol · Frazzini & Pedersen (2014) beta · Daniel & Moskowitz (2016) momentum crashes · Israelov & Nielsen (2015)
covered calls uncovered · Kelly, Pruitt & Su (2019) characteristics → latent factors (IPCA).
