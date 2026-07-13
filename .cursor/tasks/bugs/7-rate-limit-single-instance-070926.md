# rate-limit-single-instance

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | security / scale |
| **Effort** | S (proxy) / L (multi-instance store) |
| **Benefit** | Med until horizontal scale |
| **Implementation risk** | Low–Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Applied fix option A: `app.set('trust proxy', 1)` in `app.ts`, gated to `NODE_ENV === 'production'` only so dev stays direct-connection with no spoofing risk. Trusts exactly one hop, not the full chain. Documented the single-instance rate-limiter limitation as a comment directly in `rateLimiter.ts`. Redis-backed shared store (option B) intentionally not built — deferred until horizontal scaling is actually approved. Verified typecheck clean; did not verify `X-Forwarded-For` behavior against the real production proxy (manual-only, needs actual hop count).
