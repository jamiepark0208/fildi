# large-component-token-cost

| Field | Value |
|---|---|
| **Status** | in-progress — 1 of 6 done |
| **Priority** | P2 |
| **Area** | frontend / dev-cost |
| **Effort** | M (per file) |

### Purpose
Several frontend files have grown large enough that every Claude session touching them burns a Read-guard-triggering chunk of context just to locate the relevant section, even with grep-first discipline. Filed 2026-07-14 after a session working in `price-chart.tsx` needed several grep+offset reads against `chart-levels.ts` and `stock-breakdown.tsx` just to map out one feature.

### Candidates (line count as of 2026-07-14)
| File | Lines | Why it's a repeat-cost |
|---|---|---|
| `components/macro/MacroComponents.tsx` | 2565 | Hot file per CLAUDE.md's own index — touched almost every macro-tab session |
| `components/portfolio-analysis.tsx` | 1578 | Single file for what CLUSTERS.md's Cluster 6 treats as multiple phases (A1-A4) |
| `components/settings/StockDBTab.tsx` | 1224 | Admin-only, lower churn — lower priority despite size |
| `pages/options-scanner.tsx` | 1220 | Actively edited alongside enh/33 momentum work |
| `pages/portfolio.tsx` | 1092 | Pairs with portfolio-analysis.tsx above — likely same refactor pass |
| `components/stock-breakdown.tsx` | ~~1019~~ 513 | **Done 2026-07-14** — split into `analyst-ratings-section.tsx`, `market-sentiment-section.tsx`, `news-card.tsx`, `breakdown-metrics-table.tsx`; also deleted dead code (`gradeColor`/`actionLabel`, unreferenced anywhere). tsc + all 268 tests pass. |

### Suggested approach (not yet scoped in detail)
Split each into a page/container shell + section subcomponents (already the pattern `catalysts-section.tsx`, `competitors-section.tsx` follow for `stock-breakdown.tsx` — extend it: pull the remaining inline sections — bull/bear summary, header CTAs, overview bullets — into their own files the same way). `MacroComponents.tsx` is a grab-bag of unrelated chart components under one name; split by chart type/tab instead of one shared file.

### Constraints
Don't do this speculatively in one big pass — pick one file per session, verify no import breakage (`tsc --noEmit` both packages), and only split along natural section boundaries that already exist as JSX comment dividers (`{/* ── X ── */}`) rather than inventing new abstractions.
