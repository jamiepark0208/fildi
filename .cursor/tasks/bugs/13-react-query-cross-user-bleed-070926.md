# react-query-cross-user-bleed

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P1 |
| **Area** | multi-user / security |
| **Effort** | XS |
| **Benefit** | Med — shared-browser privacy |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |

## Resolution

`use-watchlist.ts` queryKey is now `['watchlist', userId]` with `enabled: !!userId`. The logout handler in `sidebar.tsx` calls `queryClient.removeQueries` for `['watchlist']` and `['portfolio-snapshot-latest']` (found via grep audit as the other user-scoped list query) before refetch/navigate, so a second user logging in on the same browser never sees a stale flash of the previous user's data. `['data-health']` was audited and intentionally left alone since it's global/admin state, not user-specific. Verified via typecheck and the full stock-compare test suite (268 pass).
