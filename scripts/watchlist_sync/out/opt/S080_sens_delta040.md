# S080 — long calls / long puts: Direction × Timing × Price (A244, 2026-10-22)

466,681 trades, 255 names, daily entries 2021-02-01 →. 0.50Δ ~45 DTE single long option, barrier exits (+100 % limit / −50 % stop at the close / 21 DTE left) walked on the daily path. Returns are **per $ debit, net of fills (bid + 23 % of spread), minus T-bill** over the holding days. Pre-registered in INDEX row S080 before this script ran; primary arm = (e).

## Arms (whole sample)

| arm | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| a unconditional | 466,681 | -9.9% | -52.1% | -15.12 | -10.9%..-8.9% | 32% | 1.53 |
| b direction | 95,095 | -8.6% | -51.9% | -5.52 | -11.2%..-6.1% | 33% | 1.53 |
| c timing | 3,356 | -13.7% | -52.0% | -5.24 | -18.0%..-9.3% | 30% | 1.49 |
| d price filter | 124,739 | -7.5% | -51.9% | -8.26 | -8.9%..-5.9% | 34% | 1.55 |
| e merged (PRIMARY) | 52 | -2.5% | -49.4% | -0.24 | -18.1%..+15.2% | 37% | 1.61 |

## Primary arm (e) — the pre-registered pass bar

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| train 2021-02→2025-06 | 43 | -8.0% | -51.7% | -0.79 | -25.1%..+7.4% | 33% | 1.60 |
| holdout 2025-07→ | 9 | +24.3% | +22.6% | 0.89 | -20.8%..+68.0% | 56% | 1.66 |
| era 2021-23 | 31 | -4.3% | -51.1% | -0.36 | -25.4%..+14.2% | 35% | 1.59 |
| era 2024→ | 21 | +0.3% | -32.2% | 0.02 | -27.9%..+27.4% | 38% | 1.64 |
| 2022 only | 9 | +19.6% | +15.9% | — | — (< 6 month blocks) | 56% | 1.45 |
| long calls | 10 | +2.4% | -51.8% | 0.11 | -38.7%..+30.5% | 40% | 1.60 |
| long puts | 42 | -3.6% | -40.6% | -0.32 | -24.6%..+13.4% | 36% | 1.60 |

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

Stress (skew ratio ±25 % on calls and on put wings): base -2.5% · rich -2.1% · cheap -3.0%. The stress barely moves a **per $ debit** return by construction — a multiplicative skew ratio scales the entry debit and the exit value together, so it cancels except where the moving |Δ| crosses a ratio cell or a barrier fires a day earlier. The pricing risk this study carries is therefore in the *level of the barriers being hit*, not in the mean.
Comparator (f) buy the stock on the same signal: -0.37% per $ invested (sd 10.96%); scaled to the option's volatility -2.3% vs the option's -2.5%.

## Descriptive (never selected on)

Exit reasons over all trades: dte 74,101 (16%), stop 280,303 (60%), take 112,277 (24%)

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| a: long calls | 233,316 | -7.3% | -52.2% | -3.25 | -11.1%..-3.6% | 34% | 1.56 |
| a: long puts | 233,365 | -12.5% | -51.9% | -5.15 | -16.1%..-8.4% | 31% | 1.49 |
| a: holdout 2025-07→ | 103,287 | -10.2% | -52.0% | -6.49 | -12.7%..-7.5% | 32% | 1.52 |
| a: train | 363,394 | -9.8% | -52.1% | -13.36 | -11.0%..-8.6% | 33% | 1.53 |
| b direction only, holdout | 21,487 | -8.4% | -51.9% | -2.83 | -12.9%..-3.5% | 33% | 1.55 |
| c timing only, holdout | 720 | -13.6% | -51.2% | -3.60 | -19.4%..-7.4% | 30% | 1.45 |
| d price filter only, holdout | 23,281 | -9.0% | -52.0% | -4.13 | -11.8%..-5.0% | 33% | 1.53 |

## Real option closes (Polygon, 2024-10→) vs the model

3,139 trades matched to a real contract (same name/side, 25–75 DTE, strike within 10 % of the model's continuous Δ-strike). Mean return per $ debit: real -7.8% vs model -7.5% (median difference +0.0%). Real closes are trade prints, not mids, and carry no fill haircut — treat as a direction check on the model, not a replacement.

## Arm (g) — Polygon call−put IV spread + put skew as direction (2024-10→, descriptive)

1,649 name-days carry an inverted IV pair (1,468 with an ATM call + put, 906 with an OTM put + ATM call). Call−put IV spread median +0.030 (LSEG cannot see this: its iv30_put and iv30_call are the same ATM series — S059's skew came out nan); OTM-put skew median -0.024. Rule used (descriptive, fixed before the slice was cut): long call if the spread > 0; long put if the skew is above its full-window median. 1,251 trades carry a signal.

| slice | n | mean | median | month-block t | 90 % CI | win | payoff |
|---|---|---|---|---|---|---|---|
| signal on | 782 | -13.3% | -51.6% | -3.25 | -20.8%..-7.6% | 30% | 1.47 |
| signal off | 469 | -18.3% | -51.6% | -5.93 | -23.8%..-13.4% | 27% | 1.33 |

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
