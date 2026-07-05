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

## Route file map
```
routes/admin-cache.ts      → /api/admin/cache/*
routes/auth.ts             → /api/auth/*, /api/admin/invite*, /api/admin/users
routes/daily-brief.ts      → /api/daily-brief/*
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
