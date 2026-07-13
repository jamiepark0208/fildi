# unauthenticated-vendor-routes

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P0 |
| **Area** | security |
| **Effort** | M (~1 session) |
| **Benefit** | Critical — stops vendor/LLM cost abuse; required for multi-user production |
| **Implementation risk** | Med — wrong allowlist breaks health/auth/macro reads |
| **Created** | 2026-07-10 |
| **Source** | bugs production-readiness audit |
| **Type** | FIX (auth boundary) |

## Resolution

Confirmed stocks/options/explain/technical/indicators/sdm routes had zero server-side auth. Fixed via path-scoped `router.use([...paths], requireAuth)` directly on the parent router in `routes/index.ts`, rather than a wrapper sub-router with a blanket `.use(requireAuth)` — that pattern (used by `watchlist.ts`/`feed.ts`) leaks and blocks unrelated routes mounted after it. Those two routers are mounted last so nothing downstream can leak.

Also fixed two unrelated bugs found while verifying: `scoring-config.ts` had a duplicated `/api` prefix causing a 404 mismatch with the frontend, and a missing `app_config` table (schema-defined but never pushed) was created directly.

Verified live via curl: stocks/options/indicators/technical/explain/sdm return 401 anonymous; daily-brief/macro/fundamentals-rankings/scoring-config/healthz stay public; watchlist/feed retain their own pre-existing auth. Full test suite and typecheck clean (2 pre-existing unrelated errors noted, unaffected).
