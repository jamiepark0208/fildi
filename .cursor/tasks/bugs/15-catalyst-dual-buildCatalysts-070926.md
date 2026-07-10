# catalyst-dual-buildCatalysts

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | correctness / data-drift |
| **Effort** | S |
| **Benefit** | Med |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit · L-05 |
| **Related** | [enh/12](../enhancements/12-stock-breakdown-sections-improvements-070926.md), [enh/4](../enhancements/4-api-integration-test-harness-070926.md) |
| **Reuse / update** | Server [`catalysts.ts`](../artifacts/api-server/src/lib/catalysts.ts); delete FE [`catalysts-section.tsx`](../artifacts/stock-compare/src/components/catalysts-section.tsx) duplicate |

### Purpose
Single `buildCatalysts` on server; UI renders breakdown payload only.

---

## 1. Finding + evidence

L-05: `buildCatalysts` in API + FE `catalysts-section.tsx` L53+.

---

## 2. Repro

Change server catalyst rule → FE still shows old logic until both updated.

---

## 3. Why this bug occurred

- **Genesis:** FE built before breakdown API returned catalysts array.
- **Category:** duplication · stale FE path

---

## 4. Permanent prevention

- Grep CI rule: only one `buildCatalysts` in api-server.
- **Non-goals:** Client-side catalyst formatting

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Breakdown missing catalysts field | Ensure route always populates |
| Test import broken | Fix [catalysts.test.ts](../artifacts/api-server/src/lib/catalysts.test.ts) in enh/4 |

---

## 6. Fix options

**A:** Delete FE builder; map `breakdown.catalysts` directly.

---

## 7. Acceptance criteria

- [ ] One `buildCatalysts` definition (server)
- [ ] catalysts.test.ts in CI (enh/4)

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `catalysts-section.tsx` | Remove duplicate |
| **P0** | `routes/stocks.ts` breakdown | Verify `catalysts` in payload |

---

## 9. Verify (before fix)

`grep buildCatalysts artifacts/` — server `lib/catalysts.ts` + FE `catalysts-section.tsx` duplicate.

Change server urgency rule → FE still old until both updated.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/stock-compare/src/components/catalysts-section.tsx` | Delete local `buildCatalysts`; map `breakdown.catalysts` from API |
| 2 | `artifacts/api-server/src/routes/stocks.ts` | Confirm breakdown L649 always sets `catalysts` |

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| CI | `artifacts/api-server/src/lib/catalysts.test.ts` (20 tests) | pass |
| Manual | Stock breakdown catalysts match server rules | ✓ |
| Grep | Single `buildCatalysts` in api-server only | ✓ |

---

## 12. Manual-only

- Visual catalyst ordering in UI

---

## 13. Regression watchlist

- `catalysts.test.ts` import path `.ts` extension (Node test runner)
- Breakdown cache invalidation (`stocks.ts` bump comment) if payload shape changes
