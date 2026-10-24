# S088 vs current Model List put rule (holdout 2023 →, walk-forward)

Current = per name-week the candidate strike nearest |Δ| 0.15, |Δ| 0.08–0.2, credit ≥ 0.3 %/wk of strike. Name ranking (fit score) has no history → 'all eligible' and 'top 10 by credit' bracket it. pnl = bp per collateral-week.

| horizon | arm | n | bp/wk | real-fill bp/wk | kept | worst 5 % | Sharpe | max DD | avg |Δ| | week t | vs current all (t) | by year |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1w | current rule, all eligible | 34243 | +42.6 | +37.3 | 87.6% | -244 | 3.95 | -10.4% | 0.15 | 7.7 | +nan | 23:+53 24:+46 25:+27 26:+47 |
| 1w | current rule, top 10 by credit | 1972 | +154.0 | +123.8 | 86.0% | -558 | 5.07 | -16.4% | 0.15 | 9.9 | +8.7 | 23:+169 24:+161 25:+113 26:+178 |
| 1w | S088 top 10, P ≥ 90 % | 1972 | +121.0 | +96.6 | 91.5% | -189 | 4.80 | -18.7% | 0.09 | 9.4 | +7.3 | 23:+109 24:+139 25:+89 26:+153 |
| 1w | hybrid: current-eligible names, S088 strike, top 10 | 1972 | +120.6 | +96.3 | 91.5% | -189 | 4.79 | -18.7% | 0.09 | 9.4 | +7.3 | 23:+109 24:+138 25:+89 26:+153 |
| 1w | hybrid, all eligible names | 30546 | +40.3 | +36.5 | 93.1% | -51 | 5.46 | -7.1% | 0.08 | 10.7 | -1.3 | 23:+40 24:+48 25:+30 26:+45 |
| 1w | LIVE POLICY: S088 strike within Δ band + income floor, else current | 34243 | +41.0 | +36.1 | 88.7% | -211 | 4.04 | -10.0% | 0.13 | 7.9 | -3.8 | 23:+51 24:+44 25:+26 26:+46 |
| 1w | same names, plain strike nearest |Δ| 0.08 (same-risk comparator) | 34243 | +41.0 | +36.9 | 92.9% | -61 | 5.43 | -7.2% | 0.08 | 10.6 | -0.8 | 23:+43 24:+48 25:+29 26:+46 |
| 2w | current rule, all eligible | 29384 | +26.8 | +22.4 | 86.7% | -217 | 2.83 | -2.8% | 0.15 | 5.5 | +nan | 23:+36 24:+25 25:+18 26:+30 |
| 2w | current rule, top 10 by credit | 1962 | +108.4 | +88.3 | 85.1% | -361 | 6.53 | -2.6% | 0.16 | 12.7 | +12.9 | 23:+118 24:+89 25:+105 26:+125 |
| 2w | S088 top 10, P ≥ 90 % | 1962 | +79.1 | +64.2 | 92.3% | -116 | 6.32 | -3.4% | 0.09 | 12.3 | +11.8 | 23:+67 24:+71 25:+75 26:+111 |
| 2w | hybrid: current-eligible names, S088 strike, top 10 | 1962 | +77.0 | +62.4 | 92.2% | -127 | 6.26 | -3.4% | 0.09 | 12.2 | +11.9 | 23:+66 24:+70 25:+75 26:+102 |
| 2w | hybrid, all eligible names | 26185 | +23.7 | +20.7 | 92.7% | -64 | 3.69 | -2.8% | 0.08 | 7.2 | -1.8 | 23:+27 24:+24 25:+18 26:+28 |
| 2w | LIVE POLICY: S088 strike within Δ band + income floor, else current | 29384 | +25.9 | +21.9 | 87.6% | -197 | 2.88 | -2.8% | 0.14 | 5.6 | -2.6 | 23:+35 24:+25 25:+16 26:+29 |
| 2w | same names, plain strike nearest |Δ| 0.08 (same-risk comparator) | 29384 | +24.3 | +21.0 | 92.4% | -77 | 3.63 | -2.1% | 0.09 | 7.1 | -1.3 | 23:+30 24:+25 25:+16 26:+28 |
| 4w | current rule, all eligible | 22622 | +25.6 | +21.3 | 85.8% | -177 | 4.46 | -1.2% | 0.16 | 8.6 | +nan | 23:+31 24:+28 25:+21 26:+24 |
| 4w | current rule, top 10 by credit | 1942 | +72.7 | +57.9 | 82.9% | -328 | 6.05 | -1.3% | 0.16 | 11.7 | +10.9 | 23:+80 24:+80 25:+70 26:+56 |
| 4w | S088 top 10, P ≥ 90 % | 1942 | +59.6 | +48.8 | 92.8% | -34 | 8.69 | -0.7% | 0.08 | 16.8 | +13.1 | 23:+52 24:+56 25:+57 26:+77 |
| 4w | hybrid: current-eligible names, S088 strike, top 10 | 1942 | +57.0 | +46.6 | 92.7% | -37 | 8.54 | -0.6% | 0.08 | 16.5 | +12.8 | 23:+52 24:+56 25:+57 26:+65 |
| 4w | hybrid, all eligible names | 20243 | +21.8 | +18.7 | 93.0% | -39 | 6.22 | -0.6% | 0.08 | 12.0 | -2.6 | 23:+26 24:+21 25:+20 26:+21 |
| 4w | LIVE POLICY: S088 strike within Δ band + income floor, else current | 22622 | +24.9 | +20.8 | 86.7% | -161 | 4.65 | -1.2% | 0.15 | 9.0 | -3.0 | 23:+31 24:+27 25:+21 26:+23 |
| 4w | same names, plain strike nearest |Δ| 0.08 (same-risk comparator) | 22622 | +22.8 | +19.6 | 92.7% | -45 | 6.72 | -0.6% | 0.08 | 13.0 | -2.0 | 23:+26 24:+23 25:+21 26:+22 |
