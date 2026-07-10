# TradeDash — Project Context
> last_updated: 2026-07-05 | update when architecture or data sources change

## What this is
Institutional-grade put-selling research tool. Surfaces put candidates by scoring fundamentals + technicals + options premium.

## Architecture
- **Frontend:** React 18 + TypeScript + Tailwind SPA — `artifacts/stock-compare/` — port 8081 (Vite, hot-reloads)
- **Backend:** Node/Express ESM API — `artifacts/api-server/` — port 8080 — **NO hot-reload; must rebuild after every src change**
- **DB:** PostgreSQL via Drizzle ORM — `lib/db/`
- **No Redis** — in-memory TTLCache only (`lib/ttl-cache.ts`)
- **Admin cache dashboard** — GET /api/admin/cache/status, DELETE /api/admin/cache/clear/:name

## Two scoring layers (self-relative, peer-set invariant)

**Fundamental scorer** (`computeRankingsV2` in `rankings.ts`)
- 4 families: Value 20%, Growth 25%, Quality 35%, Safety 20%
- Data source: multi-source pipeline (Yahoo, FMP, Finnhub, Edgar, Polygon, AV)
- DB table: `ticker_fundamentals`

**Technical scorer** (`computeTechnicalRankingsV2` in `technical-rankings.ts`)
- 6 components: oversoldDepth 25%, reversalSignal 20%, volatilityState 22%, trendContext 18%, optionsFlow 10%, volumeConfirm 5%
- Data source: Yahoo Finance `.chart()`, OHLCV 420 calendar days, daily refresh
- DB table: `ticker_technicals` (55 cols)

## Data sources
| Source | Client | Budget | Fields |
|---|---|---|---|
| Yahoo Finance | yahoo-finance2 | ~2000/hr | OHLCV, options, most fundamentals |
| FMP | fmp-client.ts, FMP_API_KEY | 250/day | wacc, roic, priceToSales, effectiveTaxRate, revenueGrowthYoyPrior, sharesOutstandingPrior |
| FactSet | stock-data-manager.ts, OCI proxy | limited quota | Revenue, EBITDA, margins, ROE, ROA, FCF |
| Finnhub | finnhub-client.ts | rate limited | valuation, margins |
| EDGAR | edgar-client.ts | public | balance sheet, income statement (annual) |
| Polygon | polygon-client.ts, POLYGON_API_KEY | generous | income statement, balance sheet (cross-validation) |
| Alpha Vantage | alpha-vantage-client.ts, ALPHA_VANTAGE_API_KEY | 25/day | valuation, margins (cross-validation) |
| FRED | lib/macro-data.ts | public | macro indicators |
| Treasury.gov | lib/macro-data.ts | public | yield curve CSV |

## Fundamentals data layers (Bronze → Silver → Gold)
**Canonical universe:** `fmp_fundamentals` — 257 tickers (as of 2026-07-05)
- Bronze: fmp/yahoo/finnhub/edgar/polygon/av_fundamentals (staging, one row/ticker)
- Silver: `source_fundamentals` (PK: ticker+source+field) — canonical field names, all sources
- Gold: `ticker_fundamentals` (merged per FIELD_DEFS priority in merge-trusted.ts)
- Provenance: `field_provenance` (PK: ticker+field) — winning source, divergence flag
- Overrides: `manual_overrides` (PK: ticker+field) — admin-set values

## Key DB tables (38 total in schema)

**Core business:**
| Table | Purpose |
|---|---|
| `watchlist` | Tickers with tier/status/tag (31 tickers) |
| `ticker_registry` | All known tickers with name/sector/exchange |
| `peer_groups` | Peer group definitions |
| `peer_group_members` | ticker ↔ group membership |
| `positions` | short_put/call/long_stock/call/put with P&L |
| `signal_log` | Fired signals with outcome tracking |
| `prices_historical` | OHLCV, INSERT OR IGNORE |
| `ticker_technicals` | Technical scorer output (55 cols) |
| `ticker_fundamentals` | Fundamental scorer output (merged gold layer) |
| `ticker_fundamentals_history` | Historical snapshots of fundamentals |
| `ticker_config` | Per-ticker scorer configuration overrides |
| `app_config` | Global app configuration key/value |

**Fundamentals pipeline:**
| Table | Purpose |
|---|---|
| `fmp_fundamentals` | Bronze: FMP staging (257 tickers — canonical universe) |
| `yahoo_fundamentals` | Bronze: Yahoo staging |
| `finnhub_fundamentals` | Bronze: Finnhub staging |
| `edgar_fundamentals` | Bronze: EDGAR staging |
| `polygon_fundamentals` | Bronze: Polygon staging (empty — awaiting backfill) |
| `av_fundamentals` | Bronze: Alpha Vantage staging (empty — awaiting backfill) |
| `source_fundamentals` | Silver: all sources normalized (ticker+source+field PK) |
| `field_provenance` | Per-field winning source + divergence flag |
| `manual_overrides` | Admin field overrides |
| `fmp_api_usage` | FMP budget guard (callsToday, resetDate) |
| `source_ticker_map` | Ticker symbol aliases (e.g. PSTG→P rename) |
| `data_sources` | Source health/status tracking |

**Users & auth:**
| Table | Purpose |
|---|---|
| `users` | User accounts |
| `invite_codes` | Registration invite codes |
| `stock_buckets` | Per-user Bullish/Neutral/Bearish picks |

**Feed / Social:**
| Table | Purpose |
|---|---|
| `trade_posts` | Trade idea posts |
| `comments` | Post comments |
| `likes` | Post likes |

**Options & signals:**
| Table | Purpose |
|---|---|
| `scorecard_cache` | RSI/MFI/indicator results, upsert on (ticker, scored_date) |
| `indicator_cache` | Indicator cache |
| `earnings_calendar` | Upcoming earnings dates |
| `market_regime` | Market regime snapshots |

**Portfolio:**
| Table | Purpose |
|---|---|
| `portfolio_positions` | Portfolio position tracking |
| `portfolio_orders` | Portfolio order history |
| `portfolio_snapshots` | Portfolio value snapshots |
| `portfolio_options` | Options in portfolio |

**Misc:**
| Table | Purpose |
|---|---|
| `ticker_cik` | EDGAR CIK mappings |
| `ticker_config` | Per-ticker scorer config |
| `unmapped_tickers` | Tickers that failed source mapping |

## Watchlist
38 watchlist tickers (SELECT count(*) FROM watchlist), 31 WATCHLIST-tracked, 257 canonical universe.
Tags: blue=holding/assigned, green=long conviction, yellow=moderate/income, purple=market context.
Financial tickers excluded from roicWaccSpread: HOOD, SOFI.

## Options scanner
Combines both scores + options chain to surface put candidates by premium/strike ratio, signal, and combined score.
Extra/hidden tickers persisted to localStorage (`fildi_scanner_extra`, `fildi_scanner_hidden`).

## AI explain endpoint
`POST /api/explain/score` — Haiku, 200 tokens, no storage. Explain button in Rankings + Technical Leaderboard; session-cached per ticker.

## Data Maintenance Pipeline (2026-07-10)

**Scripts (run manually or via scheduler):**
| Script | Command | Purpose |
|---|---|---|
| `merge-trusted.ts` | `npx tsx src/scripts/merge-trusted.ts` | Re-merge all fields from source_fundamentals → ticker_fundamentals |
| `populate-source-fundamentals.ts` | same pattern | Re-populate source_fundamentals from all staging tables |
| `nightly-enrichment.ts` | `npx tsx src/scripts/nightly-enrichment.ts [--dry-run]` | Gap-fill null fields, budget-aware, free sources first |
| `audit-coverage.ts --suspicious` | same pattern + `--suspicious` | Statistical outlier detection (z-score) + cross-source disagreement |

**Scheduler:** `lib/scheduler.ts` — runs `nightly-enrichment` in-process Sun + Thu at 02:00 UTC. No external cron needed.

**Known data quirks (fixed):**
- **Finnhub dividendYield**: Reports as percentage (2.7 = 2.7%), all others as decimal (0.027). Fixed in `populate-source-fundamentals.ts` via transforms param.
- **FMP quarterlyOperatingCashFlow**: Returns YTD from 10-Q, not isolated quarter. Removed FMP from this field's FIELD_DEFS priority — Yahoo-only.
- **Near-zero base growth**: epsGrowth/revenueGrowthYoY > 10× (1000%) displays as "N/M" in StockDB UI — prior period near zero, not a data error.
- **Manual overrides**: TROW operatingMargin → fmp (Yahoo outlier at 37% vs 3 sources at 30%); INTC cashAndEquivalents → fmp (Yahoo includes short-term investments).

**Outlier detection:** StockDBTab uses per-peer-group modified z-scores (MAD-based, log-transform for ratio fields). Threshold |z| > 3.0. Replaces old hardcoded per-field thresholds.

## Context files
- **API endpoints**: `.agents/context/api-endpoints.md` — all routes, check before adding new ones
- **Skills**: `.claude/skills/` — authoritative skill files
- **Memory/lessons**: `.agents/memory/MEMORY.md`
- **Active tasks**: `.agents/tasks/`
- **Phase reports**: `.claude/docs/`
