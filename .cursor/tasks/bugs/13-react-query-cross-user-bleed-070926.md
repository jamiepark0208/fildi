# react-query-cross-user-bleed

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | multi-user / security |
| **Effort** | XS |
| **Benefit** | Med — shared-browser privacy |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`use-watchlist.ts`](../artifacts/stock-compare/src/hooks/use-watchlist.ts), [`sidebar.tsx` logout](../artifacts/stock-compare/src/components/sidebar.tsx) |

### Purpose
Scope React Query cache to userId; clear on logout.

---

## 1. Finding + evidence

`queryKey: ["watchlist"]` — no userId. Logout only `refetch()` auth — watchlist cache stale until refetch.

Color tags use user-scoped localStorage key (good) but server list query is not.

---

## 2. Repro

1. Login User A — load watchlist.
2. Logout → Login User B on same browser without hard refresh.
3. Brief flash of User A tickers possible.

---

## 3. Why this bug occurred

- **Genesis:** Single user per browser assumed.
- **Category:** omission · cache key design

---

## 4. Permanent prevention

- Rule: all user-specific queryKeys include `user?.id`.
- Logout handler clears user queries.
- **Non-goals:** Clear entire queryClient (breaks public data)

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| undefined userId during load | Disable watchlist query until auth resolved |

---

## 6. Fix options

**A:** `queryKey: ['watchlist', userId]` + `removeQueries` on logout for watchlist, portfolio-snapshot.

---

## 7. Acceptance criteria

- [ ] User B never sees User A watchlist after logout/login
- [ ] No extra network when user unchanged

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `use-watchlist.ts` | queryKey |
| **P0** | `sidebar.tsx` | removeQueries on logout |

---

## 9. Verify (before fix)

1. Login User A — load watchlist.
2. Logout → Login User B (same browser, no hard refresh).
3. Brief flash of User A tickers possible.

Code: `use-watchlist.ts` L39 `QUERY_KEY = ["watchlist"]`; `staleTime: Infinity`.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/stock-compare/src/hooks/use-watchlist.ts` | `queryKey: ['watchlist', userId]`; `enabled: !!userId` |
| 2 | `artifacts/stock-compare/src/components/sidebar.tsx` | On logout: `queryClient.removeQueries({ queryKey: ['watchlist'] })` + portfolio keys |

Audit: `["data-health"]`, snapshot queries if user-specific.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | User B never sees User A watchlist after logout/login | ✓ |
| Manual | Same user refresh — no extra network | ✓ |

---

## 12. Manual-only

- Playwright 2-user flow (follow-on soak task)

---

## 13. Regression watchlist

- Color tags still user-scoped (`fildi_watchlist_colors_${userId}`)
- `invalidateQueries` on add/remove still works
