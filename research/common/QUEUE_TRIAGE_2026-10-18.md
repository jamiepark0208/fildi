# Build queue triage — 2026-10-18 (Muse)
> No-noise gate re-run over the 29 planned/accepted rows. Constraint: Cursor expires **Dec 11** (~7 weeks).
> Gate: does it change a decision or unblock a build? Verdicts are recommendations, not decisions.

## Must-build (gates others or top decision value)
| row | title | why now |
|---|---|---|
| A63 | Source-ranked bars | "the one that matters most" (Jamie); better bars never land without it |
| A148 | Peer-group fixes | approved 10-18; needed for Monday dev loop; peer medians move fund scores |
| A54 | Greeks/IV library | foundation for all options math |
| A53 | IV surface pipeline | feeds A134, A137 |
| A131 | Leakage audit | gates every backtest row; needs Claude sign-off (open item) |
| A137 | Vol-mispricing E[RV] vs IV | P1; the put-seller's edge number |
| A134 | GEX regime | phase 1 done; negative gamma = don't sell premium |
| A79 | Earnings risk score | feeds A136; flag blowup risk before prints |
| A136 | Pre-trade risk gate | "the bot that only says no"; protects the book |
| A82 | Prediction markets (phase 1: ingest) | phased; ingest first, UI later |
| A85 | Pundit tracker (phase 1: registry + scoring) | Jamie's watchlist; Tier 1 voices |

## Build if capacity (real value, no hard dependency)
A92 assignment track record · A101 easy-win scanner · A86 fair-value disagreement lab · A98 ETF flows tracker ·
A126 order-flow indicators (needs A53) · A115 trend-efficiency filter (needs A63) · A139 ICT suite (needs intraday) ·
A94 conviction ledger · A93 chart (phase 1 done) · A149 scenario exposure · A143 OpenJev headline labels ·
A133 PentPort eval ($10/mo approved; quick eval, not a build)

## Defer / narrow (recommendation)
| row | verdict | reason |
|---|---|---|
| A72 | DEFER to Kiro era (or phase 1 only) | Server migration is a multi-week project; doesn't fit the 7-week runway alongside Wave 0–1. The 7-day Schwab wall persists regardless. |
| A125 | DEFER | Video Lab is the Orcha/shorts lane, not fildi core; P3. |
| A127 | DEFER | Motion polish; last priority. |
| A75 | NARROW to study | API/UX audit — valuable as a study, not a build. |
| A124 | STUDY only | Forecasting-oracle pilot; merged already, no full build. |
| A117 | RESEARCH only | Algorithm inventory maps gaps; feeds planning, not user-facing. |
| A83 | WAVE 1 only | Safe mechanical refactors; defer god-file splits to Kiro era. |
| A95 | REVIEW for merge into A85 | Analyst revision breadth overlaps pundit tracker; may be one row. |

## In progress (leave alone)
A87 (Cursor 10-18: ticker price rows) · A24 (accepted, needs Claude)

## Kiro handoff spec (prep)
Whatever of "must-build" + "if capacity" is unfinished on Dec 11 moves to Kiro. Each row already carries:
spec (`asks/A##.md`), Claude's plan review (status notes), and the plan quality bar (use cases + expected results + verification).
Kiro lane per proposal: budget builder, spec-driven, steering file `.kiro/steering/fildi-lanes.md`.
Rows needing most context on handoff: A131 (quant sign-off chain), A137/A138 (shared feature pipe), A136 (consumes A134+A79).
