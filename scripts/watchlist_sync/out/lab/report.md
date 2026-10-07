# Scorecard lab report (2026-10-06)

Engine dddab16f1de8 · 17,990 replayed (ticker, date) rows · 252 names · 2020-02-03 → 2026-10-01 · monthly samples for ≥ 21-day targets, weekly for 5-day. Engines replayed from live code (lab-replay-technicals.ts).

Pass marks: 1 predictive · 2 monotonic · 3 stable · 5 beats a one-feature baseline · 6 not redundant (criterion 4 = `lab.py weights`).

## Sanity checks

- Placebo (v2 total shuffled within each date) vs 21d peer-relative return: IC +0.0060 (should be ≈ 0).
- IV mechanics: raw IV level vs realized variance premium IC +0.257. High-IV names show bigger premiums in points by construction, so every options-claim test below is also shown with IV held fixed.

## Technicals: v2 (UI / snapshots) and v4 (options scanner)

Claims tested: **trend** (score ↑ → stock beats peers next 1–3 months) and **entry timing for puts** (score ↑ → smaller worst-drop over the next 21 days, better 5-day return). Call side (v4 call): score ↑ → smaller best-rise over 21 days (stock less likely to run through a call).

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| v2 total | rel_21 | -0.011 | -1.1 | 50% | +0.0 / -0.1 / -0.1 / -0.0 / -0.1 | -0.024 / -0.001 | +0.010 / -0.025 | +0.021 | ❌❌❌❌❌ |
| v2 total | rel_63 | -0.004 | -0.3 | 50% | +0.0 / +0.1 / -0.6 / -0.2 / -0.3 | -0.032 / +0.019 | +0.030 / -0.025 | +0.032 | ❌❌❌❌✅ |
| v2 total | mae_z | -0.010 | -0.6 | 44% | -0.65 / -0.67 / -0.66 / -0.68 / -0.68 | -0.048 / +0.019 | +0.029 / -0.037 | +0.004 | ❌❌❌❌✅ |
| v2 total | rel_5 | -0.022 | -1.7 | 42% | +0.1 / +0.0 / +0.0 / -0.1 / -0.2 | -0.043 / -0.006 | +0.010 / -0.044 | -0.012 | ❌❌❌❌✅ |
| v4 put total | rel_21 | -0.009 | -0.8 | 50% | -0.0 / -0.0 / +0.0 / -0.0 / -0.1 | -0.010 / -0.008 | +0.016 / -0.026 | +0.021 | ❌❌❌❌❌ |
| v4 put total | mae_z | -0.016 | -1.1 | 40% | -0.65 / -0.67 / -0.67 / -0.67 / -0.70 | -0.010 / -0.021 | +0.001 / -0.028 | +0.004 | ❌❌❌❌✅ |
| v4 put total | rel_5 | -0.028 | -2.0 | 38% | +0.0 / +0.1 / +0.0 / -0.0 / -0.3 | -0.029 / -0.027 | +0.016 / -0.057 | -0.012 | ❌❌❌❌✅ |
| v4 call total | −mfe_z | -0.025 | -1.5 | 42% | -0.83 / -0.82 / -0.84 / -0.85 / -0.86 | -0.048 / -0.007 | +0.022 / -0.057 | -0.006 | ❌❌❌❌✅ |
| v2 total · true IV rank | rel_21 | not enough data | | | | | | | | | |
| v2 total · true IV rank | mae_z | not enough data | | | | | | | | | |

Baselines: 12-1 momentum for trend targets, distance from the 200-day average for worst-drop, −5d return (reversal) for 5-day targets. mae_z / mfe_z = worst drop / best rise over 21 days ÷ the volatility that actually followed (direction only; dividing by trailing vol instead made high IV/RV names look worse because vol mean-reverts). Raw % drops are dominated by volatility (low-vol names drop less by construction: IC of −idio vol on raw drop = +0.43), which would make any timing score look bad or good for the wrong reason.

### Components (which parts of the technical scores carry the signal)

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| v2.oversoldDepth | rel_21 | +0.002 | +0.1 | 55% | +0.1 / -0.2 / -0.1 / -0.2 / +0.1 | -0.004 / +0.006 | +0.022 / -0.012 | — | ❌❌❌✅✅ |
| v2.oversoldDepth | mae_z | -0.007 | -0.4 | 54% | -0.65 / -0.67 / -0.67 / -0.67 / -0.67 | -0.037 / +0.017 | +0.016 / -0.022 | — | ❌❌❌✅✅ |
| v2.reversalSignal | rel_21 | -0.021 | -1.9 | 41% | +0.5 / +0.0 / -0.2 / -0.1 / -0.2 | -0.009 / -0.030 | -0.016 / -0.024 | — | ❌❌❌✅✅ |
| v2.reversalSignal | mae_z | -0.034 | -2.2 | 41% | -0.64 / -0.64 / -0.67 / -0.68 / -0.70 | -0.025 / -0.041 | -0.028 / -0.038 | — | ❌❌❌✅✅ |
| v2.volatilityState | rel_21 | +0.002 | +0.1 | 51% | -0.3 / -0.1 / +0.3 / -0.2 / +0.3 | -0.003 / +0.005 | +0.004 / +0.001 | — | ❌❌❌✅✅ |
| v2.volatilityState | mae_z | +0.016 | +0.8 | 54% | -0.69 / -0.67 / -0.65 / -0.68 / -0.66 | -0.024 / +0.047 | +0.038 / +0.002 | — | ❌❌❌✅✅ |
| v2.trendContext | rel_21 | -0.002 | -0.2 | 51% | +0.2 / -0.2 / +0.2 / +0.0 / -0.2 | -0.011 / +0.005 | +0.022 / -0.018 | — | ❌❌❌✅✅ |
| v2.trendContext | mae_z | -0.008 | -0.5 | 48% | -0.65 / -0.68 / -0.65 / -0.68 / -0.68 | -0.031 / +0.009 | +0.025 / -0.031 | — | ❌❌❌✅✅ |
| v2.optionsFlow | rel_21 | not enough data | | | | | | | | | |
| v2.optionsFlow | mae_z | not enough data | | | | | | | | | |
| v2.volumeConfirm | rel_21 | +0.004 | +0.4 | 49% | -0.0 / -0.2 / +0.1 / +0.1 / -0.1 | -0.004 / +0.010 | +0.019 / -0.006 | — | ❌❌❌✅✅ |
| v2.volumeConfirm | mae_z | -0.002 | -0.2 | 49% | -0.67 / -0.67 / -0.68 / -0.67 / -0.66 | -0.015 / +0.008 | +0.004 / -0.006 | — | ❌❌❌✅✅ |
| v4p.analystUpside | rel_21 | not enough data | | | | | | | | | |
| v4p.analystUpside | mae_z | not enough data | | | | | | | | | |
| v4p.optionsFlow | rel_21 | not enough data | | | | | | | | | |
| v4p.optionsFlow | mae_z | not enough data | | | | | | | | | |
| v4p.oversoldDepth | rel_21 | +0.003 | +0.3 | 54% | +0.1 / -0.3 / +0.0 / -0.0 / -0.1 | -0.000 / +0.006 | +0.020 / -0.008 | — | ❌❌❌✅✅ |
| v4p.oversoldDepth | mae_z | -0.004 | -0.3 | 50% | -0.65 / -0.67 / -0.65 / -0.67 / -0.68 | -0.028 / +0.014 | +0.009 / -0.013 | — | ❌❌❌✅✅ |
| v4p.relativePressure | rel_21 | -0.008 | -0.7 | 54% | -0.1 / +0.1 / -0.1 / +0.1 / -0.1 | -0.015 / -0.002 | +0.016 / -0.023 | — | ❌❌❌✅✅ |
| v4p.relativePressure | mae_z | -0.011 | -0.6 | 41% | -0.68 / -0.68 / -0.65 / -0.69 / -0.68 | -0.033 / +0.007 | +0.034 / -0.040 | — | ❌❌❌✅✅ |
| v4p.reversalSignal | rel_21 | -0.021 | -1.9 | 41% | +0.5 / +0.0 / -0.2 / -0.1 / -0.2 | -0.009 / -0.030 | -0.016 / -0.024 | — | ❌❌❌✅✅ |
| v4p.reversalSignal | mae_z | -0.034 | -2.2 | 41% | -0.64 / -0.64 / -0.67 / -0.68 / -0.70 | -0.025 / -0.041 | -0.028 / -0.038 | — | ❌❌❌✅✅ |
| v4p.trendContext | rel_21 | -0.002 | -0.2 | 51% | +0.2 / -0.2 / +0.2 / +0.0 / -0.2 | -0.011 / +0.005 | +0.022 / -0.018 | — | ❌❌❌✅✅ |
| v4p.trendContext | mae_z | -0.008 | -0.5 | 48% | -0.65 / -0.68 / -0.65 / -0.68 / -0.68 | -0.031 / +0.009 | +0.025 / -0.031 | — | ❌❌❌✅✅ |
| v4p.volatilityState | rel_21 | +0.000 | +0.0 | 51% | -0.1 / -0.1 / +0.1 / -0.1 / +0.1 | +0.019 / -0.015 | +0.004 / -0.002 | — | ❌❌❌✅✅ |
| v4p.volatilityState | mae_z | -0.002 | -0.1 | 54% | -0.69 / -0.66 / -0.65 / -0.68 / -0.67 | +0.008 / -0.009 | -0.012 / +0.006 | — | ❌❌❌✅✅ |
| v4p.volumeConfirm | rel_21 | +0.004 | +0.4 | 49% | -0.0 / -0.2 / +0.1 / +0.1 / -0.1 | -0.004 / +0.010 | +0.019 / -0.006 | — | ❌❌❌✅✅ |
| v4p.volumeConfirm | mae_z | -0.002 | -0.2 | 49% | -0.67 / -0.67 / -0.68 / -0.67 / -0.66 | -0.015 / +0.008 | +0.004 / -0.006 | — | ❌❌❌✅✅ |

### Candidate additions (Step 8 factors, not in any scorecard today)

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| f.mom_12_1 | rel_21 | +0.021 | +1.4 | 62% | -0.1 / +0.1 / -0.1 / -0.1 / +0.4 | +0.031 / +0.013 | +0.023 / +0.020 | — | ❌❌✅✅✅ |
| f.mom_12_1 | rel_63 | +0.032 | +1.9 | 64% | -0.6 / -0.5 / -0.4 / +0.2 / +0.8 | +0.032 / +0.032 | +0.039 / +0.027 | — | ❌✅✅✅✅ |
| f.dist_ma200 | rel_21 | +0.030 | +1.9 | 65% | -0.2 / +0.1 / -0.1 / +0.2 / -0.0 | +0.054 / +0.011 | +0.001 / +0.048 | — | ❌❌✅✅✅ |
| f.dist_ma200 | rel_63 | +0.042 | +2.5 | 69% | -1.1 / -0.6 / -0.0 / +0.3 / +0.5 | +0.060 / +0.028 | +0.023 / +0.054 | — | ✅✅✅✅✅ |
| f.dd_52w | rel_21 | +0.030 | +1.9 | 65% | -0.2 / -0.1 / +0.0 / -0.0 / +0.0 | +0.054 / +0.012 | +0.004 / +0.048 | — | ❌❌✅✅✅ |
| f.dd_52w | rel_63 | +0.030 | +1.5 | 64% | -1.4 / -0.2 / +0.1 / +0.4 / -0.5 | +0.044 / +0.018 | -0.001 / +0.049 | — | ❌❌✅✅✅ |
| in.priceVsMa200Atr | rel_21 | +0.033 | +2.5 | 64% | -0.3 / -0.1 / -0.1 / +0.1 / +0.1 | +0.054 / +0.017 | +0.007 / +0.051 | — | ✅❌✅✅✅ |
| in.priceVsMa200Atr | rel_63 | +0.043 | +2.9 | 72% | -1.3 / -0.5 / -0.1 / +0.2 / +0.2 | +0.054 / +0.034 | +0.024 / +0.055 | — | ✅✅✅✅✅ |
| −f.idio_vol | mae_z | -0.000 | -0.0 | 55% | -0.68 / -0.65 / -0.66 / -0.68 / -0.66 | +0.054 / -0.043 | -0.048 / +0.031 | — | ❌❌❌✅✅ |
| −f.idio_vol (raw % drop, mechanical) | mae_21 | +0.429 | +17.6 | 99% | -15.9 / -10.9 / -8.0 / -6.7 / -5.0 | +0.442 / +0.419 | +0.410 / +0.442 | — | ✅✅✅✅✅ |
| −f.beta | mae_z | -0.054 | -1.9 | 41% | -0.64 / -0.66 / -0.66 / -0.69 / -0.70 | -0.012 / -0.086 | -0.084 / -0.034 | — | ❌❌❌✅✅ |
| −f.beta (raw % drop, mechanical) | mae_21 | +0.252 | +7.4 | 80% | -12.8 / -9.9 / -8.0 / -6.9 / -5.9 | +0.231 / +0.268 | +0.283 / +0.230 | — | ✅✅✅✅✅ |

## Options: pricing components (claim: score ↑ → options were rich vs what the stock then did)

Target = entry 30d ATM IV − realized vol over the next 21 days. Second line of each pair holds the IV level fixed.

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| IV/RV (LSEG) | vrp_real | +0.128 | +8.9 | 86% | +1.03 / +1.41 / +1.89 / +2.54 / +5.87 | +0.151 / +0.110 | +0.143 / +0.118 | — | ✅✅✅✅✅ |
| IV/RV (LSEG) | IV fixed | vrp_real | +0.111 | +8.0 | 85% | +1.03 / +1.41 / +1.89 / +2.54 / +5.87 | +0.138 / +0.090 | +0.124 / +0.102 | — | ✅✅✅✅✅ |
| IV rank 1y (LSEG hist) | vrp_real | +0.084 | +4.9 | 73% | +3.49 / +3.09 / +3.43 / +3.52 / +6.16 | +0.036 / +0.119 | +0.053 / +0.106 | — | ✅❌✅✅✅ |
| IV rank 1y (LSEG hist) | IV fixed | vrp_real | +0.034 | +2.4 | 64% | +3.49 / +3.09 / +3.43 / +3.52 / +6.16 | -0.018 / +0.071 | +0.025 / +0.040 | — | ✅❌❌✅✅ |
| ivRank RV-proxy (live today) | vrp_real | -0.015 | -1.1 | 44% | +3.01 / +2.51 / +2.26 / +1.87 / +3.27 | -0.041 / +0.005 | -0.032 / -0.004 | — | ❌❌❌✅✅ |
| ivRank RV-proxy (live today) | IV fixed | vrp_real | -0.030 | -2.4 | 39% | +3.01 / +2.51 / +2.26 / +1.87 / +3.27 | -0.058 / -0.007 | -0.032 / -0.028 | — | ❌❌❌✅✅ |
| v2.volatilityState | vrp_real | +0.241 | +16.4 | 96% | +0.83 / +1.13 / +1.88 / +3.49 / +10.60 | +0.242 / +0.239 | +0.237 / +0.243 | — | ✅✅✅✅✅ |
| v2.volatilityState | IV fixed | vrp_real | +0.075 | +5.9 | 75% | +0.83 / +1.13 / +1.88 / +3.49 / +10.60 | +0.091 / +0.063 | +0.090 / +0.065 | — | ✅✅✅✅✅ |
| v4p.volatilityState | vrp_real | +0.127 | +9.3 | 89% | +1.31 / +1.83 / +1.82 / +3.01 / +5.82 | +0.119 / +0.133 | +0.118 / +0.134 | — | ✅❌✅✅✅ |
| v4p.volatilityState | IV fixed | vrp_real | +0.092 | +7.8 | 80% | +1.31 / +1.83 / +1.82 / +3.01 / +5.82 | +0.085 / +0.098 | +0.095 / +0.090 | — | ✅❌✅✅✅ |
| BB width pct (squeeze) | vrp_real | -0.001 | -0.1 | 49% | +2.22 / +2.47 / +2.03 / +2.46 / +2.72 | +0.001 / -0.002 | +0.022 / -0.016 | — | ❌❌❌✅✅ |
| BB width pct (squeeze) | IV fixed | vrp_real | +0.003 | +0.2 | 48% | +2.22 / +2.47 / +2.03 / +2.46 / +2.72 | +0.003 / +0.002 | +0.019 / -0.008 | — | ❌❌❌✅✅ |

Seller's view: worst drop (puts) / best rise (calls) over 21 days in units of the implied move at entry (−1 = the stock moved exactly one implied σ against the seller).

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| IV/RV (LSEG) | mae_iv | +0.050 | +3.2 | 59% | -0.68 / -0.66 / -0.64 / -0.65 / -0.58 | +0.064 / +0.039 | +0.027 / +0.065 | — | ✅❌✅✅✅ |
| IV rank 1y (LSEG hist) | mae_iv | +0.024 | +1.5 | 62% | -0.61 / -0.60 / -0.61 / -0.62 / -0.56 | +0.005 / +0.038 | +0.030 / +0.020 | — | ❌❌✅✅✅ |
| v4p.volatilityState | mae_iv | +0.043 | +3.1 | 64% | -0.69 / -0.66 / -0.63 / -0.64 / -0.59 | +0.049 / +0.038 | +0.030 / +0.051 | — | ✅❌✅✅✅ |
| v4 put total | mae_iv | -0.002 | -0.1 | 44% | -0.63 / -0.65 / -0.63 / -0.63 / -0.65 | +0.002 / -0.005 | +0.019 / -0.016 | — | ❌❌❌✅✅ |
| IV/RV (LSEG) (calls) | −mfe_iv | +0.046 | +2.8 | 68% | -0.75 / -0.77 / -0.75 / -0.71 / -0.66 | +0.028 / +0.059 | +0.069 / +0.030 | — | ✅❌✅✅✅ |
| v4 call total (calls) | −mfe_iv | -0.017 | -1.0 | 41% | -0.73 / -0.71 / -0.74 / -0.76 / -0.73 | -0.047 / +0.006 | +0.036 / -0.053 | — | ❌❌❌✅✅ |

## Fundamentals: analyst-expectations family (the only fundamentals family with point-in-time history)

Claim: score ↑ → the stock beats its peers over the next 3–6 months (ownership). Definitions mirror the live engine (ibesRevBreadth, avgIbesSue, mean-estimate drift). Baseline = 12-1 momentum (revisions often just follow price).

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| IBES revision breadth (engine) | rel_63 | +0.028 | +2.7 | 64% | -0.6 / -0.2 / +0.2 / -0.0 / +0.2 | +0.033 / +0.024 | +0.011 / +0.039 | +0.032 | ✅❌✅❌✅ |
| IBES revision breadth (engine) | rel_126 | +0.026 | +1.6 | 64% | -0.8 / -0.9 / +0.6 / +0.0 / +0.0 | +0.022 / +0.030 | +0.006 / +0.038 | +0.029 | ❌❌✅❌✅ |
| IBES mean drift, last month (engine) | rel_63 | +0.031 | +3.5 | 68% | -0.4 / -0.6 / -0.2 / -0.1 / +0.6 | +0.034 / +0.029 | +0.020 / +0.038 | +0.032 | ✅❌✅❌✅ |
| IBES mean drift, last month (engine) | rel_126 | +0.023 | +1.6 | 65% | -0.3 / -0.4 / -1.1 / +0.1 / +0.8 | +0.019 / +0.027 | +0.011 / +0.030 | +0.029 | ❌❌✅❌✅ |
| IBES mean drift, 3 months | rel_63 | +0.032 | +2.5 | 65% | -0.4 / -0.3 / -0.5 / -0.4 / +1.2 | +0.030 / +0.033 | +0.041 / +0.026 | +0.032 | ✅❌✅✅✅ |
| IBES mean drift, 3 months | rel_126 | +0.017 | +1.0 | 60% | -0.8 / +0.2 / -1.0 / -0.7 / +0.9 | -0.013 / +0.041 | +0.033 / +0.008 | +0.029 | ❌❌❌❌✅ |
| IBES SUE avg last 4 (engine) | rel_63 | -0.006 | -0.6 | 45% | -0.2 / -0.2 / +0.0 / -0.3 / -0.3 | +0.001 / -0.012 | -0.003 / -0.008 | +0.032 | ❌❌❌❌✅ |
| IBES SUE avg last 4 (engine) | rel_126 | -0.023 | -1.5 | 35% | -0.2 / +0.0 / -0.2 / -0.7 / -1.1 | -0.013 / -0.031 | -0.014 / -0.028 | +0.029 | ❌❌❌❌✅ |
| IBES fwd EPS growth FY1→FY2 (engine fund-1.1.0) | rel_63 | +0.069 | +3.4 | 67% | -1.4 / -0.8 / -0.4 / +1.2 / +1.1 | +0.089 / +0.052 | +0.056 / +0.076 | +0.032 | ✅❌✅✅✅ |
| IBES fwd EPS growth FY1→FY2 (engine fund-1.1.0) | rel_126 | +0.077 | +3.1 | 76% | -2.6 / -1.7 / -0.6 / +1.6 / +0.9 | +0.098 / +0.059 | +0.063 / +0.085 | +0.029 | ✅❌✅✅✅ |
| −IBES dispersion | rel_63 | -0.017 | -0.6 | 49% | +0.1 / +0.5 / +0.0 / +0.0 / -1.2 | +0.004 / -0.033 | -0.033 / -0.006 | +0.032 | ❌❌❌❌✅ |
| −IBES dispersion | rel_126 | -0.036 | -0.9 | 39% | +0.4 / +0.2 / +0.6 / -0.3 / -2.7 | +0.003 / -0.069 | -0.061 / -0.021 | +0.029 | ❌❌❌❌✅ |
| StarMine combined alpha | rel_63 | +0.028 | +0.9 | 53% | -0.3 / +0.2 / -0.2 / +0.3 / -0.3 | +0.043 / +0.017 | -0.005 / +0.049 | +0.032 | ❌❌✅❌✅ |
| StarMine combined alpha | rel_126 | +0.021 | +0.5 | 57% | -0.6 / +0.4 / -0.7 / +0.3 / -1.2 | +0.039 / +0.006 | -0.000 / +0.034 | +0.029 | ❌❌✅❌✅ |
| EXPECTATIONS composite | rel_63 | +0.024 | +1.9 | 64% | -0.6 / -0.4 / +0.0 / -0.1 / +0.2 | +0.029 / +0.020 | +0.023 / +0.025 | +0.032 | ❌❌✅❌✅ |
| EXPECTATIONS composite | rel_126 | +0.009 | +0.5 | 53% | -0.7 / -1.1 / +0.2 / -0.2 / -0.8 | -0.003 / +0.019 | +0.012 / +0.007 | +0.029 | ❌❌❌❌✅ |
| EXPECTATIONS | TECH TREND fixed | rel_63 | +0.008 | +0.6 | 54% | -0.6 / -0.4 / +0.0 / -0.1 / +0.2 | +0.008 / +0.009 | +0.005 / +0.010 | — | ❌❌✅✅✅ |
| EXPECTATIONS | TECH TREND fixed | rel_126 | -0.010 | -0.5 | 48% | -0.7 / -1.1 / +0.2 / -0.2 / -0.8 | -0.019 / -0.002 | -0.010 / -0.010 | — | ❌❌❌✅✅ |

## Proposed restructure (graded on each part's own claim)

TECH TREND = mean rank of price vs 200-day average (ATR units, already computed live but unused) and 12-1 momentum. OPTIONS PRICING = 0.7 · IV/RV rank + 0.3 · 1-year IV rank (true IV history), i.e. today's Model List PREMIUM, moved into the options scorecard. These were chosen after Step 8 (different targets, 2020–26), so the 2024–26 column is the cleaner read.

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| TECH TREND | rel_63 | +0.042 | +2.6 | 67% | -1.0 / -0.9 / +0.2 / +0.4 / +0.2 | +0.048 / +0.037 | +0.035 / +0.046 | +0.032 | ✅❌✅✅✅ |
| ↳ 2024–26 only | rel_63 | +0.049 | +2.9 | | | | | | |
| TECH TREND | rel_21 | +0.030 | +2.0 | 64% | -0.2 / -0.4 / +0.2 / -0.0 / +0.2 | +0.046 / +0.018 | +0.016 / +0.039 | +0.021 | ✅❌✅✅✅ |
| ↳ 2024–26 only | rel_21 | +0.039 | +1.9 | | | | | | |
| TECH TREND | mae_z | +0.009 | +0.4 | 54% | -0.68 / -0.68 / -0.66 / -0.67 / -0.65 | +0.007 / +0.010 | -0.001 / +0.015 | +0.004 | ❌❌✅✅✅ |
| ↳ 2024–26 only | mae_z | +0.026 | +0.8 | | | | | | |
| OPTIONS PRICING | vrp_real | +0.137 | +10.1 | 90% | +1.11 / +1.30 / +2.31 / +2.64 / +6.08 | +0.150 / +0.128 | +0.143 / +0.133 | +0.128 | ✅✅✅✅✅ |
| ↳ 2024–26 only | vrp_real | +0.130 | +7.4 | | | | | | |
| OPTIONS PRICING | mae_iv | +0.052 | +3.5 | 66% | -0.68 / -0.67 / -0.65 / -0.63 / -0.58 | +0.064 / +0.043 | +0.031 / +0.066 | +0.050 | ✅✅✅✅✅ |
| ↳ 2024–26 only | mae_iv | +0.035 | +1.5 | | | | | | |
| OPTIONS PRICING (calls) | −mfe_iv | +0.054 | +3.6 | 68% | -0.76 / -0.74 / -0.76 / -0.73 / -0.64 | +0.034 / +0.070 | +0.070 / +0.043 | +0.046 | ✅❌✅✅✅ |
| ↳ 2024–26 only | −mfe_iv | +0.084 | +3.9 | | | | | | |

### Call side: what predicts the stock running through a short call (best rise in implied-σ units)?

| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |
|---|---|---|---|---|---|---|---|---|---|
| −12-1 momentum | −mfe_iv | +0.012 | +0.5 | 57% | -0.78 / -0.72 / -0.72 / -0.76 / -0.73 | +0.004 / +0.019 | +0.016 / +0.009 | — | ❌❌✅✅✅ |
| −20d vs SPY | −mfe_iv | +0.040 | +2.4 | 57% | -0.75 / -0.75 / -0.76 / -0.73 / -0.69 | +0.060 / +0.024 | -0.005 / +0.070 | — | ✅❌✅✅✅ |
| RSI pct (overbought) | −mfe_iv | -0.020 | -1.2 | 50% | -0.73 / -0.72 / -0.73 / -0.76 / -0.74 | -0.037 / -0.007 | +0.007 / -0.039 | — | ❌❌❌✅✅ |
| −price vs MA200 | −mfe_iv | +0.024 | +1.1 | 55% | -0.75 / -0.76 / -0.72 / -0.72 / -0.72 | +0.041 / +0.011 | -0.020 / +0.054 | — | ❌❌❌✅✅ |
| IV/RV | −mfe_iv | +0.046 | +2.8 | 68% | -0.75 / -0.77 / -0.75 / -0.71 / -0.66 | +0.028 / +0.059 | +0.069 / +0.030 | — | ✅❌✅✅✅ |
| v4 call total | −mfe_iv | -0.017 | -1.0 | 41% | -0.73 / -0.71 / -0.74 / -0.76 / -0.73 | -0.047 / +0.006 | +0.036 / -0.053 | — | ❌❌❌✅✅ |

## Market regime layer (per month, all names): seller outcomes by regime

| regime bucket | months | median stock drop vs implied move (puts) | P(drop > 1 implied σ) | realized VRP (pts) | 21d rel. return spread, TECH TREND Q5−Q1 |
|---|---|---|---|---|---|
| breadth: median stock ≥ 20% off high | 33 | -0.62 σ | 25% | +3.9 | -0.32% |
| breadth: normal | 48 | -0.55 σ | 23% | +3.6 | +0.88% |
| SPY VRP > 4 pts (rich) | 14 | -0.50 σ | 19% | +4.4 | +0.86% |
| SPY VRP 0–4 | 36 | -0.59 σ | 22% | +3.4 | +0.44% |
| SPY VRP < 0 (panic) | 29 | -0.64 σ | 28% | +3.9 | +0.24% |
