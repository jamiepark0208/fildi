# stock-breakdown-sections-improvements

| Field | Value |
|---|---|
| **Status** | done* (A4 re-verify pending — see note) |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Related** | [analyst-data-persistence](6-analyst-data-persistence-070926.md) |

### Purpose
One-page go/no-go research before selling a put — Simply Wall St–style scroll with FILDI scoring depth.

### Re-verified 2026-07-14
A1 (FE `buildCatalysts` dedupe) was already done before this check — `catalysts-section.tsx` is 30 lines, pure presentational, consumes server `catalysts[]` only. No other prior work found. Earnings date is already present in the catalysts bullet list (via server `buildCatalysts`), just not called out prominently near the section title.

### Shipped 2026-07-14 (commit 0634358), re-verified against current code
| # | Work | File | Verified |
|---|---|---|---|
| A2 | Earnings date prominent near catalysts title | `catalysts-section.tsx` | done — `EARNINGS_LINE` regex pulls it out of the bullet list |
| A3 | Header CTAs: "Open in Options Scanner" (+ compare shelf) | `stock-breakdown.tsx` | done — `addToScannerShelf` + navigate wired at line ~846 |
| A5 | Collapse rewards/risks to top-of-page bull/bear summary | `stock-breakdown.tsx` | done — Bull Case / Bear Case cards render above the fold |
| A6 | `/breakdown` route fate | `App.tsx` | done — redirects to `/watchlist` |
| A4 | Competitors list → clickable | `competitors-section.tsx` | **regressed** — the committed version had this, but the working tree now has an uncommitted, in-progress rewrite of `competitors-section.tsx` (+ `peer-classifier.ts`, `peer-rankings.ts`, `stocks.ts`) toward taxonomy-backed peer scoring (the "Competitors v2" work), which currently has no click handler. Re-check clickability once that rework lands. |

### Constraints
No new `/report` page. No FMP price targets (free tier empty). No Redis. No parallel breakdown fetch. Reuse `GET /api/stocks/breakdown` as-is.
