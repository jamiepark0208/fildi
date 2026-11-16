# A407 step 3 — P(OTM) calibration of pick_odds (market × 1.14) on history

Method: script docstring. Gap = predicted − realized P(OTM); positive = overconfident.

## A real quotes (S109, 2020→) — 2,726 puts, 230 weeks (2,525 with a walk-forward ratio)

| forecaster | mean P(OTM) | real OTM | gap pts | Brier ×1000 | Δ vs live | t (weeks) |
|---|---|---|---|---|---|---|
| market ×1.00 | 89.0 | 88.3 | +0.7 | 119.53 | +0.02 | +0.0 |
| live ×1.14 | 87.5 | 88.3 | -0.8 | 119.51 | +0.00 | +0.0 |
| walk-forward ratio | 88.4 | 88.3 | +0.1 | 120.19 | +0.68 | +1.2 |

Live ×1.14 by year and SPY RV20 bucket (pred − real P(OTM), pts; cells < 30 puts omitted):

| cell | puts | weeks | pred P(OTM) | real | gap |
|---|---|---|---|---|---|
| 2021 | 175 | 37 | 87.4 | 89.1 | -1.8 |
| 2022 | 528 | 38 | 87.0 | 86.4 | +0.6 |
| 2023 | 234 | 34 | 87.6 | 90.2 | -2.6 |
| 2024 | 257 | 39 | 87.4 | 87.2 | +0.3 |
| 2025 | 590 | 46 | 88.0 | 90.3 | -2.4 |
| 2026 | 935 | 35 | 87.5 | 87.5 | -0.0 |
| RV20 12–20 % | 965 | 99 | 87.4 | 90.2 | -2.7 |
| RV20 < 12 % | 1,249 | 103 | 87.6 | 86.4 | +1.2 |
| RV20 > 20 % | 512 | 37 | 87.1 | 89.1 | -1.9 |

## B engine picks (S088 pool, 2018→) — 29,698 puts, 329 weeks (29,496 with a walk-forward ratio)

| forecaster | mean P(OTM) | real OTM | gap pts | Brier ×1000 | Δ vs live | t (weeks) |
|---|---|---|---|---|---|---|
| market ×1.00 | 90.0 | 92.6 | -2.6 | 72.16 | -1.22 | -6.2 |
| live ×1.14 | 88.6 | 92.6 | -4.0 | 73.39 | +0.00 | +0.0 |
| walk-forward ratio | 92.7 | 92.6 | +0.1 | 71.54 | -1.85 | -3.2 |

Live ×1.14 by year and SPY RV20 bucket (pred − real P(OTM), pts; cells < 30 puts omitted):

| cell | puts | weeks | pred P(OTM) | real | gap |
|---|---|---|---|---|---|
| 2020 | 2,441 | 40 | 86.5 | 93.5 | -7.0 |
| 2021 | 3,529 | 52 | 89.7 | 92.5 | -2.7 |
| 2022 | 2,596 | 49 | 84.6 | 88.0 | -3.4 |
| 2023 | 3,013 | 52 | 88.8 | 93.8 | -5.0 |
| 2024 | 3,566 | 50 | 89.6 | 93.7 | -4.1 |
| 2025 | 4,377 | 46 | 89.0 | 93.0 | -4.0 |
| 2026 | 10,175 | 39 | 89.1 | 92.7 | -3.6 |
| RV20 12–20 % | 12,267 | 133 | 88.7 | 93.0 | -4.3 |
| RV20 < 12 % | 13,905 | 135 | 89.5 | 92.6 | -3.1 |
| RV20 > 20 % | 3,526 | 61 | 84.4 | 91.1 | -6.7 |

