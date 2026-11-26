# S207 — Jamie's short puts vs the put engine, same weeks (2026-11-26)

Jamie: 869 open positions in RH orders (2025-03-19 → 2026-11-24), 852 gradable (852 expired, 654 closed early), 50 names. Engine book ends 2026-09-28; paired weeks 66.

Jamie's typical put: 9.3% OTM (IQR 5.3%–14.1%), 4 DTE (IQR 3–8), premium 1.00% of strike. Engine book: ~1σ OTM, 4–5 DTE weekly.

## Jamie, every trade (% of strike per trade)

- actual (with his early closes): mean -0.28%, contract-wtd -0.04%, win 77%, worst -20.1%, n 852
- hold to expiry (expired only): mean +0.01%, win 81%, worst -27.2%, n 852
- early closes vs holding the same contract: -0.38% of strike per trade (n 654, helped 10%)

## Same weeks, bp of strike per week held (paired by week, week-clustered t)

| Book | mean bp/wk | vs engine | t | weeks | worst week |
|---|---|---|---|---|---|
| Engine champion (top ⅓ by score) | +37.0 | — | — | 66 | -308.0 |
| Random same-Δ (all names) | +20.2 | -16.8 | -2.7 | 66 | -236.1 |
| Jamie actual (his strikes, DTE, exits) | +29.3 | -7.8 | -0.2 | 66 | -2245.9 |
| Jamie held to expiry | +33.1 | -3.9 | -0.1 | 66 | -2114.3 |
| Jamie's names, engine structure (1σ weekly) | +28.8 | -8.2 | -0.3 | 66 | -999.3 |

Jamie actual − engine by half: first -49.2 (weeks 2025-04-14…2026-02-09) · second +33.7 (…2026-09-28); Jamie beat the engine in 64% of weeks.

## Risk, same weeks

| Book | median bp/wk | sd | mean ÷ sd | weeks < −100 bp | worst 3 weeks avg |
|---|---|---|---|---|---|
| Engine champion | +75.1 | 109 | +0.34 | 9 | -287.4 |
| Random same-Δ | +35.3 | 71 | +0.29 | 6 | -172.8 |
| Jamie actual | +93.9 | 338 | +0.09 | 9 | -1146.5 |

Jamie's 3 worst weeks vs engine: 2026-01-26 -2068.0 · 2025-04-14 -942.3 · 2026-01-19 -556.8

## Early closes, $ (×100 multiplier)

- holding every early-closed contract to expiry instead: +7,705 $ over 654 positions · profit-takes 537 (+4,045 $) · loss closes 117 (+3,660 $)

## Calibration: Jamie's real fill ÷ engine model price at his strike

- median 1.08× (IQR 0.75–1.81), n 633 → model under-prices OTM puts (flat iv30, no skew): engine premium is conservative
