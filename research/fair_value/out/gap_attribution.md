# Fair value gap attribution (fv-1.1.0, 2026-10-27)

Valued 791. |log gap| median 0.23, worst-quintile cut 0.50 (≈ +64% / -39%). Bad (worst quintile and street disagrees > 0.4 log) = 128 (46 too high, 82 too low).
Street (LSEG PT) available 788; rank corr(model gap, street gap) = +0.17; median |model − street| 0.24 log.

## Step 1: what the price implies (medians)

| group | n | own fwd P/E | peer P/E applied | PVGO share | FY1→FY2 g | LTG | street gap | model gap |
|---|---|---|---|---|---|---|---|---|
| bad: too low | 82 | 46.8 | 20.0 | 81% | +22% | 20% | +0.12 | -0.72 |
| bad: too high | 46 | 8.1 | 17.5 | -39% | +10% | 19% | +0.10 | +0.74 |
| rest | 663 | 19.0 | 18.4 | 38% | +14% | 15% | +0.14 | +0.05 |

## Where bad gaps concentrate

**By sector** (base rate 16%, n ≥ 8):

| sector | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| fintech | 19.0 | 10.0 | 5.0 | 53% | 3.3× | +0.08 | +0.27 |
| healthcare | 89.0 | 24.0 | 8.0 | 27% | 1.7× | +0.03 | +0.10 |
| technology | 173.0 | 42.0 | 11.0 | 24% | 1.5× | -0.02 | +0.21 |
| materials | 47.0 | 9.0 | 2.0 | 19% | 1.2× | +0.05 | +0.23 |
| consumer_discretionary | 83.0 | 15.0 | 5.0 | 18% | 1.1× | +0.03 | +0.17 |
| consumer_staples | 39.0 | 7.0 | 4.0 | 18% | 1.1× | +0.07 | +0.05 |
| energy | 29.0 | 4.0 | 3.0 | 14% | 0.9× | +0.15 | +0.09 |
| industrials | 136.0 | 11.0 | 4.0 | 8% | 0.5× | -0.07 | +0.16 |
| utilities | 38.0 | 2.0 | 2.0 | 5% | 0.3× | +0.01 | +0.08 |
| financials | 93.0 | 3.0 | 2.0 | 3% | 0.2× | +0.16 | +0.14 |
| real_estate | 36.0 | 1.0 | 0.0 | 3% | 0.2× | +0.07 | +0.13 |
| telecom | 8.0 | 0.0 | 0.0 | 0% | 0.0× | +0.41 | +0.31 |

**By gname** (base rate 16%, n ≥ 6):

| gname | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| Autos & EVs | 9.0 | 5.0 | 3.0 | 56% | 3.4× | +0.57 | +0.25 |
| Digital Finance & Payments | 19.0 | 10.0 | 5.0 | 53% | 3.3× | +0.08 | +0.27 |
| Semiconductors — Design | 22.0 | 10.0 | 2.0 | 45% | 2.8× | -0.11 | +0.35 |
| Chemicals | 14.0 | 5.0 | 1.0 | 36% | 2.2× | +0.01 | +0.13 |
| Medical Devices & Equipment | 41.0 | 14.0 | 1.0 | 34% | 2.1× | -0.17 | +0.08 |
| Health Insurance & Managed Care | 7.0 | 2.0 | 2.0 | 29% | 1.8× | +0.24 | +0.10 |
| Enterprise Software & Cloud | 54.0 | 15.0 | 1.0 | 28% | 1.7× | -0.14 | +0.05 |
| Consumer Internet & Digital Media | 30.0 | 8.0 | 5.0 | 27% | 1.6× | +0.10 | +0.15 |
| Food, Grocery & Agriculture | 8.0 | 2.0 | 1.0 | 25% | 1.5× | +0.19 | +0.12 |
| Large Pharma | 21.0 | 5.0 | 4.0 | 24% | 1.5× | +0.17 | +0.06 |
| IT Hardware & Networking | 27.0 | 6.0 | 3.0 | 22% | 1.4× | +0.09 | +0.21 |
| Base Metals & Mining | 9.0 | 2.0 | 1.0 | 22% | 1.4× | -0.18 | +0.28 |

**By mode** (base rate 16%, n ≥ 5):

| mode | n | bad | of which too high | rate | lift | median gap | median street |
|---|---|---|---|---|---|---|---|
| financial_mixed | 19.0 | 10.0 | 5.0 | 53% | 3.3× | +0.08 | +0.27 |
| healthcare_services | 7.0 | 2.0 | 2.0 | 29% | 1.8× | +0.24 | +0.10 |
| pre_revenue_ok | 57.0 | 15.0 | 1.0 | 26% | 1.6× | -0.07 | +0.06 |
| chinese | 11.0 | 2.0 | 0.0 | 18% | 1.1× | +0.41 | +0.52 |
| standard | 483.0 | 86.0 | 30.0 | 18% | 1.1× | -0.00 | +0.15 |
| energy | 29.0 | 4.0 | 3.0 | 14% | 0.9× | +0.15 | +0.09 |
| mining | 22.0 | 3.0 | 1.0 | 14% | 0.8× | +0.14 | +0.38 |
| insurance | 33.0 | 2.0 | 2.0 | 6% | 0.4× | +0.08 | +0.05 |
| utility | 38.0 | 2.0 | 2.0 | 5% | 0.3× | +0.01 | +0.08 |
| reit | 36.0 | 1.0 | 0.0 | 3% | 0.2× | +0.07 | +0.13 |
| financial | 55.0 | 1.0 | 0.0 | 2% | 0.1× | +0.19 | +0.17 |

**Traits (rate of bad when trait true vs false):**

| trait | n true | bad rate true | bad rate false | lift | direction when bad |
|---|---|---|---|---|---|
| FY1→FY2 growth > 25 % | 60 | 25% | 15% | 1.6× | 14 low / 1 high |
| LTG > 20 % | 63 | 27% | 15% | 1.8× | 13 low / 4 high |
| PVGO share > 60 % | 229 | 31% | 10% | 3.1× | 71 low / 0 high |
| own fwd P/E > 2× applied peer P/E | 54 | 72% | 12% | 6.0× | 39 low / 0 high |
| own fwd P/E < 0.5× applied | 26 | 62% | 15% | 4.2× | 0 low / 16 high |
| net debt / EBITDA > 3 | 202 | 14% | 17% | 0.9× | 13 low / 16 high |
| cyclical flag | 143 | 17% | 16% | 1.0× | 17 low / 7 high |
| value-trap flag | 112 | 21% | 15% | 1.3× | 0 low / 23 high |
| FY1 > 1.5× trailing EPS | 207 | 21% | 15% | 1.4× | 25 low / 18 high |
| FY1 < 0.67× trailing EPS | 20 | 15% | 16% | 0.9× | 2 low / 1 high |
| ROE > 30 % | 197 | 13% | 17% | 0.8× | 17 low / 9 high |
| beta > 1.6 | 95 | 29% | 14% | 2.1× | 22 low / 6 high |
| cap < $10B | 95 | 20% | 16% | 1.3× | 10 low / 9 high |
| cap > $200B | 62 | 26% | 15% | 1.7× | 15 low / 1 high |
| street target not kept | 309 | 34% | 5% | 7.1× | 72 low / 33 high |
| dividend yield > 4 % | 76 | 18% | 16% | 1.2× | 0 low / 14 high |
| ≤ 2 methods kept | 127 | 21% | 15% | 1.4× | 24 low / 3 high |

## Step 2: what explains log(FV / price) cross-sectionally

OLS on rank-normalised inputs R² 0.41 (in-sample); GBM + sector dummies out-of-fold R² 0.45.

| input | OLS coef (per 1 sd) | t | GBM permutation importance |
|---|---|---|---|
| value_trap_i | +0.152 | +11.2 | 0.238 |
| dividend_yield | +0.101 | +6.1 | 0.153 |
| log_cap | -0.095 | -5.4 | 0.122 |
| street | +0.080 | +5.3 | 0.083 |
| net_debt_ebitda | +0.037 | +2.5 | 0.075 |
| gross_margin | -0.063 | -4.2 | 0.055 |
| return_on_equity | +0.069 | +3.6 | 0.053 |
| eps_vs_trailing | +0.065 | +4.8 | 0.035 |
| sector (all dummies) | | | 0.035 |
| beta | -0.049 | -3.4 | 0.027 |
| operating_margin | +0.054 | +3.3 | 0.026 |
| g12 | -0.013 | -0.9 | 0.017 |
| revenue_growth_yoy | -0.047 | -3.3 | 0.014 |
| arm_rank | -0.029 | -1.9 | 0.014 |
| eps_drift_30d_pct | +0.021 | +1.4 | 0.006 |
| short_pct | -0.010 | -0.6 | 0.005 |
| roic | +0.001 | +0.1 | 0.002 |
| ltg | +0.009 | +0.6 | 0.001 |
| cyclical_i | +0.018 | +1.4 | -0.000 |

**Per sector, strongest single drivers (rank corr with gap, n ≥ 25):**

| sector | n | top drivers (ρ) |
|---|---|---|
| consumer_discretionary | 83 | value_trap_i +0.56, roic -0.35, dividend_yield +0.30, revenue_growth_yoy -0.25 |
| consumer_staples | 39 | value_trap_i +0.68, roic -0.64, net_debt_ebitda +0.49, dividend_yield +0.47 |
| energy | 29 | g12 +0.52, ltg -0.52, log_cap -0.42, value_trap_i +0.28 |
| financials | 93 | sbc_to_revenue +1.00, return_on_equity -0.50, value_trap_i +0.48, roic -0.43 |
| healthcare | 89 | dividend_yield +0.43, value_trap_i +0.41, g12 -0.41, beta -0.37 |
| industrials | 136 | value_trap_i +0.51, dividend_yield +0.38, ltg -0.37, g12 -0.35 |
| materials | 47 | ltg +0.50, arm_rank -0.48, short_pct +0.33, log_cap -0.33 |
| real_estate | 36 | g12 -1.00, ltg +1.00, value_trap_i +0.59, dividend_yield +0.49 |
| technology | 173 | value_trap_i +0.55, net_debt_ebitda +0.32, sbc_to_revenue +0.31, dividend_yield +0.29 |
| utilities | 38 | ltg +1.00, arm_rank -0.54, value_trap_i +0.51, g12 +0.50 |

## Worst 40 bad names

| ticker | sector | group | gap | street | own P/E | peer P/E | g12 | LTG | PVGO | flags |
|---|---|---|---|---|---|---|---|---|---|---|
| GKOS | healthcare | Medical Devices & Equipment | -95% | +8% | 350.8 | - | +- | - | 96% | PTnotkept |
| TSLA | consumer_discretionary | Autos & EVs | -90% | +1% | 159.1 | 7.0 | -7% | 13% | 95% | PTnotkept |
| GH | healthcare | Medical Devices & Equipment | -85% | +13% | - | nan | +- | - | - |  |
| PLTR | technology | Enterprise Software & Cloud | -84% | +5% | 124.3 | - | +47% | 58% | 93% | PTnotkept |
| DDOG | technology | Enterprise Software & Cloud | -83% | +4% | 109.7 | - | +15% | 17% | 92% | PTnotkept |
| MRNA | healthcare | Large Biotech | -82% | -28% | - | nan | +- | - | - |  |
| NTRA | healthcare | Medical Devices & Equipment | -82% | -3% | - | nan | +- | - | - |  |
| PANW | technology | Enterprise Software & Cloud | -81% | +2% | 93.4 | - | -2% | 13% | 88% | PTnotkept |
| MU | technology | Semiconductors — Design | +311% | +70% | 5.2 | 32.9 | -11% | - | -35% | cyc,PTnotkept |
| YELP | technology | Consumer Internet & Digital Media | +290% | +27% | 10.8 | 44.6 | +- | - | -38% | trap,PTnotkept |
| ARM | technology | Semiconductors — Design | -74% | +28% | 100.3 | 31.7 | +36% | 30% | 93% | cyc,PTnotkept |
| SHOP | technology | Enterprise Software & Cloud | -71% | +5% | 88.8 | - | +28% | 32% | 92% | PTnotkept |
| MDB | technology | Enterprise Software & Cloud | -71% | +15% | 59.5 | - | +12% | 16% | 86% | PTnotkept |
| CRCL | fintech | Digital Finance & Payments | -71% | +31% | 73.3 | 15.5 | +- | - | 90% | PTnotkept |
| RGEN | healthcare | Medical Devices & Equipment | -70% | +16% | 84.6 | 21.3 | +- | - | 88% | PTnotkept |
| MDGL | healthcare | Large Biotech | -70% | +56% | 45.6 | - | +- | - | 67% |  |
| SNDK | technology | Semiconductors — Design | +232% | +68% | 5.8 | 32.9 | +15% | - | -21% | cyc |
| CCJ | materials | Base Metals & Mining | -70% | +49% | 55.1 | 14.7 | +- | - | 82% | cyc,PTnotkept |
| CHYM | fintech | Digital Finance & Payments | -70% | +40% | 62.1 | 15.5 | +- | - | 89% | PTnotkept |
| CAVA | consumer_discretionary | Restaurants & Food Service | -70% | +63% | 94.9 | 23.8 | +38% | 27% | 92% | PTnotkept |
| ILMN | healthcare | Medical Devices & Equipment | -67% | -12% | 52.6 | 21.3 | +- | - | 83% | PTnotkept |
| SMCI | technology | IT Hardware & Networking | +206% | +34% | 7.1 | 18.9 | +15% | 48% | 1% | trap,PTnotkept |
| OMC | industrials | Professional Services | +197% | +28% | 8.0 | 20.4 | +- | - | -63% | trap,PTnotkept |
| PEN | healthcare | Medical Devices & Equipment | -66% | +13% | 69.3 | 21.3 | +- | - | 81% | PTnotkept |
| ZS | technology | Enterprise Software & Cloud | -65% | -10% | 53.3 | - | -6% | 17% | 79% | PTnotkept |
| GM | consumer_discretionary | Autos & EVs | +176% | +29% | 5.7 | 10.3 | +12% | 17% | -63% | PTnotkept |
| TWLO | technology | Enterprise Software & Cloud | -62% | +8% | 42.8 | - | +- | - | 79% | PTnotkept |
| FROG | technology | Enterprise Software & Cloud | -62% | +12% | 102.6 | - | +- | - | 91% | PTnotkept |
| ALAB | technology | Semiconductors — Design | -61% | +40% | 70.5 | 31.7 | +58% | 44% | 90% | cyc,PTnotkept |
| COST | consumer_discretionary | Retail — Home & General | -61% | +6% | 44.1 | 20.3 | -1% | 12% | 73% | PTnotkept |
| SYM | industrials | Industrial Conglomerates & Machinery | -61% | +56% | 70.0 | 24.9 | +- | - | 90% | PTnotkept |
| FTNT | technology | Enterprise Software & Cloud | -61% | -9% | 53.2 | - | +10% | 17% | 81% | PTnotkept |
| AFRM | fintech | Digital Finance & Payments | -60% | +39% | 35.3 | 9.9 | -9% | 2% | 80% | PTnotkept |
| FISV | fintech | Digital Finance & Payments | +151% | +24% | 6.7 | 17.5 | +- | - | -76% | trap,PTnotkept |
| FIS | fintech | Digital Finance & Payments | +151% | +27% | 6.0 | 17.5 | +- | - | -103% | trap,PTnotkept |
| AMD | technology | Semiconductors — Design | -60% | +18% | 69.5 | 31.7 | +104% | 61% | 90% | cyc,PTnotkept |
| CEVA | technology | Semiconductors — Design | -59% | +54% | 53.8 | 31.7 | +- | - | 87% | cyc,PTnotkept |
| PCG | utilities | Electric Utilities | +144% | +37% | 7.8 | 18.4 | +10% | 9% | -92% | trap,PTnotkept |
| PBR | energy | Integrated Oil & Gas | +143% | +4% | 5.7 | 9.4 | -12% | - | -164% | cyc,PTnotkept |
| P | technology | IT Hardware & Networking | -59% | +14% | 47.2 | 18.4 | +- | - | 81% | PTnotkept |
