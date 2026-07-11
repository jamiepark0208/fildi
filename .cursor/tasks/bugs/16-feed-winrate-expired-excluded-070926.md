# feed-winrate-expired-excluded

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P2 |
| **Area** | correctness |
| **Effort** | S |
| **Benefit** | Med — trustworthy track record |
| **Implementation risk** | Low |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [enh/13](../enhancements/13-feed-improvements-070926.md), [new_app_features/7](../new_app_features/7-analyst-leaderboard-track-record-070926.md) |
| **Reuse / update** | [`feed.ts` profile SQL](../artifacts/api-server/src/routes/feed.ts) L412–414; align [`feed.tsx`](../artifacts/stock-compare/src/pages/feed.tsx) L122–124 |

### Purpose
Server profile win rate must count `EXPIRED_WIN` / `EXPIRED_LOSS` same as client TopPerformers.

---

## 1. Finding + evidence

Server: `wins`/`losses` only when `status = 'CLOSED'`.

Client feed.tsx: resolved includes `EXPIRED_WIN`, `EXPIRED_LOSS`.

---

## 2. Repro

Compare profile API winRate vs feed page client aggregation for user with expired posts.

---

## 3. Why this bug occurred

- **Genesis:** CLOSED = manual close path first.
- **Drift:** EXPIRED_* statuses added; profile SQL not updated.
- **Category:** drift · dual semantics

---

## 4. Permanent prevention

- Document status semantics in [api-design-patterns](../.claude/skills/api-design-patterns.md).
- Single SQL helper for "resolved" posts.
- **Non-goals:** Change EXPIRED definition

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Leaderboard rank shifts | Expected; note in release |
| OPEN vs EXPIRED edge cases | Unit test fixture posts |

---

## 6. Fix options

**A:** Extend SQL CASE to include EXPIRED_WIN/LOSS in wins/losses/resolved denominator.

---

## 7. Acceptance criteria

- [ ] Profile API matches feed.tsx client math for same user
- [ ] Document resolved status set in task + skill

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/feed.ts` | SQL CASE update |

---

## 9. Verify (before fix)

User with `EXPIRED_WIN` / `EXPIRED_LOSS` posts:
- Profile API `winRate` (server `feed.ts` L412–414 CLOSED-only)
- vs feed page TopPerformers (`feed.tsx` L122 includes EXPIRED_*)

Compare values — mismatch confirms bug.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/feed.ts` | Extend SQL CASE: resolved = CLOSED + EXPIRED_WIN + EXPIRED_LOSS |
| 2 | `.claude/skills/api-design-patterns.md` or task note | Document resolved status set |

Optional: extract shared `resolvedStatuses` constant used by FE + BE.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Unit | Fixture posts with mixed statuses → server winRate matches client helper | ✓ |
| Manual | Profile page matches feed aggregation | ✓ |

---

## 12. Manual-only

- Leaderboard rank shifts for real users — expected

---

## 13. Regression watchlist

- OPEN posts still excluded from win rate
- CLOSED manual close path unchanged

---

## DONE (2026-07-11)

Extended the `wins`/`losses` SQL CASE in `routes/feed.ts` (profile stats query) to also count `EXPIRED_WIN`/`EXPIRED_LOSS` statuses, matching `feed.tsx`'s client-side `TopPerformers` aggregation exactly (win if `CLOSED` with `resolved_pnl > 0`, or status is `EXPIRED_WIN`; loss otherwise for resolved statuses). `winRate` is derived from `wins`/`losses` only, so this fixes it without touching the separate `closed` stat (still CLOSED-only — distinct, correct meaning: manual closes). Added an inline comment documenting the resolved-status set per the task's prevention note. No unit test added — this codebase's test suite is pure-function only (no DB-fixture tests exist for any route), so a SQL CASE expression isn't testable in that pattern without a larger DB-fixture harness (out of scope here). Verified via typecheck (clean, same 2 pre-existing unrelated errors as main).
