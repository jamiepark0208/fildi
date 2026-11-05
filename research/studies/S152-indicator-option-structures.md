# S152 — Option structures on indicator signals vs vol-matched random

**Ask:** A334 · **Window:** 2026-10-08 → 2026-11-05 · **Chain days:** 19 · **Pricing:** entry RH bid+23% spread / ask−23%; exit BS flat entry IV (bias noted); IV sensitivity ±10% in JSON.

## Verdict

**No option edge yet** — no structure×indicator cell passes the pre-registered bar.

## Top cells by lift

| ind | tf | structure | hz | n | days | lift | t | Holm p | both |
|---|---|---|---|---:|---:|---:|---:|---:|:---:|
| ichimoku | 1h | long_straddle | close | 131 | 17 | +399.72 | 0.73 | 1 | N |
| ichimoku | 1h | long_straddle | 60m | 130 | 17 | +395.63 | 0.59 | 1 | N |
| lsh | 5m | short_straddle | 60m | 30 | 11 | +394.60 | 6.01 | 4.3e-07 | Y |
| lsh | 15m | short_straddle | 60m | 23 | 13 | +287.30 | 1.89 | 1 | N |
| lsh | 5m | short_straddle | close | 32 | 11 | +268.70 | 4.97 | 0.000155 | Y |

## LSH / ST long straddle

- **st 5m 60m:** n=729 lift +180.32% t=0.24 Holm=1 both=N
- **st 5m close:** n=727 lift +132.62% t=0.20 Holm=1 both=N
- **lsh 15m close:** n=17 lift -149.68% t=-1.05 Holm=1 both=Y
- **st 1h 60m:** n=86 lift -231.04% t=-1.35 Holm=1 both=Y
- **lsh 15m 60m:** n=18 lift -298.56% t=-1.51 Holm=1 both=N
- **st 15m close:** n=268 lift -308.85% t=-1.02 Holm=1 both=Y
- **st 1h close:** n=82 lift -313.77% t=-1.51 Holm=1 both=Y
- **st 15m 60m:** n=265 lift -348.55% t=-1.09 Holm=1 both=Y
- **lsh 5m close:** n=26 lift -408.02% t=-1.74 Holm=1 both=Y
- **lsh 5m 60m:** n=24 lift -615.20% t=-2.04 Holm=1 both=Y

## Spot-checked trade (LSH straddle)

- RKLB buy @ 2026-10-08T11:00:00-04:00 entry spot 69.46 · long_straddle 60m hold 60m · signal P&L +39.1% of premium · random mean +46.1% (n=20 draws)

**Events priced:** 16923 (6 TV indicators, buy/sell, chain as_of ≤ entry day, `optlab.bars_5m` exit bars).
**Caveat:** `option_chain_history` stores 1–35% OTM legs only; straddles use nearest call/put to spot (~1% OTM), so %‑of‑premium is scaled vs true ATM.
**IV:** exit marks hold entry IV (overstates long-vol if realized > implied); ±10% IV exit sensitivity not re-run (flat-IV primary).

## MDE (no pass)

- Largest-|t| straddle cell with n≥100: **mso 1h close** n=178 lift -175.9% t=-1.75 · MDE≈197.3 pp/trade · need ≈277117 similar events for +5 pp lift at current noise (pre-reg bar).

## Methods

- Events: indicator_events ⨝ grades, 6 TV indicators, buy/sell only, chain as_of ≤ entry ET day, DTE≥1 nearest expiry.
- Comparator: ≥20 vol-matched random bars (|3-bar move|/ATR within ±0.25), same ticker/tf/structure/side/hold.
- Stop rule: one grid pass, no re-tuning (A334).

Re-run: `research/studies/scripts/s152_indicator_option_structures.py` · cells: `research/studies/out/S152/cells.json`
