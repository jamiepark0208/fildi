# TradeDash

A personal trading dashboard for stock analysis, options scanning, portfolio tracking, and intraday market monitoring. Authentication-gated; users log in to access their watchlist, ranked signals, technicals, portfolio P&L, and a live intraday monitor.

## Run & Operate

### Dev (Replit workspace)
The two managed workflows run automatically when you Start the Replit app. Never start them by hand — they require secrets injected by Replit's supervisor.

| Service | Port | Log | Hot-reload? |
|---|---|---|---|
| `stock-compare` (Vite frontend) | 8081 | `/tmp/vite-dev.log` | **Yes** — edit src, browser updates instantly |
| `api-server` (Express backend) | 8080 | `/tmp/api-server.log` | **No** — must rebuild + restart manually |

**After any backend (`artifacts/api-server/src/**`) change:**
```bash
cd /home/runner/workspace/artifacts/api-server && node build.mjs
pkill -f "node --enable-source-maps dist/index.mjs"
sleep 3 && curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/daily-brief
# expect 200 or 401
```
Kill only the child (`node dist/index.mjs`), never the `start.sh` supervisor — it auto-relaunches the child with secrets attached. Never kill any process whose parent is PID 24 (Replit's platform supervisor).

### Prod (published Replit deployment)
The production app runs the same `start.sh` → `node dist/index.mjs` process but with production secrets and its **own isolated DATABASE_URL**. Updates reach prod only via Replit's **Publish** button — there are no manual prod deploy commands.

**Dev/prod separation rules:**
- `pnpm --filter @workspace/db run push` — dev DB only. Never run against prod.
- Schema migrations for prod: apply the equivalent raw SQL via the production DB connection (use the database skill to confirm prod DB state first).
- Never curl localhost to verify prod — check the published deployment URL or use Replit's deployment logs.
- `SESSION_SECRET` and `DATABASE_URL` differ between environments; Replit injects the correct values per environment automatically.

### Other useful commands
```bash
pnpm run typecheck                             # full TS check across all packages
pnpm run build                                 # typecheck + esbuild bundle
pnpm --filter @workspace/api-spec run codegen  # regenerate API hooks + Zod schemas from OpenAPI spec
npx tsc -b lib/db                              # rebuild lib/db declarations (required after schema edits, before typecheck)
node .claude/scripts/rehydrate.js              # inject session state (run at start of every agent session)
codegraph context "<task description>"         # find entry points before reading source files
```

## Stack

- **Monorepo**: pnpm workspaces, Node.js 24, TypeScript 5.9
- **Frontend**: React 18, Vite, Tailwind CSS, shadcn/ui, TanStack Query, Wouter
- **Backend**: Express 5, esbuild (ESM bundle → `dist/index.mjs`)
- **DB**: PostgreSQL + Drizzle ORM (`lib/db/src/schema/index.ts` is the source of truth for all tables)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API contract**: OpenAPI spec → Orval codegen (hooks + Zod schemas)
- **Caching**: in-process `TTLCache` only — no Redis, no shared cache

## Where things live

```
artifacts/api-server/src/
  app.ts              — Express app (middleware, router mounts)
  index.ts            — process entry (port bind, scheduler start, seeder)
  routes/             — route files (no /api prefix inside files; prefix added in app.ts)
  lib/
    ttl-cache.ts      — shared TTLCache utility
    cache-registry.ts — all 22+ named caches must be registered here
    scheduler.ts      — nightly jobs (enrichment, AV backfill, etc.)
    indicators.ts     — V1 RSI/MFI scoring (indicatorCache → indicator_cache table)
    technical-scorecard.ts — V2 55-col scorer (→ ticker_technicals table)
    constants.ts      — RSI thresholds, tier configs (31-ticker legacy map)

artifacts/stock-compare/src/
  App.tsx             — router + providers
  pages/              — one file per route (rankings, watchlist, technical, portfolio,
                        options-scanner, macro, sentiment, live, feed, settings, profile)
  context/            — AuthContext, ScoringPreferencesContext
  lib/                — client-side helpers, option-scorer, rankings helpers

lib/db/src/schema/index.ts   — source of truth for all 37 DB tables (Drizzle)
artifacts/api-server/openapi.yaml — API contract (source for Orval codegen)
```

## Architecture decisions

1. **Two independent scoring systems, both rendered**: V1 (RSI/MFI → `indicator_cache`) is the simple GO/WATCH/NO signal. V2 (55+ cols → `ticker_technicals`) is the full technical scorecard. They run independently; neither replaces the other.
2. **All Yahoo Finance / FMP / AV calls go through TTLCache** — never call external APIs in React renders or on every request. Every new cache instance must be registered in `cache-registry.ts`.
3. **Drizzle returns numeric columns as strings** — always `parseFloat()` (or `Number()`) before returning numeric values from API routes.
4. **Express route ordering is critical** — declare specific routes (e.g. `/options/position-quote`) before wildcard routes (e.g. `/options/:ticker`) or the wildcard swallows them.
5. **Bronze→Silver→Gold fundamentals pipeline** — 257-ticker universe in `fmp_fundamentals` (168 canonical + 89 peer group). Refreshed biweekly by `nightly-enrichment.ts`, not at boot. See `.claude/skills/db-patterns.md` for details.

## Product

Pages accessible after login:
- **Rankings** — scored stock list with V1/V2 signal badges
- **Watchlist** — personal ticker list with live quotes and tag management
- **Technical** — per-ticker scorecard with indicators, price chart, TradingView widget
- **Portfolio** — imported positions/orders, realized P&L charts, broker integration
- **Options Scanner** — cash-secured put screener with income%, DTE, and delta filters
- **Macro** — macro indicators, COT data, economic calendar
- **Sentiment** — market sentiment indicators
- **Live** — intraday monitor (Phase 1: WebSocket candles + hotlist, shipped 2026-07-15)
- **Feed / Daily Brief** — AI-generated market summary

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Never kill a ppid-24 process** — Replit's platform supervisor owns those; killing one can cascade and take down both workflows (incident: 2026-07-10).
- **After any `lib/db/src/schema/index.ts` edit** run `npx tsc -b lib/db` before typechecking — stale declarations cause false "no exported member" errors downstream.
- **`drizzle-kit push` fails non-interactively** when the DB has any unmanaged table (`session`, owned by connect-pg-simple). Apply new tables as raw SQL instead; see `.agents/memory/drizzle-schema-build-gotchas.md`.
- **Generic JSX syntax crashes Vite** — the Replit metadata plugin can't parse `<Comp<T> ...>`. Never use explicit generics in JSX; let TS infer from props.
- **`pnpm run dev`** in `api-server` is an alias for `dev:watch` (tsx watch) — this is for manual local sessions only, not the Replit managed workflow. The workflow always runs `start.sh` → `node dist/index.mjs`.

## Pointers

- `.claude/skills/` — domain skills: `build-and-run`, `data-architecture`, `db-patterns`, `api-design-patterns`, `caching-patterns`, `trader-context`
- `.claude/state.json` — current working/in-progress/blocked state; run `node .claude/scripts/rehydrate.js` to read it
- `.agents/memory/MEMORY.md` — durable cross-session lessons (port conflicts, route ordering, drizzle gotchas, etc.)
- `pnpm-workspace` skill — workspace structure, TypeScript project references, cross-package patterns
