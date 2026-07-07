# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-07-07

## Active work
- Working: api-monitor-tab, api-usage-table, populate-source-fundamentals-polygon-av, merge-trusted-polygon-av-field-defs, provenance-cache-registry, stock-db-grouping-ui, backfill-av-db-migration, fmp-budget-unified-table
- In progress: Phase 1 complete: unified api_usage table (0011 migration), recordApiUsage wired into logApiCall for all sources, FMP budget tracking migrated from fmp_api_usage singleton to api_usage, AV cursor file syncs from DB on startup, GET /api-usage/history route, ApiMonitorTab (5min refresh, progress bars for FMP/AV, raw counts for others). Stock DB endpoint now returns peerGroupName+companyName from ticker_registry+peer_groups join. Stock DB UI adds sector/peer-group row grouping with representative highlighting — but UI quality is poor, needs full redesign next session. Polygon+AV wired into populate-source-fundamentals and merge-trusted FIELD_DEFS as lowest-priority fallbacks.
- Blocked: FMP quota exceeded today (resets midnight UTC) — run backfill-fmp.mjs first after reset. AV quota resets midnight UTC. merge-trusted must re-run after backfills to populate field_provenance for all 257 tickers. Finnhub PE/ratio coverage is patchy (some tickers null, others not) despite no daily rate cap — suspected backfill bug or Finnhub API returning null for certain ticker types, needs investigation.

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
