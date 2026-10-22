# S080 — long calls / long puts: Direction × Timing × Price (A244, 2026-10-22)

466,731 trades, 255 names, daily entries 2021-02-01 →. 0.50Δ ~45 DTE single long option, barrier exits (+100 % limit / −50 % stop at the close / 21 DTE left) walked on the daily path. Returns are **per $ debit, net of fills (bid + 23 % of spread), minus T-bill** over the holding days. Pre-registered in INDEX row S080 before this script ran; primary arm = (e).

## Arms (whole sample)

| arm | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| a unconditional | 466,731 | -11.2% | -50.3% | -32.06 | -11.8%..-10.7% | 42% | 0.87 |
| b direction | 95,098 | -10.7% | -49.8% | -9.03 | -12.7%..-8.7% | 43% | 0.87 |
| c timing | 3,356 | -11.3% | -49.1% | -5.22 | -14.9%..-7.8% | 42% | 0.87 |
| d price filter | 124,753 | -9.9% | -50.2% | -20.71 | -10.7%..-9.1% | 44% | 0.87 |
| e merged (PRIMARY) | 52 | -4.2% | -22.7% | -0.58 | -16.1%..+8.2% | 48% | 0.91 |

## Primary arm (e) — the pre-registered pass bar

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| train 2021-02→2025-06 | 43 | -7.2% | -31.5% | -0.96 | -20.1%..+4.0% | 44% | 0.94 |
| holdout 2025-07→ | 9 | +10.3% | +49.9% | 0.54 | -18.7%..+45.7% | 67% | 0.75 |
| era 2021-23 | 31 | -8.9% | -31.5% | -1.01 | -24.7%..+4.6% | 42% | 0.96 |
| era 2024→ | 21 | +2.7% | +47.6% | 0.22 | -17.5%..+21.8% | 57% | 0.83 |
| 2022 only | 9 | +2.3% | +21.7% | — | — (< 6 month blocks) | 56% | 0.88 |
| long calls | 10 | -13.5% | -51.5% | -0.92 | -42.1%..+7.4% | 40% | 0.89 |
| long puts | 42 | -2.0% | +21.7% | -0.24 | -16.4%..+11.1% | 50% | 0.92 |

**Verdict (pre-registered bar): underpowered — no decision** — holdout n 9 < 30 (pre-registered power provision)

| check | result |
|---|---|
| mean > 0 | ✗ |
| holdout t ≥ 2 | ✗ |
| both eras > 0 | ✗ |
| beats (a) | ✓ |
| beats (f) stock, equal vol | ✗ |
| stress ±25 % same sign as base | ✓ |
| 2022 ≥ −25 % | ✓ |

Stress (skew ratio ±25 % on calls and on put wings): base -4.2% · rich -4.2% · cheap -4.2%. The stress barely moves a **per $ debit** return by construction — a multiplicative skew ratio scales the entry debit and the exit value together, so it cancels except where the moving |Δ| crosses a ratio cell or a barrier fires a day earlier. The pricing risk this study carries is therefore in the *level of the barriers being hit*, not in the mean.
Comparator (f) buy the stock on the same signal: -0.38% per $ invested (sd 9.39%); scaled to the option's volatility -2.1% vs the option's -4.2%.

## Descriptive (never selected on)

Exit reasons over all trades: dte 49,709 (11%), stop 237,455 (51%), take 179,567 (38%)

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| a: long calls | 233,363 | -10.1% | -50.4% | -6.39 | -12.8%..-7.4% | 44% | 0.86 |
| a: long puts | 233,368 | -12.3% | -50.2% | -6.95 | -14.9%..-9.4% | 41% | 0.87 |
| a: holdout 2025-07→ | 103,295 | -11.3% | -50.2% | -12.92 | -12.7%..-9.9% | 42% | 0.87 |
| a: train | 363,436 | -11.2% | -50.3% | -30.09 | -11.8%..-10.6% | 43% | 0.87 |
| b direction only, holdout | 21,489 | -10.6% | -48.7% | -5.21 | -13.9%..-7.3% | 43% | 0.88 |
| c timing only, holdout | 720 | -11.9% | -41.6% | -3.70 | -17.0%..-6.6% | 41% | 0.87 |
| d price filter only, holdout | 23,285 | -10.9% | -50.2% | -9.37 | -12.4%..-8.7% | 43% | 0.87 |

## Real option closes (Polygon, 2024-10→) vs the model

3,086 trades matched to a real contract (same name/side, 25–75 DTE, strike within 10 % of the model's continuous Δ-strike). Mean return per $ debit: real -15.4% vs model -14.0% (median difference +0.0%). Real closes are trade prints, not mids, and carry no fill haircut — treat as a direction check on the model, not a replacement.

## Arm (g) — Polygon call−put IV spread + put skew as direction (2024-10→, descriptive)

1,649 name-days carry an inverted IV pair (1,468 with an ATM call + put, 906 with an OTM put + ATM call). Call−put IV spread median +0.030 (LSEG cannot see this: its iv30_put and iv30_call are the same ATM series — S059's skew came out nan); OTM-put skew median -0.024. Rule used (descriptive, fixed before the slice was cut): long call if the spread > 0; long put if the skew is above its full-window median. 1,251 trades carry a signal.

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| signal on | 782 | -10.5% | -31.5% | -3.73 | -15.2%..-6.0% | 42% | 0.91 |
| signal off | 469 | -13.6% | -39.8% | -4.27 | -18.7%..-8.6% | 39% | 0.87 |

## Sanity: what the frozen screen flags today and on 10-01..10-08 (not evidence)

- **latest week (to 2026-09-04)** — merged screen (e): **1** flags (SNPS put). Direction + price only: 240 (AAOI call, AEIS call, AFRM call, AGI put, AMD call, APP put, ARM call, ASTS put, AXON call, BA call, BABA put, BAX call). Direction + price + the 2σ event without the SPY-below-200d condition: 2 (PYPL call, SNPS put).
- **2026-10-01..10-08** — merged screen (e): **0** flags (none). Direction + price only: 0 (none). Direction + price + the 2σ event without the SPY-below-200d condition: 0 (none).

Jamie read several long-call setups now and long puts around 10-01..10-08. The merged screen does not agree, and the reason is the pre-registered timing leg: S025's one surviving condition is **SPY below its 200-day**, which is false today, so the bullish timing leg cannot fire at all in this tape. That is a property of the pre-registered rule, not a refutation of Jamie's read.


## Known weaknesses

- Call skew still rests on one day of Schwab ladders (S075); the ±25 % stress is the guard, not a fix.
- Continuous strikes at the flat-IV Δ; real chains round to listed strikes.
- Barrier exits use daily closes: the +100 % take is recorded as exactly +100 % (limit), the −50 % stop takes the close in full (gap risk counted). No intraday path.
- Daily entries overlap heavily (45 DTE held up to 24 days) → month-block bootstrap, not iid t.
- lab_tech is a Monday panel forward-filled inside the week.
- Real option closes only exist from 2024-10 (Polygon plan limit, probed 10-22); everything earlier is model-priced.
