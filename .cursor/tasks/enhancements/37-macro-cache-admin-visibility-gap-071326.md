# macro-cache-admin-visibility-gap

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P2 |
| **Area** | admin / observability |
| **Effort** | S |
| **Created** | 2026-07-13 |
| **Source** | user observation during macro-tab session wrap |
| **Related** | enh/17, enh/30, enh/36 |

### Resolution (2026-07-13)
Shipped the lighter of two options considered: `cache-registry.ts` now expands the `macro-charts` cache bucket into one entry per chart field (21 `MacroCharts` fields) instead of a single blob, so an empty/dead field renders as `EMPTY`/`SOURCE DEAD` in the Cache Monitor UI immediately, regardless of the parent bucket's freshness — directly addressing the motivating incident (a dead put/call source found only by manual inspection in enh/17). The API Monitor gap flagged in scope turned out to be a non-issue on closer trace — FRED/CNN/NY Fed calls were already metered and displayed correctly — so no change was needed there. Stock DB tab confirmed correctly out of scope (ticker-only by design).
