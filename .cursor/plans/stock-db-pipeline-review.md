# Holistic Stock DB pipeline review (2026-09-28)

## Coverage number reconciliation
| Metric | UI (filled/total) | DB now | Prior agent phrasing |
|---|---|---|---|
| PEG | 234/558 | **237** non-null | said “~321 null” (= 558−237) |
| P/E | 469/558 | **487** non-null (483 if >0) | said “~71 null” |

UI formula (`StockDBTab.tsx`): count rows where `fundamentals[col] != null` / `data.length`.
Prior replies quoted **null counts**, not filled — and UI may be slightly stale vs DB after ad-hoc merges. **Refresh Stock DB tab**; expect PEG ≈237, PE ≈487.

## Provenance honesty bug (real)
When gold PEG is nullified (growth gate), **246** `field_provenance` rows still say `winning_source=yahoo`. Gold is correct; the audit trail lies. Merge must delete/clear provenance when derived value is null.

## Framework scorecard (honest)
| Question | Grade | Notes |
|---|---|---|
| Deterministic gold path? | B | FIELD_DEFS + referee + derives are deterministic; bronze fetch timing/vendors are not |
| Bug-free? | C+ | Unit bugs (Finnhub DY), FactSet colIdx, stale provenance, dual scorers |
| Efficient? | B− | Single merge path; enrich is sequential + budget-bound; OK at 558, not “set and forget” |
| Multi-source → explain diffs → pick gold? | B | Provenance + Needs Review + FactSet referee exist; SKIP list still evolving |
| Scale? | B | Registry + budgets + maintain; FactSet 500/day is the hard cap |
| Cross-stock comparable? | B− only if owned/derived | Vendor PEG/growth/debt **not** comparable across names |
| Unit risks? | Yes | DY scale, % vs decimal, TTM vs FY, ASC 842 debt, EPS diluted vs basic |
| Derive more? | Yes | See below |
| New fields? | Yes | period_basis, forwardEps, bvps, definition_id |
| Cursor debug efficiency? | B | codegraph + SQL + drain scripts; hurt by provenance drift |
| Continuous improvement ≈ ML? | Not yet | Need scored audits + fixtures + lessons; not gradient descent |
| Next agent learns mistakes? | Only if written to lessons/plans | No automatic memory of chat |

## Recommended owns / new columns
- `forward_eps`, `book_value_per_share` (primitives for PE/P/B)
- `period_basis` enum per field or per row (`ttm`/`fy`/`forward`)
- Clear provenance on null-derived fields
- Fixture suite: AFRM + AAPL DY + ZTS PEG must stay green
