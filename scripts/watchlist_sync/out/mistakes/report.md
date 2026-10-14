# S015 — trade mistakes vs bad luck (2026-10-14)

Trades: 935 filled sell-to-open puts with an expiry close (2026-02-02 → 2026-10-09), 198 ended ITM (21%). Hold-to-expiry P&L mean +0.36% of collateral, worst -10.4%.

## Q1 — after a put ends ITM, does the stock keep falling?

Excess = forward return from the expiry close minus the same ticker's average forward return. Basis = strike − premium.

| horizon | trader events | excess | p | still below basis | broad sim n | broad excess | broad p |
|---|---|---|---|---|---|---|---|
| 5d | 47 | -0.01% | 0.978 | 66% | 3067 | -0.09% | 0.770 |
| 10d | 45 | -0.35% | 0.916 | 60% | 3012 | -0.35% | 0.567 |
| 20d | 44 | +2.79% | 0.557 | 43% | 2881 | +0.74% | 0.363 |

(51 distinct ticker × expiry breach events.)

## Q2 — did buy-to-close orders beat holding to expiry?

saved = (intrinsic at expiry − close price) × 100 × qty. Positive = closing was cheaper than holding.

| group | n | total saved | mean / share | p | share that helped |
|---|---|---|---|---|---|
| all closes | 548 | $-4,573 | -0.081 | 0.035 | 12% |
| closed while ITM | 48 | $-826 | -0.222 | 0.264 | 54% |
| closed while OTM | 500 | $-3,747 | -0.067 | 0.061 | 8% |

## Q3 — entry features known the day before (IC vs hold-to-expiry P&L)

Pattern = Holm p < 0.05 and same sign in both halves. Week-cluster bootstrap.

| feature | n | IC | p | Holm p | 1st half | 2nd half | pattern | detail |
|---|---|---|---|---|---|---|---|---|
| IV ÷ realized vol (rich premium) | 926 | +0.074 | 0.198 | 0.792 | +0.047 | +0.126 | no | low third P&L +0.34% ITM 19% · high third P&L +0.50% ITM 20% |
| earnings before expiry | 935 | +0.248 | 0.000 | 0.000 | +0.298 | +0.196 | **yes** | yes n=104 P&L +1.42% ITM 5% · no n=831 P&L +0.23% ITM 23% |
| 5-day return before entry (dip = negative) | 935 | -0.107 | 0.112 | 0.672 | -0.212 | -0.061 | no | low third P&L +0.62% ITM 17% · high third P&L +0.02% ITM 25% |
| price vs 200-day average | 935 | +0.019 | 0.731 | 1.000 | -0.003 | +0.065 | no | low third P&L +0.43% ITM 23% · high third P&L +0.41% ITM 20% |
| SPY vs its 50-day average | 935 | -0.138 | 0.127 | 0.672 | -0.267 | -0.067 | no | low third P&L +0.82% ITM 12% · high third P&L +0.00% ITM 26% |
| strike distance in vol units (≈ lower delta) | 935 | +0.048 | 0.416 | 1.000 | +0.033 | +0.074 | no | low third P&L +0.00% ITM 32% · high third P&L +0.58% ITM 16% |
| share of open put notional in this name | 935 | +0.132 | 0.032 | 0.256 | +0.082 | +0.186 | no | low third P&L +0.28% ITM 20% · high third P&L +0.64% ITM 18% |
| account's open put notional vs its usual | 935 | -0.150 | 0.094 | 0.658 | -0.244 | -0.129 | no | low third P&L +0.50% ITM 20% · high third P&L -0.14% ITM 28% |
| re-selling a name that breached in last 2 weeks | 935 | -0.064 | 0.428 | 1.000 | +0.038 | -0.122 | no | yes n=375 P&L +0.44% ITM 23% · no n=560 P&L +0.31% ITM 20% |

## Q4 — do breaches cluster by expiry?

36 expiries with ≥ 3 puts. Per-expiry breach share SD 0.228 vs 0.093 if independent (p = 0.000). Base ITM rate 21%.

Worst expiries: 2026-02-13 78% of 9; 2026-06-05 62% of 74; 2026-09-11 56% of 16; 2026-07-24 53% of 15; 2026-10-09 53% of 17
