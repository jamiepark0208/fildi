# Data quality workflows — implemented cutover

## Done

- **Single gold path:** `enrichAndMergeTickers` → populate → `merge-trusted`
- **SDM thinned:** reads gold or calls enrich; no FactSet→FMP waterfall upsert
- **FactSet referee:** after free merge; last in FIELD_DEFS; preferred on free-source divergence; clears `divergent` when it settles (Needs Review shrinks)
- **Proven on AFRM:** 12 → 4 Needs Review fields (1 FactSet call); remaining 4 are valuation ratios FactSet overview does not supply
- **Mapping fix:** FactSet overview uses `cells[1]` = latest/LTM (not `cells[2]`)
- **One-ticker test:** `pnpm exec tsx src/scripts/test-factset-referee-one.ts AFRM`
- **Maintain catch-up:** `node scripts/maintain.mjs --enrich-if-due`

## Still open (project priority)

1. **Drain Needs Review (~1830)** — run FactSet referee on divergent cohort (budget-capped); expect residual on P/E-class fields (no FactSet overview) → human override or wider FactSet report
2. **Sector-scoring cutover** — score vs `peer_group_members`, not watchlist/`FUNDAMENTAL_WATCHLIST` (see `fundamental-sector-scoring.md`)
3. **Continuous clean-data loop** — nightly free → FactSet settle → audit count trending down; escalate residual to manual override queue
