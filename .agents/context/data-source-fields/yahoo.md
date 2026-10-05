# Yahoo Finance — free fields

Client: `artifacts/api-server/src/lib/yahoo-client.ts`  
Modules: quoteSummary (financialData, defaultKeyStatistics), fundamentalsTimeSeries annual/quarterly.

## Mapped → `yahoo_fundamentals`

Margins, ROE/ROA, revenue growth, D/E, current ratio, revenue/debt/cash/FCF/EBITDA,
trailing/forward PE, PEG, P/B, EV multiples, EPS, beta, shares, dividend yield,
annual income/BS/CF line items (gross profit, OCF, FCF, equity, debt),
computed: epsGrowth, ROIC, approx WACC, effective tax rate, interest expense, quarterly OCF.

## Not mapped / not available cleanly

| Want | Status |
|---|---|
| totalAssets | **No** yahoo column — use FMP/derive |
| D&A (for FFO) | Not stored; may exist in time-series cashflow — not wired |
| CET1 / FFO / combined ratio | Not in quoteSummary modules we pull |
| Tangible book | Not in current mapping |

## Role in merge

Highest priority for many gold fields (margins, growth, OCF, gross profit). Soft-fail OK.

## Options chains (live quotes)

Yahoo `options()` via `yahoo-finance2` is the **only free live chain source** we use in production.

| Reality | Detail |
|---|---|
| Bids go to 0 after hours | We fall back to `lastPrice`, set `bidIsLive=false` / `quoteStale=true`, soft-haircut score |
| Quotes can be stale/wrong mid-session | Prefer live bid when `bid>0`; flag stale; don’t treat lastPrice as firm fill |
| Free alternatives for *live* single-name OPRA | Finnhub free options unreliable; Polygon/FMP free tiers are fundamentals-heavy; MarketData.app free = 100 req/day (too thin for ~100 candidates) |
| Free for *hist* calibration (not live) | DoltHub `post-no-preference/options`, ETF hist repos, CBOE VIX CSV |

**Decision:** keep Yahoo for live Overall/Watchlist scoring; harden freshness flags; grow W/L via `model_recs` + `option_score_snapshots`. Paid OPRA only if tilt plateaus.

