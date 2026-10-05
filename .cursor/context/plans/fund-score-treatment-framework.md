# Deterministic Fundamental Score — Treatment Framework (v3)

Status: **implemented** in `artifacts/api-server/src/lib/fund-score-engine.ts` and Scorecard Guide
`FundamentalTreatmentPanel` (`artifacts/stock-compare/src/lib/fund-score-treatments.ts`).

## Implemented (verified needed + coded)

| Dimension | Detector | Treatment |
|---|---|---|
| Peer relative | `primary_peer_group_id` | Z/ordinal inside peers; winsorize 2/98 |
| True pre-revenue | Rev ≤0 or (rev<$50M & NI<0) | Style pre_revenue; drop EY/PEG/FwdPE |
| Unprofitable operator | Rev≥$50M & NI<0 | Drop EY/PEG/EPSgrow; style growth/blend |
| Financial | mode or peer path | Style financial; **exclude D/E, ND/EBITDA** |
| Banks | financial + bank path | Also exclude current ratio |
| REIT | mode/path | ↑ div/FCF; exclude net margin, ROIC−WACC |
| Value/growth/GARP/quality | Peer value vs growth norms | `STYLE_FAMILY_WEIGHTS` |
| Cyclical | energy/mining | Haircut EY; boost EV/EBITDA + FCF |
| Chinese/VIE | chinese mode/path | Haircut ROE/ROIC; boost safety metrics |
| Distress | PB<0 or CR∈(0,0.5) | Haircut cheapness; boost liquidity/dilution |
| Dilution | growth/pre_revenue styles | Intra weight ×1.5 |
| totalAssets | backfill script | **543/547** gold (NI/ROA + debt+equity; FMP BS mostly 402) |

## Cannot treat yet (missing vendor fields)

Bank CET1/NPL/NIM · REIT FFO/AFFO · Insurance combined ratio · Absolute (cross-peer) quality floor

## Scorecard Guide

Fundamental tab shows: pipeline steps → characteristic flow → family weight table by style.
