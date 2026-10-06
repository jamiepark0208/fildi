# API Endpoint Catalog
> last_updated: 2026-07-05 | all routes mounted at /api in index.ts
> Before adding a new endpoint, check this file to avoid duplication.

## Health
| Method | Path | Purpose |
|---|---|---|
| GET | /api/healthz | Liveness check |

## Daily Brief
| Method | Path | Purpose |
|---|---|---|
| GET | /api/daily-brief | Full daily brief (macro + signals + positions) |
| GET | /api/daily-brief/market | Market snapshot only |
| GET | /api/daily-brief/history | Historical brief entries |
| GET | /api/daily-brief/context | Persistent context notes |
| PATCH | /api/daily-brief/context | Update context notes |
| GET | /api/desk-commentaries | FactSet desk rows (?hours=36) |
| GET | /api/desk-commentaries/soft-context | Narrative hints for live/regime (soft only) |
| POST | /api/desk-commentaries/ingest | requireAdmin | Drive → DB catch-up |

## Fundamentals
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/fundamentals/rankings | requireAuth | All tickers ranked by fundamental score |
| GET | /api/fundamentals/status | requireAuth | Coverage report + FMP budget usage |
| POST | /api/fundamentals/refresh | requireAuth | Trigger FMP fetch for missing tickers |
| GET | /api/fundamentals/provenance/:ticker | requireAdmin | Per-field source breakdown + divergence |
| PUT | /api/fundamentals/override | requireAdmin | Upsert manual field override |
| DELETE | /api/fundamentals/override/:ticker/:field | requireAdmin | Remove manual override |

## Technicals
| Method | Path | Purpose |
|---|---|---|
| GET | /api/technicals/all | All tickers with V2 technical scores |
| GET | /api/technicals/status | Staleness check + last scored_at timestamps |
| POST | /api/technicals/refresh | Force re-score (?force=true skips staleness) |
| GET | /api/technical/scorecard | V1 scorecard (deprecated) |
| POST | /api/technical/refresh/:ticker | V1 per-ticker refresh (deprecated) |

## Options Chain
| Method | Path | Purpose | Cache |
|---|---|---|---|
| GET | /api/options/position-quote | Quote for existing short put | none |
| GET | /api/options/:ticker | Full options chain | 30 min |

**Note:** `/options/position-quote` MUST be declared before `/options/:ticker`.

## Stocks
| Method | Path | Purpose |
|---|---|---|
| GET | /api/stocks/compare | Multi-ticker comparison |
| GET | /api/stocks/search | Ticker search |
| GET | /api/stocks/history | OHLCV history |
| GET | /api/stocks/quote | Current quote |
| GET | /api/stocks/breakdown | Fundamental breakdown + catalysts (2h cache) |
| GET | /api/stocks/competitors/:ticker | Top 5 peers 50/50 tech+fund |
| POST | /api/stocks/competitors/backfill | Auth — refresh stale peer scores |

## Indicators (V1 signal source)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/indicators/:ticker | RSI, MFI, MACD, ATR for one ticker |
| GET | /api/indicators/batch | Batch indicators (?tickers=A,B,C) |

## Macro (FRED + Treasury, 4h file cache)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/data | Full macro payload |
| GET | /api/charts | Pre-computed chart series |
| POST | /api/refresh | Force refresh FRED cache |
| GET | /api/indicator-history | Historical FRED values |
| GET | /api/sep-actuals | Fed SEP actual vs projected |
| GET | /api/sep-projections | Fed SEP projection data |
| GET | /api/highlights | Saved macro highlights |
| POST | /api/highlights/generate | AI-generate macro highlights |
| GET | /api/bank-news | Banking sector news |
| GET | /api/bank-research | Banking research notes |
| POST | /api/bank-research/generate | AI-generate bank research |
| GET | /api/fed-members | Fed committee member data |
| GET | /api/events | Upcoming economic events |

## COT (CFTC Commitment of Traders, file cache)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/cot/summary | COT positioning summary |
| GET | /api/cot/history | Historical COT data |
| GET | /api/cot/instruments | Available instruments |
| POST | /api/cot/refresh | Force COT cache refresh |

## Regime
| Method | Path | Purpose |
|---|---|---|
| GET | /api/regime/macro | Current market regime data |
| POST | /api/regime/macro/refresh | Force regime refresh |

## Scoring Config
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/scoring-config | requireAdmin | Get scorer weight config |
| POST | /api/scoring-config | requireAdmin | Update scorer weights |

## Positions
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/positions | requireAuth | List positions |
| POST | /api/positions | requireAuth | Create position |
| PATCH | /api/positions/:id | requireAuth | Update position |
| DELETE | /api/positions/:id | requireAuth | Delete position |
| GET | /api/portfolio-names | requireAuth | List portfolio names |
| POST | /api/portfolio-names | requireAuth | Create portfolio |
| DELETE | /api/portfolio-names/:name | requireAuth | Delete portfolio |

## Portfolio
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/portfolio/snapshot/latest | requireAuth | Latest portfolio snapshot |

## Watchlist
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/watchlist | requireAuth | Get watchlist tickers |
| POST | /api/watchlist | requireAuth | Add ticker to watchlist |
| DELETE | /api/watchlist/:ticker | requireAuth | Remove ticker |

## SDM (Stock Data Manager — FactSet-backed fundamentals)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | /api/sdm/status | requireAdmin | SDM coverage + freshness |
| GET | /api/sdm/tickers | requireAdmin | All managed tickers |
| POST | /api/sdm/refresh/:ticker | requireAdmin | Force FactSet re-fetch for ticker |
| POST | /api/sdm/import-csv | requireAdmin | Import fundamentals from CSV |
| GET | /api/sdm/history/:ticker | requireAdmin | Historical fundamental snapshots |
| GET | /api/sdm/peers/:ticker | requireAdmin | Peer data for ticker |

## Feed / Social
| Method | Path | Purpose |
|---|---|---|
| POST | /api/feed/posts | Create trade idea post |
| GET | /api/feed/posts | List posts |
| GET | /api/feed/posts/:id | Single post + comments |
| PATCH | /api/feed/posts/:id/close | Close post |
| DELETE | /api/feed/posts/:id | Delete post |
| POST | /api/feed/posts/:id/like | Like |
| DELETE | /api/feed/posts/:id/like | Unlike |
| POST | /api/feed/posts/:id/comments | Add comment |
| DELETE | /api/feed/comments/:id | Delete comment |
| GET | /api/feed/profile/:username | Profile + stats + posts |
| GET | /api/feed/buckets | All users' Bullish/Neutral/Bearish picks |
| GET | /api/feed/buckets/mine | Current user's picks |
| PUT | /api/feed/buckets | Upsert ticker into bucket |
| DELETE | /api/feed/buckets/:ticker | Remove ticker from buckets |

## Auth
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/register | public + authLimiter | Register with invite code (Zod) |
| POST | /api/auth/login | public + authLimiter | Login (Zod) |
| POST | /api/auth/logout | public | Destroy session |
| GET | /api/auth/me | requireAuth | Current user info |

## Admin
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/admin/invite | requireAdmin | Generate invite code |
| GET | /api/admin/invites | requireAdmin | List codes with usedByEmail |
| DELETE | /api/admin/invite/:code | requireAdmin | Delete invite code |
| GET | /api/admin/users | requireAdmin | List all users |
| GET | /api/admin/cache/status | requireAdmin | All cache stats |
| DELETE | /api/admin/cache/clear/:name | requireAdmin | Clear named cache |
| GET | /api/admin/cache/ttl/:name | requireAdmin | Get TTL for named cache |
| GET | /api/admin/data-health | requireAuth | DB freshness counts, top null fields, divergent count, last enrichment run |
| GET | /api/admin/enrichment-runs?limit=N | requireAdmin | Last N nightly-enrichment.ts runs (status, perSource counts, coverage before/after) |
| GET | /api/api-usage/history?days=N | requireAuth | Daily call counts per source (last N days, default 5) |

## Route file map
```
routes/admin-cache.ts      → /api/admin/cache/*
routes/auth.ts             → /api/auth/*, /api/admin/invite*, /api/admin/users
routes/daily-brief.ts      → /api/daily-brief/*
routes/data-health.ts      → /api/admin/data-health
routes/enrichment-runs.ts  → /api/admin/enrichment-runs
routes/explain.ts          → /api/explain/*
routes/feed.ts             → /api/feed/*
routes/fundamentals.ts     → /api/fundamentals/* (rankings, status, refresh)
routes/fundamentals-provenance.ts → /api/fundamentals/provenance/*, /api/fundamentals/override*
routes/health.ts           → /api/healthz
routes/indicators.ts       → /api/indicators/*
routes/macro.ts            → /api/data, /api/charts, /api/refresh, /api/highlights, /api/bank-*, /api/fed-*, /api/events, /api/sep-*
routes/macro-cot.ts        → /api/cot/*
routes/macro-regime.ts     → (included in macro or separate mount)
routes/options.ts          → /api/options/*
routes/portfolio-snapshot.ts → /api/portfolio/*
routes/positions.ts        → /api/positions/*, /api/portfolio-names/*
routes/regime.ts           → /api/regime/*
routes/scoring-config.ts   → /api/scoring-config
routes/sdm.ts              → /api/sdm/*
routes/stocks.ts           → /api/stocks/*
routes/technical.ts        → /api/technical/* (V1 — deprecated)
routes/technicals.ts       → /api/technicals/* (V2 — use this)
routes/watchlist.ts        → /api/watchlist/*
```

## Security middleware (global in app.ts)
- `helmet()` — HTTP security headers (first)
- `cors({ origin: FRONTEND_URL })` — origin whitelist
- `generalLimiter` — 200 req/15min
- `authLimiter` — 20 req/15min on /auth/register and /auth/login
- `errorHandler` — global (last, after router)

<!-- AUTOGEN:BEGIN (node .claude/scripts/check-api-endpoints.js --write) -->
## Auto-listed endpoints (in code, not yet in curated sections above)
> Regenerated by `node .claude/scripts/check-api-endpoints.js --write`. Move entries
> up into a curated section (with Purpose) when touching them; they disappear from
> here on next regen once documented above.

| Method | Path | Route file |
|---|---|---|
| PATCH | /api/admin/cache/ttl/:name | admin-cache.ts |
| GET | /api/api-usage/history | api-usage.ts |
| POST | /api/auth/change-password | auth.ts |
| POST | /api/admin/users | auth.ts |
| POST | /api/admin/users/:id/reset-password | auth.ts |
| GET | /api/desk-commentaries/session | desk-commentaries.ts |
| GET | /api/desk-commentaries/parse-preview | desk-commentaries.ts |
| GET | /api/desk-commentaries/daily-news | desk-daily-news.ts |
| POST | /api/desk-commentaries/daily-news/refresh | desk-daily-news.ts |
| POST | /api/desk-commentaries/daily-news/feedback | desk-daily-news.ts |
| GET | /api/desk-commentaries/daily-news/feedback | desk-daily-news.ts |
| GET | /api/admin/enrichment-runs | enrichment-runs.ts |
| POST | /api/explain/score | explain.ts |
| POST | /api/explain/options | explain.ts |
| POST | /api/explain/live-regime | explain.ts |
| POST | /api/explain/model-pick | explain.ts |
| GET | /api/feed/users | feed.ts |
| POST | /api/feed/holdings/:id/close | feed.ts |
| POST | /api/feed/portfolio/reset | feed.ts |
| GET | /api/feed/buckets/:username | feed.ts |
| POST | /api/feedback | feedback.ts |
| GET | /api/admin/feedback | feedback.ts |
| GET | /api/stocks/:ticker/score-history | fund-score-notes.ts |
| GET | /api/stocks/:ticker/score-notes | fund-score-notes.ts |
| POST | /api/stocks/:ticker/score-notes | fund-score-notes.ts |
| DELETE | /api/stocks/:ticker/score-notes/:id | fund-score-notes.ts |
| GET | /api/fundamentals/divergent | fundamentals-provenance.ts |
| POST | /api/fundamentals/queue-refetch | fundamentals-refetch-queue.ts |
| GET | /api/fundamentals/queue-refetch | fundamentals-refetch-queue.ts |
| DELETE | /api/fundamentals/queue-refetch/:id | fundamentals-refetch-queue.ts |
| POST | /api/fundamentals/queue-refetch/run | fundamentals-refetch-queue.ts |
| POST | /api/fundamentals/import-history | fundamentals.ts |
| GET | /api/fundamentals/stock-db | fundamentals.ts |
| GET | /api/fundamentals/unmapped | fundamentals.ts |
| GET | /api/live/state | live.ts |
| POST | /api/live/refresh | live.ts |
| GET | /api/live/movers | live.ts |
| GET | /api/live/regime | live.ts |
| GET | /api/live/pattern-digest | live.ts |
| GET | /api/live/entry-signals | live.ts |
| GET | /api/live/entry-stats | live.ts |
| GET | /api/admin/local-stack | local-stack.ts |
| GET | /api/volatility/regime | macro-regime.ts |
| GET | /api/macro/data | macro.ts |
| POST | /api/macro/refresh | macro.ts |
| GET | /api/macro/charts | macro.ts |
| GET | /api/macro/sector-rotation | macro.ts |
| GET | /api/macro/indicator-history | macro.ts |
| GET | /api/macro/sep-actuals | macro.ts |
| GET | /api/macro/bank-news | macro.ts |
| GET | /api/macro/highlights | macro.ts |
| POST | /api/macro/highlights/generate | macro.ts |
| GET | /api/macro/fed-members | macro.ts |
| GET | /api/macro/events | macro.ts |
| GET | /api/macro/sep-projections | macro.ts |
| GET | /api/macro/bank-research | macro.ts |
| POST | /api/macro/bank-research/generate | macro.ts |
| GET | /api/macro/risk-free-rate | macro.ts |
| GET | /api/options/candidates | options.ts |
| GET | /api/options/rankings | options.ts |
| POST | /api/options/rankings/refresh | options.ts |
| GET | /api/options/batch | options.ts |
| GET | /api/options/:ticker/term-structure | options.ts |
| GET | /api/peers/groups | peer-overrides.ts |
| GET | /api/peers/:ticker | peer-overrides.ts |
| PUT | /api/peers/:ticker/group | peer-overrides.ts |
| DELETE | /api/peers/:ticker/group | peer-overrides.ts |
| PUT | /api/peers/group/:groupId/member | peer-overrides.ts |
| DELETE | /api/peers/group/:groupId/member/:ticker | peer-overrides.ts |
| POST | /api/portfolio/ingest | portfolio-ingest.ts |
| GET | /api/portfolio/iv-rank-backtest | portfolio-snapshot.ts |
| POST | /api/portfolio/risk | portfolio-snapshot.ts |
| GET | /api/research/lseg/audit | research-lseg.ts |
| GET | /api/research/lseg/signals | research-lseg.ts |
| GET | /api/research/lseg/radar | research-lseg.ts |
| GET | /api/research/lseg/:ticker | research-lseg.ts |
| GET | /api/research/ops | research-ops.ts |
| GET | /api/research/wrds/signals | research-wrds.ts |
| GET | /api/research/wrds/:ticker | research-wrds.ts |
| GET | /api/admin/scheduled-tasks | scheduled-tasks.ts |
| GET | /api/admin/scheduled-tasks/:id/logs | scheduled-tasks.ts |
| POST | /api/admin/ops/remediate | scheduled-tasks.ts |
| POST | /api/admin/scheduled-tasks/:id/run | scheduled-tasks.ts |
| POST | /api/admin/scheduled-tasks/:id/enable | scheduled-tasks.ts |
| POST | /api/admin/scheduled-tasks/:id/disable | scheduled-tasks.ts |
| GET | /api/schwab/status | schwab.ts |
| PUT | /api/scoring-config | scoring-config.ts |
| GET | /api/stocks/quotes | stocks.ts |
| GET | /api/stocks/edgar-statements/:ticker | stocks.ts |
| GET | /api/technicals/:ticker | technicals.ts |
| POST | /api/technicals/refresh/:ticker | technicals.ts |
| GET | /api/track-record/summary | track-record.ts |
| GET | /api/track-record/by-ticker | track-record.ts |
| GET | /api/track-record/ticker-summary | track-record.ts |
| GET | /api/track-record/recs | track-record.ts |
| GET | /api/track-record/regime | track-record.ts |
| GET | /api/track-record/tilt | track-record.ts |
| POST | /api/track-record/run | track-record.ts |
| GET | /api/watchlist/user/:username | watchlist.ts |
| GET | /api/watchlist/model | watchlist.ts |
| PATCH | /api/watchlist/:ticker | watchlist.ts |
<!-- AUTOGEN:END -->
