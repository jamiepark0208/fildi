# Band engine — auto band vs fixed bands (2026-10-26)

Table fitted on 2019-12-16 → 2022-12 (108,691 1-week put candidates); graded on 2023-01 → 2026-10-12 (157,792). One trade per name-week at the chosen band. **book** = the average name-week each week, weeks with no trade count as 0. bp = real-fill net per collateral-week.

| rule | trades | book bp/wk | book worst 5 % wk | Sharpe | max DD % | per-trade bp | per-trade worst 5 % | income %/wk | vs fixed 0.06–0.08: Δ bp (t) · halves |
|---|---|---|---|---|---|---|---|---|---|
| fixed 0.06-0.08 | 17,444 | +36.5 | -34 | 5.30 | -7.1 | +37.4 | -26 | 0.68 | +0.0 (nan) · +0.0 / +0.0 |
| fixed 0.10-0.12 | 13,512 | +38.5 | -82 | 4.21 | -10.1 | +38.6 | -172 | 0.84 | +2.0 (1.0) · +5.2 / -1.2 |
| fixed 0.15-0.20 | 22,959 | +36.2 | -109 | 3.09 | -13.7 | +35.6 | -339 | 1.05 | -0.3 (-0.1) · +5.7 / -6.4 |
| auto (standard, tail ≥ -150) | 15,619 | +34.8 | -27 | 5.66 | -4.5 | +37.9 | -27 | 0.68 | -1.7 (-0.7) · -3.1 / -0.3 |
| auto (aggressive, tail ≥ -300) | 13,637 | +36.5 | -72 | 3.81 | -11.5 | +41.1 | -186 | 0.86 | +0.0 (0.0) · +1.3 / -1.2 |
| auto standard + size by market state | 15,619 | +12.7 | -8 | 4.41 | -2.1 | +13.9 | -8 | 0.68 | -23.8 (-8.5) · -26.9 / -20.7 |

Size by market state (fitted ≤ 2022): panic 0.00× · sharp_drop 1.00× · bear_grind 0.15× · normal 0.55× · rally 0.29×


## The table: chosen band per state (fitted ≤ 2022; standard / aggressive floor) + test check 2023 →

| market | name | standard band | aggressive band | train bp / worst 5 % (standard) | test bp / worst 5 % (standard band) | test months |
|---|---|---|---|---|---|---|
| panic | crashed | no trade | no trade | — | — | — |
| panic | normal | no trade | no trade | — | — | — |
| panic | extended | no trade | 0.06-0.08 | — | — | — |
| sharp_drop | crashed | 0.20-0.25 | 0.20-0.25 | +146 / -82 | — | — |
| sharp_drop | normal | 0.15-0.20 | 0.15-0.20 | +56 / -130 | — | — |
| sharp_drop | extended | 0.12-0.15 | 0.12-0.15 | +70 / +22 | — | — |
| bear_grind | crashed | no trade | 0.03-0.06 | — | — | — |
| bear_grind | normal | 0.03-0.06 | 0.06-0.08 | +7 / -127 | +21 / +11 | 4 |
| bear_grind | extended | 0.06-0.08 | 0.10-0.12 | +39 / -42 | +45 / +28 | 4 |
| normal | crashed | 0.06-0.08 | 0.06-0.08 | +65 / -73 | +59 / +2 | 20 |
| normal | normal | 0.10-0.12 | 0.20-0.25 | +26 / -118 | +41 / -15 | 20 |
| normal | extended | 0.12-0.15 | 0.20-0.25 | +65 / +32 | +32 / -262 | 20 |
| rally | crashed | 0.06-0.08 | 0.10-0.12 | +43 / -118 | +51 / -41 | 39 |
| rally | normal | 0.06-0.08 | 0.20-0.25 | +17 / -98 | +22 / -35 | 39 |
| rally | extended | 0.06-0.08 | 0.06-0.08 | +34 / -95 | +46 / -1 | 39 |
