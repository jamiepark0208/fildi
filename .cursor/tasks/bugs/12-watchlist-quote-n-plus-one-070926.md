# watchlist-quote-n-plus-one

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | perf / multi-user |
| **Effort** | M |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`quoteCache`](../artifacts/api-server/src/routes/stocks.ts), [`buildMetrics`](../artifacts/api-server/src/routes/stocks.ts), Orval client |

### Purpose
Batch stock quotes for watchlist table instead of N parallel GETs.

---

## 1. Finding + evidence

[`watchlist.tsx` L128–133](../artifacts/stock-compare/src/pages/watchlist.tsx): `useQueries` per ticker → `/stocks/quote`.

Server cache helps globally but still N HTTP round-trips per user.

---

## 2. Repro

30 tickers → 30 concurrent quote requests on page load.

---

## 3. Why this bug occurred

- **Genesis:** Orval per-ticker hook pattern; small N.
- **Category:** N+1 · missing batch API

---

## 4. Permanent prevention

- Batch endpoint + single React Query key `['quotes', tickers.join()]`.
- **Non-goals:** GraphQL

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Partial ticker failure | Return per-ticker errors in batch JSON |
| URL length limit | POST body for >50 tickers |

---

## 6. Fix options

**A:** `GET /stocks/quotes?tickers=A,B,C` reusing quoteCache per key.

**B:** POST batch for large lists.

---

## 7. Acceptance criteria

- [ ] Watchlist page 1 request for quotes (or 1 POST)
- [ ] Cache hit rate unchanged or better

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/stocks.ts` | Batch route |
| **P0** | `watchlist.tsx` | Single query |
| **P1** | OpenAPI / Orval | Regenerate client |

---

## 9. Verify (before fix)

1. Watchlist 30 tickers.
2. DevTools Network: 30× `GET /api/stocks/quote?ticker=...` on watchlist page load.

Code: `watchlist.tsx` L128 `useQueries` + Orval per ticker.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/stocks.ts` | `GET /stocks/quotes?tickers=A,B,C` — internally `quoteCache.get/set` **per ticker** |
| 2 | `artifacts/stock-compare/src/pages/watchlist.tsx` | Single `useQuery` with joined tickers |
| 3 | OpenAPI + Orval regen | `getGetStockQuotes` or equivalent |

POST batch if >50 tickers (URL length).

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | 1 HTTP request for quotes on watchlist load | ✓ |
| Manual | Partial failure returns per-ticker errors | ✓ |
| CI | api-server + stock-compare tests | pass |

---

## 12. Manual-only

- Orval regen diff size in PR

---

## 13. Regression watchlist

- Per-ticker `quoteCache` TTL (1h) unchanged — do not shorten
- Sort by price/change still works with batch map
