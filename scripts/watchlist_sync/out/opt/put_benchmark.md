# Put benchmark — live engine vs variants (holdout 2023 →, S088 1-week puts, real fills)

161,617 candidates, 198 weeks. Book = per collateral-week incl. no-trade weeks. Verdict vs live engine (see docstring).

| strategy | trades | book bp/wk | Δ vs live | t | worst-5 % wk | Δ | Sharpe | max DD % | breach % | pre-2023 Δ bp / Δ w5 | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (live) Fildi engine | 14,468 | +29.6 | | | -31 | | 4.84 | -5.0 | 7.0 | | |
| (ref) Alpaca wheel score | 38,215 | +32.7 | +3.2 | +0.7 | -101 | -69 | 2.82 | -14.0 | 16.1 |  | **SAME** |
| (ref) fixed 0.11Δ | 38,276 | +28.8 | -0.8 | -0.3 | -52 | -21 | 3.58 | -10.2 | 9.8 |  | **WORSE** |
| risk 2 flags → 1 band farther | 14,904 | +29.4 | -0.2 | -0.3 | -31 | +0 | 4.98 | -4.7 | 6.9 | +1.0 / +0 | **SAME** |
| risk 2 → farther, 0 → closer | 14,659 | +29.6 | +0.0 | +0.0 | -33 | -2 | 4.88 | -4.7 | 7.2 | +0.4 / +4 | **SAME** |
| risk 2 flags → skip week | 12,688 | +26.6 | -2.9 | -1.6 | -26 | +5 | 5.06 | -3.4 | 6.8 | -7.6 / +37 | **SAME** |
| jump model bear → 1 band farther | 15,098 | +28.6 | -1.0 | -2.5 | -31 | +0 | 4.68 | -5.2 | 6.8 | -1.1 / -5 | **SAME** |
| refit: market state × risk flags | 14,504 | +28.0 | -1.6 | -1.0 | -41 | -10 | 4.92 | -3.5 | 7.2 | +2.2 / +19 | **SAME** |
| refit: market state × jump model | 14,624 | +27.2 | -2.3 | -2.0 | -40 | -9 | 4.90 | -4.0 | 6.8 | -1.6 / +6 | **WORSE** |
| fill skipped weeks with the base band | 15,023 | +30.8 | +1.2 | +3.6 | -31 | +0 | 5.06 | -5.0 | 6.8 | -1.6 / -14 | **BETTER (holdout only)** |
| fill skipped weeks one band farther than base | 15,239 | +30.4 | +0.8 | +2.6 | -31 | +0 | 5.04 | -5.0 | 6.7 | -1.4 / -12 | **SAME** |
