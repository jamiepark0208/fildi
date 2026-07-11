# scheduler-restart-drift

| Field | Value |
|---|---|
| **Status** | done — 2026-07-11 |
| **Priority** | P1 |
| **Area** | continuous-run |
| **Effort** | M |
| **Benefit** | Med — avoid duplicate enrichment |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [enh/28](../enhancements/28-job-queue-background-workers-070926.md) |
| **Reuse / update** | [`scheduler.ts`](../artifacts/api-server/src/lib/scheduler.ts), [`data-health`](../artifacts/api-server/src/routes/data-health.ts) `lastEnrichmentRun` |

### Purpose
Persist enrichment last-run so restart does not lose dedupe guard.

---

## 1. Finding + evidence

`lastEnrichmentRun` in module memory only. Restart during Sun/Thu 02:00 UTC window may re-run [`nightly-enrichment`](../artifacts/api-server/src/scripts/nightly-enrichment.ts).

---

## 2. Repro

Restart server at 02:15 UTC Sunday → enrichment runs again same day.

---

## 3. Why this bug occurred

- **Genesis:** In-process scheduler sufficient for single instance.
- **Category:** ephemeral state

---

## 4. Permanent prevention

- Persist `lastEnrichmentRun` to PG **`app_config`** table (reuse `scoring-config-db.ts` pattern).
- **Non-goals:** pg-boss (enh/28)

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Stale persisted date blocks run | Store ISO + compare UTC date only |
| Clock skew | Use DB `now()` |

---

## 6. Fix options

**A:** Insert/update `app_config` key `last_enrichment_run` (reuse pattern in `lib/scoring-config-db.ts` — table is **`app_config`**, not `scoring_config`).

**B:** File on disk (macro pattern) — less ideal multi-instance.

---

## 7. Acceptance criteria

- [ ] Restart preserves "ran today" guard
- [ ] data-health shows persisted timestamp

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/scheduler.ts` | Read/write persisted last run |
| **P1** | `lib/scoring-config-db.ts` or `app-config-keys.ts` | `app_config` KV storage |

---

## 9. Verify (before fix)

- `scheduler.ts`: `lastEnrichmentRun` module variable only
- `data-health` reads exported `lastEnrichmentRun` from scheduler

Restart server Sunday 02:15 UTC after enrichment → may run again same calendar day.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/lib/scoring-config-db.ts` or new `app-config-keys.ts` | `get/set` for `last_enrichment_run` ISO string |
| 2 | `artifacts/api-server/src/lib/scheduler.ts` | Load on start; persist after successful `runNightlyEnrichment` |
| 3 | `artifacts/api-server/src/routes/data-health.ts` | Read persisted value |

Pattern: same as `SCORING_CONFIG_KEY` → `app_config` table (`lib/db/src/schema/index.ts`).

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Run enrichment → restart → `shouldRunNow()` false same UTC day | ✓ |
| Manual | data-health shows persisted timestamp | ✓ |
| Unit | Mock persisted yesterday → allows run today | optional |

---

## 12. Manual-only

- Exact Sun/Thu 02:00 UTC window timing in production

---

## 13. Regression watchlist

- 30-minute heartbeat interval unchanged
- `enrichmentRunning` in-memory guard still prevents concurrent runs within process

---

## DONE (2026-07-11)

Applied fix option A, inline in `scheduler.ts` rather than a separate `app-config-keys.ts` (small enough to keep local, same select-then-insert-or-update pattern as `scoring-config-db.ts`, key `last_enrichment_run` on the existing `app_config` table — confirmed live via `to_regclass`, no migration needed since bug/1 already created it). `startScheduler()` is now async: it awaits `loadPersistedLastRun()` (hydrates the in-memory `lastEnrichmentRun` export from DB) before registering the 30-min interval, so `data-health.ts` needed no changes — it already reads that same export. After a successful run, `persistLastRun()` writes the ISO timestamp back. Updated `index.ts`'s call site to `.catch()` since the function is now async (matches the existing fire-and-forget pattern used for `runSeed`/`runStartupStaleRefresh` in that same listen callback). Verified: `pnpm run typecheck` clean (2 pre-existing unrelated errors only), 40/40 tests pass. Did not add a unit test for `shouldRunNow()`/persistence (optional per §11, and this repo's tests are pure-function only — DB-backed logic isn't covered by the existing pattern, same reasoning as bug/16). Manual restart-at-02:15-UTC verification not performed (§12, needs the actual schedule window).
