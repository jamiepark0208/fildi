# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-08-02

## Active work
- Working: trade-expiry-staleness-fix, rddt-loss-correction, sector-breakdown-removed, track-record-by-ticker-table, fixture-data-cleanup, feed-page-gold-black-restyle
- In progress: feed.tsx-restyle-tsc-check-pending
- Blocked: playwright-chrome-binary-missing, 3-trade-idea-limit-unresolved, github-push-pat-invalid, fmp-plan-402-needs-decision, new-features-not-yet-verified-in-browser

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

## Fundamentals pipeline state (2026-07-23)
- Universe: ticker_registry WHERE fetch_fundamentals=true (335 tickers after removing SKHYV+ADYEN)
- Gold coverage: ~92.8% (335 active tickers × VALID_FIELD_DEFS). Was 77.6% pre-session — the
  regression was the subprocess-spawn bug (below), not real data loss.
- Only 2 flagged tickers now lack a ticker_fundamentals row (down from 61): both are peer-expansion
  edge cases; the 59 recovered were blue-chips (GS/MA/BAC/ASML/KLAC…) whose fetched staging data
  was never being merged.

### This session's changes (all in merge-trusted.ts / nightly-enrichment.ts / populate-source-fundamentals.ts)
1. **Subprocess bug FIXED**: nightly-enrichment ran populate+merge as `npx tsx` subprocesses via
   execFileSync and swallowed failures as WARN — silently failing in the long-lived prod server.
   Now runs them in-process (`runPopulateSourceFundamentals()`, `runMergeTrusted()` exported;
   process.exit only in CLI guards). A failure marks enrichment_runs `partial`.
2. **EDGAR → last-resort** in every FIELD_DEFS chain (was winning totalStockholdersEquity /
   interestExpense despite being annual/lagging).
3. **Divergence redesign** (isMaterialDivergence): winner-vs-fallback, period-aware, materiality
   tolerances → "Needs Review" 2208 → ~1017. Reads GET /fundamentals/divergent.
4. **Definitional alignment**: cashAndEquivalents = yahoo totalCash only (cash+STI concept);
   totalDebt = yahoo→fmp only; revenueGrowthYoY/epsGrowth on annual basis. NOTE: revenueGrowthYoY
   VALUES shifted (quarterly→annual, e.g. AAPL 16.6%→6.4%) and affect the growth score.
5. Removed SKHYV (pre-IPO→SKHY) + ADYEN (foreign) from registry + all fundamentals tables.
6. finnhub debtToEquity parser fix + override_flags column plumbing (from prior session, still uncommitted).

### Still open / next
- **Rebuild+restart to deploy** (deferred by user) — see Active work note.
- Production hardening not yet done: process.on(uncaughtException/unhandledRejection) in index.ts;
  frozen log-date bug (nightly log filename fixed at server-start date).
- Residual ~1017 Needs Review is genuine vendor disagreement (lease inclusion, price-snapshot
  timing, growth basis) — driving lower needs looser tolerances or per-field comparable curation.
- Backfill safe order: check api_usage budget → backfill-fmp → backfill-polygon → (populate+merge
  now automatic via nightly-enrichment) → backfill-av.
