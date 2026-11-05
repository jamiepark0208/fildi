# S152 — Option structures on indicator signals vs vol-matched random

**Ask:** A334 · **Window:** 2026-10-08 → 2026-11-05 · **Chain days:** 19 · **Pricing:** RH entry fill; IV inverted from fill; BS exit (years, entry IV); ±10% IV in JSON.

## Verdict

**1 cell(s) pass** pre-registered bar (lift ≥ +5% risk, Holm p<0.05, both halves, n≥100, days≥10).

## Top cells by lift

| ind | tf | structure | hz | n | days | lift | t | Holm p | both |
|---|---|---|---|---:|---:|---:|---:|---:|:---:|
| st | 1h | long_outright | close | 49 | 15 | +38.64 | 1.17 | 1 | N |
| st | 15m | long_outright | close | 147 | 14 | +32.73 | 1.38 | 1 | Y |
| ut | 1h | long_outright | close | 161 | 17 | +27.35 | 1.28 | 1 | Y |
| mso | 5m | long_outright | close | 1012 | 17 | +16.33 | 1.54 | 1 | Y |
| mso | 1h | long_outright | close | 97 | 15 | +15.96 | 0.92 | 1 | N |

## LSH / ST long straddle

- **lsh 15m 60m:** n=24 lift +9.87% t=2.04 Holm=1 both=Y
- **lsh 5m 60m:** n=33 lift +7.57% t=1.74 Holm=1 both=Y
- **lsh 15m close:** n=23 lift +6.31% t=0.59 Holm=1 both=N
- **st 1h close:** n=103 lift +3.89% t=0.71 Holm=1 both=N
- **st 15m 60m:** n=316 lift +3.38% t=2.07 Holm=1 both=Y
- **st 1h 60m:** n=107 lift +2.89% t=2.40 Holm=1 both=Y
- **st 15m close:** n=323 lift +2.00% t=0.51 Holm=1 both=Y
- **st 5m 60m:** n=900 lift +1.97% t=3.25 Holm=0.253 both=Y
- **lsh 5m close:** n=35 lift +0.03% t=0.00 Holm=1 both=N
- **st 5m close:** n=895 lift -1.62% t=-0.78 Holm=1 both=N

## Spot-checked trade (LSH straddle)

- RKLB buy @ 2026-10-08T11:00:00-04:00 entry spot 69.46 legs: C71/P71 same K · debit 5.59 · long_straddle 60m hold 60m · signal P&L -3.8% of premium · random mean -4.9% (n=20 draws)

**Events priced:** 16923 (6 TV indicators, buy/sell, chain as_of ≤ entry day, `optlab.bars_5m` exit bars).
**Caveat:** `option_chain_history` is 1–35% OTM only; ATM straddle uses nearest strike with both call+put at same K (~1% OTM).
**IV:** per-leg IV inverted from RH entry fill (stored chain IV ignored when inconsistent); exit BS holds that IV flat.

## MDE (no pass)

- Largest-|t| straddle cell with n≥100: **st 5m 60m** n=900 lift +2.0% t=3.25 · MDE≈1.2 pp/trade · need ≈many more days similar events for +5 pp lift at current noise (pre-reg bar).

## Methods

- Events: indicator_events ⨝ grades, 6 TV indicators, buy/sell only, chain as_of ≤ entry ET day, DTE≥1 nearest expiry.
- Comparator: ≥20 vol-matched random bars (|3-bar move|/ATR within ±0.25), same ticker/tf/structure/side/hold.
- Stop rule: one grid pass, no re-tuning (A334).

Re-run: `research/studies/scripts/s152_indicator_option_structures.py` · cells: `research/studies/out/S152/cells.json`
