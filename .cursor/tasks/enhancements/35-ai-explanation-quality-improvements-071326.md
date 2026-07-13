# ai-explanation-quality-improvements

| Field | Value |
|---|---|
| **Status** | backlog |
| **Priority** | P2 |
| **Area** | ui / content |
| **Effort** | M |
| **Created** | 2026-07-13 |
| **Source** | user feedback during enh/17 volatility tab follow-up session |
| **Related** | [macro-volatility-tab-improvements](17-macro-volatility-tab-improvements-070926.md), [macro-regime-tab-improvements](10-macro-regime-tab-improvements-070926.md) |
| **Type** | ENHANCE |

### Purpose
Every section that synthesizes a brief/note/implication (Volatility Regime Read, Liquidity Regime Read, COT Positioning Read, daily brief, etc.) should read like a human analyst explaining *why it matters*, not just restate the number. This session's COT `CotPositioningRead` (`MacroComponents.tsx`) is the first pass at this pattern — user flagged that the underlying explanation quality itself (not just presence of an explanation) needs a dedicated improvement pass across all of these sections, not just volatility.

### Scope (to define at pickup)
- Inventory every "implication card" / narrative-synthesis component across the app (macro regime, liquidity, volatility, COT, daily brief, scorecard explanations, any others) — grep for pattern `Implications`, `Read`, `summary`, `implication` in `macro-page-types.ts` / `MacroComponents.tsx` / brief-generation code.
- For each, assess: is the generated sentence genuinely explanatory (ties numbers to real-world significance, states the "so what") or just a templated readout?
- Likely needs either (a) richer template logic with more conditional branches per regime/threshold, or (b) an actual LLM call to generate the prose from structured inputs — decide per-section based on cost/latency tradeoffs (some of these refresh on every page load).
- Do not scope the specific fix yet — this task is a placeholder to revisit with fresh eyes; don't assume the COT pattern from this session is the final bar.

### Cache / DB compliance
No new caches without justification — if moving to LLM-generated prose, cache the generated text alongside the existing TTL'd data fetch rather than regenerating on every request.
