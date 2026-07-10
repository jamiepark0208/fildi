# portfolio-localstorage-not-server

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | multi-user / data |
| **Effort** | L |
| **Benefit** | High — portfolio follows user across devices |
| **Implementation risk** | High |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [enh/8](../enhancements/8-portfolio-analysis-improvements-070926.md), [`positions` routes](../artifacts/api-server/src/routes/positions.ts), [`portfolio-ingest`](../artifacts/api-server/src/routes/portfolio-ingest.ts) |
| **Reuse / update** | Server positions CRUD, RH snapshot query in [`portfolio.tsx`](../artifacts/stock-compare/src/pages/portfolio.tsx); replace [`use-portfolio.ts`](../artifacts/stock-compare/src/hooks/use-portfolio.ts) localStorage |

### Purpose
Manual portfolio entries should live in server `positions` (per userId), not unscoped localStorage.

---

## 1. Finding + evidence

`use-portfolio.ts`: `fildi_portfolio_v1` localStorage — no userId in key.

Server: `/positions` CRUD exists; portfolio page uses RH snapshot + legacy localStorage hybrid.

---

## 2. Repro

1. User A adds positions on Device 1.
2. Login Device 2 — manual entries missing (RH snapshot may appear if ingested).

---

## 3. Why this bug occurred

- **Genesis:** Client-only portfolio prototype.
- **Drift:** Server ingest + positions added; UI not fully migrated.
- **Category:** partial migration · wrong SSOT

---

## 4. Permanent prevention

- All portfolio hooks use API + `userId` in queryKey.
- **Non-goals:** Duplicate localStorage backup long-term

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Data loss on migration | One-time import localStorage → POST /positions |
| Dual-write period bugs | Feature flag migrate step |
| enh/8 scope overlap | Coordinate PRs |

---

## 6. Fix options

**A:** Migrate manual entries to `/positions`; deprecate localStorage.

**B:** Scope localStorage by userId interim — **not durable**

---

## 7. Acceptance criteria

- [ ] Positions persist per user server-side
- [ ] Second device sees same manual positions
- [ ] localStorage keys removed or migration complete

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `use-portfolio.ts` → API | Rewrite or new hook |
| **P0** | `portfolio.tsx` | Wire CRUD |
| **P1** | Migration util | One-time import |

**Coordinate with enh/8** before large UI refactor.

---

## 9. Verify (before fix)

1. User A adds manual positions on Device 1.
2. Login Device 2 — entries missing.

Code: `use-portfolio.ts` `fildi_portfolio_v1` — no `userId` in key. Server `/positions` CRUD exists.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/stock-compare/src/hooks/use-portfolio.ts` | Replace localStorage with `/api/positions` + `queryKey: ['positions', userId]` |
| 2 | `artifacts/stock-compare/src/pages/portfolio.tsx` | Wire CRUD; keep RH snapshot path separate |
| 3 | **New** `scripts/migrate-portfolio-localStorage.ts` or one-time UI import | POST localStorage → server |

**Field map needed:** localStorage entry shape ↔ `positions` table columns (document in PR).

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | CRUD round-trip per user | ✓ |
| Manual | Second device sees same positions | ✓ |
| Manual | Migration imports existing localStorage once | ✓ |
| CI | typecheck both packages | pass |

---

## 12. Manual-only

- RH snapshot vs manual positions UX boundary
- enh/8 PR coordination

---

## 13. Regression watchlist

- `/api/portfolio/snapshot/latest` ingest flow unchanged
- Do not delete localStorage until migration confirmed
