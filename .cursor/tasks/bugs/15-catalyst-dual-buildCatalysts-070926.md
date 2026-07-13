# catalyst-dual-buildCatalysts

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | correctness / data-drift |
| **Effort** | S |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit · L-05 |

## Resolution

Confirmed the server's `attachCatalysts()` in `routes/stocks.ts` runs on both the cache-hit and cache-miss response paths, so `catalysts` is always populated server-side — safe to delete the frontend fallback entirely rather than just deprioritize it. Removed the duplicate `buildCatalysts`/`analystLine`/`daysUntil` logic and now-unused types from `catalysts-section.tsx`, which is now a pure renderer taking only a `catalysts` prop; updated its one caller (`stock-breakdown.tsx`) to match. Verified exactly one `buildCatalysts` definition remains (server `lib/catalysts.ts`); typecheck clean on both packages, `catalysts.test.ts` (20 tests) and full api-server suite (40/40) pass.
