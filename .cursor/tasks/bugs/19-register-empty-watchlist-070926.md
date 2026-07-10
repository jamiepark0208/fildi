# register-empty-watchlist

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | multi-user / onboarding |
| **Effort** | S (~1–2 hours) |
| **Benefit** | High — new users get working scorecard/scanner day one |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [2-watchlist-global-constant-split](2-watchlist-global-constant-split-070926.md), [`auth/register`](../artifacts/api-server/src/routes/auth.ts) |
| **Reuse / update** | `WATCHLIST` constant as seed list, [`watchlist` insert](../artifacts/api-server/src/routes/watchlist.ts) same shape as POST |

### Purpose
Seed default watchlist rows on register so new users are not empty while scorecard assumes tickers exist.

---

## 1. Finding + evidence

[`auth.ts` register](../artifacts/api-server/src/routes/auth.ts): inserts user only — **no watchlist rows**.

Scorecard/seeder assume ~31 tickers from constants; new user sees empty watchlist in UI.

---

## 2. Repro

1. Register new account.
2. `GET /api/watchlist` → `[]`.
3. Technical/scanner empty or confusing.

---

## 3. Why this bug occurred

- **Genesis:** Single shared constant watchlist; no per-user table initially.
- **Drift:** DB watchlist added; migration for existing users implicit (manual?) but **register path never seeds**.
- **Category:** omission · partial migration

---

## 4. Permanent prevention

- Register integration test: new user has ≥1 watchlist row.
- **Non-goals:** Do not force re-seed on every login; do not overwrite user edits (`onConflictDoNothing`).

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Duplicate rows on re-register | PK (userId, ticker) |
| User wanted empty start | Settings "reset to default" later (out of scope) |
| Large seed list slow | Batch insert once (~31 rows) |

---

## 6. Fix options

**A:** After user insert, bulk insert `WATCHLIST` tickers with default tier/status (mirror watchlist POST defaults).

**B:** Lazy seed on first `GET /watchlist` if empty — harder to test.

**Recommend A.**

---

## 7. Acceptance criteria

- [ ] New register → watchlist count = len(WATCHLIST) or documented subset
- [ ] Existing users unchanged
- [ ] Idempotent if register retried

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/routes/auth.ts` | Bulk insert after user create |
| **P1** | enh/4 test | Register fixture asserts watchlist rows |

**Wave 1** — ship with [bug/1](1-unauthenticated-vendor-routes-070926.md), [bug/4](4-startup-universe-refresh-storm-070926.md).

---

## 9. Verify (before fix)

1. Register new account.
2. `GET /api/watchlist` → `[]`.
3. Technical/scanner empty or confusing for new user.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/auth.ts` | After user insert: bulk `watchlist` insert from `WATCHLIST` + `getTier` + `status: "monitoring"` |
| 2 | Use `onConflictDoNothing()` | PK safety |

Mirror shape from `watchlist.ts` POST defaults.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | New register → watchlist count = len(WATCHLIST) (~31) | ✓ |
| Manual | Existing users unchanged | ✓ |
| Integration (enh/4) | Register fixture asserts watchlist rows | when available |
| CI | api-server tests | pass |

---

## 12. Manual-only

- Invite-only register flow with real DB

---

## 13. Regression watchlist

- Register still sets session cookie
- Invite code consumption unchanged
- bug/10 cap must be **> 31** if implemented same PR
