# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-06-16

## Active work
- Working: options-scanner-phase4, options-scanner-phase5
- In progress: Options scanner enhancement complete: new scorer live, StrikeCard overhauled, MacroBanner added, sort system updated
- Blocked: none

## Next tasks (priority order)
1. **options-comparison-table** — side-by-side put option comparison UI
4. **strike-explorer-slider** — interactive strike selection slider
5. **user-management-system** — independent watchlists per user, session auth, admin-only refresh (design pending — brainstorm interrupted)
4. **fmp-fundamentals-backfill** — `POST /api/fundamentals/refresh` for tickers not yet in DB (check: `GET /api/fundamentals/status`). FactSet is now priority-1; FMP fills remaining fields (PE, P/B, P/S, ROIC, Beta, WACC, shares).
5. **macro-data-live-feed**
6. **reserve-oracle-vm-ip** — OCI Console → Networking → IP Management → Reserved Public IPs → assign `146.235.223.94` before any VM reboot loses it

## Living task list
`FILDI_ROADMAP.md` (root) — read before starting any new feature to understand pending/known-broken/architectural decisions.

## Completed (recent)
scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix, fundamental-scorer-v2, fmp-phases-1-5, technical-scorer-v2-phases-1-5, AI-score-explanations, options-scanner-persistence, context-consolidation, factset-proxy-infrastructure, factset-proxy-activation (2026-06-14), **options-scanner-enhancement** (2026-06-16) — new scorer live, ivRank scale fix, /api/fundamentals/rankings endpoint, StrikeCard overhauled, MacroBanner, sort system

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
