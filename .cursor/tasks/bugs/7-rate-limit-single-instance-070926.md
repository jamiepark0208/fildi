# rate-limit-single-instance

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | security / scale |
| **Effort** | S (proxy) / L (multi-instance store) |
| **Benefit** | Med until horizontal scale |
| **Implementation risk** | Low–Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [enh/29](../enhancements/29-redis-optional-shared-cache-070926.md) deferred |
| **Reuse / update** | [`rateLimiter.ts`](../artifacts/api-server/src/middleware/rateLimiter.ts) |

### Purpose
Correct client IP behind proxy; document single-instance limiter; plan shared store only when scaling.

---

## 1. Finding + evidence

In-memory `express-rate-limit`; no `app.set('trust proxy', 1)`. Multi-instance = 300×N req/15m.

---

## 2. Repro

Behind Replit/proxy — all users share one IP bucket (or wrong IP).

---

## 3. Why this bug occurred

- **Genesis:** Local dev direct connection.
- **Category:** omission · deployment assumption

---

## 4. Permanent prevention

- `trust proxy` when `NODE_ENV=production`.
- **Non-goals:** Redis store until multi-instance approved (enh/29).

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| trust proxy too broad | Set to 1 hop only |
| Stricter limit locks out power users | Tune max after [bug/1](1-unauthenticated-vendor-routes-070926.md) |

---

## 6. Fix options

**A:** `trust proxy` + document single-instance.

**B:** PG-backed rate limit (future).

---

## 7. Acceptance criteria

- [ ] Production proxy: rate limit per real client IP
- [ ] Document limitation for multi-dyno

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `app.ts` | trust proxy conditional |

---

## 9. Verify (before fix)

- `app.ts`: no `trust proxy`
- `rateLimiter.ts`: in-memory `express-rate-limit`, 300/15m general

Behind proxy: all clients may share one IP bucket.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/app.ts` | `app.set('trust proxy', 1)` when `NODE_ENV=production` |
| 2 | Document single-instance limiter in skill or CURSOR.md |

**Non-goals:** Redis store (enh/29).

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | `X-Forwarded-For` different clients → separate buckets (if testable) | ✓ |
| Manual | Local dev without proxy unchanged | ✓ |

---

## 12. Manual-only

- Replit/production proxy hop count
- Multi-dyno 300×N bypass (document only until shared store)

---

## 13. Regression watchlist

- `skipGeneralLimit` for `/api/auth` and `/api/healthz` preserved
- Less urgent after bug/1 auth gate
