# Fair value gap attribution (fv-1.1.0, 2026-10-27)

Valued 756. |log gap| median 0.17, worst-quintile cut 0.36 (≈ +44% / -30%). Bad (worst quintile and street disagrees > 0.4 log) = 60 (24 too high, 36 too low).
Street (LSEG PT) available 753; rank corr(model gap, street gap) = +0.32; median |model − street| 0.19 log.

## Step 1: what the price implies (medians)

| group | n | own fwd P/E | peer P/E applied | PVGO share | FY1→FY2 g | LTG | street gap | model gap |
|---|---|---|---|---|---|---|---|---|
| bad: too low | 36 | 53.3 | 16.1 | 81% | +14% | 17% | +0.08 | -0.53 |
| bad: too high | 24 | 7.2 | 17.9 | -61% | +9% | 22% | +0.07 | +0.60 |
| rest | 696 | 19.3 | 18.4 | 39% | +15% | 15% | +0.14 | +0.06 |

## Where bad gaps concentrate

**By sector** (base rate 8%, n ≥ 8):

| sector | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| fintech | 17.0 | 4.0 | 1.0 | 24% | 3.0× | +0.14 | +0.27 |
| consumer_discretionary | 82.0 | 12.0 | 4.0 | 15% | 1.8× | +0.06 | +0.17 |
| technology | 152.0 | 21.0 | 7.0 | 14% | 1.7× | +0.03 | +0.20 |
| energy | 28.0 | 3.0 | 3.0 | 11% | 1.4× | +0.13 | +0.09 |
| consumer_staples | 39.0 | 4.0 | 2.0 | 10% | 1.3× | +0.08 | +0.05 |
| healthcare | 83.0 | 6.0 | 2.0 | 7% | 0.9× | +0.06 | +0.10 |
| materials | 47.0 | 3.0 | 0.0 | 6% | 0.8× | +0.13 | +0.23 |
| real_estate | 35.0 | 1.0 | 0.0 | 3% | 0.4× | +0.07 | +0.13 |
| utilities | 38.0 | 1.0 | 1.0 | 3% | 0.3× | +0.02 | +0.08 |
| industrials | 134.0 | 3.0 | 3.0 | 2% | 0.3× | +0.01 | +0.16 |
| financials | 93.0 | 2.0 | 1.0 | 2% | 0.3× | +0.15 | +0.14 |
| telecom | 8.0 | 0.0 | 0.0 | 0% | 0.0× | +0.47 | +0.31 |

**By gname** (base rate 8%, n ≥ 6):

| gname | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| Autos & EVs | 8.0 | 4.0 | 3.0 | 50% | 6.3× | +0.58 | +0.21 |
| Travel, Leisure & Hospitality | 20.0 | 5.0 | 1.0 | 25% | 3.2× | +0.23 | +0.22 |
| Digital Finance & Payments | 17.0 | 4.0 | 1.0 | 24% | 3.0× | +0.14 | +0.27 |
| Enterprise Software & Cloud | 47.0 | 11.0 | 0.0 | 23% | 2.9× | -0.11 | +0.05 |
| Semiconductors — Design | 22.0 | 4.0 | 2.0 | 18% | 2.3× | -0.04 | +0.35 |
| Chemicals | 14.0 | 2.0 | 0.0 | 14% | 1.8× | +0.03 | +0.13 |
| Integrated Oil & Gas | 23.0 | 3.0 | 3.0 | 13% | 1.6× | +0.20 | +0.04 |
| Packaged Goods & Beverages | 31.0 | 4.0 | 2.0 | 13% | 1.6× | +0.06 | +0.04 |
| Consumer Internet & Digital Media | 26.0 | 3.0 | 3.0 | 12% | 1.5× | +0.14 | +0.18 |
| IT Hardware & Networking | 27.0 | 3.0 | 2.0 | 11% | 1.4× | +0.10 | +0.21 |
| Base Metals & Mining | 9.0 | 1.0 | 0.0 | 11% | 1.4× | +0.05 | +0.28 |
| Medical Devices & Equipment | 38.0 | 4.0 | 0.0 | 11% | 1.3× | -0.02 | +0.08 |

**By mode** (base rate 8%, n ≥ 5):

| mode | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| financial_mixed | 17.0 | 4.0 | 1.0 | 24% | 3.0× | +0.14 | +0.27 |
| pre_revenue_ok | 50.0 | 11.0 | 0.0 | 22% | 2.8× | -0.08 | +0.06 |
| energy | 28.0 | 3.0 | 3.0 | 11% | 1.4× | +0.13 | +0.09 |
| standard | 471.0 | 37.0 | 18.0 | 8% | 1.0× | +0.05 | +0.15 |
| insurance | 33.0 | 2.0 | 1.0 | 6% | 0.8× | +0.08 | +0.05 |
| mining | 22.0 | 1.0 | 0.0 | 5% | 0.6× | +0.21 | +0.38 |
| reit | 35.0 | 1.0 | 0.0 | 3% | 0.4× | +0.07 | +0.13 |
| utility | 38.0 | 1.0 | 1.0 | 3% | 0.3× | +0.02 | +0.08 |
| financial | 55.0 | 0.0 | 0.0 | 0% | 0.0× | +0.19 | +0.17 |
| healthcare_services | 7.0 | 0.0 | 0.0 | 0% | 0.0× | +0.21 | +0.10 |

**Traits (rate of bad when trait true vs false):**

| trait | n true | bad rate true | bad rate false | lift | direction when bad |
|---|---|---|---|---|---|
| FY1→FY2 growth > 25 % | 59 | 10% | 8% | 1.3× | 5 low / 1 high |
| LTG > 20 % | 60 | 13% | 7% | 1.8× | 5 low / 3 high |
| PVGO share > 60 % | 214 | 15% | 5% | 3.1× | 32 low / 1 high |
| own fwd P/E > 2× applied peer P/E | 54 | 35% | 6% | 6.0× | 19 low / 0 high |
| own fwd P/E < 0.5× applied | 26 | 31% | 7% | 4.3× | 0 low / 8 high |
| net debt / EBITDA > 3 | 198 | 7% | 8% | 0.8× | 6 low / 7 high |
| cyclical flag | 141 | 8% | 8% | 1.0× | 5 low / 6 high |
| value-trap flag | 92 | 10% | 8% | 1.3× | 0 low / 9 high |
| FY1 > 1.5× trailing EPS | 194 | 11% | 7% | 1.7× | 13 low / 9 high |
| FY1 < 0.67× trailing EPS | 19 | 11% | 8% | 1.3× | 1 low / 1 high |
| ROE > 30 % | 190 | 6% | 8% | 0.7× | 5 low / 7 high |
| beta > 1.6 | 91 | 16% | 7% | 2.4× | 9 low / 6 high |
| cap < $10B | 81 | 12% | 7% | 1.7× | 4 low / 6 high |
| cap > $200B | 61 | 16% | 7% | 2.3× | 9 low / 1 high |
| dividend yield > 4 % | 74 | 14% | 7% | 1.8× | 0 low / 10 high |
| ≤ 2 methods kept | 61 | 18% | 7% | 2.6× | 11 low / 0 high |

## Step 2: what explains log(FV / price) cross-sectionally

OLS on rank-normalised inputs R² 0.44 (in-sample); GBM + sector dummies out-of-fold R² 0.46.

| input | OLS coef (per 1 sd) | t | GBM permutation importance |
|---|---|---|---|
| value_trap_i | +0.102 | +12.3 | 0.243 |
| street | +0.100 | +10.3 | 0.226 |
| dividend_yield | +0.062 | +5.9 | 0.110 |
| log_cap | -0.053 | -4.8 | 0.104 |
| eps_vs_trailing | +0.047 | +5.4 | 0.058 |
| gross_margin | -0.039 | -4.2 | 0.047 |
| net_debt_ebitda | +0.008 | +0.9 | 0.047 |
| beta | -0.031 | -3.3 | 0.028 |
| return_on_equity | +0.033 | +2.8 | 0.027 |
| revenue_growth_yoy | -0.027 | -3.1 | 0.025 |
| g12 | -0.009 | -0.9 | 0.018 |
| sector (all dummies) | | | 0.012 |
| operating_margin | +0.028 | +2.8 | 0.010 |
| short_pct | +0.004 | +0.4 | 0.008 |
| arm_rank | -0.010 | -1.0 | 0.004 |
| roic | -0.004 | -0.3 | 0.003 |
| eps_drift_30d_pct | +0.010 | +1.1 | 0.002 |
| cyclical_i | +0.011 | +1.3 | -0.001 |
| ltg | +0.007 | +0.8 | -0.003 |

**Per sector, strongest single drivers (rank corr with gap, n ≥ 25):**

| sector | n | top drivers (ρ) |
|---|---|---|
| consumer_discretionary | 82 | value_trap_i +0.56, roic -0.37, street +0.33, log_cap -0.27 |
| consumer_staples | 39 | value_trap_i +0.68, roic -0.65, net_debt_ebitda +0.49, log_cap -0.48 |
| energy | 28 | g12 +0.49, ltg -0.48, log_cap -0.43, value_trap_i +0.31 |
| financials | 93 | sbc_to_revenue +1.00, return_on_equity -0.49, value_trap_i +0.49, roic -0.42 |
| healthcare | 83 | g12 -0.43, value_trap_i +0.41, street +0.37, beta -0.36 |
| industrials | 134 | value_trap_i +0.46, log_cap -0.32, short_pct +0.30, eps_drift_30d_pct -0.26 |
| materials | 47 | ltg +1.00, arm_rank -0.52, short_pct +0.43, log_cap -0.39 |
| real_estate | 35 | g12 -1.00, ltg +1.00, value_trap_i +0.49, arm_rank -0.38 |
| technology | 152 | street +0.46, value_trap_i +0.44, net_debt_ebitda +0.40, sbc_to_revenue +0.31 |
| utilities | 38 | ltg +1.00, arm_rank -0.54, value_trap_i +0.52, eps_vs_trailing +0.51 |

## Worst 40 bad names

| ticker | sector | group | gap | street | own P/E | peer P/E | g12 | LTG | PVGO | flags |
|---|---|---|---|---|---|---|---|---|---|---|
| TSLA | consumer_discretionary | Autos & EVs | -69% | +1% | 159.1 | 7.0 | -7% | 13% | 95% |  |
| MU | technology | Semiconductors — Design | +178% | +70% | 5.2 | 32.9 | -11% | - | -35% | cyc |
| PLTR | technology | Enterprise Software & Cloud | -63% | +5% | 124.3 | - | +47% | 58% | 93% |  |
| SNDK | technology | Semiconductors — Design | +155% | +68% | 5.8 | 32.9 | +15% | - | -21% | cyc |
| YELP | technology | Consumer Internet & Digital Media | +146% | +27% | 10.8 | 44.6 | +- | - | -38% | trap |
| DKNG | consumer_discretionary | Travel, Leisure & Hospitality | -59% | +62% | 12.0 | - | +- | - | 32% |  |
| DDOG | technology | Enterprise Software & Cloud | -58% | +4% | 109.7 | - | +15% | 17% | 92% |  |
| PANW | technology | Enterprise Software & Cloud | -57% | +2% | 93.4 | - | -2% | 13% | 88% |  |
| GM | consumer_discretionary | Autos & EVs | +125% | +29% | 5.7 | 10.3 | +12% | 17% | -63% |  |
| F | consumer_discretionary | Autos & EVs | +110% | +35% | 6.3 | 10.3 | +4% | 22% | -18% | trap |
| SMCI | technology | IT Hardware & Networking | +104% | +34% | 7.1 | 18.9 | +15% | 48% | 1% | trap |
| PBR | energy | Integrated Oil & Gas | +103% | +4% | 5.7 | 9.4 | -12% | - | -164% | cyc |
| BMBL | technology | Consumer Internet & Digital Media | +99% | -32% | 3.0 | - | +- | - | -145% | trap |
| SHOP | technology | Enterprise Software & Cloud | -50% | +5% | 88.8 | - | +28% | 32% | 92% |  |
| OMC | industrials | Professional Services | +97% | +28% | 8.0 | 20.4 | +- | - | -63% | trap |
| ILMN | healthcare | Medical Devices & Equipment | -49% | -12% | 52.6 | 21.3 | +- | - | 83% |  |
| SNAP | technology | Consumer Internet & Digital Media | +94% | +18% | 10.4 | 20.8 | +30% | 40% | -2% | trap |
| ZS | technology | Enterprise Software & Cloud | -48% | -10% | 53.3 | - | -6% | 17% | 79% |  |
| AAL | consumer_discretionary | Travel, Leisure & Hospitality | +92% | +25% | 4.8 | - | -1% | - | -91% |  |
| FIS | fintech | Digital Finance & Payments | +90% | +27% | 6.0 | 17.5 | +- | - | -103% | trap |
| FTNT | technology | Enterprise Software & Cloud | -46% | -9% | 53.2 | - | +10% | 17% | 81% |  |
| ARM | technology | Semiconductors — Design | -45% | +28% | 100.3 | 31.7 | +36% | 30% | 93% | cyc |
| RGEN | healthcare | Medical Devices & Equipment | -44% | +16% | 84.6 | 21.3 | +- | - | 88% |  |
| MDB | technology | Enterprise Software & Cloud | -44% | +15% | 59.5 | - | +12% | 16% | 86% |  |
| CRCL | fintech | Digital Finance & Payments | -43% | +31% | 73.3 | 15.5 | +- | - | 90% |  |
| LYV | consumer_discretionary | Travel, Leisure & Hospitality | -43% | +16% | 90.7 | - | +- | - | 89% |  |
| HMC | consumer_discretionary | Autos & EVs | +77% | -2% | 20.6 | 36.2 | +- | - | 28% |  |
| CHYM | fintech | Digital Finance & Payments | -43% | +40% | 62.1 | 15.5 | +- | - | 89% |  |
| ERIE | financials | Insurance | -43% | -69% | 19.4 | 12.0 | +- | - | 23% |  |
| KO | consumer_staples | Packaged Goods & Beverages | -43% | +3% | 28.0 | 16.1 | +- | - | 47% |  |
| ARW | technology | IT Hardware & Networking | +73% | +5% | 10.1 | 18.9 | +- | - | 1% |  |
| OKTA | technology | Enterprise Software & Cloud | -42% | -6% | 58.0 | - | +- | - | 78% |  |
| TAP | consumer_staples | Packaged Goods & Beverages | +69% | +9% | 8.5 | 16.3 | +- | - | -76% | trap |
| PEN | healthcare | Medical Devices & Equipment | -40% | +13% | 69.3 | 21.3 | +- | - | 81% |  |
| FRO | industrials | Transportation & Logistics | +67% | -10% | 6.1 | 25.1 | +- | - | -145% |  |
| BMY | healthcare | Large Pharma | +66% | +6% | 9.4 | 14.6 | +- | - | -59% |  |
| CCJ | materials | Base Metals & Mining | -40% | +49% | 55.1 | 14.7 | +- | - | 82% | cyc |
| WELL | real_estate | REITs — Diversified | -38% | +9% | 83.5 | - | +- | - | 85% |  |
| TEAM | technology | Enterprise Software & Cloud | -38% | +1% | 40.6 | - | +20% | 16% | 76% |  |
| BB | technology | Enterprise Software & Cloud | -38% | +7% | 44.7 | - | +12% | - | 81% |  |
