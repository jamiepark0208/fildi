# Stock DB quality audit (2026-09-28 evening)

## Verdict
**Not perfect.** Scoring unify stays blocked. Ad-hoc work ran — **do not wait for tonight**.

## Trajectory
| | Start (session) | Now |
|---|---|---|
| Needs Review | 1764 | **483** |
| FactSet calls today | 0 | 383 / 500 |
| Tech rows | 493 | **533** (25 left = delisted/thin history) |

## Field-wide findings (fundamentals)
| Pattern | Fields | Action taken |
|---|---|---|
| Growth-gate nulls | PEG ~321, FwdPEG | Expected — leave null when g≤5% or ≥300% |
| Loss-maker nulls | PE ~71 | All non-positive EPS — correct |
| Owned derives | netMargin, opMargin, ROE, D/E, PE, P/B, ROIC, PEG, FwdPEG | Live in merge-trusted |
| Def SKIP (not bugs) | beta, D/E, PEG, FwdPEG, epsGrowth, revGrowth, totalDebt | Cleared NR noise |
| Scale bug | Finnhub dividendYield double-/wrong scale | Fixed populate heuristic |
| FactSet settles | opMargin, P/B, ROA, grossMargin, EPS… | drain-needs-review ad-hoc |
| Coverage gaps | EBITDA ~44, ROIC ~47 | Need more enrich / FactSet |

## Technicals
- Core indicators filled on rows that exist (0 null RSI/MFI/ATR/MA/regime)
- 25 missing: BF.B, BRK.B, delisted (STOR, SKX, X, WTR…), thin history (SKHY)
- IV nulls without options chain = expected

## Ad-hoc (anytime)
```bash
cd artifacts/api-server
pnpm exec tsx src/scripts/drain-needs-review.ts --max=40
pnpm exec tsx src/scripts/merge-trusted.ts
pnpm exec tsx src/scripts/backfill-missing-technicals.ts
pnpm exec tsx src/scripts/populate-source-fundamentals.ts  # after enrich
```

## Perfect bar → then unify scorers
NR ≪ 300 with only definitional leftovers; tech missing = delisted cleanup only; dual client/server scorers then merge.
