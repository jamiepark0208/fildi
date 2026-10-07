# Gate 1: regime labels, Stock score, Trade confidence % (2026-10-05, regime-0.2)

52,419 reconstructed 30-day trades (Δ0.15, Δ0.2, Δ0.3; puts + covered calls) · 259 tickers · entries 2020-03-02 → 2026-09-01. Black-Scholes at LSEG IV × 0.85 fill. Read-only; labels stored in `watchlist_sync.lab_labels`.

## 1. Regime timeline

2019-10-15 → 2026-10-05 (7.0 years). Flips per year: trend 3.4, breadth 2.2, vol 6.5, vrp 8.7.

**trend**: 19-10-15→19-10-29 sideways · 19-10-30→20-03-13 up · 20-03-16→20-06-03 down · 20-06-04→22-02-03 up · 22-02-04→22-02-23 sideways · 22-02-24→22-03-29 down · 22-03-30→22-04-13 sideways · 22-04-14→22-08-16 down · 22-08-17→22-10-05 sideways · 22-10-06→22-12-05 down · 22-12-06→23-01-26 sideways · 23-01-27→23-03-14 up · 23-03-15→23-03-28 sideways · 23-03-29→23-10-03 up · 23-10-04→23-10-30 sideways · 23-10-31→23-11-07 down · 23-11-08→23-12-05 sideways · 23-12-06→25-03-13 up · 25-03-14→25-05-15 down · 25-05-16→25-06-04 sideways · 25-06-05→26-03-17 up · 26-03-18→26-03-24 sideways · 26-03-25→26-04-13 down · 26-04-14→26-05-04 sideways · 26-05-05→26-10-05 up

**breadth**: 19-10-15→20-03-12 normal · 20-03-13→20-05-21 selloff · 20-05-22→22-01-26 normal · 22-01-27→23-05-10 selloff · 23-05-11→23-10-23 normal · 23-10-24→23-11-07 selloff · 23-11-08→24-08-07 normal · 24-08-08→24-08-14 selloff · 24-08-15→25-02-26 normal · 25-02-27→25-06-25 selloff · 25-06-26→25-11-20 normal · 25-11-21→25-12-02 selloff · 25-12-03→26-03-03 normal · 26-03-04→26-05-05 selloff · 26-05-06→26-06-23 normal · 26-06-24→26-10-05 selloff

**vrp**: 20-01-02→20-03-20 normal · 20-03-23→20-05-22 panic · 20-05-26→20-07-02 normal · 20-07-06→20-07-17 panic · 20-07-20→20-07-30 normal · 20-07-31→20-09-14 rich · 20-09-15→20-10-22 normal · 20-10-23→20-11-09 rich · 20-11-19→20-12-01 panic · 20-12-02→20-12-14 normal · 20-12-15→21-02-05 rich · 21-02-08→21-03-18 normal · 21-03-19→21-04-01 panic · 21-04-05→21-09-21 normal · 21-09-22→21-10-08 rich · 21-10-20→21-10-29 panic · 21-11-01→21-11-11 normal · 21-11-12→21-12-27 rich · 21-12-28→22-01-10 panic · 22-01-11→22-01-25 normal · 22-01-26→22-02-03 rich · 22-02-04→22-03-21 normal · 22-03-22→22-04-11 panic · 22-04-12→22-05-17 normal · 22-05-18→22-07-15 panic · 22-07-18→22-12-05 normal · 22-12-06→22-12-22 panic · 22-12-23→23-04-13 normal · 23-04-17→23-05-31 normal · 23-06-02→23-06-14 normal · 23-06-21→23-07-27 normal · 23-08-01→23-10-24 normal · 23-10-25→23-11-10 rich · 23-11-13→23-11-29 panic · 23-11-30→24-04-18 normal · 24-04-19→24-04-25 rich · 24-04-26→24-07-29 normal · 24-07-31→24-08-13 normal · 24-08-14→24-09-06 panic · 24-09-09→24-10-08 normal · 24-10-09→24-11-11 rich · 24-11-12→25-03-24 normal · 25-03-25→25-05-22 panic · 25-05-23→25-07-17 normal · 25-07-18→25-08-07 rich · 25-08-08→25-09-25 normal · 25-09-26→25-10-22 rich · 25-10-23→26-03-10 normal · 26-03-11→26-04-06 rich · 26-04-14→26-04-29 panic · 26-04-30→26-07-02 normal · 26-07-06→26-07-15 panic · 26-07-16→26-10-05 normal

**vol**: 20-01-02→20-03-03 calm · 20-03-04→20-05-21 stressed · 20-05-22→20-06-16 normal · 20-06-17→20-07-06 stressed · 20-07-07→20-10-29 normal · 20-10-30→20-11-09 stressed · 20-11-10→21-04-07 normal · 21-04-08→21-10-01 calm · 21-10-04→21-10-18 normal · 21-10-19→21-12-01 calm · 21-12-02→21-12-28 normal · 21-12-29→22-01-19 calm · 22-01-20→22-05-23 normal · 22-05-24→22-05-31 stressed · 22-06-01→22-06-15 normal · 22-06-16→22-06-28 stressed · 22-06-29→22-09-28 normal · 22-09-29→22-11-07 stressed · 22-11-08→23-04-13 normal · 23-04-17→23-05-31 calm · 23-06-02→23-06-14 calm · 23-06-21→23-07-27 calm · 23-08-01→23-10-05 calm · 23-10-06→23-11-10 normal · 23-11-13→24-04-18 calm · 24-04-19→24-04-25 normal · 24-04-26→24-07-29 calm · 24-08-12→24-08-16 normal · 24-08-19→24-09-09 calm · 24-09-10→24-09-16 normal · 24-09-17→24-10-10 calm · 24-10-11→24-11-11 normal · 24-11-12→25-03-06 calm · 25-03-07→25-06-03 normal · 25-06-04→25-11-18 calm · 25-11-19→25-12-01 normal · 25-12-02→26-03-05 calm · 26-03-06→26-04-15 normal · 26-04-16→26-10-05 calm

## 2. Regime tests (5 pre-registered; sample = months; trials = 5)

**H1: 0.20Δ puts by vrp**

| state | months | loss rate | mean return / collateral | worst month |
|---|---|---|---|---|
| rich | 13 | 8.1% | 1.12% | -0.81% |
| normal | 54 | 18.9% | -0.03% | -16.18% |
| panic | 11 | 18.9% | -0.12% | -5.90% |

panic vs rich: loss-rate t = +1.38 (Welch, months). Halves (loss rate rich / panic): 10.3% / 22.6% · 4.8% / 9.2%

**H2: 0.20Δ puts by trend**

| state | months | loss rate | mean return / collateral | worst month |
|---|---|---|---|---|
| up | 58 | 17.6% | 0.07% | -16.18% |
| sideways | 7 | 20.2% | -0.15% | -5.90% |
| down | 14 | 12.4% | 0.75% | -3.52% |

down vs up: loss-rate t = -1.10 (Welch, months). Halves (loss rate up / down): 18.3% / 15.2% · 17.1% / 5.6%

**H3: does IV/RV still rank 0.20Δ puts inside each VRP regime?** (monthly IC vs premium kept)

| VRP | months | IC | t |
|---|---|---|---|
| rich | 13 | -0.025 | -1.4 |
| normal | 54 | +0.012 | +1.0 |
| panic | 10 | -0.022 | -0.4 |
| all | 78 | +0.001 | +0.1 |

**H4: long-term trend (stock score trend part) vs 63-day return vs peers, by breadth**

| breadth | months | IC | t |
|---|---|---|---|
| normal | 50 | +0.022 | +1.2 |
| selloff | 27 | +0.038 | +1.2 |

**H5: covered calls (0.20Δ) on top-fifth 20-day strength vs the rest**

call kept money: top fifth 83.7% vs rest 83.3%; monthly difference 0.3% (t +0.3, 79 months); halves 2.2% / -1.5%

## 3. Stock score (trend + revisions; fundamentals not testable yet)

Monthly IC vs 63-day return vs peers (`own63`):

| score | IC | t | months | 2020–23 | 2024–26 |
|---|---|---|---|---|---|
| Stock score | +0.038 | +2.6 | 77 | +0.032 | +0.048 |
| 12-1 momentum | +0.027 | +1.7 | 77 | +0.018 | +0.041 |
| vs 200-day | +0.044 | +3.1 | 77 | +0.041 | +0.047 |
| StarMine alpha | +0.025 | +1.0 | 77 | +0.025 | +0.025 |

## 4. Trade confidence %

### Puts (put P&L > 0)

Train 28,443 trades (to 2023-12) · test 23,976 (2024-01 →). Training success rate by delta: Δ0.15 84.7%, Δ0.2 80.6%, Δ0.3 73.9%

Brier: model 0.1418 vs baseline 0.1333 → skill **-6.4%** (> 0 = better than the strike alone)

Monthly Brier improvement: positive in 12/33 months, t -2.4; halves 5/16 / 7/17

Reliability on 2024–26 (fifths of predicted confidence):

| fifth | predicted | actual | n | gap |
|---|---|---|---|---|
| 1 | 62.0% | 78.7% | 4,796 | +16.7 |
| 2 | 70.7% | 82.0% | 4,795 | +11.3 |
| 3 | 76.1% | 83.1% | 4,795 | +7.0 |
| 4 | 80.7% | 85.6% | 4,795 | +5.0 |
| 5 | 88.3% | 91.4% | 4,795 | +3.1 |

Largest gap 16.7 pts (stop rule: > 10). By test half: 2024-01→2025-04 predicted 76.0% actual 83.3% · 2025-05→2026-09 predicted 75.2% actual 85.0%

Weights (standardized): delta -0.29, iv_rv +0.19, iv_rank_1y -0.09, stock +0.09, earnings_in_window +0.04, L_trend=down +0.32, L_trend=sideways -0.03, L_vrp=rich +0.37, L_vrp=panic -0.10, L_breadth=selloff -0.20, L_vol=stressed +0.58

### Calls (covered call beats holding)

Train 28,443 trades (to 2023-12) · test 23,976 (2024-01 →). Training success rate by delta: Δ0.15 88.1%, Δ0.2 84.6%, Δ0.3 77.1%

Brier: model 0.1526 vs baseline 0.1496 → skill **-2.1%** (> 0 = better than the strike alone)

Monthly Brier improvement: positive in 13/33 months, t -1.4; halves 7/16 / 6/17

Reliability on 2024–26 (fifths of predicted confidence):

| fifth | predicted | actual | n | gap |
|---|---|---|---|---|
| 1 | 76.4% | 70.2% | 4,796 | -6.2 |
| 2 | 87.9% | 77.3% | 4,795 | -10.6 |
| 3 | 91.5% | 82.0% | 4,795 | -9.5 |
| 4 | 93.8% | 86.7% | 4,795 | -7.1 |
| 5 | 95.9% | 90.7% | 4,795 | -5.3 |

Largest gap 10.6 pts (stop rule: > 10). By test half: 2024-01→2025-04 predicted 90.7% actual 81.9% · 2025-05→2026-09 predicted 87.7% actual 80.9%

Weights (standardized): delta -0.34, iv_rv -0.08, iv_rank_1y +0.38, stock -0.04, earnings_in_window -0.09, L_trend=down -0.37, L_trend=sideways -0.37, L_vrp=rich -0.51, L_vrp=panic -0.09, L_breadth=selloff +0.15, L_vol=stressed -0.32

## 5. Decision ladder (2024-01 → , 0.20Δ puts, top 20 a month by PREMIUM, equal weight; skipped month = 0)

| rung | months traded | trades | mean monthly return | loss rate | tail rate (< −5%) | worst month | mean/sd | halves (mean monthly) |
|---|---|---|---|---|---|---|---|---|
| L0 today (PREMIUM top 20, SPY pause) | 33/33 | 660 | 0.86% | 15.6% | 8.2% | -3.55% | 0.50 | 0.89% / 0.84% |
| L1 + regime dial (skip panic / downtrend months) | 29/33 | 580 | 0.73% | 16.0% | 8.6% | -3.55% | 0.43 | 0.81% / 0.66% |
| L2 + confidence (drop bottom-fifth) | 29/33 | 566 | 0.78% | 16.6% | 8.5% | -3.55% | 0.45 | 0.84% / 0.72% |

