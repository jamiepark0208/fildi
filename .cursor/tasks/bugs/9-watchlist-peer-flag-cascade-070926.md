# watchlist-peer-flag-cascade

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | overprocessing / multi-user |
| **Effort** | S |
| **Benefit** | Med — limits global backfill expansion |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`watchlist.ts` POST](../artifacts/api-server/src/routes/watchlist.ts) L44–69, `ticker_registry.fetchFundamentals` |

### Purpose
Stop synchronous peer-group fundamentals flagging on every watchlist add from expanding global fetch surface unbounded.

---

## 1. Finding + evidence

Adding one ticker sets `fetchFundamentals=true` on all peers in same peer group(s) immediately.

---

## 2. Repro

10 users each add different mega-cap → overlapping peer groups → most registry flagged.

---

## 3. Why this bug occurred

- **Intent:** Ensure peer comparables populated (good data quality goal).
- **Side effect:** Synchronous global side effect on user action.
- **Category:** overprocessing · missing async boundary

---

## 4. Permanent prevention

- Peer flagging only for tickers user actually added; peers flagged via scheduled job with budget.
- **Non-goals:** Remove peer coverage entirely

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Peers missing data | Nightly enrichment still processes registry |
| User expects instant peer data | UI warning already exists for no peer group |

---

## 6. Fix options

**A:** Remove peer bulk update; only flag added ticker.

**B:** Queue peer flags for nightly batch (log intent).

---

## 7. Acceptance criteria

- [ ] POST watchlist does not update >1 ticker registry row synchronously (except added ticker)
- [ ] Peer data still arrives via scheduled paths

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/watchlist.ts` | Narrow peer update block |

---

## 9. Verify (before fix)

1. POST watchlist with ticker in a peer group (e.g. mega-cap).
2. Query `ticker_registry` — multiple peers have `fetch_fundamentals=true` beyond added ticker.

Code: `watchlist.ts` L44–69 bulk `update ticker_registry`.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/watchlist.ts` | Remove or defer peer bulk `fetchFundamentals` update; keep single-ticker registry upsert only |

Peers still backfill via nightly enrichment / admin paths.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Integration | POST watchlist → at most 1 registry row updated synchronously (added ticker) | ✓ |
| Manual | Nightly enrichment still populates peer data over time | ✓ |

---

## 12. Manual-only

- Long-run registry size vs startup refresh universe (bug/4)

---

## 13. Regression watchlist

- New ticker still inserted into `ticker_registry` with `fetch_fundamentals=true`
- Peer group warning in POST response unchanged
- Do not break watchlist POST 201 shape
