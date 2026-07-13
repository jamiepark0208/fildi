# performance-resilience-optimization

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P0 |
| **Area** | perf / resilience / devx |
| **Effort** | L (waves A–D) |
| **Created** | 2026-07-10 |
| **Related** | [bug/4](../bugs/4-startup-universe-refresh-storm-070926.md), [bug/5](../bugs/5-ttlcache-unbounded-memory-070926.md), [bug/11](../bugs/11-options-scanner-fetch-storm-070926.md), [bug/12](../bugs/12-watchlist-quote-n-plus-one-070926.md), [enh/5](5-api-dev-hot-reload-070926.md), [enh/26](26-react-query-fetch-standardization-070926.md) |

### Resolution (2026-07-11)
All four waves shipped. **Wave A** (crash isolation): `RouteErrorBoundary.tsx` wired into `ProtectedRoute` so a page-level throw shows a fallback card instead of a full white screen; sidebar recovery is via the fallback's Home link rather than literal sidebar persistence (a full layout-shell refactor was judged out of scope). **Wave B** (perceived speed): `lib/query-keys.ts` unified the fundamentals-rankings key between home and scanner (real double-fetch fix), `lib/prefetch-policy.ts` does idle-time JS-chunk-only prefetching, all routes except Login are lazy-loaded behind a `PageSkeleton`. **Wave C** (linked bugs 4/5/11/12) was already closed by a prior session — skipped re-implementation. **Wave D** (devx): `tsx watch` dev server (folded into enh/5) plus `scripts/dev-up.sh` waiting on `/api/healthz` before starting Vite, verified under 60s. Not verified in-browser this session (Playwright unavailable) — correctness based on tsc + code review. Bundle-size baseline was not measured due to a pre-existing, unrelated Rollup/Sentry externalization build failure on `main`.
