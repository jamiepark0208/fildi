# Data Agent Skill
> Load for ANY task involving data fetching, null cleanup, DB persistence, or source wiring.
> Read caching-patterns.md and data-architecture.md alongside this skill.

---

## GOAL
Own the stock DB. Maintain timely, accurate, complete data for all tickers
in watchlist + peer universe (~180 tickers). Minimize API cost and tokens.
Three measures of data quality: timeliness, accuracy, completeness.

---

## MINDSET

- **Plan first.** Identify what's needed, find the optimal path, then execute.
- **Free first, paid last.** Exhaust free sources before FactSet.
- **Static is static.** sector, exchange, companyName → fetch once, persist permanently. Never re-query.
- **Own the data.** Every fetch result (success OR failure) gets persisted or mapped.
- **Suspect means cross-check, not discard.** Extreme values might be real (startup/meme/penny/pre-revenue).
  Research briefly — check peer group scoring_mode before overriding anything.
- **Record everything.** What worked, what failed, for which ticker+field.
  Future fetches consult this map first — never re-test a known-bad source/ticker combo.

---

## EXISTING PATTERNS — FOLLOW THESE

**In-memory cache (serve-time):** TTLCache from lib/ttl-cache.ts
- Every Yahoo call must use TTLCache — see caching-patterns.md
- TTLs: search=24h, fundamentals=2h, price=1h, options=30min, intraday=15min
- Register every new cache in cache-registry.ts

**DB persistence (long-term):** ticker_fundamentals, ticker_technicals
- Fundamentals: written by writeFundamentalsRow() in fundamentals-db.ts
- Technicals: written by technical refresh job
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

Stop at first successful result per field. Check source_ticker_map before each attempt.

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

4. Alpha Vantage   — NOT YET WIRED, ALPHA_VANTAGE_API_KEY, 25/day free
                     OVERVIEW endpoint fills FMP gaps well
                     NEWS_SENTIMENT endpoint for sentiment scoring
                     low daily limit — reserve for tickers where 1-3 all fail

5. Polygon         — NOT YET WIRED, POLYGON_API_KEY, unlimited free (delayed)
                     broad coverage, best fallback for FMP misses
                     financials endpoint: /vX/reference/financials?ticker=X

6. FactSet         — stock-data-manager.ts (primary), internal, limited quota
                     most reliable — use only after free sources exhausted

7. EDGAR/SEC       — NOT YET WIRED, no key, generous rate limit
                     authoritative for any public company
                     gap: requires CIK lookup first, complex JSON structure
                     use only when all others fail for critical fields

8. FRED            — macro-data.ts, FRED_API_KEY
                     macro only (SOFR, Fed Funds, CPI, GDP, yield curve)
                     not per-ticker
```

---

## SOURCE-TICKER MAPPING

Table: `source_ticker_map`
```sql
ticker TEXT, source TEXT, field TEXT,
works BOOLEAN, last_tested TIMESTAMP, notes TEXT
PRIMARY KEY (ticker, source, field)
```
- Check before every fetch. Skip known-bad combos instantly.
- Upsert after every attempt (works=true/false).
- Use field='all' when entire source fails for a ticker.
- This is institutional memory — gets smarter over time, reduces future API calls.

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
3. For each null: check source_ticker_map → run waterfall → persist result
4. Validate suspect values (see below)
5. Recompute fund_score after all fields attempted
6. Write session log
```

---

## TROUBLESHOOTING WORKFLOW

When a source returns null/empty for a ticker:
```
1. Check source_ticker_map — if works=false already recorded → skip immediately
2. Try next source in waterfall — test ONE ticker first, not full batch
3. If data returned → validate:
   - Order of magnitude reasonable vs peer group?
   - Does another source agree?
   - Is ticker in speculative_pre_revenue mode? → extreme values expected
4. If two sources agree on extreme → real value, keep, add to suspectMetrics flag
   If sources disagree → prefer non-outlier, update source_ticker_map
5. All sources fail → log as unfillable, move on
   Scoring layer handles missing fields gracefully via coverage fallback
6. After confirming source works for ticker → expand to batch
```

---

## SUSPECT VALUE RULES

```
Flag when: |netMargin|>100%, |revenueGrowth|>1000%, |epsGrowth|>1000%,
           pe_ratio<0, any metric >10x peer group median

Response:
  Cross-check one other source
  Sources agree → keep value, add suspectMetrics display flag
  Sources disagree → use non-outlier, update source_ticker_map
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
3. Wire into stock-data-manager.ts waterfall after existing sources
4. Map fields to ticker_fundamentals columns (see mappings above)
5. Test with ONE ticker (use NVDA) before any batch
6. Update source_ticker_map with test result
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
[ ] Alpha Vantage: not wired in stock-data-manager.ts
[ ] Polygon: not wired in stock-data-manager.ts
[ ] source_ticker_map: table not yet created
[ ] freeCashFlow: Yahoo serve-time only, not persisted to DB
[ ] writeFundamentalsRow: missing forwardPe, evEbitda, evRevenue, revenueGrowthYoyPrior
[ ] Yahoo fundamentals: fetched at serve-time in buildMetrics, not persisted to DB
```