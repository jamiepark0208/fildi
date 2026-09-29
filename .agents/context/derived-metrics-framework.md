# Derived metrics framework (PEG / Fwd PEG / ratios)

## Principle
Vendors publish **labels**, not interchangeable numbers. TradeDash owns formulas for
any metric that mixes price, earnings, and growth.

| Gold field | Formula | Notes |
|---|---|---|
| `peRatio` | priority merge, FactSet referee, or price/EPS | |
| `forwardPe` | priority merge / price÷forwardEps | |
| `pegRatio` | `peRatio / (epsGrowth×100)` | source=`derived` — never vendor vote |
| `forwardPeg` | `forwardPe / (epsGrowth×100)` | same growth basis; diagnostic sibling |

## Stock DB cell showing 1–2 PEGs
Often correct historically (vendors omit PEG). **Fix:** populate fill-in derives
missing `source_fundamentals.pegRatio` from that source's own PE+epsGrowth so the
provenance grid fills without pretending Yahoo-5yr ≡ Finnhub-forward.

## Scoring
- Client V2 scorecard uses **trailing PEG** only (value family).
- **Do not** also weight Fwd PEG at full strength — double-counts growth vs price.
- Server `fundamentals-db` SCORING_METRICS currently omits PEG — unify later.

## Data agent loop (recommended ops)
1. Enrich free sources → populate (incl. derive missing PEGs) → merge (derived gold)
2. FactSet referee on divergent non-skip fields
3. Audit: `node scripts/data-ops-audit.mjs` + Needs Review count trend
4. Human only for residuals that cannot be derived
