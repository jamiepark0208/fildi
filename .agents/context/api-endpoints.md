# API Endpoint Catalog
> last_updated: 2026-06-18 | all routes mounted at /api in index.ts
> Before adding a new endpoint, check this file to avoid duplication.

## Health
| Method | Path | Purpose |
|---|---|---|
| GET | /api/healthz | Liveness check — returns 200 |

## Daily Brief
| Method | Path | Purpose |
|---|---|---|
| GET | /api/daily-brief | Full daily brief (macro + signals + positions) |
| GET | /api/daily-brief/market | Market snapshot only |
| GET | /api/daily-brief/history | Historical brief entries |
| GET | /api/daily-brief/context | Persistent context notes |
| PATCH | /api/daily-brief/context | Update context notes |

## Fundamentals (FMP-sourced, weekly refresh)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/fundamentals/rankings | All tickers ranked by fundamental score (V2) |
| GET | /api/fundamentals/status | Coverage report + FMP budget usage |
| POST | /api/fundamentals/refresh | Trigger FMP data fetch for missing tickers |

## Technicals (Yahoo OHLCV-sourced, daily refresh)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/technicals/all | All tickers with V2 technical scores (primary endpoint for UI) |
| GET | /api/technicals/status | Staleness check + last scored_at timestamps |
| POST | /api/technicals/refresh | Force re-score all tickers (add ?force=true to skip staleness check) |

## Technical (legacy V1 — do not use for new features)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/technical/scorecard | V1 scorecard (deprecated — use /technicals/all) |
| POST | /api/technical/refresh/:ticker | V1 per-ticker refresh (deprecated) |

## Options Chain
| Method | Path | Purpose | Cache |
|---|---|---|---|
| GET | /api/options/position-quote | Quote for an existing short put position | none |
| GET | /api/options/:ticker | Full options chain for ticker | 30 min TTL (optionsCache) |

**Note:** `/options/position-quote` MUST be declared before `/options/:ticker` in routes/options.ts — wildcard swallows it otherwise.

## Stocks / Indicators
| Method | Path | Purpose |
|---|---|---|
| GET | /api/indicators/:ticker | RSI, MFI, MACD, ATR for one ticker (V1 signal source) |
| GET | /api/indicators/batch | Batch indicators for multiple tickers (?tickers=A,B,C) |
| GET | /api/stocks/compare | Multi-ticker comparison data |
| GET | /api/stocks/search | Ticker search |
| GET | /api/stocks/history | OHLCV history for a ticker |
| GET | /api/stocks/quote | Current quote |
| GET | /api/stocks/breakdown | Fundamental breakdown + catalysts for a ticker (2h cache) |
| GET | /api/stocks/competitors/:ticker | Top 5 peers ranked 50/50 tech+fund (DB-first, peersCache 24h) |
| POST | /api/stocks/competitors/backfill | Auth — refresh stale/missing peer scores; adds to watchlist |

## Macro (FRED + Treasury, 4h file cache)
| Method | Path | Purpose |
|---|---|---|
| GET | /api/data | Full macro data payload (yields, VIX, rates, etc.) |
| GET | /api/charts | Pre-computed chart series |
| POST | /api/refresh | Force refresh FRED data cache |
| GET | /api/indicator-history | Historical FRED indicator values |
| GET | /api/sep-actuals | Fed SEP actual vs projected |
| GET | /api/sep-projections | Fed SEP projection data |
| GET | /api/highlights | Saved macro highlights |
| POST | /api/highlights/generate | AI-generate macro highlights |
| GET | /api/bank-news | Banking sector news |
| GET | /api/bank-research | Banking research notes |
| POST | /api/bank-research/generate | AI-generate bank research |
| GET | /api/fed-members | Fed committee member data |
| GET | /api/events | Upcoming economic events |

## AI
| Method | Path | Purpose | Model |
|---|---|---|---|
| POST | /api/explain/score | Explain a ticker's fundamental or technical score | Haiku, 200 tokens, no storage |

## Feed / Social
| Method | Path | Purpose |
|---|---|---|
| POST | /api/feed/posts | Create trade idea post |
| GET | /api/feed/posts | List posts (filter: ticker, username, status, sort) |
| GET | /api/feed/posts/:id | Single post with comments |
| PATCH | /api/feed/posts/:id/close | Close a post with closePremium |
| DELETE | /api/feed/posts/:id | Delete open post (owner or admin) |
| POST | /api/feed/posts/:id/like | Like a post |
| DELETE | /api/feed/posts/:id/like | Unlike a post |
| POST | /api/feed/posts/:id/comments | Add comment |
| DELETE | /api/feed/comments/:id | Delete comment |
| GET | /api/feed/profile/:username | Profile data + stats + posts |
| GET | /api/feed/buckets | All users' Bullish/Neutral/Bearish picks |
| GET | /api/feed/buckets/mine | Current user's picks |
| PUT | /api/feed/buckets | Upsert ticker into a bucket { ticker, bucket } |
| DELETE | /api/feed/buckets/:ticker | Remove ticker from user's buckets |

## Auth / Session
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/register | public + authLimiter | Register with invite code (Zod validated) |
| POST | /api/auth/login | public + authLimiter | Login (Zod validated) |
| POST | /api/auth/logout | public | Destroy session |
| GET | /api/auth/me | requireAuth | Current user info |

## Admin
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/admin/invite | requireAdmin | Generate new invite code |
| GET | /api/admin/invites | requireAdmin | List all invite codes with usedByEmail |
| DELETE | /api/admin/invite/:code | requireAdmin | Delete an invite code |
| GET | /api/admin/cache/status | requireAdmin | All cache stats (hits, misses, TTL, entries) |
| DELETE | /api/admin/cache/clear/:name | requireAdmin | Clear a named cache by name |

**Cache names:** search, compare, history, history-1d, quote, breakdown, options, options-expiry, peer-map, peer-profile

## Security middleware (applied globally in app.ts)
- `helmet()` — HTTP security headers (first middleware)
- `cors({ origin: FRONTEND_URL })` — origin whitelist
- `generalLimiter` — 200 req/15min
- `authLimiter` — 20 req/15min on /auth/register and /auth/login
- `errorHandler` — global error handler (last middleware, after router)

## Route file map
```
routes/admin-cache.ts   → /api/admin/cache/*
routes/auth.ts          → /api/auth/*, /api/admin/invite*, /api/admin/invites*
routes/daily-brief.ts   → /api/daily-brief/*
routes/explain.ts        → /api/explain/*
routes/fundamentals.ts   → /api/fundamentals/*
routes/health.ts         → /api/healthz
routes/indicators.ts     → /api/indicators/*
routes/macro.ts          → /api/data, /api/charts, /api/refresh, /api/highlights, /api/bank-*, /api/fed-*, /api/events, /api/sep-*
routes/options.ts        → /api/options/*
routes/stocks.ts         → /api/stocks/*
routes/technical.ts      → /api/technical/* (V1 — deprecated)
routes/technicals.ts     → /api/technicals/* (V2 — use this)
```
