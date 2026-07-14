# stock-breakdown-sections-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Related** | [analyst-data-persistence](6-analyst-data-persistence-070926.md) |

### Purpose
One-page go/no-go research before selling a put — Simply Wall St–style scroll with FILDI scoring depth.

### Re-verified 2026-07-14
A1 (FE `buildCatalysts` dedupe) was already done before this check — `catalysts-section.tsx` is 30 lines, pure presentational, consumes server `catalysts[]` only. No other prior work found. Earnings date is already present in the catalysts bullet list (via server `buildCatalysts`), just not called out prominently near the section title.

### Remaining steps
| # | Work | File |
|---|---|---|
| A2 | Make earnings date prominent near catalysts title (currently buried in bullet list) | `catalysts-section.tsx` |
| A3 | Header CTAs: "Open in scanner" + "Add to compare" (≤5 shelf) | `stock-breakdown.tsx` |
| A4 | Competitors list → clickable, link to compare/home | `competitors-section.tsx` |
| A5 (optional) | Collapse rewards/risks to top-of-page summary from existing bull/bear bullets | `stock-breakdown.tsx` |
| A6 | Decide `/breakdown` route fate — redirect to `/watchlist?ticker=` (prefer, since watchlist already embeds `<StockBreakdown>`) or unify header CTAs | `App.tsx`, `pages/breakdown.tsx` |

### Constraints
No new `/report` page. No FMP price targets (free tier empty). No Redis. No parallel breakdown fetch. Reuse `GET /api/stocks/breakdown` as-is.
