# S015 — trade mistakes vs bad luck (2026-11-27)

Trades: 1598 filled sell-to-open puts with an expiry close (2026-02-02 → 2026-11-20), 348 ended ITM (22%). Hold-to-expiry P&L mean +0.27% of collateral, worst -27.2%.

## Q1 — after a put ends ITM, does the stock keep falling?

Excess = forward return from the expiry close minus the same ticker's average forward return. Basis = strike − premium.

| horizon | trader events | excess | p | still below basis | broad sim n | broad excess | broad p |
|---|---|---|---|---|---|---|---|
| 5d | 62 | -0.51% | 0.785 | 73% | 3403 | -0.07% | 0.847 |
| 10d | 62 | +0.17% | 0.966 | 68% | 3387 | -0.55% | 0.392 |
| 20d | 61 | +1.94% | 0.688 | 57% | 3241 | +0.52% | 0.491 |

(63 distinct ticker × expiry breach events.)

## Q2 — did buy-to-close orders beat holding to expiry?

saved = (intrinsic at expiry − close price) × 100 × qty. Positive = closing was cheaper than holding.

| group | n | total saved | mean / share | p | share that helped |
|---|---|---|---|---|---|
| all closes | 1073 | $-8,648 | -0.067 | 0.046 | 10% |
| closed while ITM | 88 | $-1,174 | -0.111 | 0.492 | 43% |
| closed while OTM | 985 | $-7,474 | -0.063 | 0.072 | 7% |

## Q3 — entry features known the day before (IC vs hold-to-expiry P&L)

Pattern = Holm p < 0.05 and same sign in both halves. Week-cluster bootstrap.

| feature | n | IC | p | Holm p | 1st half | 2nd half | pattern | detail |
|---|---|---|---|---|---|---|---|---|
| IV ÷ realized vol (rich premium) | 1583 | +0.061 | 0.391 | 1.000 | +0.098 | -0.002 | no | low third P&L +0.27% ITM 19% · high third P&L +0.29% ITM 22% |
| earnings before expiry | 1598 | +0.222 | 0.022 | 0.198 | +0.282 | +0.069 | no | yes n=124 P&L +1.59% ITM 9% · no n=1474 P&L +0.16% ITM 23% |
| 5-day return before entry (dip = negative) | 1598 | -0.096 | 0.188 | 1.000 | -0.133 | -0.172 | no | low third P&L +0.59% ITM 17% · high third P&L +0.06% ITM 23% |
| price vs 200-day average | 1598 | +0.009 | 0.814 | 1.000 | +0.029 | +0.107 | no | low third P&L +0.25% ITM 22% · high third P&L +0.40% ITM 20% |
| SPY vs its 50-day average | 1598 | -0.147 | 0.101 | 0.707 | -0.172 | -0.162 | no | low third P&L +0.79% ITM 12% · high third P&L -0.01% ITM 26% |
| strike distance in vol units (≈ lower delta) | 1598 | +0.021 | 0.752 | 1.000 | -0.009 | +0.044 | no | low third P&L +0.04% ITM 31% · high third P&L +0.32% ITM 20% |
| share of open put notional in this name | 1598 | +0.107 | 0.043 | 0.344 | +0.099 | +0.131 | no | low third P&L +0.16% ITM 21% · high third P&L +0.44% ITM 18% |
| account's open put notional vs its usual | 1598 | -0.076 | 0.395 | 1.000 | -0.137 | -0.197 | no | low third P&L +0.28% ITM 20% · high third P&L +0.14% ITM 24% |
| re-selling a name that breached in last 2 weeks | 1598 | -0.052 | 0.514 | 1.000 | +0.026 | -0.008 | no | yes n=644 P&L +0.47% ITM 25% · no n=954 P&L +0.13% ITM 19% |

## Q4 — do breaches cluster by expiry?

41 expiries with ≥ 3 puts. Per-expiry breach share SD 0.253 vs 0.088 if independent (p = 0.000). Base ITM rate 22%.

Worst expiries: 2026-10-16 96% of 25; 2026-02-13 82% of 22; 2026-06-05 61% of 137; 2026-07-24 59% of 17; 2026-09-11 56% of 16
