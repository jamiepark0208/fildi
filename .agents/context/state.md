# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-07-15

## Active work
- Working: explain-ai-options-scanner-phase1, daily-cache-bucketing, opt-in-ai-button
- In progress: none active
- Blocked: none

## Next tasks (priority order)

0. **macro-synthesis-card-unit-tests** — `computeVolatilityImplications()` and `computeLiquidityImplications()` in `api-server/src/lib/macro-data.ts` (both currently module-private, not exported) and `derivePolicySignals()` in `stock-compare/src/components/macro/MacroComponents.tsx` (also private) have hardcoded regime thresholds driving user-facing trading verdicts, with zero test coverage — unlike the rest of the codebase (308 passing tests elsewhere). Scoped but deferred this session for context budget. To pick up: export the three functions, add boundary tests per threshold transition (see exact threshold values already read out in this session's transcript — VIX 15/20/30, VVIX 90/100/120, put/call 0.7/1.0/1.3, MOVE 90/110/140, HY OAS 350/400/500, RRP 75/300, SOFR-IORB 0/5/15, NFCI -0.1/0.1/0.5) plus one compound-condition case per card.

1. **stock-db-ui-redesign** — The current StockDBTab grouping implementation is hard to read. Redesign from scratch: collapsible accordion sections per sector → peer group, groups ordered by descending coverage % (most data-complete groups first), clear visual hierarchy between sector/group/ticker rows, representative tickers (watchlist) visually distinct within their group. Do NOT patch the existing grouping render — plan the layout first, then implement.

2. **finnhub-coverage-investigation** — Finnhub has no daily rate cap yet `finnhub_fundamentals` is missing PE and other ratios for many tickers. Before assuming a bug, check: (a) which tickers have null `finnhub_pe_ratio`, (b) what `backfill-finnhub.ts` skip logic looks like, (c) whether Finnhub's free tier genuinely returns null metrics for certain ticker types (e.g. ETFs, foreign listings, small caps). Report findings before making any changes.

3. **backfill-fmp** — FMP quota resets at midnight UTC. Check `api_usage` table for today's FMP count before running. Run `backfill-fmp.mjs` only after confirming remaining budget > 0. This runs ~247 tickers × 9 calls over ~10 days at 250/day.

4. **backfill-polygon** — One-shot, no daily cap. Run `backfill-polygon.mjs` after FMP backfill. 175 tickers expected.

5. **populate-and-merge** — After any backfill: run `populate-source-fundamentals.mjs` (now processes all 6 sources including Polygon + AV), then `merge-trusted.mjs`. Do NOT run these blindly — confirm backfill output looks sane first.

6. **backfill-av** — AV quota resets at midnight UTC. 25 calls/day, resumable cursor. Run after populate+merge to avoid gaps in provenance.

7. **verify-provenance-tooltip** — After merge-trusted re-run, open Stock DB tab and confirm the provenance popover shows real winning_source data for at least 3 tickers across different sources.

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

## Fundamentals pipeline state (2026-07-13)
- Universe: ticker_registry WHERE fetch_fundamentals=true (257 tickers) — golden source for all scripts
- Bronze tables: fmp(257), yahoo(280), finnhub(280), edgar(280), polygon(162), av(14)
- Silver: source_fundamentals 23,158 rows (fresh — re-ran 2026-07-13, 118 rejected)
- Gold: ticker_fundamentals 269 tickers merged, field_provenance 9,259 rows (fresh — re-ran 2026-07-13). Fields null >20% of tickers: peRatio (64/283), pegRatio (59/283) — worth investigating if these matter for scoring.
- All 7 backfill scripts now read from ticker_registry WHERE fetch_fundamentals=true
- populate-source-fundamentals.ts now handles all 6 sources including Polygon (source='polygon') and AV (source='alpha_vantage')
- merge-trusted.ts FIELD_DEFS: Polygon + AV added as lowest-priority fallbacks across applicable fields
- Backfill safe order: check api_usage budget → backfill-fmp (250/day) → backfill-polygon (no cap) → populate-source-fundamentals → merge-trusted → backfill-av (25/day)
