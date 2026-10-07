# Gate 1: regime labels, Stock score, Trade confidence % (2026-10-05, regime-0.1)

52,419 reconstructed 30-day trades (Δ0.15, Δ0.2, Δ0.3; puts + covered calls) · 259 tickers · entries 2020-03-02 → 2026-09-01. Black-Scholes at LSEG IV × 0.85 fill. Read-only; labels stored in `watchlist_sync.lab_labels`.

## 1. Regime timeline

2019-10-15 → 2026-10-05 (7.0 years). Flips per year: trend 3.4, breadth 2.2, vol 6.5, vrp 10.3.

**trend**: 19-10-15→19-10-29 sideways · 19-10-30→20-03-13 up · 20-03-16→20-06-03 down · 20-06-04→22-02-03 up · 22-02-04→22-02-23 sideways · 22-02-24→22-03-29 down · 22-03-30→22-04-13 sideways · 22-04-14→22-08-16 down · 22-08-17→22-10-05 sideways · 22-10-06→22-12-05 down · 22-12-06→23-01-26 sideways · 23-01-27→23-03-14 up · 23-03-15→23-03-28 sideways · 23-03-29→23-10-03 up · 23-10-04→23-10-30 sideways · 23-10-31→23-11-07 down · 23-11-08→23-12-05 sideways · 23-12-06→25-03-13 up · 25-03-14→25-05-15 down · 25-05-16→25-06-04 sideways · 25-06-05→26-03-17 up · 26-03-18→26-03-24 sideways · 26-03-25→26-04-13 down · 26-04-14→26-05-04 sideways · 26-05-05→26-10-05 up

**breadth**: 19-10-15→20-03-12 normal · 20-03-13→20-05-21 selloff · 20-05-22→22-01-26 normal · 22-01-27→23-05-10 selloff · 23-05-11→23-10-23 normal · 23-10-24→23-11-07 selloff · 23-11-08→24-08-07 normal · 24-08-08→24-08-14 selloff · 24-08-15→25-02-26 normal · 25-02-27→25-06-25 selloff · 25-06-26→25-11-20 normal · 25-11-21→25-12-02 selloff · 25-12-03→26-03-03 normal · 26-03-04→26-05-05 selloff · 26-05-06→26-06-23 normal · 26-06-24→26-10-05 selloff

**vrp**: 20-01-02→20-02-10 normal · 20-02-11→20-07-17 panic · 20-07-20→20-07-30 normal · 20-07-31→20-09-29 rich · 20-09-30→20-10-13 panic · 20-10-14→20-10-22 normal · 20-10-23→20-11-11 rich · 20-11-12→20-12-03 panic · 20-12-04→20-12-14 normal · 20-12-15→21-02-23 rich · 21-02-24→21-03-15 normal · 21-03-16→21-04-06 panic · 21-04-07→21-05-27 normal · 21-05-28→21-06-14 panic · 21-06-15→21-09-21 normal · 21-09-22→21-10-15 rich · 21-10-18→21-11-01 panic · 21-11-02→21-11-11 normal · 21-11-12→21-12-10 rich · 21-12-13→22-01-25 panic · 22-01-26→22-02-09 rich · 22-02-10→22-04-14 panic · 22-04-18→22-05-06 normal · 22-05-09→22-08-19 panic · 22-08-22→22-10-06 normal · 22-10-07→23-01-04 panic · 23-01-05→23-01-13 normal · 23-01-17→23-02-24 panic · 23-02-27→23-03-30 normal · 23-03-31→23-04-13 panic · 23-04-17→23-05-31 normal · 23-06-02→23-06-14 panic · 23-06-21→23-07-07 panic · 23-07-10→23-07-27 normal · 23-08-01→23-09-01 normal · 23-09-05→23-12-06 panic · 23-12-07→24-02-13 normal · 24-02-14→24-03-26 panic · 24-03-27→24-05-01 normal · 24-05-02→24-06-03 panic · 24-06-04→24-07-29 normal · 24-07-31→24-09-09 panic · 24-09-10→24-09-24 normal · 24-09-25→24-10-09 panic · 24-10-10→24-11-11 rich · 24-11-12→24-12-10 panic · 24-12-11→24-12-27 normal · 24-12-30→25-02-18 panic · 25-02-19→25-03-19 normal · 25-03-20→25-06-13 panic · 25-06-16→25-07-17 normal · 25-07-18→25-08-07 rich · 25-08-08→25-08-27 normal · 25-09-05→25-09-25 normal · 25-09-26→25-11-11 rich · 25-11-12→25-12-01 normal · 25-12-02→25-12-22 panic · 25-12-23→26-03-10 normal · 26-03-11→26-04-06 rich · 26-04-07→26-04-13 normal · 26-04-14→26-04-30 panic · 26-05-01→26-06-23 normal · 26-06-24→26-07-21 panic · 26-07-22→26-08-06 normal · 26-08-07→26-09-22 panic · 26-09-23→26-10-05 normal

**vol**: 20-01-02→20-03-03 calm · 20-03-04→20-05-21 stressed · 20-05-22→20-06-16 normal · 20-06-17→20-07-06 stressed · 20-07-07→20-10-29 normal · 20-10-30→20-11-09 stressed · 20-11-10→21-04-07 normal · 21-04-08→21-10-01 calm · 21-10-04→21-10-18 normal · 21-10-19→21-12-01 calm · 21-12-02→21-12-28 normal · 21-12-29→22-01-19 calm · 22-01-20→22-05-23 normal · 22-05-24→22-05-31 stressed · 22-06-01→22-06-15 normal · 22-06-16→22-06-28 stressed · 22-06-29→22-09-28 normal · 22-09-29→22-11-07 stressed · 22-11-08→23-04-13 normal · 23-04-17→23-05-31 calm · 23-06-02→23-06-14 calm · 23-06-21→23-07-27 calm · 23-08-01→23-10-05 calm · 23-10-06→23-11-10 normal · 23-11-13→24-04-18 calm · 24-04-19→24-04-25 normal · 24-04-26→24-07-29 calm · 24-08-12→24-08-16 normal · 24-08-19→24-09-09 calm · 24-09-10→24-09-16 normal · 24-09-17→24-10-10 calm · 24-10-11→24-11-11 normal · 24-11-12→25-03-06 calm · 25-03-07→25-06-03 normal · 25-06-04→25-11-18 calm · 25-11-19→25-12-01 normal · 25-12-02→26-03-05 calm · 26-03-06→26-04-15 normal · 26-04-16→26-10-05 calm

## 2. Regime tests (5 pre-registered; sample = months; trials = 5)

**H1: 0.20Δ puts by vrp**

| state | months | loss rate | mean return / collateral | worst month |
|---|---|---|---|---|
| rich | 13 | 9.7% | 1.01% | -0.81% |
| normal | 26 | 19.2% | 0.25% | -1.69% |
| panic | 39 | 18.3% | -0.20% | -16.18% |

panic vs rich: loss-rate t = +2.11 (Welch, months). Halves (loss rate rich / panic): 10.3% / 22.1% · 8.8% / 13.8%

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
| rich | 13 | -0.027 | -1.2 |
| normal | 26 | +0.014 | +0.7 |
| panic | 38 | +0.002 | +0.1 |
| all | 78 | +0.001 | +0.1 |

**H4: long-term trend (stock score trend part) vs 63-day return vs peers, by breadth**

| breadth | months | IC | t |
|---|---|---|---|
| normal | 50 | +0.021 | +1.2 |
| selloff | 27 | +0.039 | +1.3 |

**H5: covered calls (0.20Δ) on top-fifth 20-day strength vs the rest**

call kept money: top fifth 83.7% vs rest 83.3%; monthly difference 0.3% (t +0.3, 79 months); halves 2.2% / -1.5%

## 3. Stock score (trend + revisions; fundamentals not testable yet)

Monthly IC vs 63-day return vs peers (`own63`):

| score | IC | t | months | 2020–23 | 2024–26 |
|---|---|---|---|---|---|
| Stock score | +0.038 | +2.6 | 77 | +0.032 | +0.047 |
| 12-1 momentum | +0.027 | +1.7 | 77 | +0.019 | +0.039 |
| vs 200-day | +0.043 | +3.1 | 77 | +0.041 | +0.047 |
| StarMine alpha | +0.025 | +1.0 | 77 | +0.026 | +0.023 |

## 4. Trade confidence %

### Puts (put P&L > 0)

Train 28,443 trades (to 2023-12) · test 23,976 (2024-01 →). Training success rate by delta: Δ0.15 84.7%, Δ0.2 80.6%, Δ0.3 73.9%

Brier: model 0.1426 vs baseline 0.1333 → skill **-7.0%** (> 0 = better than the strike alone)

Monthly Brier improvement: positive in 11/33 months, t -2.6; halves 5/16 / 6/17

Reliability on 2024–26 (fifths of predicted confidence):

| fifth | predicted | actual | n | gap |
|---|---|---|---|---|
| 1 | 61.1% | 78.4% | 4,796 | +17.2 |
| 2 | 70.6% | 82.0% | 4,795 | +11.4 |
| 3 | 76.2% | 83.7% | 4,795 | +7.4 |
| 4 | 81.2% | 86.8% | 4,795 | +5.5 |
| 5 | 88.9% | 90.0% | 4,795 | +1.0 |

Largest gap 17.2 pts (stop rule: > 10). By test half: 2024-01→2025-04 predicted 75.7% actual 83.3% · 2025-05→2026-09 predicted 75.6% actual 85.0%

Weights (standardized): delta -0.29, iv_rv +0.22, iv_rank_1y -0.12, stock +0.09, earnings_in_window +0.04, L_trend=down +0.35, L_trend=sideways -0.04, L_vrp=rich +0.31, L_vrp=panic -0.04, L_breadth=selloff -0.19, L_vol=stressed +0.57

### Calls (covered call beats holding)

Train 28,443 trades (to 2023-12) · test 23,976 (2024-01 →). Training success rate by delta: Δ0.15 88.1%, Δ0.2 84.6%, Δ0.3 77.1%

Brier: model 0.1517 vs baseline 0.1496 → skill **-1.4%** (> 0 = better than the strike alone)

Monthly Brier improvement: positive in 13/33 months, t -1.0; halves 7/16 / 6/17

Reliability on 2024–26 (fifths of predicted confidence):

| fifth | predicted | actual | n | gap |
|---|---|---|---|---|
| 1 | 76.3% | 71.2% | 4,796 | -5.1 |
| 2 | 86.4% | 78.0% | 4,795 | -8.4 |
| 3 | 90.3% | 81.8% | 4,795 | -8.6 |
| 4 | 92.9% | 85.7% | 4,795 | -7.2 |
| 5 | 95.4% | 90.2% | 4,795 | -5.2 |

Largest gap 8.6 pts (stop rule: > 10). By test half: 2024-01→2025-04 predicted 89.8% actual 81.9% · 2025-05→2026-09 predicted 86.9% actual 80.9%

Weights (standardized): delta -0.34, iv_rv -0.11, iv_rank_1y +0.35, stock -0.04, earnings_in_window -0.08, L_trend=down -0.35, L_trend=sideways -0.33, L_vrp=rich -0.44, L_vrp=panic -0.15, L_breadth=selloff +0.13, L_vol=stressed -0.30

## 5. Decision ladder (2024-01 → , 0.20Δ puts, top 20 a month by PREMIUM, equal weight; skipped month = 0)

| rung | months traded | trades | mean monthly return | loss rate | tail rate (< −5%) | worst month | mean/sd | halves (mean monthly) |
|---|---|---|---|---|---|---|---|---|
| L0 today (PREMIUM top 20, SPY pause) | 33/33 | 660 | 0.86% | 15.6% | 8.2% | -3.55% | 0.50 | 0.89% / 0.84% |
| L1 + regime dial (skip panic / downtrend months) | 18/33 | 360 | 0.34% | 18.3% | 10.8% | -3.55% | 0.22 | 0.35% / 0.34% |
| L2 + confidence (drop bottom-fifth) | 18/33 | 360 | 0.39% | 17.8% | 10.6% | -3.55% | 0.25 | 0.39% / 0.39% |

