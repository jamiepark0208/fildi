# Step 4 v2: reconstructed put-selling backtest (2026-10-05)

17,245 monthly trades · 258 tickers · 2020-03-02 → 2026-09-01 · ~0.20Δ put, 30d, Black-Scholes at LSEG 30d ATM put IV × 0.85 fill haircut

**Baseline:** mean +0.33% of collateral/month · median +1.11% · win 83% · assigned 20% · loss beyond 1 implied σ 2.0% · worst -54.6%

**Scoring:** risk-adjusted return = return on collateral ÷ the option's own implied 1σ move. Raw return mechanically favors high-IV names (bigger premium) while hiding their blow-ups, so v1's raw-return table was misleading. *IC | IV* holds the IV level fixed: it shows whether a feature adds anything beyond 'sell the higher-IV name'.

## Continuous features (IC > 0 → higher value, better risk-adjusted put outcome)

| feature | IC | t | IC \| IV | t | Q1 ra-ret | Q5 ra-ret | Q1 tail | Q5 tail | n |
|---|---|---|---|---|---|---|---|---|---|
| iv30 | +0.662 | +22.5 | — | — | -0.011 | +0.032 | 2.9% | 1.3% | 17,245 |
| iv_rank_1y | +0.121 | +5.7 | +0.003 | +0.4 | +0.011 | +0.024 | 1.9% | 1.6% | 17,028 |
| iv_rv | +0.074 | +3.7 | +0.024 | +2.8 | -0.001 | +0.012 | 1.8% | 2.5% | 17,245 |
| mom20 | -0.040 | -1.4 | -0.010 | -0.9 | +0.019 | +0.009 | 1.8% | 2.4% | 17,245 |
| mom_rel_peer | -0.004 | -0.2 | -0.001 | -0.1 | +0.017 | +0.011 | 1.7% | 1.9% | 12,602 |
| dist_ma50 | -0.060 | -2.1 | -0.015 | -1.3 | +0.023 | +0.016 | 1.8% | 2.0% | 17,245 |
| rsi14 | -0.055 | -2.9 | -0.002 | -0.2 | +0.012 | +0.003 | 2.0% | 2.7% | 17,245 |
| oversold_self | +0.004 | +0.2 | +0.002 | +0.2 | -0.001 | +0.011 | 2.6% | 2.0% | 16,256 |
| oversold_cs | +0.055 | +2.9 | +0.002 | +0.2 | +0.003 | +0.013 | 2.7% | 2.0% | 17,245 |
| combined_alpha_rank | -0.376 | -15.7 | -0.004 | -0.3 | +0.013 | +0.007 | 2.0% | 2.1% | 16,047 |
| cam_rel_peer | -0.175 | -14.0 | -0.009 | -1.1 | +0.011 | +0.009 | 1.9% | 2.1% | 12,498 |
| pred_surprise_pct_fq1 | +0.003 | +0.4 | +0.003 | +0.5 | +0.007 | +0.009 | 2.1% | 2.2% | 16,028 |

## Two cleaner targets: premium kept (mean +0.07 of premium collected) and 3-month stock return vs sector peers

*Premium kept* = P&L ÷ premium (1 = kept it all): what a put seller earns relative to what they were paid, with no built-in IV link. *3-month vs peers* is the right target for the green 'would happily own' verdict.

| feature | kept: IC | t | kept: IC \| IV | t | own (63d vs peers): IC | t | own: IC \| IV | t |
|---|---|---|---|---|---|---|---|---|
| iv30 | -0.032 | -1.5 | — | — | +0.016 | +1.0 | — | — |
| iv_rank_1y | -0.013 | -1.2 | +0.020 | +2.5 | -0.019 | -2.2 | -0.022 | -2.4 |
| iv_rv | +0.000 | +0.0 | +0.041 | +4.4 | +0.003 | +0.2 | -0.003 | -0.3 |
| mom20 | -0.015 | -1.1 | -0.007 | -0.6 | +0.003 | +0.2 | +0.010 | +0.8 |
| mom_rel_peer | -0.011 | -1.1 | +0.018 | +2.1 | +0.001 | +0.0 | +0.003 | +0.2 |
| dist_ma50 | -0.012 | -0.8 | -0.006 | -0.6 | +0.017 | +1.2 | +0.026 | +2.0 |
| rsi14 | -0.001 | -0.1 | +0.005 | +0.4 | +0.010 | +1.1 | +0.017 | +1.8 |
| oversold_self | +0.013 | +0.9 | +0.021 | +1.8 | +0.007 | +0.8 | +0.000 | +0.0 |
| oversold_cs | +0.001 | +0.1 | -0.005 | -0.4 | -0.010 | -1.1 | -0.017 | -1.8 |
| combined_alpha_rank | +0.032 | +1.7 | +0.025 | +2.1 | +0.025 | +1.8 | +0.038 | +3.8 |
| cam_rel_peer | +0.010 | +0.8 | +0.015 | +1.9 | +0.031 | +1.8 | +0.037 | +2.5 |
| pred_surprise_pct_fq1 | +0.006 | +0.7 | +0.010 | +1.2 | +0.022 | +2.6 | +0.019 | +2.2 |

## Flags (monthly difference: flagged minus not flagged)

| flag | months | Δ ra-ret | t | Δ tail rate | t | flagged trades |
|---|---|---|---|---|---|---|
| earnings_in_window | 75 | -0.010 | -1.1 | +1.4 pts | +2.2 | 5,241 |
| fk_proxy | 66 | +0.021 | +2.2 | -0.6 pts | -1.2 | 1,779 |

## Oversold signals by market regime (SPY 20-day move at entry)

| regime | months | IC oversold_self | IC oversold_cs | IC mom_rel_peer |
|---|---|---|---|---|
| selloff (SPY 20d < −5%) | 8 | -0.052 (t -2.5) | +0.068 (t +1.6) | -0.101 (t -2.0) |
| normal | 54 | +0.028 (t +1.3) | +0.077 (t +3.8) | -0.018 (t -1.2) |
| rally (> +5%) | 16 | -0.060 (t -1.0) | -0.024 (t -0.4) | +0.094 (t +3.1) |

## IC by year (stability, risk-adjusted)

| feature | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|
| iv30 | +0.87 | +0.67 | +0.44 | +0.69 | +0.68 | +0.71 | +0.62 |
| iv_rank_1y | +0.25 | +0.15 | -0.00 | +0.24 | +0.14 | +0.02 | +0.06 |
| iv_rv | +0.10 | +0.01 | +0.09 | +0.10 | +0.12 | +0.03 | +0.08 |
| mom20 | +0.07 | -0.04 | -0.12 | -0.02 | -0.03 | -0.04 | -0.08 |
| mom_rel_peer | +0.08 | -0.03 | -0.03 | -0.01 | +0.00 | -0.01 | -0.02 |
| dist_ma50 | +0.05 | -0.05 | -0.13 | -0.02 | -0.09 | -0.06 | -0.11 |
| rsi14 | +0.03 | -0.04 | -0.06 | -0.04 | -0.12 | -0.08 | -0.07 |
| oversold_self | -0.20 | -0.00 | -0.02 | -0.03 | +0.06 | +0.04 | +0.06 |
| oversold_cs | -0.03 | +0.04 | +0.06 | +0.04 | +0.12 | +0.08 | +0.07 |
| combined_alpha_rank | -0.48 | -0.35 | -0.23 | -0.45 | -0.38 | -0.42 | -0.34 |
| cam_rel_peer | -0.28 | -0.20 | -0.08 | -0.22 | -0.13 | -0.18 | -0.15 |
| pred_surprise_pct_fq1 | -0.01 | -0.00 | -0.05 | +0.00 | +0.03 | +0.05 | +0.01 |

Notes: monthly entries don't overlap, so monthly ICs are ≈ independent; |t| < 2 is not reliable. No point-in-time history here for fundamentals, ARM (revisions) or credit, so those can't be tested yet. ATM IV understates OTM skew, so absolute returns are conservative; rankings are what matter.
