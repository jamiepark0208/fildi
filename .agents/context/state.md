# TradeDash — Current State

> Update this file at the end of each session (or run `.claude/scripts/session-wrap.js`).

## Phase
**build** — last updated 2026-10-06

## Active work
- Working: api-llm-optimization-pass, blended-fair-value-fv-1.0.0, fund-1.1.0-ibesFwdGrowth, fair-value-maintain-health-checks, value-trap-flag, cyclical-confidence-cap, model-list-strike-vs-fair
- In progress: fair-value-snapshot-history-accruing
- Blocked: none

## Next tasks (priority order)

1. **Model List live grades** — first expiries 2026-10-09..12: grade vs win-rate table, then A24 (RH trade tiers → learn.py).
2. **fair value re-test** — after ~6 months of `fair_value_snapshots` (see memory fair-value).

Done 2026-10-06 — fund-1.1.1 champion in scorecard_params (user YES; 1.1.0 retired with its real optionalMetrics). Hooks: Read guard only; rehydrate dropped (2 s/prompt, stale). Verified: tsc 0 errors both apps, api 235/235 + web 334/334 tests, vite build OK, validate-workflow 9/10):
- Backlog already closed: options-income chart, finnhub coverage, backfills, crash handlers.
- Nightly log filename dated per write. Vitest-only tests → node:test. `npm test` fixed for Node 26 (api: `tsx --test`; web: dropped `--experimental-transform-types`).
- orval codegen fixed: js-yaml override `>=4.3.0` resolved to 5.x (no default export) → `^4.3.0`. Output identical to committed.
- Macro card threshold tests: `macro/macro-implications.test.ts` (14) + `macro-policy-signals.test.ts` (8; logic moved to `macro-policy-signals.ts`). Found + fixed: event today read as "tomorrow".
- Stock DB redesign was already done; fixed stale legend swatch.
- All 39 pre-existing tsc errors fixed (incl. real bugs: Finnhub dividendYield provenance note overwritten by duplicate key; scheduled-tasks duplicate research-ops import; stale option-scoring dist).
- Line ratchet: every file back under its ceiling via splits (no behavior change) + dead-code removal (legacy fund scorer in fundamentals-db, unused imports). Ratchet count now matches wc -l.

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
- Residual ~1017 Needs Review is genuine vendor disagreement (lease inclusion, price-snapshot
  timing, growth basis) — driving lower needs looser tolerances or per-field comparable curation.
- Backfill safe order: check api_usage budget → backfill-fmp → backfill-polygon → (populate+merge
  now automatic via nightly-enrichment) → backfill-av.

## Watchlist recommendations (Claude, 2026-10-05)
Live: app Watchlist → **Model List** tab (champion `fit-1.4.1` from `watchlist_sync.model_params`; portfolio-sized ideas, Needs Review, Manage Open Positions).
Updated daily by the Robinhood export session (COLLECT_PROTOCOL Steps 13–14 → `scripts/watchlist_sync/daily.py`). Learning loop `learn.py` (bounded auto-promotion).
Health strip in the Model List header shows pipeline freshness. Next: first live grades 2026-10-09/12; Cursor A17–A21 (IBES coverage batches, AVB deactivation). Details: `scripts/watchlist_sync/NEXT_SESSION.md`.
