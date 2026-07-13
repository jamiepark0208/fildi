# admin-routes-auth-not-admin

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | security |
| **Effort** | XS |
| **Benefit** | Low — ops metadata exposure |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

Swapped `requireAuth` for `requireAdmin` on `GET /admin/cache/status` (`admin-cache.ts`) and `GET /admin/data-health` (`data-health.ts`); removed the now-unused `requireAuth` imports. Live-verified via curl against a rebuilt/restarted server rather than relying on typecheck alone: anonymous requests to both routes now return 401 (previously 200), and `healthz` remains unaffected. Member-session 403 wasn't separately re-tested this session, but `requireAdmin` wraps `requireAuth` internally and that code path was already proven correct on the existing PATCH/DELETE cache routes. Typecheck clean.
