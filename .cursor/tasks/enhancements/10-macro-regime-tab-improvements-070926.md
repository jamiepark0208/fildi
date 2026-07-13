# macro-regime-tab-improvements

| Field | Value |
|---|---|
| **Status** | done (rescoped — see resolution below) |
| **Priority** | P0 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Related** | [macro-catalyst](11-macro-catalyst-calendar-improvements-070926.md), [liquidity-money-flow-research](30-liquidity-money-flow-research-070926.md) |

### Resolution (2026-07-13) — superseded, not implemented as scoped
Audited before implementing: the original spec (morning delta strip + CSP income chip) never shipped. Since filing, later work (enh/17 volatility, enh/30 liquidity, enh/35-36 policy) independently built per-tab "verdict" synthesis cards (`VolatilityImplicationsCard`, `LiquidityImplicationsCard`, `PolicyCspSummary`, COT crowding logic) — the Policy card even linked to a Regime "implications" view that didn't exist yet.

Rescoped and shipped instead as a **cross-tab aggregation**: a new `CrossTabReadRow` component on the Regime tab shows one badge per existing verdict (Volatility/Liquidity/Policy/COT), each clickable to jump to its source tab — reusing already-fetched data with zero new fetches/caches. Extracted `getCotCrowding()` as a shared helper so the badge and existing prose card use identical logic. The original delta-strip idea was intentionally dropped in favor of surfacing verdicts that already exist.
