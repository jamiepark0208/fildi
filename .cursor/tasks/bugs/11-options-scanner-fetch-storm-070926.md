# options-scanner-fetch-storm

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | overprocessing / perf |
| **Effort** | M |
| **Benefit** | High — scanner usable with large watchlists |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [2-watchlist-global-constant-split](2-watchlist-global-constant-split-070926.md), [new_app_features/5](../new_app_features/5-scanner-simplified-view-070926.md) |
| **Reuse / update** | [`options-scanner.tsx`](../artifacts/stock-compare/src/pages/options-scanner.tsx) L989–998 auto-fetch, `handleExpand` lazy pattern L1001+ |

### Purpose
Stop auto-fetching options chains for every display ticker on scanner mount.

---

## 1. Finding + evidence

`useEffect` adds all `displayTickers` to `fetchedOnce` when loaded → `useQueries` fires options chain for each.

Combined with extra/hidden localStorage tickers — O(n) Yahoo per visit.

---

## 2. Repro

Watchlist 40 tickers → open scanner → network tab shows 40+ `/api/options/` parallel.

---

## 3. Why this bug occurred

- **Genesis:** ~31 tickers; instant scanner UX valued.
- **Drift:** Per-user watchlist + extras; no lazy load default.
- **Category:** overprocessing

---

## 4. Permanent prevention

- Default lazy fetch (expand row or visible viewport).
- **Non-goals:** Prefetch all on fast network

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| UX feels slower | Prefetch top 5 GO only |
| Sort by premium broken until fetch | Show skeleton; sort after load |

---

## 6. Fix options

**A:** Remove auto `useEffect`; only fetch on expand + manual refresh.

**B:** Fetch first 5 sorted tickers only; rest lazy.

---

## 7. Acceptance criteria

- [ ] Initial mount ≤5 options requests (or zero until interaction)
- [ ] Expanded row still loads chain

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `options-scanner.tsx` | Gate fetchedOnce population |

---

## 9. Verify (before fix)

1. Watchlist ~30+ tickers.
2. Open options scanner — Network: parallel `/api/options/{ticker}` for all display tickers on mount.

Code: `options-scanner.tsx` L989–998 auto-adds all `displayTickers` to `fetchedOnce`.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/stock-compare/src/pages/options-scanner.tsx` | Remove/gate L989–998 auto-fetch; keep `handleExpand` L1007 lazy pattern |
| 2 | Optional | Prefetch top 5 GO tickers only (Fix B) |

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Initial mount ≤5 or 0 options requests | ✓ |
| Manual | Expand row still loads chain | ✓ |
| Manual | Sort by premium shows skeleton then fills | ✓ |
| CI | stock-compare typecheck | pass |

---

## 12. Manual-only

- UX perceived slowness on expand

---

## 13. Regression watchlist

- `handleRowRefresh`, `handleOverride` still set `fetchedOnce`
- Hidden/extra tickers localStorage behavior unchanged
- Depends on bug/2 for correct ticker set
