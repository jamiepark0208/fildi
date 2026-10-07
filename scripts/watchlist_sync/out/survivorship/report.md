# Survivorship bias in the put backtests (CRSP, delisting-aware)

0.20Δ 1-month puts, month-end entries 2020-02 → 2024-11, BS at trailing vol × 1.15, fill × 0.85. Universe: US common, price ≥ $3, cap ≥ $300M. Return = P&L ÷ collateral per trade.
Survivors = still listed at the last CRSP month (like our ticker list). Bias = survivors − all.

| slice | group | trades | mean monthly | loss rate | tail (< −5%) | worst month |
|---|---|---|---|---|---|---|
| all vol | all names | 133,273 | +0.49% | 14.2% | 7.2% | -15.14% |
| all vol | survivors | 119,663 | +0.47% | 14.3% | 7.1% | -14.95% |
| low vol | all names | 44,407 | -0.18% | 15.7% | 6.0% | -12.07% |
| low vol | survivors | 41,254 | -0.17% | 16.0% | 6.0% | -11.60% |
| mid vol | all names | 44,423 | +0.11% | 13.7% | 7.1% | -16.72% |
| mid vol | survivors | 40,158 | +0.14% | 13.6% | 6.9% | -16.81% |
| high vol | all names | 44,443 | +1.53% | 13.2% | 8.6% | -16.63% |
| high vol | survivors | 38,251 | +1.51% | 13.3% | 8.5% | -16.76% |

| slice | bias in mean monthly (survivors − all) | bias in tail rate |
|---|---|---|
| all vol | -0.02% pts | -0.1% pts |
| low vol | +0.00% pts | -0.0% pts |
| mid vol | +0.04% pts | -0.2% pts |
| high vol | -0.02% pts | -0.0% pts |

Trades in names that later left the sample, by reason: performance 1,890 (mean -0.15%), merger 10,947 (mean +0.71%), other 773 (mean +0.39%)

Read: subtract the matching bias from backtest_puts / gate-1 monthly returns (our list skews to the high-vol tercile).

## Speculative tail (price ≥ $1, cap ≥ $50M; where OPEN / REBN / GOSS live)
Bias survivors − all: all +0.02 pts · low +0.02 · mid +0.07 · **high vol +0.10 pts/month**, tail rate −0.4 pts.
Performance delistings 6,289 trades (mean −0.55%) vs mergers 16,062 (+0.69%): acquisitions offset bankruptcies for put sellers.

## Conclusion (2026-10-06)
Survivorship bias is small: ≈ 0 for mid/large caps, ≈ 0.1 pt/month for high-vol small caps. Haircut the gate-1 headline
(0.86%/month, 2024–26) to ≈ 0.75–0.8% for a speculative-heavy list. Not a reason to change the model.
