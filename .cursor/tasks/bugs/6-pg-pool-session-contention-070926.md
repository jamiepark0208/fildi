# pg-pool-session-contention

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | continuous-run / multi-user |
| **Effort** | S |
| **Benefit** | Med — fewer pool timeouts under concurrent load |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`lib/db/src/index.ts`](../lib/db/src/index.ts) pool, [`app.ts`](../artifacts/api-server/src/app.ts) connect-pg-simple |

### Purpose
Tune PostgreSQL pool; avoid session store starving app queries.

---

## 1. Finding + evidence

`new Pool({ connectionString })` — default `max` ~10, shared by Drizzle + `connect-pg-simple` sessions.

[`data-health`](../artifacts/api-server/src/routes/data-health.ts) full table scans + enrichment hold connections.

---

## 2. Repro

Concurrent users + admin data-health during enrichment → `timeout acquiring client` in logs (under load).

---

## 3. Why this bug occurred

- **Genesis:** Low concurrency assumed; defaults fine for dev.
- **Category:** omission · scale assumption

---

## 4. Permanent prevention

- Document `DATABASE_POOL_MAX` in env example.
- **Non-goals:** Separate RDS; read replicas

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Too many connections vs PG limit | Set max ≤ provider limit (e.g. 20) |
| Second pool complexity | Optional phase 2 |

---

## 6. Fix options

**A:** `max: 20`, `idleTimeoutMillis: 30000` on pool.

**B:** Dedicated small pool for sessions (2–3 connections).

---

## 7. Acceptance criteria

- [ ] Pool config env-tunable
- [ ] No regression single-user dev

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/db/src/index.ts` | Pool options from env |

---

## 9. Verify (before fix)

Read `lib/db/src/index.ts`: `new Pool({ connectionString })` — defaults only.

Under load (manual/k6): logs `timeout acquiring client` during enrichment + concurrent API.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `lib/db/src/index.ts` | `max`, `idleTimeoutMillis` from `DATABASE_POOL_MAX` env (e.g. 20) |
| 2 | `.env.example` or build-and-run skill | Document |

Optional phase 2: dedicated small pool for `connect-pg-simple` in `app.ts`.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Single-user dev — no regression | ✓ |
| Manual | Concurrent requests during enrichment | no pool timeout |
| CI | api-server tests | pass |

---

## 12. Manual-only

- Load test proving fix under production concurrency
- Provider max connections limit

---

## 13. Regression watchlist

- Same `pool` used by Drizzle + session store — do not create orphan pools without documenting total connection budget
