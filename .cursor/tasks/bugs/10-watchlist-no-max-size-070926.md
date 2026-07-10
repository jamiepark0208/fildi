# watchlist-no-max-size

| Field | Value |
|---|---|
| **Status** | done — 2026-07-10 |
| **Priority** | P1 |
| **Area** | multi-user / perf |
| **Effort** | XS |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [12-watchlist-quote-n-plus-one](12-watchlist-quote-n-plus-one-070926.md) |
| **Reuse / update** | [`watchlist.ts` POST validation](../artifacts/api-server/src/routes/watchlist.ts) |

### Purpose
Cap watchlist size server-side to bound client N+1 quote fetches.

---

## 1. Finding + evidence

POST validates ticker length 1–10 but not row count. [`watchlist.tsx`](../artifacts/stock-compare/src/pages/watchlist.tsx) `useQueries` = 1 request per row.

---

## 2. Repro

Script 200 POST watchlist → browser hangs on quote fan-out.

---

## 3. Why this bug occurred

- **Category:** missing validation

---

## 4. Permanent prevention

- `MAX_WATCHLIST_SIZE` constant (e.g. 75) + 400 response.
- **Non-goals:** Pagination v1 (optional later)

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Power user hits cap | Clear error message; admin override later |

---

## 6. Fix options

**A:** Count rows before insert; reject if ≥ MAX.

---

## 7. Acceptance criteria

- [ ] POST returns 400 when at cap
- [ ] FE shows error toast

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/watchlist.ts` | COUNT guard |

---

## 9. Verify (before fix)

Script or loop: POST watchlist until 200+ rows — no server rejection today.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/watchlist.ts` | `MAX_WATCHLIST_SIZE` (recommend **≥ 75**; must be **> 31** after bug/19 register seed) |
| 2 | `artifacts/stock-compare/src/hooks/use-watchlist.ts` | Surface 400 error toast |

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Integration | POST at cap-1 OK; at cap → 400 | ✓ |
| Manual | New register (31 rows) can still add tickers | ✓ |

---

## 12. Manual-only

- FE toast copy review

---

## 13. Regression watchlist

- Register seed (bug/19) + POST shape unchanged
- PK `(user_id, ticker)` conflicts still `onConflictDoNothing`

---

## DONE (2026-07-10)

Added `MAX_WATCHLIST_SIZE = 75` guard in `routes/watchlist.ts` POST — counts existing rows via `db.$count` before insert, returns 400 when at cap. `use-watchlist.ts` `addEntry` now checks `res.ok` and surfaces the 400 via `toast()` (destructive variant), matching the existing error-toast pattern in `price-chart.tsx`. Verified via `pnpm --filter @workspace/api-server test` (35 pass) and `tsc --noEmit` on both packages (clean).
