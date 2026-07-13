# liquidity-money-flow-research

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | research → macro ui/data |
| **Effort** | M (research); build phases spawn after |
| **Created** | 2026-07-09 |
| **Source** | user theory (stimulus economy + sector rotation) + competitive liquidity dashboards |
| **Related** | [macro-regime-tab](10-macro-regime-tab-improvements-070926.md), [macro-volatility](17-macro-volatility-tab-improvements-070926.md), [macro-policy](18-macro-policy-tab-improvements-070926.md) |

### Resolution (2026-07-13)
Research locked a three-layer honest-proxy model (Fed plumbing = Net Liquidity from WALCL−TGA−RRP; reservoirs = MMF/NFCI/reserves/fiscal; sector rotation = SPDR relative-strength bubbles vs SPY) and explicitly ruled out a literal inter-sector cash Sankey, since no such data is public. Rather than spawning separate Phase A/B stub tasks, the user asked to build a working tab directly in-session: shipped a new **Liquidity** macro tab with `deriveNetLiquidity()` (weekly-aligned WALCL/WTREGEN/RRPONTSYD/WRESBAL), a plumbing-diagram card with real $ and 1w/1m deltas, and a `SectorRotationBubbles` chart (SPY + 11 SPDRs + SMH, quadrant-colored). Verified live: computed Net Liquidity ($5,958.2B) matched an independently-sourced figure, and sector rotation returned plausible July-2026 quadrants. Both endpoints reuse the existing `fetchFredCSV` pattern and 4h cache TTL — no new client or parallel fetch path.
