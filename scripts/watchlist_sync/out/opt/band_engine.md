# Band engine — auto band vs fixed bands (2026-10-26)

Table fitted on 2019-12-16 → 2022-12 (111,181 1-week put candidates); graded on 2023-01 → 2026-10-12 (161,617). One trade per name-week at the chosen band. **book** = the average name-week each week, weeks with no trade count as 0. bp = real-fill net per collateral-week.

| rule | trades | book bp/wk | book worst 5 % wk | Sharpe | max DD % | per-trade bp | per-trade worst 5 % | income %/wk | vs fixed 0.06–0.08: Δ bp (t) · halves |
|---|---|---|---|---|---|---|---|---|---|
| fixed 0.06-0.08 | 17,200 | +27.0 | -36 | 4.29 | -7.6 | +27.8 | -29 | 0.58 | +0.0 (nan) · +0.0 / +0.0 |
| fixed 0.08-0.10 | 15,283 | +28.1 | -66 | 3.56 | -9.8 | +28.5 | -116 | 0.68 | +1.1 (0.8) · +3.8 / -1.6 |
| fixed 0.10-0.12 | 13,378 | +31.7 | -80 | 3.53 | -10.8 | +32.0 | -177 | 0.76 | +4.7 (2.6) · +7.1 / +2.3 |
| fixed 0.15-0.20 | 22,922 | +33.5 | -111 | 2.86 | -14.1 | +33.1 | -340 | 1.03 | +6.5 (2.0) · +11.0 / +2.0 |
| auto (standard, tail ≥ -200) | 14,250 | +28.2 | -42 | 4.78 | -4.1 | +30.8 | -61 | 0.64 | +1.2 (0.5) · +0.9 / +1.4 |
| auto (aggressive, tail ≥ -400) | 12,896 | +32.0 | -85 | 3.40 | -11.5 | +36.6 | -201 | 0.83 | +5.0 (2.0) · +5.3 / +4.6 |

Size by market state was tested (weights from ≤ 2022) and failed out of sample (Sharpe and bp down) → not used; panic = no trade is the only timing rule.


## The table: chosen band per state (fitted ≤ 2022; standard / aggressive floor) + test check 2023 →

| market | name | standard band | aggressive band | train bp / worst 5 % (standard) | test bp / worst 5 % (standard band) | test months |
|---|---|---|---|---|---|---|
| panic | crashed | no trade | no trade | — | — | — |
| panic | normal | no trade | no trade | — | — | — |
| panic | extended | no trade | 0.06-0.08 | — | — | — |
| sharp_drop | crashed | 0.20-0.25 | 0.20-0.25 | +139 / -88 | — | — |
| sharp_drop | normal | 0.15-0.20 | 0.15-0.20 | +51 / -133 | — | — |
| sharp_drop | extended | 0.12-0.15 | 0.12-0.15 | +66 / +17 | — | — |
| bear_grind | crashed | no trade | 0.03-0.06 | — | — | — |
| bear_grind | normal | 0.06-0.08 | 0.06-0.08 | +8 / -189 | +20 / +17 | 4 |
| bear_grind | extended | 0.06-0.08 | 0.10-0.12 | +36 / -32 | +41 / +27 | 4 |
| normal | crashed | 0.06-0.08 | 0.10-0.12 | +47 / -117 | +41 / -26 | 20 |
| normal | normal | 0.08-0.10 | 0.10-0.12 | +22 / -125 | +29 / -29 | 20 |
| normal | extended | 0.12-0.15 | 0.20-0.25 | +61 / +33 | +30 / -269 | 20 |
| rally | crashed | 0.08-0.10 | 0.10-0.12 | +43 / -196 | +38 / -149 | 39 |
| rally | normal | 0.08-0.10 | 0.20-0.25 | +14 / -131 | +21 / -55 | 39 |
| rally | extended | 0.06-0.08 | 0.10-0.12 | +25 / -105 | +34 / -8 | 39 |
