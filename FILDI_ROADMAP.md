# FILDI Roadmap
> Read before starting any new feature. Tracks pending work, known-broken items, and architectural decisions.
> Updated: 2026-06-10

## Pending Features (priority order)

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | Options comparison table | ready | Side-by-side put option comparison UI |
| 2 | Strike explorer slider | ready | Interactive strike selection with premium preview |
| 3 | User management system | complete | express-session auth, invite-only register, per-user watchlist, admin UI, ProtectedRoute — Phases 0-4 done 2026-06-16 |
| 4 | FMP fundamentals backfill | ready | POST /api/fundamentals/refresh — check budget first via GET /api/fundamentals/status |
| 5 | Macro data live feed | ready | Replace file-cached FRED data with live polling |

## Known Issues / Technical Debt

| Item | Area | Priority |
|---|---|---|
| ivRank/ivPercentile use realized vol as IV proxy | Technical scorer | Low — upgrade after ~60d of atmPutIv history accumulates |
| putCallVolumeRatio/basicSkew use absolute mapping | Technical scorer | Low — upgrade to percentileRank after ~60d history |
| computeTechnicalRankings (V1) still exists alongside V2 | technical-rankings.ts | Low — remove after one release cycle |
| scorecard-explanation.tsx still shows V1 metrics | UI | Medium — update in next UI pass |
| FMP coverage partial (8 of watchlist tickers populated) | Data layer | Medium — blocked on manual refresh trigger |

## Architectural Decisions (standing)

- **Self-relative scoring**: both scorers rank tickers against each other (not absolute thresholds). Adding/removing a ticker changes all scores. This is intentional.
- **No Redis**: TTLCache in-process only. Acceptable for single-server Replit deployment.
- **FMP over Yahoo for fundamentals**: Yahoo Finance fundamentals endpoints are unstable. FMP is the stable source. Yahoo still used for OHLCV (chart()) and options chain.
- **Drizzle ORM**: schema-first. Always run migration after schema change. Never raw SQL for schema changes.
- **ESM build**: api-server is ESM (`.mjs` output). No CommonJS require() in server code.
- **Financial tickers (HOOD, SOFI)**: excluded from roicWaccSpread calculation — different accounting standards make the metric meaningless.
- **Options on-demand only**: never fetch the options chain on page load. Only fetch when a user explicitly triggers the options scanner.

## Completed (recent)
See `.agents/sessions/INDEX.md` for session log.
See `.claude/docs/phase-report*.md` for detailed phase reports.
