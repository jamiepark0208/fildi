# session-table-growth

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | continuous-run |
| **Effort** | S |
| **Benefit** | Med — long-run DB health |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`connect-pg-simple`](../artifacts/api-server/src/app.ts), [`scheduler.ts`](../artifacts/api-server/src/lib/scheduler.ts) interval pattern |

### Purpose
Prune expired session rows so `session` table does not grow unbounded.

---

## 1. Finding + evidence

30-day rolling cookie; no prune job or `pruneSessionInterval` configured.

---

## 2. Repro

Inspect `session` table row count over months on prod-like env.

---

## 3. Why this bug occurred

- **Genesis:** Low user count; PG store set-and-forget.
- **Category:** omission · housekeeping

---

## 4. Permanent prevention

- Enable connect-pg-simple built-in prune OR weekly DELETE cron.
- **Non-goals:** Move sessions to Redis

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Prune active session | Library uses expire column correctly |

---

## 6. Fix options

**A:** `pruneSessionInterval: 900` (15 min) in PgSession config.

**B:** Scheduler job DELETE expired weekly.

---

## 7. Acceptance criteria

- [ ] Expired sessions removed automatically
- [ ] Active sessions unaffected

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `app.ts` | PgSession options |

---

## 9. Verify (before fix)

```sql
SELECT count(*) FROM session;
-- Re-check after months / many logins — monotonic growth
```

`app.ts`: no `pruneSessionInterval` on PgSession store.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/app.ts` | `pruneSessionInterval: 900` (15 min) on connect-pg-simple store config |

See connect-pg-simple docs — uses `expire` column.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Insert expired session row → pruned within interval | ✓ |
| Manual | Active session survives rolling cookie refresh | ✓ |

---

## 12. Manual-only

- Production `session` table size over months

---

## 13. Regression watchlist

- `rolling: true` cookie behavior unchanged
- Shared pool with bug/6 — prune adds light periodic DB load
