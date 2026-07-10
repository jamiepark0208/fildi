# competitive-tech-research
**Status:** done (research artifact)  
**Priority:** P0  
**Area:** research  
**Created:** 2026-07-09  
**Source:** competitive-research  

## Executive summary

TradeDash is **strong on data architecture for its scale** — multi-source fundamentals pipeline with provenance, budget-aware API clients, and DB-backed technical indicators — but **weak on engineering operations**: almost no automated tests, no CI, partial OpenAPI adoption, in-memory-only caching, and no job-queue observability. Competitors at similar user scale (Finviz, Koyfin) invest heavily in **pre-computed screeners, caching tiers, and monitoring**; options-focused apps (OptionStrat, Barchart) invest in **real-time data paths and vendor APIs**.

The gap is not "we need microservices" — it's **closing the loop between a sophisticated data pipeline and a reliable, observable product surface**.

---

## 10 benchmark apps (engineering lens)

| App | Stack (public signals) | Data strategy | Caching / perf | Build vs buy |
|---|---|---|---|---|
| **Koyfin** | TypeScript, NestJS, React, PG + MongoDB, AWS, K8s, Redis, RabbitMQ | Vendor feeds (FactSet, Refinitiv) + proprietary aggregation | Redis, distributed data flows, Datadog | Heavy vendor infra; microservices at scale |
| **Finviz** | React/TS frontend, .NET Core/C#, SQL Server, Python/Node tasks | Pre-indexed screener DB; ~100M API calls/day claimed | SQL query tuning, CDN (Cloudflare), Azure App Insights | Optimize monolith + SQL; minimal frontend framework churn |
| **Barchart** | Laravel, Redis, DynamoDB (historical API) | OnDemand API product; exchange FIX feeds for real-time | Redis + DynamoDB for million-req/sec historical paths | Vendor data + specialized stores per access pattern |
| **OptionStrat** | React frontend; proprietary backend | YFinance + Alpha Vantage + optional IB TWS socket | Recommended Redis for chains/spots (often in-memory in OSS clones) | Custom quant engine; vendor for market data |
| **TradingView** | Proprietary WebSocket protocol, custom chart engine | Real-time exchange feeds via persistent WS sessions | Stateful WS sessions, edge CDN, pre-aggregated bars | Build proprietary streaming; Pine Script ecosystem |
| **TipRanks** | Enterprise SaaS (undisclosed; typical: Java/Node + PG) | Analyst ratings + performance tracking DB | CDN + server-side aggregation | Buy data; build trust/scoring layer |
| **Seeking Alpha** | Large content platform (CMS + market data) | Editorial + quant ratings pipelines | Heavy CDN, search indexing (Elasticsearch-class) | Content platform patterns |
| **StockTwits** | Social API + real-time feeds | User-generated + market tickers | Real-time pub/sub (likely Redis/Kafka class) | Social infra vendors |
| **Robinhood** | Python/Java microservices, Kafka, Cassandra (historical blog posts) | Internal ledger + vendor market data | Event-driven, multi-region | Build core brokerage; vendor market data |
| **TradeDash** | Express ESM, React/Vite, Drizzle/PG, Orval (partial) | 7+ source Bronze→Silver→Gold pipeline | In-memory TTLCache + JSON file caches; PG for indicators | Build data pipeline; buy UI (Radix/shadcn); under-buy ops |

---

## What TradeDash does well (keep / extend)

### 1. Multi-source fundamentals pipeline (institutional pattern)
Bronze staging tables → `source_fundamentals` → `ticker_fundamentals` with `FIELD_DEFS` priority in `merge-trusted.ts`. `field_provenance` + `manual_overrides` — most retail competitors don't expose this depth.

**Benchmark:** Koyfin/FactSet do similar internally; Finviz hides it. **TradeDash advantage:** transparency + admin overrides.

### 2. API budget governance
Unified `api_usage` table, `logApiCall()` on FMP/Yahoo/Finnhub/AV clients, FMP `fetchWithRetry` with 429 backoff. Prevents runaway backfill costs.

**Benchmark:** OptionStrat OSS docs recommend Redis + rate limiter — TradeDash already has DB-backed counters.

### 3. Cache registry + admin dashboard
`cache-registry.ts` centralizes TTLCache instances + file caches; `GET/PATCH/DELETE /api/admin/cache/*` for ops. Rare in apps this size.

### 4. Codegen foundation (underused)
OpenAPI spec + Orval → React Query hooks + Zod schemas in `lib/api-client-react` and `lib/api-zod`. Right architecture; incomplete coverage.

### 5. Security baseline
Helmet, express-rate-limit (general + auth), Zod validators, session in PG (`connect-pg-simple`), admin middleware.

### 6. Concurrency patterns in data workers
3-worker queue pattern in `seeder.ts`, `indicators.ts`, `macro-data.ts` — simple, effective for Yahoo rate limits.

### 7. Dev workflow tooling (meta)
Codegraph MCP, Cursor skills/rules — mirrors competitor "buy tooling to move fast" without shipping it to users.

---

## Deficiencies vs benchmarks

| Gap | TradeDash today | Benchmark behavior | Risk |
|---|---|---|---|
| **Test coverage** | 4 test files (3 frontend lib, 1 untracked API) | Finviz/Koyfin: CI gates, integration tests | Regressions in scoring/pipeline undetected |
| **CI/CD** | No `.github/workflows` | Finviz: CI/CD + Azure App Insights | Manual verification only |
| **OpenAPI coverage** | ~5 routes in spec; 25+ route files | Barchart OnDemand: API-first product | Type drift, duplicate fetch logic |
| **Client data layer** | Mix of Orval hooks + raw `fetch()` | Koyfin: consistent client cache layer | Duplicate requests, inconsistent error handling |
| **Cache durability** | In-memory TTLCache; macro on JSON files | Koyfin/Barchart: Redis; Finviz: SQL materialized views | Cold-start latency; cache lost on restart |
| **Background jobs** | Fire-and-forget `runSeed()` on boot | Finviz: scheduled pipelines; Koyfin: RabbitMQ queues | No retry visibility, no job dashboard |
| **Pre-computation** | Rankings computed on request | Finviz: pre-indexed screener (~100M req/day) | Slow home/scanner under load |
| **Real-time quotes** | Poll Yahoo on demand | TradingView/Barchart: WebSocket streams | Stale prices on watchlist; higher API load |
| **Observability** | Pino logs only | Koyfin: Datadog; Finviz: Azure App Insights | Production blind spots |
| **API dev UX** | Rebuild esbuild on every change | Standard: tsx watch / nodemon | Slow iteration on backend |
| **Bronze layer completion** | Polygon/AV tables empty | Multi-source is the design intent | Cross-validation unused |
| **Horizontal scale** | Single Node process assumptions | Koyfin: K8s replicas | In-memory cache breaks multi-instance |

---

## Build vs buy spectrum (where TradeDash should lean)

```
BUILD (core moat)          HYBRID                    BUY/VENDOR (commodity)
─────────────────────────────────────────────────────────────────────────
FIELD_DEFS merge           Orval/OpenAPI codegen     Radix/shadcn UI
Provenance pipeline        pg-boss on existing PG    Sentry error tracking
Scoring algorithms         React Query               FMP/Yahoo/Finnhub data
Peer resolution            GitHub Actions CI         Anthropic Haiku explain
Admin cache dashboard      Playwright smoke E2E      cmdk (already installed)
```

**Avoid for now:** Kubernetes, MongoDB second store, RabbitMQ, custom WebSocket protocol — premature for current scale.

**Consider when user count grows:** Redis (shared cache), read replicas, pre-computed materialized views.

---

## Vendor-tool analogies (Cursor/skills/plugins)

| Competitor pattern | TradeDash equivalent today | Enhancement opportunity |
|---|---|---|
| Koyfin Datadog dashboards | Admin cache status + api_usage | Add Sentry + freshness alerts |
| Barchart OnDemand API | Internal REST only | Expand OpenAPI → external API v1 later |
| OptionStrart LiteLLM router | Single Haiku explain route | Route table for model selection by score type |
| TradingView Pine Script plugins | Scorecard guide (static) | Plugin registry for custom screener filters (future) |
| Finviz export/API | CSV export scattered | Unified export endpoint from materialized rankings |
| GitHub Actions (industry default) | None | CI pipeline task |

---

## Recommended coding enhancement tasks (prioritized)

See `.cursor/tasks/INDEX.md` § Coding enhancements.

| P | Task | Rationale |
|---|---|---|
| P0 | `ci-pipeline-typecheck-tests` | Finviz/Koyfin baseline — gate regressions |
| P0 | `api-integration-test-harness` | Protect scoring + merge pipeline |
| P0 | `openapi-coverage-orval-migration` | Close spec↔implementation gap; kill raw fetch |
| P1 | `react-query-fetch-standardization` | Dedup + staleTime conventions across pages |
| P1 | `api-dev-hot-reload` | Remove esbuild friction in daily dev |
| P1 | `precomputed-rankings-materialization` | Finviz-style instant home/scanner |
| P1 | `job-queue-background-workers` | pg-boss for backfill/seeder with retry |
| P1 | `observability-error-tracking` | Sentry + request correlation |
| P2 | `redis-optional-shared-cache` | Multi-instance path without rewrite |
| P2 | `data-freshness-monitoring` | Admin alerts on stale fundamentals |
| P2 | `e2e-smoke-playwright` | Critical path automation |
| P2 | `polygon-av-backfill-completion` | Finish bronze cross-validation |

**Updated 2026-07-09 audit:** See § Audit below — 3 tasks deferred to P3; add `analyst-data-persistence`.

---

## Audit addendum (2026-07-09)

Initial engineering backlog **overstated infra gaps**. After codebase review:

| Finding | Action |
|---|---|
| TTLCache + PG persistence + startup withRetry already mature | Defer redis, job-queue, rankings materialization |
| `app.ts` already extracted | API test task revised |
| OpenAPI partial adoption | Incremental migration only |
| FMP free tier empty for per-bank PTs | New `analyst-data-persistence` task (Yahoo U/D Track 1, Finviz Track 2) |

**Revised engineering priority:**

| P | Task | Verdict |
|---|---|---|
| P0 | ci-pipeline, api-integration-tests | Keep |
| P1 | api-dev-hot-reload, observability, openapi (incremental), **analyst-data-persistence** | Keep / New |
| P2 | data-health, polygon/AV, e2e, react-query-keys | Keep / Revise |
| P3 | precomputed-rankings, job-queue, redis | **Deferred** |

Each engineering task file now includes **§10 Audit** with quantified benefit and negative impact.

---

## Sources consulted

- Koyfin careers pages (NestJS, PG, MongoDB, Redis, RabbitMQ, K8s, Datadog)
- Finviz careers + W3Techs stack survey
- Barchart/Vention portfolio (Laravel, Redis, DynamoDB)
- OptionStrat AI OSS docs (FastAPI, hybrid sources, Redis recommendation)
- TradingView WebSocket protocol docs (tvkit, tvdatafeed)
- TradeDash codebase: `project.md`, `cache-registry.ts`, `orval.config.ts`, `ttl-cache.ts`, `fmp-client.ts`, package.json test scripts

## Downstream tasks

All tasks listed above → individual files in `.cursor/tasks/2026-07-09-<slug>.md`
