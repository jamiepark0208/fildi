# Entry timing test: your own Robinhood sell-to-open fills

1513 expired-or-dated trades with prices on both ends (of 1536 filled orders). Breach = stock beyond the strike at the expiry close (ignores early closes/rolls, so it's the risk you sold, not what you kept). Timing edge = baseline breach − your breach (positive = your timing beat a random day).

## IRA: 654 puts, 403 calls

### Puts by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| dropped 3–8% | 134 | 10.8% | 14.2% | 18.0% | +3.8% | +0.55% | -6.8% |
| dropped ≥8% in 5d | 263 | 10.3% | 17.5% | 19.5% | +2.1% | +0.52% | -12.4% |
| flat / up (no dip) | 257 | 11.9% | 21.0% | 16.9% | -4.2% | +0.23% | -10.2% |

### Puts by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 235 | 11.0% | 16.6% | 18.1% | +1.5% | +0.59% | -6.8% |
| RSI 50–65 | 151 | 11.7% | 21.9% | 17.0% | -4.9% | +0.14% | -10.2% |
| RSI < 35 | 222 | 9.1% | 18.0% | 21.2% | +3.1% | +0.36% | -12.4% |
| RSI ≥ 65 | 46 | 17.4% | 15.2% | 8.2% | -7.0% | +0.67% | -3.1% |

### Puts by distance above the 20-day low (support proxy)

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| 3–10% above | 235 | 9.5% | 17.9% | 20.6% | +2.8% | +0.38% | -12.4% |
| >10% above 20d low | 304 | 13.2% | 19.7% | 14.2% | -5.6% | +0.30% | -10.2% |
| within 3% of 20d low | 115 | 7.6% | 14.8% | 23.8% | +9.0% | +0.76% | -6.5% |

### Calls by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| flat / down (no rally) | 235 | 14.7% | 22.6% | 10.6% | -11.9% | -0.41% | -14.9% |
| rallied 3–8% | 60 | 11.2% | 21.7% | 17.5% | -4.2% | -0.98% | -11.6% |
| rallied ≥8% in 5d | 108 | 10.5% | 7.4% | 14.7% | +7.3% | +0.61% | -7.4% |

### Calls by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 82 | 15.6% | 18.3% | 9.7% | -8.6% | -1.05% | -14.9% |
| RSI 50–65 | 196 | 12.3% | 21.9% | 13.8% | -8.2% | -0.29% | -11.7% |
| RSI < 35 | 67 | 14.9% | 9.0% | 10.4% | +1.4% | +0.48% | -7.4% |
| RSI ≥ 65 | 58 | 10.4% | 17.2% | 16.2% | -1.1% | +0.37% | -5.9% |

## FILDI: 295 puts, 161 calls

### Puts by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| dropped 3–8% | 50 | 10.6% | 26.0% | 19.3% | -6.7% | +0.39% | -6.7% |
| dropped ≥8% in 5d | 121 | 10.7% | 16.5% | 19.4% | +2.8% | +0.61% | -17.5% |
| flat / up (no dip) | 124 | 10.8% | 37.9% | 23.8% | -14.1% | -0.70% | -10.8% |

### Puts by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 102 | 12.5% | 29.4% | 17.3% | -12.2% | +0.41% | -6.7% |
| RSI 50–65 | 74 | 10.7% | 27.0% | 24.3% | -2.7% | -1.18% | -10.8% |
| RSI < 35 | 97 | 7.8% | 29.9% | 26.0% | -3.9% | +0.33% | -17.5% |
| RSI ≥ 65 | 22 | 17.3% | 4.5% | 8.2% | +3.6% | +0.99% | -2.0% |

### Puts by distance above the 20-day low (support proxy)

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| 3–10% above | 94 | 10.5% | 18.1% | 22.4% | +4.3% | +0.56% | -17.5% |
| >10% above 20d low | 148 | 13.4% | 36.5% | 20.1% | -16.4% | -0.50% | -10.8% |
| within 3% of 20d low | 53 | 8.7% | 17.0% | 22.3% | +5.3% | +0.53% | -2.1% |

### Calls by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| flat / down (no rally) | 102 | 18.1% | 13.7% | 6.9% | -6.8% | -0.15% | -12.4% |
| rallied 3–8% | 19 | 19.4% | 0.0% | 3.8% | +3.8% | +0.84% | +0.4% |
| rallied ≥8% in 5d | 40 | 22.4% | 2.5% | 10.6% | +8.1% | +0.50% | -5.9% |

### Calls by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 32 | 17.2% | 6.2% | 9.7% | +3.4% | +0.09% | -12.4% |
| RSI 50–65 | 74 | 21.5% | 10.8% | 4.3% | -6.5% | -0.05% | -5.9% |
| RSI < 35 | 42 | 23.2% | 9.5% | 7.1% | -2.4% | +0.46% | -5.8% |
| RSI ≥ 65 | 13 | 1.7% | 7.7% | 20.9% | +13.2% | +0.17% | -5.9% |

## all: 949 puts, 564 calls

### Puts by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| dropped 3–8% | 184 | 10.6% | 17.4% | 18.4% | +1.0% | +0.50% | -6.8% |
| dropped ≥8% in 5d | 384 | 10.5% | 17.2% | 19.5% | +2.3% | +0.55% | -17.5% |
| flat / up (no dip) | 381 | 11.7% | 26.5% | 19.1% | -7.4% | -0.07% | -10.8% |

### Puts by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 337 | 11.2% | 20.5% | 17.8% | -2.6% | +0.54% | -6.8% |
| RSI 50–65 | 225 | 10.7% | 23.6% | 19.4% | -4.2% | -0.30% | -10.8% |
| RSI < 35 | 319 | 8.9% | 21.6% | 22.6% | +1.0% | +0.35% | -17.5% |
| RSI ≥ 65 | 68 | 17.4% | 11.8% | 8.2% | -3.6% | +0.77% | -3.1% |

### Puts by distance above the 20-day low (support proxy)

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| 3–10% above | 329 | 9.9% | 17.9% | 21.1% | +3.2% | +0.43% | -17.5% |
| >10% above 20d low | 452 | 13.2% | 25.2% | 16.1% | -9.1% | +0.04% | -10.8% |
| within 3% of 20d low | 168 | 8.6% | 15.5% | 23.3% | +7.8% | +0.68% | -6.5% |

### Calls by 5-day move before entry

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| flat / down (no rally) | 337 | 15.4% | 19.9% | 9.5% | -10.4% | -0.33% | -14.9% |
| rallied 3–8% | 79 | 14.6% | 16.5% | 14.2% | -2.3% | -0.54% | -11.6% |
| rallied ≥8% in 5d | 148 | 12.4% | 6.1% | 13.6% | +7.5% | +0.58% | -7.4% |

### Calls by RSI(14) the day before

| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | timing edge | P&L per collateral (mean) | worst |
|---|---|---|---|---|---|---|---|
| RSI 35–50 | 114 | 16.5% | 14.9% | 9.7% | -5.2% | -0.73% | -14.9% |
| RSI 50–65 | 270 | 14.6% | 18.9% | 11.2% | -7.7% | -0.23% | -11.7% |
| RSI < 35 | 109 | 16.8% | 9.2% | 9.1% | -0.1% | +0.47% | -7.4% |
| RSI ≥ 65 | 71 | 10.4% | 15.5% | 17.0% | +1.5% | +0.33% | -5.9% |
