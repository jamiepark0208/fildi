# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-06-24

## Active work
- Working: macro-subtabs, cot-embedded, tradingview-widgets, sidebar-cleanup, macro-file-splits, workflow-hooks
- In progress: Macro tab has CBOE put/call ratio, GSCPI, money market AUM charts added; macro.tsx split into macro.tsx(643L)+MacroComponents.tsx(1402L)+macro-page-types.ts(172L); macro-data.ts split into macro-data.ts(845L)+macro-static.ts(262L)
- Blocked: FMP daily rate limit exhausted — per-analyst price targets will not show until reset

## Next tasks (priority order)
1. **options-comparison-table** — side-by-side put option comparison UI
2. **strike-explorer-slider** — interactive strike selection slider
3. **user-management-system** — independent watchlists per user, session auth, admin-only refresh (design pending — brainstorm interrupted)
4. **fmp-fundamentals-backfill** — `POST /api/fundamentals/refresh` for tickers not yet in DB (check: `GET /api/fundamentals/status`). FactSet is now priority-1; FMP fills remaining fields (PE, P/B, P/S, ROIC, Beta, WACC, shares).
5. **macro-data-live-feed**
6. **reserve-oracle-vm-ip** — OCI Console → Networking → IP Management → Reserved Public IPs → assign `146.235.223.94` before any VM reboot loses it

## Living task list
`FILDI_ROADMAP.md` (root) — read before starting any new feature to understand pending/known-broken/architectural decisions.

## Completed (recent)
**watchlist-stock-analysis** (2026-06-18, Cursor):
- Watchlist `StockBreakdown`: overview name dedup; Competitors (top 5, 50/50 tech+fund, DB-first peers + backfill); Event Risk/Catalysts from breakdown cache
- API: `GET/POST /api/stocks/competitors/*`, `peer-resolver`, `buildCatalysts`, `peersCache`

**profile-bucket-search + scorecard-guide-ui** (2026-06-18):
- My Profile sentiment buckets: ticker autocomplete via useSearchStocks (same cache as Fundamental tab)
- Scorecard Guide: larger typography, colored status badge chips, shadcn Table grids with higher contrast

scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix, fundamental-scorer-v2, fmp-phases-1-5, technical-scorer-v2-phases-1-5, AI-score-explanations, options-scanner-persistence, context-consolidation, factset-proxy-infrastructure, factset-proxy-activation (2026-06-14), **options-scanner-enhancement** (2026-06-16) — new scorer live, ivRank scale fix, /api/fundamentals/rankings endpoint, StrikeCard overhauled, MacroBanner, sort system

**github-enhancements** (2026-06-18):
- Security middleware: rate limiting, CORS whitelist, global error handler, Zod validate() factory, helmet
- TTLCache extracted to lib/ttl-cache.ts with hit/miss stats and getStats()/clear()
- All 8 cache instances named and exported; cache TTLs updated (search 24h, quote/compare/history 1h, breakdown 2h, history-1d 15m, options 30m, options-expiry 24h, macro-regime 30m)
- Shared expiry date cache in lib/options.ts (24h, key='shared') — skips undated Yahoo call on cache hit
- Admin cache dashboard: GET/DELETE /api/admin/cache/* — Settings page CacheMonitor component (⚠️ UI rendering bug TBD next session)
- Zod auth validators: lib/validators/auth.ts, applied to /auth/register and /auth/login
- DB schema: positions.notes column added (ALTER TABLE), lib/db dist rebuilt
- Invite codes: GET /admin/invites now returns usedByEmail; DELETE /admin/invite/:code added
- retry utility: lib/retry.ts with withRetry<T>(); startup tasks wrapped in 3-attempt retry

## FactSet Proxy — LIVE ✅ (2026-06-14)
- Oracle Cloud VM `146.235.223.94` — Ubuntu 22.04, VM.Standard.E2.1.Micro (Oracle Always Free)
- SSH: `ssh -i ~/Desktop/ssh-key-2026-06-14.key ubuntu@146.235.223.94` (key on Mac Desktop only — not in Replit)
- PM2: started via `cd ~/factset-proxy && pm2 start ecosystem.config.js && pm2 save` (env vars persist across reboots)
- PM2 logs: `pm2 logs factset-proxy --lines 30 --nostream`
- FactSet account: `USCMARSHALL-2393811` — only **Overview Report Builder API** subscribed
- Endpoint: `GET /report/overview/v1/financial-highlights?id=TICKER-US` → STACH 2.0 response
- Fields provided: Revenue, EBITDA, EBIT, Net Income, EPS, Gross/Operating/Net Margins, ROE, ROA, FCF, Current Ratio, D/E, Total Equity, Cash, Operating Cash Flow, Revenue Growth YoY, EPS Growth (~57% quality score)
- Fields NOT available from FactSet: PE ratio, P/B, P/S, ROIC, Beta, WACC, Analyst Target, Interest Expense, Total Debt, Shares Outstanding → FMP fills these
- Cache: DB-first, 7-day freshness. UI queries never touch FactSet. Only `POST /api/sdm/refresh/:ticker?admin=true` forces a live call.
- Rate limit: 20 req/sec (not a concern — one call per ticker per 7 days max)
- Env vars in Replit Secrets: `FACTSET_PROXY_URL=http://146.235.223.94:3001`, `FACTSET_PROXY_SECRET`
- IP `146.235.223.94` is **Reserved** in OCI — safe across VM reboots ✅

## Technical Scorer V2 — COMPLETE (2026-06-09)
- DB: `tickerTechnicals` (55 cols), daily refresh, `GET /api/technicals/all`
- Scorer: `computeTechnicalRankingsV2` in `technical-rankings.ts`
- UI: `technical.tsx` + `options-scanner.tsx` wired to V2
- Known remaining items:
  - `ivRank`/`ivPercentile`: still use realized vol as IV proxy (upgrade when ~60d of atmPutIv history accumulates)
  - `putCallVolumeRatio`/`basicSkew`: absolute mapping (upgrade to percentileRank when ~60d history accumulates)
  - Remove `computeTechnicalRankings` (V1) after one release
  - `scorecard-explanation.tsx`: still shows V1 metrics — update in next UI pass

## FMP Data Layer — COMPLETE (2026-06-09)
- Partial coverage — check live status: `GET /api/fundamentals/status`
- Budget guard: 220 calls/day max via `fmp_api_usage` table
- Complements FactSet: provides PE, P/B, P/S, ROIC, Beta, WACC, shares that FactSet Overview API doesn't cover

## RSI / MFI thresholds
Per-ticker thresholds live in `.claude/skills/signal-filters.md` (authoritative).
MFI threshold: 25 (all tickers)

## Technicals stale check
Auto-runs on startup. Force-refresh:
```bash
curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true
```
