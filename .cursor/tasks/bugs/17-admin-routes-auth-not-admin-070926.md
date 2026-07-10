# admin-routes-auth-not-admin

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | security |
| **Effort** | XS |
| **Benefit** | Low — ops metadata exposure |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`requireAdmin`](../artifacts/api-server/src/middleware/requireAdmin.ts) already on PATCH/DELETE cache |

### Purpose
Restrict cache status + data-health GET to admin role.

---

## 1. Finding + evidence

[`admin-cache.ts`](../artifacts/api-server/src/routes/admin-cache.ts) GET `/admin/cache/status` — `requireAuth` only.

[`data-health.ts`](../artifacts/api-server/src/routes/data-health.ts) — same.

---

## 2. Repro

Member session → GET cache status → 200 with entry counts.

---

## 3. Why this bug occurred

- **Intent:** Settings UI visible to members for transparency.
- **Category:** ACL inconsistency (mutations admin-only, reads member)

---

## 4. Permanent prevention

- `/admin/*` prefix → `requireAdmin` by default middleware.

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Members lose cache UI | Settings tab admin-only section already |

---

## 6. Fix options

**A:** Swap to `requireAdmin` on both GETs.

---

## 7. Acceptance criteria

- [ ] Member → 403 on both routes
- [ ] Admin → 200 unchanged

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `admin-cache.ts`, `data-health.ts` | requireAdmin |

---

## 9. Verify (before fix)

Member session (not admin):
```bash
curl -b member.cookie "http://localhost:$PORT/api/admin/cache/status"  # 200 today
curl -b member.cookie "http://localhost:$PORT/api/admin/data-health"  # 200 today
```

Settings UI already hides Cache Monitor for non-admin — API still leaks.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/admin-cache.ts` | GET `/admin/cache/status` → `requireAdmin` |
| 2 | `artifacts/api-server/src/routes/data-health.ts` | GET `/admin/data-health` → `requireAdmin` |

PATCH/DELETE cache already `requireAdmin`.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Member → 403 both GETs | ✓ |
| Manual | Admin → 200; Settings Cache + API Monitor tabs work | ✓ |

---

## 12. Manual-only

- None if admin test account exists

---

## 13. Regression watchlist

- `ApiMonitorTab` only visible to admin in `settings.tsx` — already gated
- Do not lock out admin cache clear/TTL PATCH
