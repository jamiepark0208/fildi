# Step 8: what makes a trade good? PCA factors + scenarios (2026-10-05)

17,310 reconstructed monthly ~0.20Δ 30-day puts · 259 tickers · 2020-03-02 → 2026-09-01 (79 months) · fill haircut 0.85

Not testable with current data: put skew and IV term structure (LSEG ATM call IV = put IV; 90-day IV is ~0% covered), fundamentals/valuation (no point-in-time history), size (no market-cap history), and the qualitative thesis (StarMine analyst alpha is used as the closest point-in-time proxy).

## 1. Stock-level PCA (what the 16 trade-entry features boil down to)

Features are ranked within each month, so this is about *which names* to pick in a given month. 6 components explain 82% of the variation.

| PC | variance | top loadings | IC put premium kept | IC wheel campaign (in premiums) | IC stock vs peers, 3 mo | IC call premium kept |
|---|---|---|---|---|---|---|
| PC1 | 30% | +dd_52w, +dist_ma50, +dist_ma200 | +0.012 (t +0.3) | -0.017 (t -0.4) | +0.024 (t +2.3) | +0.063 (t +1.2) |
| PC2 | 20% | +iv30, +idio_vol, +beta | +0.003 (t +0.1) | +0.065 (t +1.3) | +0.018 (t +1.5) | -0.063 (t -1.1) |
| PC3 | 11% | +earnings_in_window, +iv_rank_1y, +iv_rv | +0.034 (t +1.6) | +0.014 (t +0.8) | -0.017 (t -1.5) | -0.008 (t -0.4) |
| PC4 | 11% | +mom_12_1, +dist_ma200, −rev5 | +0.027 (t +1.1) | +0.011 (t +0.5) | +0.030 (t +2.7) | -0.056 (t -2.2) |
| PC5 | 6% | +iv_rv, −iv_rank_1y, −earnings_in_window | +0.003 (t +0.2) | +0.010 (t +0.7) | +0.005 (t +0.4) | -0.032 (t -2.1) |
| PC6 | 5% | +rev5, −mom20, −dist_ma50 | +0.036 (t +1.9) | +0.015 (t +0.9) | -0.011 (t -1.0) | -0.038 (t -1.6) |

Full loadings (rows = features, columns = PCs):

| feature | PC1 | PC2 | PC3 | PC4 | PC5 | PC6 |
|---|---|---|---|---|---|---|
| iv_rv | -0.04 | -0.02 | +0.51 | +0.06 | +0.81 | +0.10 |
| iv_rank_1y | -0.04 | +0.02 | +0.58 | +0.09 | -0.51 | -0.13 |
| iv30 | -0.30 | +0.42 | +0.06 | +0.14 | -0.03 | -0.03 |
| idio_vol | -0.30 | +0.42 | -0.09 | +0.10 | +0.03 | -0.00 |
| beta | -0.24 | +0.37 | -0.13 | +0.14 | -0.01 | +0.02 |
| mom20 | +0.32 | +0.33 | +0.04 | -0.21 | +0.02 | -0.34 |
| dist_ma50 | +0.36 | +0.33 | +0.02 | -0.09 | +0.04 | -0.28 |
| rsi14 | +0.31 | +0.30 | +0.05 | -0.28 | +0.03 | +0.02 |
| rev5 | +0.20 | +0.25 | +0.07 | -0.30 | -0.13 | +0.84 |
| mom_12_1 | +0.17 | +0.06 | -0.12 | +0.68 | -0.03 | +0.26 |
| dist_ma200 | +0.33 | +0.21 | -0.07 | +0.44 | +0.03 | -0.05 |
| dd_52w | +0.44 | -0.06 | +0.01 | +0.19 | +0.09 | +0.01 |
| combined_alpha_rank | +0.27 | -0.28 | +0.05 | +0.08 | -0.16 | +0.02 |
| earnings_in_window | -0.03 | +0.07 | +0.59 | +0.14 | -0.17 | +0.03 |

## 2. Individual factors: monthly rank IC (Fama-MacBeth, Newey-West t, lag 3)

IC > 0 → a higher value of the factor means a better outcome. **All ICs hold the IV level fixed** (outcome rank residualized on IV rank within each month), except the iv30 row itself, which is raw. |t| ≥ 2 is the usual bar; ICs of 0.02–0.05 are what real factors look like.

| factor | put premium kept | wheel campaign (in premiums) | stock vs peers, 3 mo | call premium kept |
|---|---|---|---|---|
| iv_rv | +0.030 (+1.7) | +0.021 (+1.2) | -0.003 (-0.2) |  **-0.038 (-2.0)** |
| iv_rank_1y | +0.026 (+1.1) | +0.013 (+0.6) |  **-0.020 (-2.2)** | +0.015 (+0.7) |
| iv30 | -0.032 (-1.7) | -0.026 (-1.6) | +0.019 (+0.6) |  **+0.043 (+2.2)** |
| idio_vol | -0.022 (-0.3) | +0.059 (+0.9) | -0.003 (-0.6) | -0.094 (-1.2) |
| beta | +0.006 (+0.1) | +0.059 (+1.2) | +0.029 (+1.4) | -0.082 (-1.6) |
| mom20 | +0.005 (+0.2) | +0.021 (+0.9) | +0.011 (+0.9) |  **+0.050 (+2.2)** |
| dist_ma50 | -0.008 (-0.4) | +0.024 (+1.0) | +0.026 (+1.9) | +0.047 (+2.0) |
| rsi14 | +0.000 (+0.0) | +0.023 (+1.2) | +0.013 (+1.2) | +0.012 (+0.7) |
| rev5 | +0.016 (+0.8) | +0.024 (+1.1) | -0.008 (-0.9) | +0.014 (+0.6) |
| mom_12_1 | +0.034 (+1.3) | +0.019 (+0.7) |  **+0.032 (+2.3)** | -0.047 (-1.5) |
| dist_ma200 | +0.032 (+1.5) | +0.020 (+0.8) |  **+0.043 (+3.2)** | -0.018 (-0.6) |
| dd_52w | +0.021 (+0.5) | -0.028 (-0.7) |  **+0.026 (+2.4)** | +0.059 (+1.1) |
| combined_alpha_rank | +0.023 (+0.5) | -0.030 (-0.7) |  **+0.034 (+2.1)** | +0.062 (+1.3) |
| earnings_in_window | +0.013 (+0.5) | +0.005 (+0.2) | -0.002 (-0.4) | -0.045 (-1.9) |

### 2b. Assigned puts only: which entry factors predicted the stock recovering 3 months after assignment?

Target = stock price 63 trading days after assignment ÷ strike, relative to the other assigned names that month. Months with ≥ 8 assignments only.

| factor | IC | t | months |
|---|---|---|---|
| iv_rv | +0.013 | +0.6 | 66 |
| iv_rank_1y | -0.039 | -1.5 | 66 |
| iv30 | **-0.136** | -2.8 | 66 |
| idio_vol | **-0.125** | -2.7 | 65 |
| beta | -0.028 | -0.6 | 65 |
| mom20 | +0.013 | +0.4 | 66 |
| dist_ma50 | +0.053 | +1.4 | 66 |
| rsi14 | +0.042 | +1.8 | 66 |
| rev5 | -0.036 | -1.1 | 66 |
| mom_12_1 | +0.039 | +1.0 | 62 |
| dist_ma200 | **+0.089** | +2.9 | 62 |
| dd_52w | **+0.110** | +2.6 | 66 |
| combined_alpha_rank | **+0.157** | +3.1 | 66 |
| earnings_in_window | -0.013 | -0.6 | 63 |

## 3. Out-of-sample importance (train on earlier years, test 2022–2026; drop one factor group)

Full model = all stock features. Δ = how much out-of-sample IC is lost when the group is removed (bigger = more important, and not replaceable by the other features).

| group | Δ put premium kept | Δ wheel campaign (in premiums) | Δ stock vs peers, 3 mo | Δ call premium kept |
|---|---|---|---|---|
| **full model OOS IC** | **-0.053** (t -1.4) | **-0.014** (t -0.2) | **+0.036** (t +3.0) | **+0.068** (t +1.4) |
| vol pricing (IV vs RV, IV rank) | -0.004 | +0.003 | +0.004 | -0.000 |
| vol level / risk (IV, idio vol, beta) | -0.008 | -0.005 | +0.011 | -0.001 |
| short-term trend (1m mom, MA50, RSI, 5d reversal) | +0.008 | -0.005 | -0.003 | +0.009 |
| long-term trend (12-1 mom, MA200) | +0.008 | -0.034 | -0.000 | +0.009 |
| drawdown from 52w high | -0.000 | -0.004 | -0.001 | -0.003 |
| analyst revisions (StarMine alpha) | +0.004 | +0.000 | +0.011 | -0.005 |
| earnings in window | -0.008 | -0.002 | -0.000 | -0.002 |

## 4. Market regime (time series: does *when* you sell matter?)

One row per month (76 months). Market PCA: MPC1 53% = +spy_dd_52w, +mkt_med_dd, +spy_m20; MPC2 16% = +dispersion, −spy_vrp, +breadth50; MPC3 11% = +dispersion, +spy_vrp, −breadth50.

Correlation of the month's average outcome (all names) with each regime variable (Newey-West t on the product of z-scores):

| regime variable | put premium kept | wheel campaign (in premiums) | stock vs peers, 3 mo | call premium kept |
|---|---|---|---|---|
| mkt_med_dd | +0.06 (t +0.5) | -0.04 (t -0.4) | +0.16 (t +1.2) | -0.01 (t -0.1) |
| spy_m20 | -0.13 (t -1.3) | -0.07 (t -1.0) | +0.03 (t +0.4) | +0.05 (t +0.4) |
| spy_dd_52w | -0.06 (t -0.6) | -0.08 (t -0.8) | +0.11 (t +1.0) | +0.05 (t +0.4) |
| spy_iv | +0.25 (t +2.0) | +0.06 (t +0.8) | +0.15 (t +0.9) | -0.07 (t -0.7) |
| spy_vrp | +0.08 (t +0.6) | +0.11 (t +1.3) | +0.08 (t +0.7) | -0.14 (t -1.9) |
| breadth50 | -0.01 (t -0.2) | -0.01 (t -0.1) | +0.07 (t +0.7) | +0.09 (t +0.7) |
| dispersion | +0.07 (t +0.7) | -0.13 (t -0.8) | -0.06 (t -0.7) | +0.02 (t +0.4) |
| MPC1 | -0.07 (t -0.7) | -0.06 (t -0.6) | +0.06 (t +0.5) | +0.04 (t +0.3) |
| MPC2 | +0.05 (t +0.4) | -0.11 (t -0.9) | -0.03 (t -0.3) | +0.09 (t +1.1) |
| MPC3 | +0.14 (t +1.0) | -0.01 (t -0.1) | -0.05 (t -0.7) | -0.12 (t -1.2) |

**Breadth: the median stock's drawdown from its 52-week high at entry**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| deep (> 30%) | 2,244 | -0.01% | 21% | 25% | +1.61% | -2.0% | +1.1% | -0.83% | 16% |
| broad selloff (20–30%) | 3,677 | +0.43% | 17% | 20% | +1.64% | -1.5% | +2.4% | -0.40% | 15% |
| soft (12–20%) | 6,484 | +0.30% | 16% | 19% | +1.70% | +0.1% | +3.9% | -1.24% | 18% |
| healthy (< 12%) | 4,905 | +0.44% | 16% | 19% | +0.95% | -3.7% | +2.9% | -0.48% | 15% |

**SPY drawdown from its 52-week high at entry**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| bear (> 20% down) | 855 | +1.92% | 4% | 5% | +2.52% | +4.3% | +1.6% | -3.76% | 34% |
| correction (10–20%) | 2,239 | -0.51% | 26% | 30% | +2.27% | +1.2% | +1.6% | +0.71% | 8% |
| pullback (5–10%) | 2,569 | +0.32% | 15% | 17% | +1.29% | -3.0% | +3.7% | -1.14% | 19% |
| near highs (< 5%) | 11,647 | +0.38% | 16% | 19% | +1.27% | -2.3% | +3.1% | -0.79% | 16% |

**SPY 30-day implied vol at entry (VIX proxy, terciles)**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| calm (< 13) | 5,497 | -0.23% | 23% | 27% | +0.21% | -5.8% | +2.6% | -0.60% | 15% |
| normal (13–17) | 5,670 | +0.46% | 14% | 17% | +2.03% | +2.0% | +3.6% | -0.89% | 17% |
| stressed (> 17) | 5,722 | +0.69% | 14% | 16% | +2.09% | +0.9% | +2.7% | -0.89% | 17% |

**SPY implied − realized vol (variance risk premium)**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| negative (realized > implied: panic) | 6,622 | +0.08% | 19% | 22% | +1.06% | -3.5% | +3.1% | -0.15% | 14% |
| 0–4 pts | 7,932 | +0.31% | 17% | 21% | +1.48% | -1.2% | +2.5% | -1.02% | 17% |
| > 4 pts (rich insurance) | 2,335 | +1.02% | 9% | 11% | +2.63% | +7.2% | +4.1% | -1.87% | 21% |

## 5. Your HOOD logic: deep stock drawdown × market selloff

Stock 'deep drawdown' = bottom quintile of 52w-high drawdown that month. **Broad selloff = the median stock is ≥ 20% below its 52w high** (breadth; Feb 2026 qualified at −21% while SPY was only −2.6%).

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| broad selloff · deep drawdown (Q1) | 1,186 | +1.01% | 19% | 22% | +3.24% | -1.6% | +4.2% | -1.06% | 14% |
| broad selloff · middle (Q2–Q4) | 3,549 | +0.04% | 19% | 22% | +1.31% | -2.1% | +1.6% | -0.56% | 17% |
| broad selloff · near high (Q5) | 1,186 | +0.19% | 15% | 19% | +0.96% | -1.0% | +0.3% | -0.08% | 14% |
| market normal · deep drawdown (Q1) | 2,281 | +0.60% | 18% | 22% | +1.97% | -4.1% | +6.9% | -1.02% | 13% |
| market normal · middle (Q2–Q4) | 6,814 | +0.27% | 16% | 18% | +1.21% | -1.1% | +3.0% | -0.99% | 18% |
| market normal · near high (Q5) | 2,293 | +0.41% | 14% | 17% | +1.26% | +0.3% | +1.5% | -0.56% | 18% |

Adding a thesis proxy (StarMine combined alpha in the top half that month — the closest point-in-time stand-in for 'I like this company for reasons'):

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| broad selloff · deep dd + alpha top half | 161 | +1.38% | 12% | 16% | +2.57% | -3.0% | +1.6% | -0.78% | 16% |
| broad selloff · deep dd + alpha bottom half | 995 | +0.99% | 19% | 23% | +3.35% | -1.3% | +4.8% | -1.04% | 13% |
| market normal · deep dd + alpha top half | 417 | +0.62% | 16% | 19% | +4.19% | +11.3% | +6.8% | -0.89% | 14% |
| market normal · deep dd + alpha bottom half | 1,809 | +0.57% | 18% | 22% | +1.36% | -7.4% | +7.1% | -1.07% | 13% |

Pullback in a long-term uptrend (HOOD: 20th pct drawdown, 92nd pct 12-month momentum in Feb 2026). Deep dd = bottom 40%; trend = 12-1 momentum:

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| deep dd + 12m downtrend (bottom 40%) (869 assigned) | 3,987 | +0.24% | 19% | 23% | +1.62% | -3.6% | +3.9% | -0.96% | 14% |
| deep dd + 12m uptrend (top 40%) (316 assigned) | 1,457 | +0.81% | 18% | 23% | +1.82% | -5.0% | +3.2% | -0.87% | 14% |
| deep dd + uptrend + alpha top half (54 assigned) | 314 | +0.89% | 16% | 19% | +2.71% | +3.3% | +10.4% | -0.58% | 15% |

## 6. When do covered calls cost you? (CC − hold by 1-month momentum and 52w position)

CC − hold < 0 means the call gave away more upside than it paid. Kept = premium kept on the call.

| bucket | trades | CC − hold | median call kept | calls finishing ITM |
|---|---|---|---|---|
| 1m momentum top quintile | 3,467 | -1.26% | +1.00 | 16% |
| 1m momentum bottom quintile | 3,467 | -1.05% | +1.00 | 14% |
| near 52w high (top quintile) | 3,479 | -0.40% | +1.00 | 17% |
| deep below high (bottom quintile) | 3,467 | -1.03% | +1.00 | 13% |
| momentum top AND near high | 1,321 | -0.86% | +1.00 | 18% |
| all | 17,309 | -0.79% | +1.00 | 16% |
| market selloff (SPY ≥10% off high) | 3,094 | -0.53% | — | — |
| market near highs | 11,647 | -0.79% | — | — |

## 7. Named episodes

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| Covid crash entry (2020-03, 2020-04) | 176 | +3.19% | 1% | 1% | +3.77% | +71.0% | +4.6% | -0.69% | 23% |
| 2021 bull | 2,370 | +0.48% | 14% | 17% | +0.47% | -6.9% | +1.3% | -0.36% | 16% |
| 2022 bear | 2,302 | -1.25% | 30% | 34% | -2.12% | -12.0% | +1.2% | +0.70% | 8% |
| 2023–24 bull | 5,467 | +0.42% | 16% | 20% | +1.95% | +1.7% | +3.2% | -1.54% | 19% |
| 2025 tariff shock (Mar–Apr) | 487 | +0.54% | 17% | 22% | +4.99% | +14.4% | +0.3% | +1.01% | 5% |
| 2026 Feb–Mar selloff (your HOOD entries) | 469 | +0.11% | 22% | 27% | +4.48% | +9.1% | +4.1% | +0.35% | 9% |
| 2026 Apr → now | 1,475 | +0.71% | 15% | 19% | +1.79% | -3.1% | +2.1% | -1.59% | 18% |

## 8. Decision-rule scenarios (what if the Model List had picked trades this way?)

**Single filters**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| all trades (baseline) | 17,310 | +0.33% | 17% | 20% | +1.46% | -1.6% | +2.9% | -0.79% | 16% |
| IV/RV top 40% | 6,925 | +0.45% | 16% | 20% | +1.50% | -2.4% | +3.9% | -0.73% | 16% |
| no earnings in window | 12,069 | +0.31% | 17% | 20% | +1.60% | -0.4% | +2.9% | -0.63% | 16% |
| deep 52w drawdown (bottom 40%) | 6,925 | +0.49% | 18% | 21% | +1.71% | -3.9% | +4.3% | -0.96% | 14% |
| StarMine alpha top half | 8,037 | +0.25% | 16% | 18% | +1.46% | +1.2% | +1.7% | -0.50% | 18% |
| market selloff only (SPY ≥ 10% off high) | 3,094 | +0.16% | 20% | 23% | +2.34% | +1.3% | +1.6% | -0.53% | 15% |
| broad selloff only (median stock ≥ 20% off high) | 5,921 | +0.27% | 18% | 22% | +1.63% | -1.8% | +1.8% | -0.56% | 16% |
| SPY implied > realized (VRP > 0) | 10,267 | +0.47% | 15% | 19% | +1.74% | -0.0% | +2.9% | -1.21% | 18% |

**Combinations**

| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |
|---|---|---|---|---|---|---|---|---|---|
| IV/RV top 40% + no earnings | 4,002 | +0.43% | 16% | 19% | +1.77% | -0.6% | +4.3% | -0.50% | 15% |
| + alpha top half | 1,672 | +0.24% | 16% | 18% | +1.73% | +2.7% | +1.7% | -0.33% | 17% |
| + deep drawdown (HOOD-style entry) | 392 | +0.70% | 14% | 15% | +2.74% | +5.8% | +4.0% | -0.55% | 15% |
| + deep drawdown + broad selloff | 116 | +0.60% | 16% | 19% | +1.53% | -6.9% | -1.7% | -0.69% | 19% |
| deep drawdown + alpha top + broad selloff (no IV filter) | 519 | +0.75% | 15% | 18% | +2.48% | +1.9% | +0.5% | -0.77% | 18% |
| deep drawdown + broad selloff (no other filter) | 2,368 | +0.60% | 18% | 22% | +2.14% | -3.9% | +2.7% | -0.92% | 15% |

## 9. Stability: same factor IC in the first half vs the second half (IV held fixed)

| factor | campaign 2020–22 | campaign 2023–26 | vs peers 2020–22 | vs peers 2023–26 |
|---|---|---|---|---|
| iv_rv | +0.022 | +0.020 | +0.013 | -0.015 |
| iv_rank_1y | -0.010 | +0.029 | -0.036 | -0.009 |
| iv30 | +0.145 | +0.018 | +0.004 | +0.009 |
| idio_vol | +0.131 | +0.011 | -0.007 | -0.000 |
| beta | +0.111 | +0.024 | +0.043 | +0.019 |
| mom20 | +0.009 | +0.030 | +0.008 | +0.012 |
| dist_ma50 | -0.000 | +0.042 | +0.036 | +0.019 |
| rsi14 | -0.016 | +0.051 | +0.002 | +0.022 |
| rev5 | -0.004 | +0.044 | -0.028 | +0.006 |
| mom_12_1 | -0.042 | +0.052 | +0.026 | +0.036 |
| dist_ma200 | -0.049 | +0.059 | +0.041 | +0.044 |
| dd_52w | -0.109 | +0.032 | +0.022 | +0.029 |
| combined_alpha_rank | -0.084 | +0.009 | +0.042 | +0.028 |
| earnings_in_window | -0.008 | +0.013 | +0.002 | -0.005 |

## 10. Where HOOD's Feb–Apr 2026 entries ranked on each factor (percentile within that month; 100 = highest value)

| entry | dd_52w | iv_rv | iv_rank_1y | mom20 | mom_12_1 | combined_alpha_rank | idio_vol | median stock dd | spy_dd_52w | premium kept | campaign |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-01-02 | 36 | 20 | 3 | 6 | 97 | 58 | 72 | -18% | -1.0% | -1.36 | -27.18% |
| 2026-02-02 | 20 | 66 | 44 | 3 | 92 | 58 | 73 | -19% | -0.0% | +1.00 | +2.48% |
| 2026-03-02 | 16 | 13 | 35 | 8 | 87 | 21 | 69 | -21% | -1.3% | +1.00 | +2.31% |
| 2026-04-01 | 14 | 39 | 34 | 16 | 80 | 24 | 69 | -24% | -5.8% | +1.00 | +2.34% |
| 2026-05-01 | 12 | 5 | 2 | 46 | 66 | 14 | 71 | -18% | +0.0% | +1.00 | +1.75% |
