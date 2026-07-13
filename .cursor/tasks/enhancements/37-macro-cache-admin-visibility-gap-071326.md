# macro-cache-admin-visibility-gap

| Field | Value |
|---|---|
| **Status** | backlog |
| **Priority** | P2 |
| **Area** | admin / observability |
| **Effort** | S |
| **Created** | 2026-07-13 |
| **Source** | user observation during macro-tab session wrap |
| **Related** | enh/17, enh/30, enh/36 (macro tab work these gaps trail behind) |
| **Type** | ENHANCE |

### Purpose
Over several sessions the Macro tab gained a lot of new sub-data (Liquidity tab plumbing/sector rotation, Volatility tab 2x3 grid + COT marquee + fixed put/call source, Policy tab Balance Sheet/QT card). The Settings admin tabs — **Cache Monitor**, **Stock DB**, **API Monitor** — were not updated alongside this work:

- `cache-registry.ts` only tracks three coarse buckets (`macro-data`, `macro-charts`, `macro-cot`) as single blobs. It has no per-field visibility — e.g. if `fedAssetsHistory`, `volatilityImplications`, or the CNN fear-greed-derived put/call source silently starts returning empty/stale data, the Cache Monitor tab still shows the parent `macro-charts` bucket as fresh.
- `StockDBTab.tsx` and `ApiMonitorTab.tsx` have zero references to macro (grepped clean) — they're scoped to fundamentals/tickers, not macro series. Not necessarily wrong, but means there's currently no admin-side health check for any macro data source at the field level.

### Scope (to define at pickup)
- Decide whether this needs per-field cache entries (heavier: restructure `macro-charts` cache bucket) or just a lighter per-field "last non-null value seen" staleness check surfaced in Cache Monitor.
- Audit which macro sub-fields have silently gone stale/dead before (put-call source in enh/17 was found by manual inspection, not by any monitor) — that's the concrete motivating incident.
- Out of scope: don't rebuild Stock DB/API Monitor around macro — just close the visibility gap for macro-charts sub-fields in Cache Monitor.
