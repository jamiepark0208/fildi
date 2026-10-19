# Endpoint entitlements — what our keys can actually call (probed 2026-10-14, Claude)

> **Read this before planning any new data feature.** Every row was called live with our keys (not taken from docs), unless marked *docs*.
> Re-probe one endpoint before building on it if the date here is > 60 days old. Plan context: `research/common/asks/A75.md` (v2).
> ✅ = works on our plan · ❌ = not entitled / premium · ⚠ = works with a caveat · **used** = Fildi calls it today.

## Schwab Market Data (OAuth, 7-day refresh; ~120 req/min)
✅ **used** `/quotes`, `/chains`, `/pricehistory` · ✅ `/markets` (hours + holidays) · ✅ `/expirationchain` · ✅ `/movers/{index}` · ✅ `/instruments?projection=fundamental` (52w, PE, div) · ✅ 5-min intraday `pricehistory`.
Trader API `/accounts`: works, but the Schwab account is empty (data-only; positions live at Robinhood).

## Robinhood Trading MCP (*docs* + support article; not yet connected)
Official, free, `https://agent.robinhood.com/mcp/trading`, OAuth through an MCP client. **Reads all RH accounts**; trades only in a separate Agentic account.
Tools: positions/orders/tax lots/realized P&L, `review_option_order` (pre-trade warnings), option chains/quotes/historicals, alerts (`create_alert` → RH app), scanner, analyst ratings, politician trades, SEC filings, earnings.
Positions/history overlap the existing RH CSV export (user already has it), so the new value is only `review_option_order` and RH-app alerts. Token lifetime is undocumented.

## Polygon / Massive (free Basic: 5 calls/min, end-of-day, ~2 y history)
✅ `/v2/aggs/ticker/{T}/range|prev` · ✅ `/v2/aggs/grouped/.../{date}` (whole market, 1 call) — **stocks only**: `/v2/aggs/grouped/locale/us/market/options/{date}` → 403/404 (probed 10-19) · ✅ `/v3/reference/tickers/{T}` · ✅ `/v2/reference/news` · ✅ dividends, splits · ✅ `/v1/marketstatus/now|upcoming` · ✅ `/v3/reference/options/contracts` · ✅ **option contract daily bars** `/v2/aggs/ticker/O:{OCC}/range` (end-of-day only) · ✅ `/v1/open-close` · ✅ `/v1/indicators/rsi` · ✅ **used** `stocks/v1/short-interest` (1 call = full history since 2020; `lib/short-interest.ts` → Breakdown › Short interest), ✅ `stocks/v1/short-volume`.
❌ `/v3/snapshot/options/*` (live chain) · ❌ `/v2/snapshot/...tickers` · ❌ `/v3/trades`. ⚠ **`/vX/reference/financials` is GONE** (deprecated; `lib/polygon-client.ts` still calls it).

## FMP (free) — ⚠ **symbol-restricted**
Per-symbol endpoints (`quote`, `key-metrics`, `price-target-consensus`, `grades-consensus`, `analyst-estimates`, `shares-float`, `historical-price-eod`) work for mega caps (AAPL, NVDA) but return "Premium Query Parameter" for small/mid caps (ONDS, RKLB). The fundamentals waterfall wastes calls on those.
✅ market-wide: `earnings-calendar`, `insider-trading/latest`, `senate-latest`, `house-latest`, `sector-performance-snapshot`, `biggest-losers`, `treasury-rates`, `economic-indicators`, `dividends-calendar`, `sec-filings-search/symbol`.
❌ `economic-calendar`, `news/*`, `insider-trading/statistics`, `institutional-ownership/*`, `historical-chart/*`, `technical-indicators/*`, `earning-call-transcript`, `batch-quote`, `eod-bulk`, `esg-disclosures`. Empty: `short-interest`, `fail-to-deliver`, `market-hours`, `stock-screener`.

## Finnhub (free, 60/min)
✅ **used** `calendar/earnings`, `stock/earnings` (fiscal `year`/`quarter` = AV transcript label), `stock/metric`, `stock/peers` · ✅ `quote`, `company-news`, `stock/recommendation`, `stock/insider-transactions`, `stock/insider-sentiment`, `stock/market-status`, `stock/market-holiday`, `stock/lobbying`, `stock/usa-spending`, `stock/profile2`, `stock/financials-reported`, `news`.
❌ `news-sentiment`, `stock/price-target`, `stock/upgrade-downgrade`, `stock/ownership`, `stock/social-sentiment`, `scan/*`, `calendar/economic`, `stock/short-interest`, `stock/option-chain`, `stock/eps-estimate`, `stock/revenue-estimate`, `stock/candle`, `stock/supply-chain`, `stock/esg`, `stock/earnings-quality-score`, `stock/filings-sentiment`, `stock/congressional-trading`.

## Alpha Vantage (free, 25 calls/day; counted in `api_usage` source `av`)
✅ **used** `EARNINGS_CALL_TRANSCRIPT` (fiscal `YYYYQn`; per-segment sentiment; `scripts/watchlist_sync/transcripts.py`, ≤ 20/day) · ✅ `OVERVIEW` · ✅ `EARNINGS_CALENDAR` (CSV with `timeOfTheDay`) · ✅ `ANALYTICS_FIXED_WINDOW` · ✅ `TOP_GAINERS_LOSERS` · ✅ `INSIDER_TRANSACTIONS` (empty for small caps).
❌ `NEWS_SENTIMENT`, `REALTIME_OPTIONS`, `HISTORICAL_OPTIONS`.
✅ Fixed A84: nightly enrich reads `ALPHA_VANTAGE_API_KEY` (legacy `AV_API_KEY` alias) and caps OVERVIEW at 5/day so transcripts.py can use ≤20.

## SEC EDGAR (keyless; User-Agent required, ≤ 10 req/s)
✅ **used** `companyfacts`, `submissions`, `company_tickers.json` · ✅ full-text `efts.sec.gov/LATEST/search-index` (⚠ ticker text matching is noisy, so use `submissions` by CIK and filter forms S-3 / 424B* for offerings).

## LSEG options history (probed 10-19, Workspace desktop session)
✅ **Daily history for any US equity option, live or expired**: `ld.get_history(OPRA RIC)` → BID, ASK, MID_PRICE, TRDPRC_1, OPINT_1, IMP_VOLT (+ greeks on live contracts). Expired RIC = live RIC + `^` + A–L month + YY (e.g. `SPYU182665000.U^I26`: full life 2025-06-17 → 2026-09-18). Contracts a few days past expiry may not be renamed yet. Limits: 10k req/day, ≤ 4 req/s (`_session.py`). Helper + cache: `research/lseg/option_prices.py` → `optlab.lseg_opt_daily`. **Use this, not Polygon, for daily option backtests**: it has mids and OI, with no 5/min cap.

## WRDS (Postgres `wrds-pgdata.wharton.upenn.edu:9737`)
✅ crsp (⚠ `dsf` ends 2024-12-31), ibes, comp, ciq, taqm_2026, fisd, compsamp, tfn, audit, wrdsapps.
❌ **OptionMetrics** (`optionm` → `optionm_all` permission denied).

## LSEG (offline Workspace sync, Mac-only) — in DB
`lseg_research.signals_daily` (daily, since 2026-10-04): StarMine ranks, EPS/PT consensus, **short_interest, short_pct (% float), free_float**, implied vol, credit. Short % shows in Live › Portfolio Alerts › Your names.

## Not offered by any of our sources
Dark-pool prints, borrow rates / stock-loan fees, true unusual-options-activity feeds (derive from volume vs OI), real-time news sentiment.
