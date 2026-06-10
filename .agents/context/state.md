# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-06-10

## Active work
- Working: none
- In progress: none
- Blocked: none

## Next tasks (priority order)
1. **options-comparison-table** — side-by-side put option comparison UI
2. **strike-explorer-slider** — interactive strike selection slider
3. **user-management-system** — independent watchlists per user, session auth, admin-only refresh (design pending — brainstorm interrupted)
4. POST `/api/fundamentals/refresh` — populate remaining FMP tickers (check budget first: `GET /api/fundamentals/status`)
5. **macro-data-live-feed**

## Living task list
`FILDI_ROADMAP.md` (root) — read before starting any new feature to understand pending/known-broken/architectural decisions.

## Completed (recent)
scorecard, portfolio, daily-brief, technical-tab, data-architecture, build-skill, iv-rank-metric, ma200-buffer-metric, rsi-velocity-bonus, options-scanner-ux, macro-tab, scorecard-startup-fix, fundamental-scorer-v2, fmp-phases-1-5, technical-scorer-v2-phases-1-5, AI-score-explanations, options-scanner-persistence, context-consolidation

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
- Populate remaining tickers: `POST /api/fundamentals/refresh`

## RSI / MFI thresholds
Per-ticker thresholds live in `.claude/skills/signal-filters.md` (authoritative).
MFI threshold: 25 (all tickers)

## Technicals stale check
Auto-runs on startup. Force-refresh:
```bash
curl -s -X POST http://localhost:8080/api/technicals/refresh?force=true
```
