# S152 — Option structures on indicator signals vs vol-matched random

**Ask:** A334 · **Window:** 2026-10-08 → 2026-11-05 · **Chain days:** 19 · **Pricing:** RH entry fill; IV inverted from fill; BS exit (years, entry IV); ±10% IV in JSON.

## Verdict

**No option edge yet** — no structure×indicator cell passes the pre-registered bar.

## Top cells by lift

| ind | tf | structure | hz | n | days | lift | t | Holm p | both |
|---|---|---|---|---:|---:|---:|---:|---:|:---:|
| st | 15m | long_outright | close | 155 | 15 | +30.51 | 1.49 | 1 | Y |
| st | 1h | long_outright | close | 47 | 14 | +27.30 | 0.79 | 1 | N |
| mso | 5m | debit_vertical | close | 213 | 13 | +23.44 | 2.29 | 1 | Y |
| ut | 1h | debit_vertical | close | 47 | 13 | +21.12 | 1.13 | 1 | Y |
| ut | 1h | long_outright | close | 165 | 17 | +21.01 | 1.16 | 1 | N |

## LSH / ST long straddle

- **lsh 15m 60m:** n=18 lift +8.49% t=1.23 Holm=1 both=Y
- **st 15m 60m:** n=265 lift +0.84% t=0.66 Holm=1 both=Y
- **st 5m close:** n=727 lift +0.72% t=0.18 Holm=1 both=N
- **st 15m close:** n=268 lift +0.72% t=0.11 Holm=1 both=N
- **st 5m 60m:** n=729 lift -0.40% t=-0.43 Holm=1 both=Y
- **lsh 5m 60m:** n=24 lift -1.81% t=-0.93 Holm=1 both=Y
- **lsh 15m close:** n=17 lift -2.50% t=-0.28 Holm=1 both=N
- **st 1h 60m:** n=86 lift -2.53% t=-1.78 Holm=1 both=N
- **st 1h close:** n=82 lift -2.98% t=-0.30 Holm=1 both=N
- **lsh 5m close:** n=26 lift -8.96% t=-1.56 Holm=1 both=Y

## Spot-checked trade (LSH straddle)

- RKLB buy @ 2026-10-08T11:00:00-04:00 entry spot 69.46 legs: C71/P66 nearest OTM · debit 2.70 · long_straddle 60m hold 60m · signal P&L -3.3% of premium · random mean +5.2% (n=20 draws)

**Events priced:** 16923 (6 TV indicators, buy/sell, chain as_of ≤ entry day, `optlab.bars_5m` exit bars).
**Caveat:** `option_chain_history` is 1–35% OTM only; ATM straddle uses nearest strike with both call+put at same K (~1% OTM).
**IV:** per-leg IV inverted from RH entry fill (stored chain IV ignored when inconsistent); exit BS holds that IV flat.

## MDE (no pass)

- Largest-|t| straddle cell with n≥100: **ichimoku 1h close** n=131 lift -6.9% t=-1.37 · MDE≈9.9 pp/trade · need ≈382 similar events for +5 pp lift at current noise (pre-reg bar).

## Methods

- Events: indicator_events ⨝ grades, 6 TV indicators, buy/sell only, chain as_of ≤ entry ET day, DTE≥1 nearest expiry.
- Comparator: ≥20 vol-matched random bars (|3-bar move|/ATR within ±0.25), same ticker/tf/structure/side/hold.
- Stop rule: one grid pass, no re-tuning (A334).

Re-run: `research/studies/scripts/s152_indicator_option_structures.py` · cells: `research/studies/out/S152/cells.json`
