---
name: hot-files
description: Line-finding greps for frequently edited macro/schema/pipeline files (moved out of CLAUDE.md 10-20, W03)
---

# Hot file index — grep before Read, never load whole file
These files are edited frequently. Always `grep -n "<pattern>" <file>` to get line numbers, then `Read offset+limit`.

| File (path relative to artifacts/) | Find what | Grep pattern |
|---|---|---|
| `api-server/src/lib/macro-data.ts` | MacroCharts interface | `grep -n "MacroCharts\|interface Macro"` |
| `api-server/src/lib/macro-data.ts` | fetchMacroCharts body | `grep -n "fetchMacroCharts\|Promise.allSettled"` |
| `api-server/src/lib/macro-data.ts` | loadChartsCache guard | `grep -n "loadChartsCache\|in data"` |
| `api-server/src/lib/macro-data.ts` | fetchMacroData body | `grep -n "fetchMacroData\|ismManufacturing"` |
| `api-server/src/lib/macro-static.ts` | INDICATOR_SERIES entries | `grep -n "INDICATOR_SERIES\|ismManufacturing"` |
| `stock-compare/src/pages/macro.tsx` | regime tab charts section | `grep -n "HY Credit\|IG/HY\|NFCI\|DXY\|Economic Indicators"` |
| `stock-compare/src/pages/macro.tsx` | macro component imports | `grep -n "DualLine\|RateHistory\|import {"` |
| `stock-compare/src/components/macro/macro-history-charts.tsx` | DualLineHistoryChart / RateHistoryChart | `grep -n "DualLine\|RateHistoryChart\|referenceLines"` |
| `stock-compare/src/components/macro/macro-page-types.ts` | MacroCharts / MacroData types | `grep -n "MacroCharts\|MacroData\|igSpread\|nfci"` |
| `lib/db/src/schema/index.ts` (repo root, NOT under artifacts/) | any table definition | `grep -n "pgTable\|market_regime"` |
| `api-server/src/scripts/merge-trusted.ts` | FIELD_DEFS priority table | `grep -n "FIELD_DEFS\|tfCol\|priority"` |
| `api-server/src/scripts/nightly-enrichment.ts` | per-source fetchX() write bodies — check for dropped fields vs the source's *-client.ts interface before trusting coverage numbers | `grep -n "^async function fetch"` |
| `api-server/src/lib/cache-registry.ts` | registered cache names | `grep -n "DISPLAY_NAMES\|getAllCaches"` |

