# Data Source Audit — Phase Report
_Generated: 2026-06-11 | Last updated: 2026-06-14_

---

## Phase 1A — DB Schema ✅ COMPLETE

**Date:** 2026-06-11

### New tables added to `lib/db/src/schema/index.ts`

| Table | PK | Notes |
|---|---|---|
| `data_sources` | serial id | name unique; priority, daily_limit, calls_today, last_reset_date, is_active |
| `ticker_registry` | ticker text | name, sector, industry_group, peer_tickers[], index_memberships[], is_active, added_at |
| `ticker_fundamentals_history` | (ticker, year) composite | pe_ratio, price_to_book, roic, margins, revenue, ebitda, eps, source, imported_at |
| `earnings_calendar` | (ticker, report_date) composite | is_confirmed, eps_estimate, eps_actual, surprise_pct, fetched_at |

### Extended: `ticker_fundamentals`
- Added `last_source text default 'fmp'`
- Added `data_quality_score numeric` (0–1, % non-null fields)

### Migration
- `npm run push` → `[✓] Changes applied` (no errors)

### TypeScript checks
- `stock-compare` tsc --noEmit → **clean (no output)**
- `lib/api-client-react` tsc --build → **clean (no output)**

## Phase 1C — SDM API Routes ✅ COMPLETE

**Date:** 2026-06-11

### File created
`artifacts/api-server/src/routes/sdm.ts` — mounted at `/sdm` in `routes/index.ts` (resolves to `/api/sdm/*`)

### Routes implemented

| Method | Path | Status |
|---|---|---|
| GET | `/api/sdm/status` | ✅ Returns sources + budgets + registry/history counts |
| GET | `/api/sdm/tickers` | ✅ Returns registry joined with fundamentals quality fields |
| POST | `/api/sdm/refresh/:ticker?admin=true` | ✅ Force-refreshes via StockDataManager |
| POST | `/api/sdm/import-csv` | ✅ Batch imports `HistoryCSVRow[]` |
| GET | `/api/sdm/history/:ticker` | ✅ Returns history rows sorted by year |
| GET | `/api/sdm/peers/:ticker` | ✅ Returns ticker + full peer registry rows |

### curl test results
```
GET /api/sdm/status  → {"sources":[],"tickerRegistryCount":0,"historyRowCount":0}
GET /api/sdm/tickers → []
GET /api/sdm/history/AAPL → []
GET /api/sdm/peers/AAPL → {"error":"ticker AAPL not found in registry"}
```
All correct — tables empty (no seed data yet), 404 for unknown ticker is expected.

### Build
`node build.mjs` → ⚡ Done in 161ms (no errors)

---

## Phase 1B — StockDataManager Service ✅ COMPLETE

**Date:** 2026-06-11

### File created
`artifacts/api-server/src/lib/stock-data-manager.ts`

### Class: `StockDataManager`

| Method | Status |
|---|---|
| `getFundamentals(ticker)` | Implemented — DB cache check + 5-source fallback chain |
| `getSourceBudgets()` | Implemented — reads `data_sources` table |
| `resetDailyCountersIfNeeded()` | Implemented — resets rows where `last_reset_date < today` |
| `importHistoryRow(row)` | Implemented — upserts into `ticker_fundamentals_history` |
| `getMetricHistory(ticker, metric)` | Implemented — returns ordered numeric history |
| `computeHistoricalPercentile(value, history)` | Implemented — fraction of history ≤ currentValue |

### Source priority chain in `getFundamentals()`
1. DB cache (< 7 days fresh → return immediately)
2. FactSet — stubbed with TODO comment; skips if key absent
3. SimFin — stubbed with TODO comment; skips if key absent
4. SEC EDGAR — full implementation (CIK lookup + `/api/xbrl/companyfacts`)
5. Finnhub — full implementation via `/stock/metric`
6. FMP — calls existing `fetchFMPFundamentals()` from `fmp-client.ts`

### Quality score
`computeQualityScore()` counts non-null fields / 30 expected fields → stored as `data_quality_score` (0–1) and `last_source`.

### Fix applied during 1B
- Rebuilt `lib/db` declarations (`npx tsc --build`) — dist `.d.ts` was stale, missing new tables

### TypeScript check
- `api-server` tsc --noEmit → **clean (no output)**

---

## 1. DB Schema — All Tables & Columns

### `watchlist`
| Column | Type |
|---|---|
| ticker | text PK |
| tier | integer |
| status | text (`want_to_own` \| `assigned` \| `monitoring` \| `closed`) |
| added_at | timestamp with tz |
| notes | text |

### `ticker_config`
| Column | Type |
|---|---|
| ticker | text PK |
| tier | integer |
| rsi_threshold | numeric |
| notes | text |

### `positions`
| Column | Type |
|---|---|
| id | serial PK |
| account_id | text |
| ticker | text |
| position_type | text (`short_put` \| `short_call` \| `long_stock` \| `long_call` \| `long_put`) |
| strike | numeric |
| expiry | date |
| qty | integer |
| avg_price | numeric |
| opened_at | timestamp with tz |
| closed_at | timestamp with tz |
| pnl | numeric |

### `signal_log`
| Column | Type |
|---|---|
| id | serial PK |
| ticker | text |
| fired_at | timestamp with tz |
| rsi_at_fire | numeric |
| mfi_at_fire | numeric |
| return_5d | numeric |
| rm_result | text (`proceed` \| `check_catalyst` \| `exclude`) |
| catalyst_found | text |
| strike | numeric |
| expiry | date |
| premium | numeric |
| income_pct | numeric |
| vix_at_fire | numeric |
| outcome | text (`win` \| `loss` \| `assigned` \| `pending`) |

### `prices_historical`
| Column | Type |
|---|---|
| ticker | text (composite PK) |
| date | date (composite PK) |
| open | numeric |
| high | numeric |
| low | numeric |
| close | numeric |
| volume | bigint |

### `indicator_cache`
| Column | Type |
|---|---|
| ticker | text (composite PK) |
| scored_date | date (composite PK) |
| rsi | numeric |
| mfi | numeric |
| rsi_threshold | numeric |
| signal | text (`GO` \| `WATCH` \| `NO`) |
| atr | numeric |
| macd_cross | text (`BULLISH_CROSS` \| `BEARISH_CROSS` \| `BULLISH` \| `BEARISH`) |
| stoch | numeric (%K) |
| return_5d | numeric |
| position_52w | numeric (0–100) |
| vs_spy_20d | numeric |
| earnings_date | date |

### `ticker_fundamentals`
| Column | Type |
|---|---|
| ticker | text PK |
| fundamentals_last_fetched | timestamp with tz |
| discrepancy_flags | text (comma-separated) |
| fmp_coverage_percent | numeric |
| pe_ratio | numeric |
| peg_ratio | numeric |
| price_to_book | numeric |
| price_to_sales | numeric |
| debt_to_equity | numeric (raw ratio, not ×100) |
| total_revenue | numeric |
| revenue_growth_yoy | numeric |
| net_income | numeric |
| ebitda | numeric |
| earnings_per_share | numeric |
| eps_growth | numeric |
| free_cash_flow | numeric |
| dividend_yield | numeric |
| return_on_equity | numeric |
| return_on_assets | numeric |
| current_ratio | numeric |
| gross_margin | numeric |
| operating_margin | numeric |
| net_margin | numeric |
| beta | numeric |
| analyst_target_price | numeric |
| wacc | numeric |
| roic | numeric |
| interest_expense | numeric (always positive, Math.abs applied) |
| total_debt | numeric |
| total_stockholders_equity | numeric |
| ebit | numeric |
| effective_tax_rate | numeric |
| cash_and_equivalents | numeric |
| quarterly_operating_cash_flow | numeric |
| shares_outstanding | numeric |
| shares_outstanding_prior | numeric |

### `fmp_api_usage`
| Column | Type |
|---|---|
| id | integer PK (always 1) |
| calls_today | integer |
| reset_date | text (YYYY-MM-DD) |

### `ticker_technicals`
| Column | Type |
|---|---|
| ticker | text PK |
| technicals_last_fetched | timestamp with tz |
| technicals_coverage | numeric (0–1) |
| **Momentum** | |
| rsi14 | numeric |
| rsi14_pct | numeric ([0,1] self-relative) |
| mfi14 | numeric |
| mfi14_pct | numeric |
| stoch | numeric (%K) |
| stoch_pct | numeric |
| macd_hist | numeric |
| macd_direction | text (`UP` \| `DOWN` \| `FLAT`) |
| atr14 | numeric |
| atr14_pct | numeric |
| rsi_velocity | numeric (RSI change over last 3 bars) |
| **Volume** | |
| volume_ratio | numeric (today / 20d avg) |
| volume_ratio_pct | numeric ([0,1] self-relative) |
| **Volatility** | |
| realized_vol_20d | numeric (annualized %) |
| bb_upper | numeric |
| bb_lower | numeric |
| bb_width | numeric ((upper−lower)/middle) |
| bb_width_pct | numeric ([0,1] self-relative) |
| price_z_score | numeric ((price − 20d mean) / 20d std) |
| **Moving Averages** | |
| ma20 | numeric |
| ma50 | numeric |
| ma200 | numeric |
| ma50_slope_10d | numeric |
| price_vs_ma20_atr | numeric |
| price_vs_ma50_atr | numeric |
| price_vs_ma200_atr | numeric |
| **Support / Resistance** | |
| swing_high_20d | numeric |
| swing_low_20d | numeric |
| swing_high_50d | numeric |
| swing_low_50d | numeric |
| vwap_20d | numeric |
| price_vs_vwap_pct | numeric (%) |
| pivot_point | numeric |
| pivot_r1 | numeric |
| pivot_s1 | numeric |
| nearest_support_dist_pct | numeric |
| nearest_resist_dist_pct | numeric |
| **Regime** | |
| regime | text (`BULLISH` \| `NEUTRAL` \| `BEARISH`) |
| falling_knife | integer (0 \| 1) |
| **Options Flow** | |
| atm_put_iv | numeric (ATM put IV %) |
| iv_rank | numeric ([0,1]) |
| iv_percentile | numeric (0–100) |
| implied_move_weekly | numeric |
| iv_vs_realized_vol | numeric |
| put_call_volume_ratio | numeric |
| basic_skew | numeric |
| iv_term_structure | numeric |
| gex_net | numeric (always null — requires dealer data) |
| put_wall_strike | numeric (always null) |
| call_wall_strike | numeric (always null) |
| max_pain_strike | numeric (always null) |
| delta_skew_25 | numeric (always null) |
| **Earnings** | |
| earnings_days_out | integer |

---

## 2. `fmp-client.ts` — Functions & FMP Endpoints

**One exported function:** `fetchFMPFundamentals(ticker, apiKey): Promise<FMPFundamentalsData>`

Fires 7 parallel requests to `https://financialmodelingprep.com/stable`:

| Endpoint | Key fields consumed |
|---|---|
| `GET /key-metrics?symbol=…&limit=1` | `returnOnInvestedCapital` (ROIC), `currentRatio` (fallback), `returnOnEquity` (fallback) |
| `GET /ratios?symbol=…&limit=1` | `priceToEarningsRatio`, `priceToEarningsGrowthRatio`, `priceToBookRatio`, `priceToSalesRatio`, `debtToEquityRatio`, `dividendYield`, `grossProfitMargin`, `operatingProfitMargin`, `netProfitMargin`, `returnOnEquity`, `returnOnAssets`, `effectiveTaxRate`, `currentRatio` |
| `GET /income-statement?symbol=…&limit=2` | `revenue`, `netIncome`, `ebitda`, `ebit`/`operatingIncome`, `interestExpense`, `eps`, `weightedAverageShsOut` (2 periods for shares dilution) |
| `GET /balance-sheet-statement?symbol=…&limit=2` | `totalDebt`, `totalStockholdersEquity`, `cashAndCashEquivalents` |
| `GET /price-target-consensus?symbol=…` | `targetConsensus` |
| `GET /cash-flow-statement?symbol=…&period=quarter&limit=2` | `operatingCashFlow` (most-recent quarter) |
| `GET /financial-growth?symbol=…&limit=1` | `revenueGrowth`, `epsgrowth` |

**Note:** Beta is NOT fetched from FMP. The `/stable/profile` endpoint is rate-limited at 31-ticker scale; `buildMetrics` falls back to Yahoo `quote.beta`.

**Internal helpers (not exported):**
- `fetchWithRetry(url, maxRetries=3)` — exponential backoff on 429 and non-OK
- `fmpN(v)` — coerces to finite number or undefined
- `firstOf(arr)` / `secondOf(arr)` — safe array accessors

---

## 3. `rankings.ts` — Cross-Ticker Normalization Logic

### V1: `computeRankings` (lines 57–69)
For each metric, collects all stock values, filters nulls/non-finite, sorts by `higherIsBetter`, then assigns ordinal percentile score:
```
score[i] = (n - 1 - rankIdx) / (n - 1)   // 0–1, best ticker = 1.0
```
Purely cross-sectional — every ticker's score depends on the full peer set.

### V2: `computeRankingsV2` (lines 231–297)
Same ordinal normalization but via `normalize()` from `rankings-helpers.ts`, grouped by `stockGroupKeys`. Currently all tickers map to `"__global__"` (sector-neutral not wired).

**Base-effect growth guard** (lines 283–297): if `totalRevenue < $100M` AND `revgrow > 500%`, `normScores["revgrow"][i]` is overridden to `0.5` (neutral). Only scoring override — all other suspect flags are display-only.

**Suspect detection** (lines 244–259): flags `netmgn`, `revgrow`, `epsgrow`, `earningsYield` when values exceed thresholds (`|netMargin| > 100%`, `|growth| > 1000%`, or `|netIncome| > |totalRevenue|`). Display-only except for the base-effect guard above.

---

## 4. `technical-rankings.ts` — Cross-Ticker Normalization

### V2: `computeTechnicalRankingsV2` (lines 308–388) — **SELF-RELATIVE, NO CROSS-TICKER NORMALIZATION**
Each ticker's score is computed from its own DB row only. All `_pct` fields (e.g. `rsi14Pct`, `mfi14Pct`, `stochPct`, `volumeRatioPct`, `bbWidthPct`, `ivRank`) are pre-computed self-relative percentiles stored in `ticker_technicals`.

The only cross-sectional operation is `sort` for rank assignment (line 350) — explicitly labeled display-only. Adding/removing peers never changes any ticker's `totalScore`.

### V1: `computeTechnicalRankings` (lines 392–443) — **CROSS-TICKER**
Same ordinal normalization as `rankings.ts` V1: collects all values across peers, assigns `(n-1-rankIdx)/(n-1)` per metric.

---

## 5. All API Routes

| Method | Path | Router file |
|---|---|---|
| GET | `/healthz` | health.ts |
| GET | `/stocks/compare` | stocks.ts |
| GET | `/stocks/search` | stocks.ts |
| GET | `/stocks/history` | stocks.ts |
| GET | `/stocks/quote` | stocks.ts |
| GET | `/stocks/breakdown` | stocks.ts |
| GET | `/indicators/:ticker` | indicators.ts |
| GET | `/indicators/batch` | indicators.ts |
| GET | `/options/position-quote` | options.ts |
| GET | `/options/:ticker` | options.ts |
| GET | `/technical/scorecard` | technical.ts |
| POST | `/technical/refresh/:ticker` | technical.ts |
| GET | `/daily-brief/market` | daily-brief.ts |
| GET | `/daily-brief/history` | daily-brief.ts |
| GET | `/daily-brief` | daily-brief.ts |
| GET | `/daily-brief/context` | daily-brief.ts |
| PATCH | `/daily-brief/context` | daily-brief.ts |
| GET | `/macro/data` | macro.ts |
| POST | `/macro/refresh` | macro.ts |
| GET | `/macro/charts` | macro.ts |
| GET | `/macro/indicator-history` | macro.ts |
| GET | `/macro/sep-actuals` | macro.ts |
| GET | `/macro/bank-news` | macro.ts |
| GET | `/macro/highlights` | macro.ts |
| POST | `/macro/highlights/generate` | macro.ts |
| GET | `/macro/fed-members` | macro.ts |
| GET | `/macro/events` | macro.ts |
| GET | `/macro/sep-projections` | macro.ts |
| GET | `/macro/bank-research` | macro.ts |
| POST | `/macro/bank-research/generate` | macro.ts |
| POST | `/fundamentals/refresh` | fundamentals.ts |
| GET | `/fundamentals/status` | fundamentals.ts |
| POST | `/technicals/refresh` | technicals.ts |
| GET | `/technicals/status` | technicals.ts |
| GET | `/technicals/all` | technicals.ts |
| POST | `/explain/score` | explain.ts |

---

## Phase 2 — FactSet Static IP Proxy ✅ COMPLETE

**Date:** 2026-06-14

### Problem
FactSet Developer API requires IP whitelisting. Replit's shell IP is dynamic, requiring constant manual updates in FactSet Control Center.

### Solution
Lightweight proxy on Oracle Cloud Always Free VM with a static IP. All FactSet calls route through the proxy; only the proxy IP is whitelisted in FactSet.

### Infrastructure
- **Cloud:** Oracle Cloud Always Free (US West / San Jose)
- **Instance:** `instance-20260614-0856` — Ubuntu 22.04, VM.Standard.E2.1.Micro (1 OCPU, 1GB RAM)
- **Public IP:** `146.235.223.94` ⚠️ still ephemeral — reserve via OCI → Networking → IP Management → Reserved Public IPs
- **VCN:** `vcn-20260614-0903`, **Subnet:** `subnet-20260614-0903`
- **Security List:** Port 22 (SSH) + Port 3001 (proxy) open

### Completed steps
- [x] VM created and running
- [x] OCI Security List: port 22 + port 3001 ingress rules added
- [x] OS-level iptables rule opened for port 3001 + netfilter-persistent save
- [x] Node.js 20 + PM2 installed on VM
- [x] `~/factset-proxy/proxy.js` + `ecosystem.config.js` deployed (env vars baked in via ecosystem file, not shell)
- [x] PM2 started via `pm2 start ecosystem.config.js` + `pm2 save` — survives reboots
- [x] FactSet API key IP whitelist updated to `146.235.223.94`
- [x] Replit Secrets: `FACTSET_PROXY_URL=http://146.235.223.94:3001`, `FACTSET_PROXY_SECRET` set
- [x] `fetchFactSet()` rewritten to use Overview Report Builder API (the only subscribed FactSet API)
- [x] End-to-end test: `POST /api/sdm/refresh/NVDA` → `{"source":"factset","dataQualityScore":"0.5667"}`
- [ ] Reserve ephemeral IP in OCI (non-blocking — proxy works, but IP lost on VM reboot until reserved)

### Key discovery: FactSet API subscription
The developer account (`USCMARSHALL-2393811`) only has access to the **Overview Report Builder API**.
- The originally planned Fundamentals API v2 (`/content/factset-fundamentals/v2/fundamentals`) returns 403 — not subscribed.
- Correct endpoint: `GET https://api.factset.com/report/overview/v1/financial-highlights?id=TICKER-US`
- Response format: STACH 2.0 (`data.tables.main.data.rows[]` — cells[0]=label, cells[2]=most-recent actual)
- Scale quirk: FactSet omits `scale` from some FIN rows; code defaults to scale=6 (millions) for `metric=FIN` non-pct rows

### Fields from FactSet Overview API
| Available | Not available (FMP fills) |
|---|---|
| Revenue, Net Income, EBITDA, EBIT | PE ratio, P/B, P/S |
| EPS (Diluted) | ROIC, WACC, Beta |
| Gross/Operating/Net Margins | Analyst Target Price |
| ROE, ROA | Interest Expense, Total Debt |
| FCF, Operating Cash Flow | Shares Outstanding |
| Current Ratio, D/E ratio | Dividend Yield |
| Total Stockholders' Equity | |
| Revenue Growth YoY, EPS Growth | |

### Architecture
```
Replit API server → http://146.235.223.94:3001/factset/* → api.factset.com
 (dynamic IP)         (whitelisted static IP)
```

### Caching behavior
- DB-first, 7-day freshness check in `getFundamentals()`
- UI queries read from DB only — FactSet is never called during normal app use
- Force refresh: `POST /api/sdm/refresh/:ticker?admin=true` (invalidates cache, triggers live fetch)
- Rate limit: 20 req/sec (effectively 1 call per ticker per 7 days)

### PM2 quick reference (SSH from Mac)
```
ssh -i ~/Desktop/ssh-key-2026-06-14.key ubuntu@146.235.223.94
pm2 logs factset-proxy --lines 30 --nostream
pm2 restart factset-proxy
```

### Architecture
```
Replit API server → http://146.235.223.94:3001/factset/* → api.factset.com
 (dynamic IP)         (whitelisted static IP)
```

### VM Setup Commands (run in SSH session on 146.235.223.94)

**package.json:**
```
cat > ~/factset-proxy/package.json << 'EOF'
{
  "name": "factset-proxy",
  "version": "1.0.0",
  "main": "proxy.js",
  "dependencies": { "express": "^4.19.0" }
}
EOF
```

**proxy.js:**
```
cat > ~/factset-proxy/proxy.js << 'EOF'
const express = require('express');
const app = express();
const SECRET = process.env.PROXY_SECRET;
const FACTSET_KEY = process.env.FACTSET_KEY;
if (!SECRET || !FACTSET_KEY) { console.error('Missing env vars'); process.exit(1); }
app.use(express.json());
app.get('/health', (_, res) => res.json({ ok: true }));
app.all('/factset/*', async (req, res) => {
  if (req.headers['x-proxy-secret'] !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  const path = req.path.replace('/factset', '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = `https://api.factset.com${path}${qs}`;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { Authorization: `Basic ${FACTSET_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err) { res.status(502).json({ error: 'upstream_error', detail: err.message }); }
});
app.listen(3001, () => console.log('factset-proxy listening on :3001'));
EOF
```

**Install + start:**
```
cd ~/factset-proxy && npm install
PROXY_SECRET=<random-token> FACTSET_KEY=<base64-user:apikey> pm2 start proxy.js --name factset-proxy
pm2 startup
pm2 save
```

**Test (from Mac terminal, not SSH):**
```
curl http://146.235.223.94:3001/health
```

**Generate FACTSET_KEY (base64 of username:apikey):**
```
echo -n "YOUR_USERNAME:YOUR_API_KEY" | base64
```

**Fix: restart with ecosystem.config.js to persist env vars:**
```
pm2 delete factset-proxy

cat > ~/factset-proxy/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'factset-proxy',
    script: 'proxy.js',
    env: {
      PROXY_SECRET: 'REPLACE_WITH_YOUR_OPENSSL_TOKEN',
      FACTSET_KEY: 'REPLACE_WITH_YOUR_BASE64_KEY'
    }
  }]
}
EOF

nano ecosystem.config.js   # fill in the two REPLACE_WITH values, save with Ctrl+O then Ctrl+X

pm2 start ecosystem.config.js
pm2 save

curl http://localhost:3001/health   # should return {"ok":true}
```
