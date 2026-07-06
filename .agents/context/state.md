# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-07-06

## Active work
- Working: macro-subtabs, cot-embedded, tradingview-widgets, sidebar-cleanup, macro-file-splits, workflow-hooks, macro-data-enhancements, market-regime-schema, peer-group-infrastructure, scoring-pipeline-improvements, stock-db-admin-view, av-polygon-data-sources, backfill-script, yahoo-data-source, edgar-data-source, source-fundamentals-table, validate-sources, merge-trusted, field-provenance, manual-overrides, provenance-tooltip, provenance-cache
- In progress: Stock DB tooltip + override system complete: field_provenance + manual_overrides tables migrated; merge-trusted.ts refactored (resolveField exported, field_provenance upserted, provenanceCache.delete per ticker); GET/PUT/DELETE provenance API routes live; StockDBTab popover with per-field source breakdown + override control; server-side TTLCache (15min, key=ticker) with explicit invalidation on override save and merge batch; AbortController via react-query signal; 10min client staleTime with refetchOnWindowFocus; error state + retry in popover. field_provenance is empty until merge-trusted.ts is re-run.
- Blocked: FMP quota resets midnight UTC (wacc, priceToSales, roic). AV quota resets midnight UTC. merge-trusted.ts must be re-run after FMP backfill to populate field_provenance.

## Next tasks (priority order)
1. **universe-audit** — Confirm whether 257-ticker fmp_fundamentals expansion is intentional; see `.claude/docs/next-session-tasks-db.md` for full 5-step plan
2. **fmp-backfill-live** — Run `backfill-fmp.mjs` after midnight UTC quota reset (247 tickers × 9 calls, ~10 days)
3. **polygon-backfill-live** — Run `backfill-polygon.mjs` one shot (175 tickers)
4. **provenance-cache-registry** — Register `provenanceCache` in `cache-registry.ts` (admin panel)
5. **options-comparison-table** — Side-by-side put option comparison UI
6. **strike-explorer-slider** — Interactive strike selection slider
7. **reserve-oracle-vm-ip** — OCI Console → Networking → IP Management → assign `146.235.223.94` before any VM reboot

## FactSet Proxy — LIVE ✅
- Oracle Cloud VM `146.235.223.94` — Ubuntu 22.04, VM.Standard.E2.1.Micro (Oracle Always Free)
- SSH: `ssh -i ~/Desktop/ssh-key-2026-06-14.key ubuntu@146.235.223.94` (key on Mac Desktop only)
- PM2: `pm2 logs factset-proxy --lines 30 --nostream`
- FactSet account: `USCMARSHALL-2393811` — Overview Report Builder API only
- Endpoint: `GET /report/overview/v1/financial-highlights?id=TICKER-US`
- Fields: Revenue, EBITDA, EBIT, Net Income, EPS, margins, ROE, ROA, FCF, Current Ratio, D/E, Total Equity, Cash, OCF, Revenue Growth YoY, EPS Growth
- Fields NOT from FactSet: PE, P/B, P/S, ROIC, Beta, WACC, Analyst Target, Interest Expense, Total Debt, Shares → FMP fills these
- Cache: DB-first, 7-day freshness. Only `POST /api/sdm/refresh/:ticker?admin=true` forces live call.
- IP `146.235.223.94` is **Reserved** in OCI ✅

## RSI / MFI thresholds
Per-ticker thresholds: `.claude/skills/signal-filters.md` (authoritative). MFI threshold: 25 (all tickers).

## Fundamentals pipeline state (2026-07-05)
- Canonical universe: 257 tickers in fmp_fundamentals
- Bronze tables: fmp(257), yahoo(281), finnhub(158), edgar(158), polygon(0), av(0)
- Silver: source_fundamentals ~15,809 rows
- Gold: ticker_fundamentals 257 rows, field_provenance 6,726 rows (pre-expansion — needs re-run)
- Backfill scripts built: backfill-fmp.ts (247 pending), backfill-polygon.ts (175 pending), backfill-av.ts (all 257, 25/day)
- Run order after midnight UTC: backfill-fmp → backfill-polygon → populate-source-fundamentals → merge-trusted → backfill-av (daily)
