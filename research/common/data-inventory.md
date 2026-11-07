# Data-source inventory — what we pay for or set up, and what we don't use

**Date:** 2026-10-24 · **Ask:** A263 · **Read-only.** No scoring change.
**30-day `api_usage` (through 2026-10-23, plus 2026-10-24 before this audit):** lseg 27306, polygon 5885, finnhub 3424, factset 1182, fmp 1155, fred 648, yahoo 366, edgar 298, av 131, anthropic 80, nyfed 22, cnn 22, wrds 15. Schwab, Kalshi, Codiv: not in the table (all-time).
**This audit's probes, metered after:** fmp +2, finnhub +2, factset +3, polygon +6, edgar +1, wrds +1. AV and LSEG not probed (budgets below). Samples: `research/sources/a263/`. Docs: `research/sources/massive.com/`.

Prior field notes in `.agents/context/data-source-fields/` (2026-09-29 / 10-14) are partly stale: tangible book is now mapped, Polygon short interest is called, Polygon financials are not on the free plan.

**WRDS + LSEG** are already audited in A228 (entitlements, unused StarMine models, workstreams W1–W8). This file does not redo that plan. Added here: a 2026-10-24 library list, how many rows we actually stored, and fill rates on the LSEG fields we already pull. Extra StarMine models stay on A228 W4 and A262 S092 — not probed (LSEG 4689/10000 today).

## Summary

| Source | Plan we can prove | Used / available | Unused worth a test | Overlap |
|---|---|---|---|---|
| FactSet | Proxy overview, `data_sources` cap 500/day (80 before probes). Product SKU not in repo | 1 endpoint. JPM overview returns 26 labels; we store ~5 | **Tier 1, total capital, ROTCE, TBV, NII, deposits** — already in the response | TBV also in gold (123/588). Tier 1 has no other live source |
| London Strategic Edge | Free API (`LSE_KEY`). Verified `/v3/usage` 2026-11-06: 60/min, 12.5M rows/day, 2.5M/export (A357) | `scripts/lse_client.py`; OPRA option **trade** daily export → `lse_option_daily` | US stock 1m (A184 ORB), macro series, options flow | Traded options before our `option_chain_history` (from 2026-10-08). Not bid/ask |
| Polygon / Massive | Free stocks plan. Ratios + balance sheets **403** (Advanced / Financials add-on). 5 calls/min | Aggs, option bars, dividends, short interest, short volume | Form 4, 8-K categories, related tickers, 13-F (no ticker filter), short-history **coverage** | Short % and float already on LSEG. News overlaps Finnhub |
| Finnhub | `daily_limit` 9999. Free. Economic calendar **403** today | metric, earnings, calendar/earnings, peers, company-news | 109 of 133 `metric=all` keys on the call we already make | Most match Yahoo/FMP. 5y growth and price-vs-SPX do not |
| FMP | Cap 220/day. AAPL ratios + key-metrics 200 today. Small/mid still "Premium" as of 2026-10-14 (not re-probed) | 9 statement endpoints + grades/targets tape + peers + profile | P/FCF, interest coverage, income quality, SBC/revenue, FCF yield | Derivable from statements we store. Mega-cap only |
| Schwab | OAuth market data. Not in `api_usage`. ~120/min per 2026-10-14 probe | `/quotes`, `/chains`, `/pricehistory` | `/movers`, `/expirationchain`, `/instruments`, `/markets` | Movers = S097. Fundamentals overlap Yahoo |
| WRDS | Academic. **279 libraries** this login (`research/sources/a263/wrds-libraries.txt`) | IBES synced. CRSP 16 permnos through 2024-12-31. finratio 14 rows | `tr_13f`, `tr_insiders`, `comp_bank_daily`, `comp_na_daily_all` | Research only — cannot ship into live scores. Full OptionMetrics **absent** |
| LSEG | Workspace desktop. Code cap 10k/day. Today 4689 before this audit. SKU not in repo | signals, StarMine history, prices, holders, events, option mids | Extra StarMine models — **not probed** (S092) | Short %, float, holders already cover Polygon's current snapshot |
| Yahoo | Keyless, yahoo-finance2 | quote, chart, options, quoteSummary modules listed below | `insiderHolders`, `institutionOwnership`, `earningsTrend` modules not called | Insider % and float **are** stored. IBES covers estimates |
| EDGAR | Keyless, User-Agent, ≤10/s | companyfacts, submissions, ticker map | Full-text search (`efts.sec.gov`) has **0 code refs**. AAPL companyfacts has 503 `us-gaap` tags; we read ~24 | Line items overlap FMP/Yahoo. D&A is the FFO input |
| Alpha Vantage | Cap 25/day. Today 20 before this audit — **no probe** | OVERVIEW (14 names stored), earnings-call transcript | EARNINGS_CALENDAR, TOP_GAINERS, INSIDER, ANALYTICS (entitled 2026-10-14, not in code) | 25/day is already the transcript budget |
| FRED | Keyless CSV | CPI, payrolls, GDP, SOFR, HY/IG OAS, NFCI, Fed balance sheet, DGS10, DTB3 (studies) | No high-value series missing from macro or the study cache | — |
| Kalshi | Public, no key | FOMC, CPI YoY, BTC/NDQ 15m | Macro series catalog not listed (unfiltered `/events` returned novelty markets) | Display only |
| Caldara–Iacoviello GPR | Public xls, no key (added 10-28) | Daily GPR total / acts / threats / 30 d avg 1985 → → `geo_risk.py` → `watchlist_sync.macro_daily`; FRED WTI + Brent same table | Country-level GPR (monthly file) if a country theme needs it | — |
| Treasury Fiscal Data | Public, no key (added 10-28) | DTS deposits/withdrawals (TGA totals, debt cash issues/redemptions, interest, DoD), DTS TGA closing balance, MTS table 1 monthly receipts/outlays/deficit → `gov_flows.py` → `watchlist_sync.gov_flows_daily/monthly`; raw pages in vendor_raw | Auctions (`od/auctions_query`: bid-to-cover, tails), outlays by function (MTS table 9), debt to the penny — next if a theme needs them | TGA weekly also in FRED WTREGEN (Liquidity tab) |
| CNN | Keyless site JSON | fear-and-greed history + put/call | Other sub-indices unknown this run | Live fetch **418** ("You're a bot") |
| NY Fed | Keyless xlsx | GSCPI monthly | SOFR already via FRED | — |
| Anthropic | Key set. Model `claude-haiku-5-5` in transcripts only. Spend cap not in repo | Transcript summaries. 80 calls / 30d | No other caller | — |
| Codiv | `CODIV_API_KEY` set. A129: free hosted tier, 100M tokens (not re-probed) | **0 code references** | None until local OpenJev is the constraint | OpenJev runs locally (`com.fildi.openjev`) |
| Crawl4AI | Local | `scripts/fetch-page.sh` | — | Used for the Massive docs cited here |
| OpenJev local | Local model, LaunchAgent | Shortlist, headline labels, controls | Hosted Codiv key unused | — |
| tastytrade | OAuth personal grant (`read openid`), added 2026-10-24. No published cap | `/market-metrics` daily (586 app names → `vendor_raw` + `tasty_metrics_daily`; shown in Breakdown › Options history › IV rank), backtester on demand | historic earnings + dividends endpoints (verify our calendars), DXLink streaming quotes | IV percentile agrees with LSEG (Spearman 0.84, 130 names) and covers 137 names LSEG doesn't. Positions: none (portfolio is Robinhood) |
| S&P Global | Claude.ai connector + local plugin. **Not authenticated** (`mcp-needs-auth-cache.json`: `claude.ai S&P Global`, `plugin:sp-global:spglobal`). No key in `.env.local` | Nothing in repo code | Kensho / Capital IQ tearsheets | Would overlap FactSet + LSEG. Do not use until auth and a license check |

## Ranked — worth testing (do not run here)

1. **FactSet bank block on the overview we already fetch.** JPM 2026-10-24: Tier 1 **15.23**, total capital **16.6**, ROTCE **21.22**, TBV **$116.53**. Units: Tier 1 and total capital are `valueType=RATIO` but the numbers are **percent points** (15.2 means 15.2%, not 15×). The client only divides `PERCENTAGE` by 100, so a naive map of Tier 1 would store 15.2. ROTCE is `PERCENTAGE` (client would store 0.212). TBV is `scale=0` dollars/share. NII, deposits, loan-loss are `metric=FIN` `scale=6` (millions). Evidence: `research/sources/a263/factset-jpm-units.json`, labels in `factset-jpm-highlight-labels.json`. Code keeps Revenue, NI, EPS, EBITDA, EBIT, BVPS, margins, ROE/ROA, equity, FCF, cash, current ratio, D/E (`factset-client.ts`). Gold `tangible_book_value_per_share` is filled for 123/588 names from Finnhub/FMP, not from this. **Proposed study (not on A262, not run):** bank Tier 1 + ROTCE vs fund score and put pnl. Research-only Compustat `comp_bank_daily` can audit it; it cannot ship live.
2. **Polygon Form 4** — `GET /stocks/filings/vX/form-4`, all stocks plans, HTTP 200. Filter is `tickers=`, not `ticker=` (this probe's `ticker=AAPL` may have been ignored). Not referenced in code (`rg api.polygon.io`). Doc: `research/sources/massive.com/docs-rest-stocks-filings-form-4-md.md`. Overlap: Yahoo `heldPercentInsiders` (a snapshot, stored), WRDS `tr_insiders` (entitled, no sync script). Already S099.
3. **Polygon 8-K disclosures** — `GET /stocks/filings/8-K/vX/disclosures`, all plans, HTTP 200, `tickers=` filter, category fields. Not in code. Doc: `docs-rest-stocks-filings-8-k-disclosures-md.md`. Overlap: LSEG `events`. Feeds the news shortlist more than the put board. S099.
4. **Polygon short-interest coverage, not the endpoint.** `lib/short-interest.ts` already calls `stocks/v1/short-interest` and `short-volume`. Stored: 31 tickers, 4839 rows, 2017-12-29 → 2026-09-30; short volume 28 tickers, 2026-07-24 → 2026-10-23. LSEG `signals_daily` on 2026-10-22: short % on 257/271, free float on 271/271, history only since the signals table exists. The gap is backfilling the book, which S099 already names.
5. **Polygon related tickers** — `GET /v1/related-companies/{ticker}`, all plans, HTTP 200, AAPL returned 10 names including MSFT. Not in code. Doc: `docs-rest-stocks-tickers-related-tickers-md.md`. Overlap: Finnhub `/stock/peers` and FMP `stock-peers` are both called (`peer-resolver.ts`). Verification vs `peer_groups` (A261 / S099), not a new signal.
6. **Polygon 13-F** — `GET /stocks/filings/vX/13-F`, all plans, HTTP 200. **No ticker parameter** (filer CIK + filing date; match CUSIP / issuer name). A per-name pull is a scan, not one call. Doc: `docs-rest-stocks-filings-13-f-filings-md.md`. Overlap: LSEG `holders_top` 110 names; WRDS `tr_13f` entitled and not synced. S099 should budget for a filing scan.
7. **Schwab movers** — `/movers/{index}` marked working on 2026-10-14 (`.agents/context/data-source-fields/endpoint-entitlements.md`) and has **zero** code references (`rg expirationchain|movers/`). Same for `/expirationchain`, `/instruments?projection=fundamental`, `/markets`. Calls are not metered. S097 owns movers. Expiration chain is an ops saving, not a signal.
8. **Finnhub `metric=all` leftovers.** AAPL 2026-10-24: 133 keys, 109 unmapped (`finnhub-metric-aapl-keys.json`). We already map the TTM multiples, margins, ROE/ROA/ROIC, growth, D/E, TBV, 52w (`finnhub-client.ts`). Best of the rest: `forwardPE`, `pegTTM`, `epsGrowth5Y`, `revenueGrowth5Y`, `payoutRatioTTM`, `netInterestCoverageTTM`, `ptbvAnnual`, `priceRelativeToS&P50052Week`. Same HTTP call. Overlap is high for PE and ptbv (TBV is stored). 5y growth and relative return are the pieces we don't store. S093 is already testing recommendation / scan, not these keys.
9. **FMP ratio and key-metric leftovers.** AAPL 200: ratios 66 keys, key-metrics 47 (`fmp-*-aapl-keys.json`). We map the statement lines, margins, ROE, TBV, WACC, ROIC (`fmp-client.ts`). Unmapped and not just a restatement: `priceToFreeCashFlowRatio`, `interestCoverageRatio`, `incomeQuality`, `stockBasedCompensationToRevenue`, `freeCashFlowYield`, `cashConversionCycle`. 2026-10-14 probe: per-symbol endpoints 402 on small/mid caps. Not re-probed here (AAPL only). Low value until a mid-cap 402 check says the book can use them.
10. **WRDS sync depth (the libraries themselves are A228).** `tr_13f`, `tr_insiders`, `comp_bank_daily`, `comp_na_daily_all` are entitled and already on A228's workstreams. New measurement: CRSP sync is **16 permnos**, 8032 rows, 2023-01-03 → 2024-12-31; `finratio_snapshot` is **14 rows**; IBES is the one large pull (`ibes_statsum` 174079, `ibes_surpsum` 129589). Full `optionm` is still absent (only `optionmsamp_us` / `optionmsamp_europe`), same fact as A228. License: research only.

Not worth a test: Polygon float (all plans, AAPL free float 92.1% effective **2026-05-14** — lagged; LSEG float is full on the latest signals day; Yahoo `floatShares` is stored). Polygon `/stocks/financials/v1/ratios` and balance sheets: docs say Stocks Basic / Starter / Developer **not included**; live **403** "not entitled". Old `/vX/reference/financials` is hard-disabled in `polygon-client.ts`. `polygon_fundamentals` still has 427 stale rows. Polygon news (`/v2/reference/news`, all plans, sentiment field) overlaps Finnhub `company-news` plus OpenJev labels. Codiv hosted tokens: key set, zero callers, local OpenJev is the system of record.

## Per source

### FMP
Plan: `data_sources.daily_limit` 220. Key set. Stable base `financialmodelingprep.com/stable`. Called: `key-metrics`, `ratios`, income, balance, cash-flow (annual + quarter), `financial-growth`, `wacc`, `price-target-consensus`, `earnings`, `grades-latest-news`, `price-target-latest-news`, `stock-peers`, `profile` (`fmp-client.ts`, `fmp-analyst-feed.ts`, `peer-resolver.ts`, `openjev_controls.py`). Stored: `fmp_fundamentals` 271 rows; `source_fundamentals` source=fmp 1972 rows / 180 tickers; analyst events fmp-grade 142, fmp-target 101. Market-wide endpoints marked working 2026-10-14 and **absent from code**: insider latest, senate, house, sector snapshot, biggest-losers, treasury, economic indicators, dividends calendar, sec-filings search (entitlements file). Those overlap EDGAR, FRED, treasury.gov, and our scanner.
- 10-27 (A283): `analyst-estimates` (annual revenue/EBIT/EPS mean·high·low, analyst counts, FY−5…FY+5) → `watchlist_sync.consensus_annual` source fmp (`dcf/estimates.py`, not scheduled). Our plan: 13/55 watchlist names, rest "Premium" → LSEG is the DCF source; FMP = megacap cross-check (FY4–5).

### Finnhub
Plan: limit 9999, key set. Called: `/stock/metric?metric=all`, `/stock/earnings`, `/calendar/earnings`, `/stock/peers`, `/company-news` (`finnhub-client.ts`, `peer-resolver.ts`, `openjev_desk_headlines.py`, `transcripts.py`). `/stock/recommendation` is only in `analysis/s093_finnhub_verify.py` (in progress). `/calendar/economic` is called by `economic-calendar.ts` and returned **403** on 2026-10-24 (static calendar remains). `finnhub_fundamentals` 586 rows. Scan / price-target / ownership marked not entitled 2026-10-14; not re-probed (S093).

### Alpha Vantage
Plan: limit 25/day. Today 20 calls before this audit, so no sample. Code: `OVERVIEW` (`alpha-vantage-client.ts`) and `EARNINGS_CALL_TRANSCRIPT` (`transcripts.py`). `av_fundamentals` **14 rows**. `source_fundamentals` alpha_vantage 157 rows / 14 tickers. Other functions marked working 2026-10-14 and absent from code: `EARNINGS_CALENDAR`, `ANALYTICS_FIXED_WINDOW`, `TOP_GAINERS_LOSERS`, `INSIDER_TRANSACTIONS`. `NEWS_SENTIMENT` and options functions were not entitled then.

### Polygon / Massive
Plan: key set. Docs (fetched 2026-10-24): float, Form 4, 13-F, 8-K disclosures, related tickers, and news are **included in all stocks plans**. Ratios `GET /stocks/financials/v1/ratios` and balance sheets `GET /stocks/financials/v1/balance-sheets` are **not** on Basic, Starter, or Developer. Live: float, form-4, 13-F, 8-K, related-companies **200**; ratios **403**. Index: `research/sources/massive.com/docs-llms-txt.md`. Called in code: grouped aggs, daily aggs, option contracts + option aggs, dividends, short interest, short volume, health-check prev. `polygon_429` has 2 metered rows (2026-10-20). 5/min still binds.

### FactSet
Plan: client id, client secret, API key, and proxy all set. Cap 500/day. Only path in code: `{proxy}/factset/report/overview/v1/financial-highlights`. `source_fundamentals` source=factset 9855 rows / 485 tickers. Industry template changes the rows (JPM returned bank lines, not a generic income statement). No other FactSet product is documented in repo. Units: section above. Do not divide Tier 1 by 100.

### Schwab
Plan: OAuth client id + secret set. Market-data base `api.schwabapi.com/marketdata/v1`. Called: `/quotes` (stock and option), `/chains`, `/pricehistory` (daily and 1-minute) in `schwab-client.ts` and `schwab-option-quotes.ts`. Not called: `/markets`, `/expirationchain`, `/movers/{index}`, `/instruments`. Trader token refresh exists; no positions reader (2026-10-14 note: the Schwab account was empty). **Never written to `api_usage`.**

### LSEG
Plan: app key set. Workspace desktop, 10k requests/day, research refuses to start above 80% (`research/lseg/_session.py`). Today **4689** before this audit — no extra probe. Fields we pull are listed in `research/lseg/sync_signals.py` (price, rec, PT, ARM, combined alpha, value/price momentum, short interest, short %, free float, shares, credit, CDS, IV price/intrinsic, EPS/revenue consensus, SmartEstimate, predicted surprise). `signals_daily` latest day 2026-10-22: 271 names; free float 271, short % 257, price-to-intrinsic 186, credit rank 250, ARM 247, combined alpha 247, SmartEstimate 245. `starmine_history` 55636 rows. `holders_top` 110 names. Unused StarMine models (earnings quality, insider filings, smart holdings, short-interest model, M&A, MarketPsych) are S092's probe, not done here.
- 10-27 (A283): `sync_consensus.py` → `consensus_annual` source lseg: FY0 revenue/EBIT actual + FY1–FY3 RevenueMean/High/Low/NumIncEstimates, EBITMean/High/Low/NumIncEstimates (+ period ends). 934 names, 19 requests, ~28k datapoints; daily lseg stage. EBIT is street basis (pre-SBC).

### WRDS
Plan: username set. One `list_libraries()` on 2026-10-24: **279** libraries, saved at `research/sources/a263/wrds-libraries.txt`. Present and relevant: `crsp` (+ CCM, stock, indexes), `comp` / `comp_na_daily_all` / `comp_bank_daily` / `comp_segments_hist_daily` / `comp_execucomp`, `tr_ibes` + guidance, `tr_13f`, `tr_insiders`, `trace` (+ enhanced), `wrdsapps_finratio*`, `wrdsapps_evtstudy_*`, `boardex`, `ravenpack_trial`, `taqm_2015`–later years, `cboe`. **Not present:** `optionm` (full). Samples only: `optionmsamp_us`, `optionmsamp_europe`. Sync scripts: `sync_ibes.py`, `sync_crsp.py`, `sync_finratio.py`, `sync_gics.py`. TAQ stays off (playbook). Academic license — research tables only.

### FRED
No key. CSV `fredgraph.csv?id=`. Live series include CPIAUCSL, CPILFESL, PCEPILFE, UNRATE, PAYEMS, JTSJOL, A191RL1Q225SBEA, PPIACO, RSXFS, UMCSENT, DFF, GFDEBTN, NAPM, SOFR, IORB, WRMFNS, NFCI, WALCL, WTREGEN, RRPONTSYD, WRESBAL, BAMLH0A0HYM2, BAMLC0A0CM, DGS10 (`macro-data.ts`, `macro-charts.ts`, `fair-value-snapshots.ts`). Studies add DTB3, T10Y2Y, T10Y3M, BAA10Y. 648 calls / 30d. Nothing obvious left unused for the desk.

### SEC EDGAR
Keyless. Called: `data.sec.gov` companyfacts + submissions + `company_tickers.json` (`edgar-client.ts`). `edgar_fundamentals` 534 rows. AAPL companyfacts 2026-10-24: 503 `us-gaap` concepts (`edgar-aapl-concepts.json`). Statement tags we read are the standard income / balance / cash-flow set plus D&A (`STATEMENT_LINE_ITEM_TAGS`). `efts.sec.gov` full-text search: entitled in the 2026-10-14 note, **zero code references**.
**2026-10-30 earnings 8-Ks** (`scripts/watchlist_sync/earnings_packet.py`): item 2.02 8-K → all ex-99.x exhibits (raw HTML → `vendor_raw` edgar/8k_ex99_1) → parsed income statement + cash flow lines, deterministic EPS/FCF bridge, one-off sentences, Finnhub street EPS/revenue → `watchlist_sync.earnings_packets` → Breakdown › Notes (earnings_notes.py). Not mapped: segment tables (kept as compact text in the packet), guidance tables, non-GAAP reconciliations (kept as text).

### Yahoo
Keyless. Called: quote, chart, options, search, and quoteSummary modules `financialData`, `defaultKeyStatistics`, `summaryDetail`, `assetProfile`, `recommendationTrend`, `calendarEvents`, `upgradeDowngradeHistory` (`yahoo-client.ts`, `stocks.ts`, `yahoo-analyst-client.ts`). Stored fields include float, insider %, short ratio, margins, target, beta. `yahoo_fundamentals` 567 rows; analyst events source=yahoo 7164. Not called from product code: `insiderHolders`, `institutionOwnership`, `earningsTrend`, `earningsHistory` (last one only in `scripts/src/analyze-move-coverage.ts`).

### Kalshi
No key. `api.elections.kalshi.com/trade-api/v2`. Code asks for `KXFEDDECISION`, `KXCPIYOY`, and 15-minute BTC/NDQ (`kalshi-macro.ts`). Not in `api_usage`. One unfiltered open-events call returned novelty series (Mars, NFL, politics), not a macro catalog. No unused macro series is claimed from that sample.

### NY Fed
One file: GSCPI xlsx (`macro-charts.ts`). 22 calls / 30d, last 2026-10-21. SOFR/IORB come from FRED.

### CNN fear & greed
`production.dataviz.cnn.io/index/fearandgreed/graphdata`. Code reads `fear_and_greed_historical` and `put_call_options` (`macro-charts.ts`). 22 calls / 30d, last 2026-10-21. This run: **HTTP 418** "I'm a teapot. You're a bot." Other keys in the payload were not listed.

### Anthropic
Key set. Only caller: `transcripts.py` `POST /v1/messages`, model `claude-haiku-5-5`, summaries into `watchlist_sync.earnings_transcripts`. 80 calls / 30d, 18 on 2026-10-24 before probes. No monthly cap in repo.

### Codiv
`CODIV_API_KEY` set (length 49). `rg CODIV` hits only `asks/A129.md` and `asks/A263.md`. Not probed (would spend the hosted token grant). OpenJev local is what runs.

### tastytrade
Plan: OAuth app + personal grant (2026-10-24), client `scripts/watchlist_sync/tastytrade.py`. Market metrics = **snapshot only** (IV index, IV rank, IV percentile, liquidity value/rank/rating, IV per expiry); every daily payload is kept whole in `vendor_raw` (pruned at 400 d) and typed into `watchlist_sync.tasty_metrics_daily` (kept), so our own history starts 2026-10-24. Wired into: daily.py (model stage, before the option scan), data_freshness, api_usage + Settings › API Monitor, Agents activity source tags. **Used in scores (10-24):** IV percentile is the fallback in the IV-rank resolver (`iv_rank.py` → `iv_rank_daily`: LSEG → tastytrade) read by the Options score (options-1.2.1 ivRelative), Model List PREMIUM and `strategy_engine.py`. Liquidity rating: stored, not yet in a score (S096 step 1). Backtester: separate host, 147 symbols, 2013→ (`/available-dates`); AAPL 1w Monday puts 2023→ 0.09Δ kept 96.8 % / 0.15Δ 91.7 %. Daily check (`tastytrade.py universe`): exit 1 if coverage < 90 % or Spearman vs LSEG IV pctile < 0.6. Unused: earnings/dividend history, `/market-data/by-type` quotes, streaming.

### Crawl4AI
Local venv + `scripts/fetch-page.sh`. No vendor plan. This inventory's Massive pages were saved with `--save`.

### OpenJev local
LaunchAgent `com.fildi.openjev`. Used by the shortlist, desk headlines, and controls. Not a paid API. Hosted Codiv is the unused twin.

### S&P Global
No repo caller, no env key. Local Claude plugin `sp-global` is installed (Kensho skills: tearsheets, earnings previews). Auth cache says `claude.ai S&P Global` and `plugin:sp-global:spglobal` need auth. Treat as not usable. Capital IQ-class fields would duplicate FactSet and LSEG if a license is ever turned on.

## Corrections to the 2026-10-24 brief

- Polygon short interest and short volume are integrated (`lib/short-interest.ts` → Breakdown). The hole is coverage (31 names), not discovery.
- Polygon financials / ratios / balance sheets are **not** on this key (403 + docs). The old financials URL is already disabled.
- Tangible book is mapped from Finnhub and FMP into gold. The September field memos that say it is unmapped are stale.
- Finnhub economic calendar is wired and rejected (403).
- (10-24 eve) `ticker_technicals.iv_rank` / tech Volatility State uses a realized-vol proxy, not IV rank — Spearman 0.22 vs tastytrade real IV rank, half the names off > 30 pts. The "upgrade after ~60 d of atmPutIv" note in technical-scorecard.md never happened (snapshots since 09-29).
- 10-26 Polygon /v2/aggs day (adjusted) for 35 theme ETFs → vendor_raw (source polygon, endpoint aggs/day) + watchlist_sync.sector_etf_daily close (sector_etfs.py, A277). CRSP dsf for the same ETFs 2017–2024 (sync_crsp.py --force now does a full --days backfill).

- **optlab.bars_5m (10-26, Claude):** Polygon 5-minute aggs, 2 years, shared by s078 / intraday_1m_backfill / T1. Stores OHLCV only; Polygon's `vw` and `n` fields are dropped to fit the existing 7-column table (not used by any study).

## Fetch mode (A367 — scheduled jobs)

| Job | Source | Mode | Guard |
|---|---|---|---|
| `schwab-1m-poll.ts` (API 5m RTH) | Schwab 1m | tail (−2 bars) | yes · `fetch_runs` |
| `backfill-stale-prices.ts` (maintain 08:00 ET) | Schwab→Yahoo→LSEG | tail | yes |
| `session-bar-fill.ts` (maintain) | Polygon grouped | tail (missing session only) | yes (insert-only) |
| `research/lseg/sync_daily_history.py` | LSEG | tail | yes · `--backfill` for new names |
| `research/wrds/sync_ibes.py` | WRDS IBES | tail (`statpers` watermark) | yes |
| `research/wrds/sync_crsp.py` | WRDS CRSP | tail (`sync_state`) | yes |
| `analysis/lab_fund_features.py` (monthly) | local IBES | tail (new `lab_outcomes` dates) | yes · skip if IBES wm+code unchanged |
| `dcf/financials.py` companyfacts | EDGAR | change-signal (submissions filingDate) | yes · vendor_raw hash dedupe |
| `split_repair.py` (daily.py) | local prices | full scan | no — must detect splits universe-wide; touches split tickers only |
| `watchlist_sync/daily.py` option scan | Polygon/Schwab | tail / capped | partial — pre-existing caps |
| API `nightly-enrichment` | multi | tail per source | partial — uses enrichment_runs not fetch_runs yet |
