# TradeDash — Project Context

Full context: `.agents/context/project.md`

Key facts inline for quick reference:
- Backend port 8080 (`artifacts/api-server/`) — **NO hot-reload, rebuild required after every src change**
- Frontend port 8081 (`artifacts/stock-compare/`) — Vite hot-reloads
- DB: PostgreSQL via Drizzle ORM (`lib/db/`)
- Watchlist tickers: query `watchlist` DB table (3 tiers)
- Financial tickers excluded from roicWaccSpread: HOOD, SOFI
