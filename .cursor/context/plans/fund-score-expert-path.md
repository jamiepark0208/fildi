# Path to finance-expert-ready fund scores

## v3 shipped (outlier + expected profit + safety gates)

| Fix | What |
|---|---|
| Growth / PEG outliers | YoY growth clamped ±100% for scoring; PEG floored at 0.25 |
| Expected EY (`expEy`) | `1/fwdPE` or `NI×(1+g≤35%)/mcap`; universe-heavy blend (25/35/40) |
| Soft-peer dampening | Chinese / speculative / &lt;8 peers → 35/35/30 peer/sector/universe |
| Safety required | beta + netCash/assets metrics; missing safety → prior 38 or unrank |
| Speculative cap | speculative mode / micro-rev → total ≤ 55 |
| China overlay | total × 0.90 |
| Cyclical + semis | margin/ROE haircut; expEy / EV/EBITDA ↑ |
| Megacap quality floor | mcap ≥ $200B & Q≥55 → blend quality into total |
| Expensive growth | growth/garp with P/S ≥ 25 → × 0.92 |

## Still paid-only / future

- CET1 / NIM / NPL / combined ratio / true FFO·AFFO
- Separate UI boards (peer-relative vs absolute vs speculative)

## Definition of “proud to show”

- Top-15 not dominated by quantum/crypto micro-names
- Every ranked name has a safety score
- MU-class cyclicals compete fairly with soft-peer outliers
- Megacaps not buried in the 500s solely for peer multiples
