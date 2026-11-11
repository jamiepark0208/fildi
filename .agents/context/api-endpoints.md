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
| GET | /api/indicators/scorecard | Graded track record per TV indicator (scorecard rows + registry meta; 10 min cache) |
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

## PM / Portfolio Alerts / Stock context (Claude PM role, 2026-10-14)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/pm/alerts | Latest Portfolio Alerts run (admin; `watchlist_sync.pm_alerts`) |
| GET | /api/pm/names | Book names: LSEG short %, next earnings, latest call summary (admin) |
| GET | /api/pm/book | Book card / expiry desk (admin; `watchlist_sync.pm_book_latest`, file fallback) |
| GET | /api/stocks/:ticker/short-interest | Polygon short-interest history (stored, 7-day refresh) + LSEG current % float |
| GET | /api/stocks/:ticker/earnings-call | Summarized earnings calls + LSEG street (Breakdown › Earnings calls) |
| GET | /api/fair-value/:ticker/assumptions | Shared rules, cohort, inputs + last changed, judgement rows, FV history |
| GET | /api/fair-value/:ticker/assumptions/history?field= | Every value of one input + its overrides |
| POST | /api/fair-value/assumptions | New proposed/active override (admin; reason ≥ 5 chars; expiry = next earnings) |
| POST | /api/fair-value/assumptions/:id | accept / reject / retire (admin) → recompute |
| GET | /api/stocks/:ticker/options-history | Earnings moves (priced vs actual) + 30-day IV / realized / true IV rank (`optlab`) |
| GET | /api/pm/trades/:ticker | Your short puts on a name + each contract's daily closes (admin) |
| GET | /api/pm/playbook | Study verdicts S017–S021 (`optlab.findings`, admin) |
| GET | /api/research/studies | research/studies/INDEX.md rows → Settings › Research (admin) |

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
routes/pm-alerts.ts        → /api/pm/{alerts,names,book}
routes/stock-context.ts    → /api/stocks/:ticker/{short-interest,earnings-call}
routes/options-history.ts  → /api/stocks/:ticker/options-history, /api/pm/{trades/:ticker,playbook}, /api/research/studies
routes/fair-value-assumptions.ts → /api/fair-value/:ticker/assumptions*, /api/fair-value/assumptions*
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
| GET | /api/admin/vendor-health | admin-cache.ts |
| PATCH | /api/admin/cache/ttl/:name | admin-cache.ts |
| GET | /api/agents/drill/apis | agents-drill.ts |
| GET | /api/agents/drill/apis/:source | agents-drill.ts |
| POST | /api/agents/ideas/:id/dismiss | agents.ts |
| GET | /api/agents/needs/:item/comments | agents.ts |
| POST | /api/agents/needs/:item/comments | agents.ts |
| GET | /api/agents/overview | agents.ts |
| GET | /api/agents/learn | agents.ts |
| GET | /api/api-usage/history | api-usage.ts |
| GET | /api/api-usage/ai-spend | api-usage.ts |
| POST | /api/auth/change-password | auth.ts |
| POST | /api/admin/users | auth.ts |
| POST | /api/admin/users/:id/reset-password | auth.ts |
| GET | /api/backtest/catalog | backtest.ts |
| GET | /api/backtest/inspect | backtest.ts |
| POST | /api/backtest/run | backtest.ts |
| GET | /api/backtest/runs | backtest.ts |
| GET | /api/backtest/runs/:id | backtest.ts |
| GET | /api/backtest/runs/:id/trades | backtest.ts |
| POST | /api/client/ui-crash | client-telemetry.ts |
| GET | /api/stocks/:ticker/congress | congress.ts |
| GET | /api/congress/latest | congress.ts |
| GET | /api/conviction/:ticker | conviction.ts |
| POST | /api/conviction/:ticker | conviction.ts |
| POST | /api/conviction/thesis/:id/confidence | conviction.ts |
| POST | /api/conviction/thesis/:id/kill | conviction.ts |
| GET | /api/admin/data-sources | data-health.ts |
| GET | /api/decision-changes | decision-changes.ts |
| GET | /api/desk-commentaries/session | desk-commentaries.ts |
| GET | /api/desk-commentaries/parse-preview | desk-commentaries.ts |
| GET | /api/desk-commentaries/daily-news | desk-daily-news.ts |
| POST | /api/desk-commentaries/daily-news/refresh | desk-daily-news.ts |
| POST | /api/desk-commentaries/daily-news/feedback | desk-daily-news.ts |
| GET | /api/desk-commentaries/daily-news/feedback | desk-daily-news.ts |
| GET | /api/desk-commentaries/daily-news/oj-labels | desk-daily-news.ts |
| GET | /api/admin/enrichment-runs | enrichment-runs.ts |
| POST | /api/explain/score | explain.ts |
| POST | /api/explain/options | explain.ts |
| POST | /api/explain/live-regime | explain.ts |
| POST | /api/explain/model-pick | explain.ts |
| GET | /api/fair-value/:ticker/assumptions/history | fair-value-assumptions.ts |
| GET | /api/fair-value/street-gaps | fair-value-assumptions.ts |
| GET | /api/fair-value/:ticker/vs-street | fair-value-assumptions.ts |
| GET | /api/fair-value/:ticker/external | fair-value-assumptions.ts |
| GET | /api/fair-value/:ticker/v2 | fair-value-assumptions.ts |
| GET | /api/fair-value/:ticker/dcf | fair-value-assumptions.ts |
| GET | /api/feed/users | feed.ts |
| POST | /api/feed/holdings/:id/close | feed.ts |
| POST | /api/feed/portfolio/reset | feed.ts |
| POST | /api/feed/portfolio/reset-stats | feed.ts |
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
| PUT | /api/fundamentals/peer-rep | fundamentals.ts |
| GET | /api/fundamentals/explain/:ticker | fundamentals.ts |
| GET | /api/fundamentals/unmapped | fundamentals.ts |
| GET | /api/live/index-movers | index-movers.ts |
| GET | /api/live/state | live.ts |
| GET | /api/live/prices | live.ts |
| POST | /api/live/refresh | live.ts |
| GET | /api/live/movers | live.ts |
| GET | /api/live/regime | live.ts |
| GET | /api/live/market-context | live.ts |
| GET | /api/live/pattern-digest | live.ts |
| GET | /api/live/entry-signals | live.ts |
| GET | /api/live/entry-stats | live.ts |
| GET | /api/live/pred-markets | live.ts |
| GET | /api/live/scenarios | live.ts |
| GET | /api/admin/local-stack | local-stack.ts |
| GET | /api/options/long-board | long-option-board.ts |
| GET | /api/options/put-ladder | long-option-board.ts |
| GET | /api/volatility/regime | macro-regime.ts |
| GET | /api/themes | macro-themes.ts |
| GET | /api/money-flows | macro-themes.ts |
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
| GET | /api/macro/watchlist-earnings | macro.ts |
| GET | /api/macro/sep-projections | macro.ts |
| GET | /api/macro/bank-research | macro.ts |
| POST | /api/macro/bank-research/generate | macro.ts |
| GET | /api/macro/breadth | macro.ts |
| GET | /api/macro/voices | macro.ts |
| POST | /api/macro/voices/resolve | macro.ts |
| POST | /api/macro/voices | macro.ts |
| POST | /api/macro/voices/ingest | macro.ts |
| POST | /api/macro/voices/auto-resolve | macro.ts |
| GET | /api/macro/risk-free-rate | macro.ts |
| GET | /api/macro/etf-flows | macro.ts |
| GET | /api/macro/etf-bid | macro.ts |
| GET | /api/macro/revision-breadth | macro.ts |
| GET | /api/options/mover-facts | mover-facts.ts |
| GET | /api/stocks/:ticker/options-flow | options-flow.ts |
| GET | /api/options-flow/latest | options-flow.ts |
| GET | /api/research/scoreboard | options-history.ts |
| GET | /api/options/candidates | options.ts |
| GET | /api/options/rankings | options.ts |
| GET | /api/options/structures | options.ts |
| GET | /api/options/structures/backtest | options.ts |
| POST | /api/options/structures/price | options.ts |
| POST | /api/options/structures/template | options.ts |
| POST | /api/options/rankings/refresh | options.ts |
| GET | /api/options/batch | options.ts |
| GET | /api/options/quote-dq | options.ts |
| GET | /api/options/:ticker/structures/rank | options.ts |
| GET | /api/options/:ticker/term-structure | options.ts |
| GET | /api/peers/groups | peer-overrides.ts |
| GET | /api/peers/:ticker | peer-overrides.ts |
| PUT | /api/peers/:ticker/group | peer-overrides.ts |
| DELETE | /api/peers/:ticker/group | peer-overrides.ts |
| PUT | /api/peers/group/:groupId/member | peer-overrides.ts |
| DELETE | /api/peers/group/:groupId/member/:ticker | peer-overrides.ts |
| POST | /api/peers/cleanup-override-duals | peer-overrides.ts |
| GET | /api/pm/odds | pm-alerts.ts |
| GET | /api/pm/house-view | pm-alerts.ts |
| POST | /api/pm/what-if | pm-alerts.ts |
| POST | /api/pm/risk-override | pm-alerts.ts |
| GET | /api/pm/risk-override | pm-alerts.ts |
| POST | /api/portfolio/ingest | portfolio-ingest.ts |
| GET | /api/portfolio/iv-rank-backtest | portfolio-snapshot.ts |
| POST | /api/portfolio/risk | portfolio-snapshot.ts |
| GET | /api/strategies/put-band | put-band.ts |
| PUT | /api/strategies/put-band | put-band.ts |
| GET | /api/put-manage | put-manage.ts |
| GET | /api/research/lseg/audit | research-lseg.ts |
| GET | /api/research/lseg/signals | research-lseg.ts |
| GET | /api/research/lseg/radar | research-lseg.ts |
| GET | /api/research/lseg/:ticker | research-lseg.ts |
| GET | /api/research/ops | research-ops.ts |
| GET | /api/research/wrds/signals | research-wrds.ts |
| GET | /api/research/wrds/:ticker | research-wrds.ts |
| GET | /api/schwab/status | schwab.ts |
| POST | /api/schwab/oauth/start | schwab.ts |
| GET | /api/schwab/oauth/status | schwab.ts |
| POST | /api/schwab/oauth/complete | schwab.ts |
| GET | /api/research/score-outliers | score-outliers.ts |
| POST | /api/research/score-outliers/disposition | score-outliers.ts |
| PUT | /api/scoring-config | scoring-config.ts |
| GET | /api/stocks/:ticker/session-flow | stock-context.ts |
| GET | /api/stocks/:ticker/media-sentiment | stock-context.ts |
| GET | /api/stocks/:ticker/insiders | stock-context.ts |
| GET | /api/stocks/:ticker/events | stock-context.ts |
| GET | /api/stocks/:ticker/edges | stock-edges.ts |
| GET | /api/stocks/quotes | stocks.ts |
| POST | /api/stocks/news-summary | stocks.ts |
| GET | /api/stocks/edgar-statements/:ticker | stocks.ts |
| GET | /api/strategies | strategies.ts |
| GET | /api/strategy-signals/active | strategies.ts |
| GET | /api/trade-funnel/today | strategies.ts |
| GET | /api/strategies/:id/signals | strategies.ts |
| GET | /api/strategies/:id | strategies.ts |
| GET | /api/strategy-board | strategy-board.ts |
| GET | /api/rankings/rules | strategy-rules.ts |
| GET | /api/technicals/rankings | technicals.ts |
| GET | /api/technicals/:ticker | technicals.ts |
| POST | /api/technicals/refresh/:ticker | technicals.ts |
| GET | /api/track-record/summary | track-record.ts |
| GET | /api/track-record/by-ticker | track-record.ts |
| GET | /api/track-record/ticker-summary | track-record.ts |
| GET | /api/track-record/recs | track-record.ts |
| GET | /api/track-record/ticker/:ticker | track-record.ts |
| GET | /api/track-record/regime | track-record.ts |
| GET | /api/track-record/tilt | track-record.ts |
| POST | /api/track-record/run | track-record.ts |
| GET | /api/trade-journal | trade-journal.ts |
| GET | /api/stocks/:ticker/vol-metrics | vol-metrics.ts |
| GET | /api/watchlist/meta | watchlist.ts |
| GET | /api/watchlist/user/:username | watchlist.ts |
| GET | /api/watchlist/model | watchlist.ts |
| PATCH | /api/watchlist/:ticker | watchlist.ts |
| GET | /api/watchlist/position-odds | watchlist.ts |
<!-- AUTOGEN:END -->
