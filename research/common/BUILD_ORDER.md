# Fildi build order (proposed)

Plans reference dependencies ad hoc; this file is the master sequence so rows
aren't built in an order that creates rework. Read top-down: each wave's rows
assume the waves above are done or underway.

Status words: open = filed, not reviewed · planned = Claude-reviewed, build-ready
· blocked = waiting on another row.

## Wave 0 — Data foundations (build first; everything stands on these)

| row | title | status | notes |
|---|---|---|---|
| A63 | Source-ranked upsert for price bars | planned | Schwab > FMP/Polygon > Yahoo; without this, better bars never land |
| A54 | Greeks/IV math library | planned | A107 folded in: test Greeks vs GS Quant, skip adoption |
| A53 | IV surface pipeline | planned | feeds A134, A137 |
| A131 | Backtest timestamp-leakage audit | open, needs [quant] | gates every backtest-dependent row (A120, A137); runs parallel to the rest of Wave 0 |

## Wave 1 — Signals (need Wave 0)

| row | title | status | notes |
|---|---|---|---|
| A137 | Vol-mispricing E[RV] vs IV | open, needs [quant] | HAR baseline; shares feature pipe with A138 — build the pipe once |
| A138 | TimesFM pilot | open, needs [quant] | head-to-head vs A137's HAR; same pipe, do not duplicate |
| A134 | GEX regime indicator | open, needs [quant] | needs A53 chains; dealer-sign convention is the [quant] question |
| A126 | Order-flow chart indicators | open | needs Schwab intraday (extends A53); A93 chart work is the UI home |
| A139 | ICT suite + rank-weighted composite | open, needs [quant] | needs intraday bars — after A126's data path lands |
| A115 | Trend-efficiency regime filter | open, needs [quant] | signal; needs clean bars (A63) |

## Wave 2 — Risk (needs Wave 1 outputs)

| row | title | status | notes |
|---|---|---|---|
| A136 | Pre-trade risk gate | open | consumes A134 (GEX regime) + A79 (earnings calendar); building before those = stubbed checks, rework later |
| A79 | Earnings risk score | planned, narrowed | study first per Claude 10-14; feeds A136 |

## Wave 3 — UI / polish (independent, anytime)

A127 motion polish · A132 FinceptTerminal teardown (research → feeds UI backlog) ·
A81 scanner "so what" (planned) · A93 TradingView-class chart (planned)

## Independent pilots (anytime, no dependencies)

A133 PentPort eval · A128 codebase-mcp A/B · A124 Pythia · A129 OpenJev ·
A130 OmniRoute · A123 Crawl4AI · A135 Karpathy merge (agent instructions) ·
A122 Stage orb (needs Jamie's approval — expands Muse push boundary)

## Parked / declined (Claude 10-15 triage — do not build)

A103 SkillOpt · A104 Lightpanda · A105 quant-stack survey · A106 Pinchtab ·
A108 OpenAlice · A109 microstructure survey

## Ready for Claude [quant] review now

A131, A134, A137, A138, A139, A115 — plus A120 (already with Claude, open).
Non-quant rows marked open above (A126, A136) can go straight to Cursor once
their Wave 0/1 dependencies are underway.
