# Data Source Integration Plan (v2 summary)

> **Full SSOT:** [`.cursor/tasks/research/data-source-integration-070926.md`](../tasks/research/data-source-integration-070926.md) — expanded 2026-07-10

## What changed (v1 → v2)

v1 collapsed sources into tier blurbs and ~3 “Best At” lines per vendor. **Unacceptable for Yahoo** — the library alone exposes 10+ methods, 34 quoteSummary modules, options, news, screeners, and `fundamentalsTimeSeries`. TradeDash uses ~15% of that.

v2 is **inventory-first:** every method/module, code call-site, cache/TTL, bronze table, FIELD_DEFS role, and prioritized unlock.

## Yahoo at a glance (see doc §3 for full matrix)

| Category | Used today | High-value unused |
|---|---|---|
| **quoteSummary** | 7 modules (price, summaryDetail, financialData, defaultKeyStatistics, assetProfile, recommendationTrend, upgradeDowngradeHistory, calendarEvents) | earningsTrend, earningsHistory, insiderTransactions, institutionOwnership, secFilings, summaryProfile |
| **Market data** | chart (history + macro), historical (legacy bootstrap), options (puts scanner) | quoteCombine batch, call-side / skew persist |
| **Discovery** | search (tickers + news) | screener, trendingSymbols, insights |
| **Statements** | fundamentalsTimeSeries (backfill only) | Quarterly panel UI, serve-time freshness |

## Other sources (abbreviated)

| Source | Wired | Key gap |
|---|---|---|
| FMP | 9 endpoints/ticker, merge fallback | Free tier empty for mid-caps; don’t burn on PT breakdown |
| EDGAR | XBRL bronze, merge for balance sheet | No live filing poll |
| Finnhub / Polygon / AV | Bronze + partial merge | Backfill incomplete (enh/24) |
| FRED + macro files | Regime + charts | — |
| FactSet | Admin SDM only | Not in merge; outlier tie-break |
| RH / TV / Coinbase | CSV + widgets | PRDs pending |

## Tier model (unchanged intent)

- **T0:** Yahoo + EDGAR — automated, cache-aware
- **T1:** FMP, AV, Polygon, Finnhub — budgeted batch
- **T2–T3:** WRDS / Refinitiv — quarterly bronze, not page load
- **T4:** RH, TV, Coinbase — human-triggered adapters

## Immediate next steps

1. **Yahoo P0 (no new vendors):** migrate `historical()` → `chart()`; add earningsTrend/earningsHistory to breakdown quoteSummary
2. WRDS discovery checklist (§13)
3. Child PRDs: yahoo-unlock, TV webhook, WRDS batch

## Session note

Bug Wave 1 code was reverted; this track remains research/docs only until user approves implementation.
