# Session Index

Full detail for each date at `.agents/sessions/claude-YYYY-MM-DD.md` (Claude) or `cursor-YYYY-MM-DD.md` (Cursor).
Pre-2026-06-08 history: `.claude/docs/session-history.md`

## Recent (last 30 days)

- [2026-07-13](claude-2026-07-13.md) — Fixed Policy tab responsive grid breakpoint gap and folded Balance Sheet in as 4th compact chart next to SEP Projections - filed enh36 historical-analogy addendum and new enh37 for macro cache admin visibility gap surfaced by user during wrap | build | next: pick up enh35 or enh36 QRA/historical-analogy scoping or enh37 cache visibility gap
- [2026-07-12](claude-2026-07-12.md) — moved Beta Contribution into new 2x2 white-text chart grid below Capital Allocation, added Cumulative P&L by Trade Type and by Top Ticker stacked bars, replaced DTE histogram with YTD bi-weekly Options Income Timeline plus run-rate year-end projection | build | next: resume enlarge-correlation-grid and light-grey-to-white contrast fix across rest of portfolio tab
- [2026-07-11](claude-2026-07-11.md) — shipped YTD orders backfill (1445 new rows) plus PnL box redesign (realized/unrealized/total grid, top-tickers-sold card, removed old transactions table); left mid-investigation on a real numbers-dont-match-Robinhood bug user flagged, most likely missing dividend/distribution data | build | next: resume PnL tie-out then add calls/puts columns to Top Tickers Options Sold table then enlarge correlation grid then restyle Top Tickers table to match equity positions table then fix light-grey-to-white text contrast across portfolio-analysis.tsx
- [2026-07-10](claude-2026-07-10.md) — auto-saved | build | next: bug/11: read ONLY .cursor/tasks/bugs/11-options-scanner-fetch-storm-070926.md + artifacts/stock-compare/src/pages/options-scanner.tsx L980-1010 (grep for fetchedOnce/displayTickers first, don't read whole file). Fix: gate auto-fetch useEffect, keep handleExpand lazy pattern. Then bug/12 (watchlist-quote-n-plus-one): .cursor/tasks/bugs/12-watchlist-quote-n-plus-one-070926.md + routes/stocks.ts quoteCache + stock-compare/src/pages/watchlist.tsx L128. Do NOT re-read CLUSTERS.md/CLAUDE-IMPLEMENT.md/bug-9 file again — already internalized this session: fetch_fundamentals is the single universe gate across all pipeline scripts, nightly scheduler already wired live in index.ts.
- [2026-07-09](claude-2026-07-09.md) — auto-saved | build | next: 1) Complete Yahoo dividendYield: add yahoo_dividendYield to yahoo-client.ts result (fd.dividendYield already available in financialData module), add to populate YAHOO_FIELDS, add to backfill-yahoo upsert. 2) Re-run backfill-finnhub to refresh dividendYield with corrected pct() values. 3) Run populate-source-fundamentals + merge-trusted. 4) Verify NVDA dividendYield now shows ~0.027% not 51.3%. 5) Run nightly-enrichment.ts dry-run then live for all fields. 6) FMP backfill post-midnight reset. 7) AV resumes from ADYEN.
- [2026-07-07](claude-2026-07-07.md) — auto-saved | build | next: 1) REWRITE Stock DB UI completely: collapsible sector+peer-group sections, ordered by coverage %, clear visual hierarchy
- [2026-07-06](claude-2026-07-06.md) — auto-saved | build | next: 1) Run backfill-fmp.ts after midnight UTC quota reset. 2) Re-run merge-trusted.ts to populate field_provenance for all 257 tickers. 3) Verify provenance tooltip shows real source data in UI. 4) Register provenanceCache in cache-registry.ts. 5) Phase 1: audit all 6 data source usage-tracking mechanisms for Phase 2 api_usage table design.
- [2026-07-05](claude-2026-07-05.md) — auto-saved | build | next: 1) Run FMP backfill (backfill-fmp.ts) after midnight UTC quota reset. 2) Re-run merge-trusted.ts to populate field_provenance for all 169 tickers. 3) Verify provenance tooltip shows real source data in UI. 4) Register provenanceCache in cache-registry.ts so it shows in admin cache panel.
- [2026-07-04](claude-2026-07-04.md) — DB staging pipeline: fmp/polygon/av tables, source_fundamentals, validate-sources, merge-trusted, field_provenance, manual_overrides, provenance API, StockDB tooltip + override UI
- [2026-06-26](claude-2026-06-26.md) — Finnhub/Edgar/Yahoo backfill scripts, source staging tables, SDM waterfall wiring
- [2026-06-25](claude-2026-06-25.md) — Stock DB tab enhancements
- [2026-06-24](claude-2026-06-24.md) — DB migrations, macro tab, file splits
- [2026-06-22](claude-2026-06-22.md) — FILDI feed Phase 5, chart zones, profile page
- [2026-06-21](claude-2026-06-21.md) — FILDI Phase 5 continued
- [2026-06-19](claude-2026-06-19.md) — Portfolio import route, FILDI Phase 5
- [2026-06-18](claude-2026-06-18.md) — Security middleware, cache naming, admin cache dashboard, auth Zod validators
- [2026-06-18](cursor-2026-06-18.md) — Cursor: Competitors 50/50 tech+fund, catalysts, DB-first peers
- [2026-06-17](claude-2026-06-17.md) — Scorecard guide UI, chart EMA/zone labels
- [2026-06-16](claude-2026-06-16.md) — Options scanner enhancements: new scorer, ivRank fix, StrikeCard, MacroBanner
- [2026-06-16](cursor-2026-06-16.md) — Cursor: options scanner UX
- [2026-06-15](claude-2026-06-15.md) — Options scanner Q&A + fixes
- [2026-06-14](claude-2026-06-14.md) — FactSet proxy activation (OCI VM live), options scanner persistence

## Older
- [2026-06-12](claude-2026-06-12.md), [2026-06-11](claude-2026-06-11.md), [2026-06-10](claude-2026-06-10.md): Technical scorer V2, FMP data layer, context consolidation, AI score explanations
- [2026-06-09](claude-2026-06-09.md): Technical scorer V2 (all 5 phases), FMP WACC/safety metrics
- [2026-06-08](claude-2026-06-08.md): Fundamental scorer V2 (4 families, 13 metrics)
