# observability-error-tracking

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | infra |
| **Effort** | S (~1 session) |
| **Created** | 2026-07-09 |
| **Source** | competitive-tech-research |

### Resolution (2026-07-10)
Added optional Sentry (no-op unless DSN set) with request-ID correlation: a `requestId` middleware generates/propagates `x-request-id` on every response; `@sentry/node` is initialized in `app.ts` and wired to `errorHandler.ts` to capture 5xx exceptions (tagged with requestId/method/url) — 4xx/Zod validation errors stay local-only; `@sentry/react` wraps the SPA in an `ErrorBoundary`; `custom-fetch.ts` lazy-reports 5xx API responses with the request-id tag. Activated by setting `SENTRY_DSN` (API) / `VITE_SENTRY_DSN` (frontend); both no-op when unset.
