# Data Agent Skill
> Load for ANY task involving data fetching, null cleanup, DB persistence, or source wiring.
> Read caching-patterns.md and data-architecture.md alongside this skill.

---

## GOAL
Own the stock DB. Maintain timely, accurate, complete data for all tickers
in watchlist + peer universe (257 canonical tickers). Minimize API cost and tokens.
Three measures of data quality: timeliness, accuracy, completeness.

---

## MINDSET

- **Plan first.** Identify what's needed, find the optimal path, then execute.
- **Free first, paid last.** Exhaust free sources before FactSet/SDM.
- **Static is static.** sector, exchange, companyName → fetch once, persist permanently. Never re-query.
- **Own the data.** Every fetch result (success OR failure) gets persisted or mapped.
- **Suspect means cross-check, not discard.** Extreme values might be real (startup/meme/penny/pre-revenue).
  Research briefly — check peer group scoring_mode before overriding anything.
- **Record everything.** What worked, what failed, for which ticker+field, in the session log
  (see LOGGING below) — there's no persisted per-field pass/fail table today, so the log is
  the only record; check it before re-testing a combo you may have already ruled out this session.

---

## EXISTING PATTERNS — FOLLOW THESE

**In-memory cache (serve-time):** TTLCache from lib/ttl-cache.ts
- Every Yahoo call must use TTLCache — see caching-patterns.md
- TTLs: search=24h, fundamentals=2h, price=1h, options=30min, intraday=15min
- Register every new cache in cache-registry.ts

**DB persistence (long-term):** ticker_fundamentals, ticker_technicals
- Fundamentals: written by writeFundamentalsRow() in fundamentals-db.ts
- Technicals: written by computeTechnicalRankingsV2() in lib/technical-rankings.ts (the "V2"
  scorer — see technical-scorecard.md). Separate from indicator_cache's simpler RSI/MFI signal,
  which lib/seeder.ts populates at boot — both are live, not sequential versions of each other.
- Upsert pattern: ON CONFLICT DO UPDATE — never DELETE+INSERT
- Max 3 concurrent fetches — never batch all tickers simultaneously
- FMP budget: checkFMPBudget() before any FMP batch — 250 calls/day free tier

**Data tiers (from data-architecture.md):**
```
Tier A — DB persistent: fundamentals, technicals, historical OHLCV
Tier B — TTLCache only: current price, marketCap (serve-time, never persisted)
Tier C — TTLCache short-lived: options chain (30min), expiry calendar (24h)
```

---

## DATA SOURCES + WATERFALL

Stop at first successful result per field. Check source_ticker_map for a known symbol alias
before each attempt (it does NOT track per-field pass/fail — see SOURCE-TICKER MAPPING below).

```
1. Yahoo Finance   — yahoo-finance2, no key, ~2000/hr
                     broadest coverage, already wired
                     ALL Yahoo calls must use TTLCache (caching-patterns.md)
                     gap: some fields inconsistent, not all metrics available

2. FMP             — fmp-client.ts, FMP_API_KEY, 250/day free
                     deep ratios + key-metrics when available
                     gap: free tier returns empty for most non-large-cap → move on fast

3. Finnhub         — peer-resolver.ts (partial), FINNHUB_API_KEY, 60/min free
                     good for profile, basic financials, recommendations


4. Polygon         — POLYGON_API_KEY, 5/min, no daily cap, 
                     EOD fine for fundamentals ← better than AlphaVantage
                     broad coverage, best fallback for FMP misses
                     financials endpoint: /vX/reference/financials?ticker=X

5. Alpha Vantage   — ALPHA_VANTAGE_API_KEY, 25/day free. very limited.
                     OVERVIEW endpoint fills FMP gaps well
                     NEWS_SENTIMENT endpoint for sentiment scoring
                     low daily limit — reserve for tickers where 1-3 all fail

6. EDGAR/SEC       — wired into merge-trusted.ts FIELD_DEFS as **last resort in every chain**
                     (annual 10-K data lags TTM/MRQ sources; only wins when all else is null),
                     no key, generous rate limit. Authoritative but stale + extraction can be
                     unreliable per-field (e.g. totalDebt often captures LT-debt only).
                     Excluded from the divergence check for TTM/flow fields (period mismatch).
                     gap: requires CIK lookup first (tickerCik table), complex JSON structure

7. FRED            — macro-data.ts, FRED_API_KEY
                     macro only (SOFR, Fed Funds, CPI, GDP, yield curve)
                     not per-ticker

8. FactSet/SDM     — stock-data-manager.ts, OCI proxy at 146.235.223.94:3001
                     Revenue, EBITDA, margins, ROE, ROA, FCF — use after free sources exhausted
                     Force refresh: POST /api/sdm/refresh/:ticker?admin=true

 
```

---

## SOURCE-TICKER MAPPING

Table: `source_ticker_map` — actual columns (this section previously described an aspirational
per-field works/last_tested design that was never built; don't reintroduce it without checking
KNOWN GAPS first):
```sql
ticker TEXT, source TEXT, source_ticker TEXT,
active BOOLEAN, notes TEXT, created_at TIMESTAMPTZ
PRIMARY KEY (ticker, source)
```
- Purely a ticker-symbol alias map per source today (e.g. internal `BRK.B` ↔ Polygon's
  `BRK-B`) — not a per-field known-good/known-bad cache. Check `lib/stock-data-manager.ts`
  before assuming any richer tracking exists.

---

## FIELD TTL CATEGORIES

```
STATIC — fetch once, never re-fetch:
  sector, industry, exchange, companyName, description, country

QUARTERLY (95 days):
  grossMargin, netMargin, operatingMargin, ebitda, ebit,
  totalRevenue, netIncome, freeCashFlow, totalDebt,
  cashAndEquivalents, returnOnEquity, roic, wacc,
  revenueGrowthYoY, revenueGrowthYoyPrior, epsGrowth,
  currentRatio, debtToEquity, forwardPe, evEbitda,
  evRevenue, pbRatio, dividendYield, sharesOutstanding,
  interestExpense, effectiveTaxRate

WEEKLY (7 days):
  peRatio, pegRatio, priceToSalesRatio, analystTargetPrice, beta

DAILY (23 hours):
  technicals: rsi, macd, bollinger, volume, moving averages
  ivRank, ivPercentile, putCallRatio

REAL-TIME — Tier B, never persist:
  currentPrice, marketCap, bid, ask → Yahoo TTLCache only
```

---

## NULL CLEANUP WORKFLOW

```
1. SELECT all scoring fields from ticker_fundamentals — identify nulls
2. Prioritize:
   CRITICAL: grossMargin, netMargin, operatingMargin, totalRevenue,
             netIncome, freeCashFlow, ebitda, ebit, totalDebt,
             cashAndEquivalents, returnOnEquity, revenueGrowthYoY
   IMPORTANT: forwardPe, evEbitda, evRevenue, pbRatio, dividendYield,
              wacc, revenueGrowthYoyPrior, epsGrowth
3. For each null: run waterfall (source_ticker_map has no per-field history to check) → persist result
4. Validate suspect values (see below)
5. Recompute fund_score after all fields attempted
6. Write session log
```

---

## TROUBLESHOOTING WORKFLOW

When a source returns null/empty for a ticker:
```
1. Try next source in waterfall — test ONE ticker first, not full batch
2. If data returned → validate:
   - Order of magnitude reasonable vs peer group?
   - Does another source agree?
   - Is ticker in speculative_pre_revenue mode? → extreme values expected
3. If two sources agree on extreme → real value, keep, add to suspectMetrics flag
   If sources disagree → prefer non-outlier, note it in the session log (LOGGING below)
4. All sources fail → log as unfillable, move on
   Scoring layer handles missing fields gracefully via coverage fallback
5. After confirming source works for ticker → expand to batch
```
Per-field pass/fail history isn't persisted anywhere today — source_ticker_map is symbol-alias
only. Use the data-agent log file as the record of what worked per session (see LOGGING below).

---

## SUSPECT VALUE RULES

```
Flag when: |netMargin|>100%, |revenueGrowth|>1000%, |epsGrowth|>1000%,
           pe_ratio<0, any metric >10x peer group median

Response:
  Cross-check one other source
  Sources agree → keep value, add suspectMetrics display flag
  Sources disagree → use non-outlier, note it in the session log
  speculative_pre_revenue scoring_mode → extreme expected, keep + flag
  Winsorization handles outliers at score time — flag don't override
```

---

## BATCH RULES

```
Max 5 tickers per batch (existing pattern: max 3 concurrent Yahoo calls)
Check checkFMPBudget() before each FMP batch
FMP exhausted → Yahoo + Polygon + Finnhub only, continue
Alpha Vantage 25/day → reserve for tickers where Yahoo+FMP+Finnhub all fail
Never re-fetch fresh data — respect TTL categories above
Complete current batch before stopping
```

---

## NEW SOURCE FIELD MAPPINGS

**Alpha Vantage OVERVIEW → ticker_fundamentals:**
```
EBITDA→ebitda  ForwardPE→forwardPe  PERatio→peRatio
PEGRatio→pegRatio  PriceToBookRatio→pbRatio
ProfitMargin→netMargin  OperatingMarginTTM→operatingMargin
ReturnOnEquityTTM→returnOnEquity  RevenueTTM→totalRevenue
DividendYield→dividendYield  Beta→beta
AnalystTargetPrice→analystTargetPrice
```

**Polygon /vX/reference/financials → ticker_fundamentals:**
```
income_statement.revenues→totalRevenue
income_statement.gross_profit→compute grossMargin=gross/revenue
income_statement.net_income_loss→netIncome
income_statement.operating_income_loss→compute operatingMargin
income_statement.interest_expense→interestExpense
balance_sheet.liabilities→totalDebt
balance_sheet.equity→totalStockholdersEquity
cash_flow_statement.net_cash_flow_from_operating_activities→quarterlyOperatingCashFlow
```

---

## ADDING NEW SOURCES

```
1. Create artifacts/api-server/src/lib/{source}-client.ts (follow fmp-client.ts pattern)
2. Add TTLCache instance if source is called at serve-time (caching-patterns.md)
3. Add staging table (Bronze layer) + migration. Wire into populate-source-fundamentals.ts and merge-trusted.ts FIELD_DEFS
4. Map fields to ticker_fundamentals columns (see mappings above)
5. Test with ONE ticker (use NVDA) before any batch
6. If the new source needs a ticker-symbol alias, add it to source_ticker_map
7. Update KNOWN GAPS below
```

---

## LOGGING

Append to `artifacts/logs/data-agent-{YYYY-MM-DD}.log`:
```
[ts] BATCH tickers | filled:N | null:N | sources:yahoo(N) fmp(N) av(N) polygon(N) | fmp_remaining:N
[ts] SESSION COMPLETE | tickers:N | filled:N | still_null:N | fmp_used:N
     top_null_fields:[f1,f2,f3] | unfillable:[t1,t2]
```
No UI needed. Logs for admin review only.

---

## KNOWN GAPS (update as resolved)

```
[x] Alpha Vantage: backfill-av.ts built (25/day quota, resumable cursor). Wired into merge-trusted.ts
    FIELD_DEFS as lowest-priority fallback (grossMargin, operatingMargin, totalDebt, etc.) — 2026-07-14.
[x] Polygon: backfill-polygon.ts built. Wired into merge-trusted.ts FIELD_DEFS, same as above — 2026-07-14.
[x] EDGAR: backfill-edgar.ts + edgar-client.ts + tickerCik built and wired into FIELD_DEFS
    (balance sheet / income statement fallback) — 2026-07-14.
[x] source_ticker_map: table exists; ticker+source PK, source_ticker=source-specific alias
    (e.g. renamed tickers). Symbol-alias only — no per-field pass/fail tracking exists despite
    earlier drafts of this doc describing one; don't reintroduce without a real migration.
[x] freeCashFlow: now persisted to DB via writeFundamentalsRow
[x] writeFundamentalsRow: forwardPe, evEbitda, evRevenue, revenueGrowthYoyPrior, freeCashFlow all present
[x] nightly-enrichment: populate+merge run IN-PROCESS now (not npx tsx subprocesses — those
    failed silently in prod, stranding ~61 flagged blue-chips with fetched-but-unmerged data for
    a month). Coverage recovered 77.6%→92.8% once run correctly — 2026-07-23.
[x] EDGAR demoted to last-resort in every FIELD_DEFS chain (was winning totalStockholdersEquity /
    interestExpense over timelier sources) — 2026-07-23.
[x] Definitional alignment (2026-07-23): cashAndEquivalents = yahoo totalCash only (cash+STI);
    totalDebt = yahoo→fmp only (dropped Polygon/EDGAR garbage); revenueGrowthYoY/epsGrowth on
    annual-YoY basis. "Needs Review" divergence redefined winner-vs-fallback/period-aware/material
    → 2208 down to ~1017. See fundamentals-field-definitions memory + db-patterns.md.
[x] Removed SKHYV (pre-IPO, replaced by SKHY) and ADYEN (foreign, no US-source coverage) from
    ticker_registry + all fundamentals tables — 2026-07-23.
[ ] Yahoo fundamentals: fetched at serve-time in buildMetrics, not persisted to DB
[ ] PENDING DEPLOY: all 2026-07-23 merge-trusted/nightly-enrichment changes are in source + the
    live DB (ran manually) but NOT in the running server's compiled code — needs rebuild+restart
    or the next scheduled merge recomputes with old logic.
```

**Scripts that exist but aren't part of the core bronze→silver→gold flow above** (QA/one-off,
not scheduled): `audit-coverage.ts`, `validate-sources.ts` (cross-source QA checks),
`refetch-renamed-tickers.ts`, `snapshot-to-staging.ts`, `test-av-polygon.ts`. Portfolio-ingest-
adjacent, not fundamentals pipeline: `backfill-analyst-events.ts`,
`backfill-dividends-assignments-cashbonus.ts`, `backfill-ytd-orders.ts` (see db-patterns.md's
Portfolio ingest table group).