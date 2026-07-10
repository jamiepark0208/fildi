# watchlist-peer-flag-cascade

| Field | Value |
|---|---|
| **Status** | done |
| **Priority** | P1 |
| **Area** | overprocessing / multi-user |
| **Effort** | S |
| **Benefit** | Med — limits global backfill expansion |
| **Implementation risk** | Med |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Reuse / update** | [`watchlist.ts` POST](../artifacts/api-server/src/routes/watchlist.ts) L44–69, `ticker_registry.fetchFundamentals` |

### Purpose
Stop synchronous peer-group fundamentals flagging on every watchlist add from expanding global fetch surface unbounded.

---

## 1. Finding + evidence

Adding one ticker sets `fetchFundamentals=true` on all peers in same peer group(s) immediately.

---

## 2. Repro

10 users each add different mega-cap → overlapping peer groups → most registry flagged.

---

## 3. Why this bug occurred

- **Intent:** Ensure peer comparables populated (good data quality goal).
- **Side effect:** Synchronous global side effect on user action.
- **Category:** overprocessing · missing async boundary

---

## 4. Permanent prevention

- Peer flagging only for tickers user actually added; peers flagged via scheduled job with budget.
- **Non-goals:** Remove peer coverage entirely

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Peers missing data | Nightly enrichment still processes registry |
| User expects instant peer data | UI warning already exists for no peer group |

---

## 6. Fix options

**A:** Remove peer bulk update; only flag added ticker.

**B:** Queue peer flags for nightly batch (log intent).

---

## 7. Acceptance criteria

- [ ] POST watchlist does not update >1 ticker registry row synchronously (except added ticker)
- [ ] Peer data still arrives via scheduled paths

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `routes/watchlist.ts` | Narrow peer update block |

---

## 9. Verify (before fix)

1. POST watchlist with ticker in a peer group (e.g. mega-cap).
2. Query `ticker_registry` — multiple peers have `fetch_fundamentals=true` beyond added ticker.

Code: `watchlist.ts` L44–69 bulk `update ticker_registry`.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/routes/watchlist.ts` | Remove or defer peer bulk `fetchFundamentals` update; keep single-ticker registry upsert only |

Peers still backfill via nightly enrichment / admin paths.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Integration | POST watchlist → at most 1 registry row updated synchronously (added ticker) | ✓ |
| Manual | Nightly enrichment still populates peer data over time | ✓ |

---

## 12. Manual-only

- Long-run registry size vs startup refresh universe (bug/4)

---

## 13. Regression watchlist

- New ticker still inserted into `ticker_registry` with `fetch_fundamentals=true`
- Peer group warning in POST response unchanged
- Do not break watchlist POST 201 shape

---

## DONE (2026-07-10)

**Cursor's fix options (§6) were incomplete.** Traced every reader of `fetch_fundamentals` before editing: `nightly-enrichment.ts`, `merge-trusted.ts`, `startup-refresh.ts`, `data-health.ts`, and every `backfill-*.ts` script all gate their universe on `WHERE fetch_fundamentals=true` — it's the single source-of-truth flag from the 2026-07-06 universe-unification work (`.claude/docs/phase-report-db-260704.md`). Option A ("just delete the block") would have permanently stranded peer tickers from ever getting fundamentals data — nightly enrichment does **not** already cover unflagged tickers, contrary to the task's §5 assumption. Also confirmed peer-relative scoring needs peers' fundamentals in the DB (not just cosmetic) — this was the explicit reason the peer bulk-flag was added in the first place.

**Fix implemented (Option B, moved not deleted):**
1. `routes/watchlist.ts` POST — removed the synchronous bulk `UPDATE ticker_registry SET fetch_fundamentals=true WHERE ticker IN (peers)`. Kept the single added-ticker upsert and the "no peer group" warning lookup unchanged.
2. `scripts/nightly-enrichment.ts` — added a peer-expansion step before the fetch pipeline runs: pulls peer-group members of the already-flagged universe that aren't flagged yet, caps at 25/run (`PEER_EXPANSION_CAP`), flips `fetch_fundamentals=true` for them (skipped under `--dry-run`), then folds them into the same run's fetch + `merge-trusted` pass so peer-relative scoring picks them up without waiting a second cycle.

**Verified live:**
- Built + restarted the real api-server process (killed the supervised pid, `start.sh`'s crash-restart loop brought it back up on the rebuilt `dist/`).
- Created a throwaway test user, logged in, `POST /api/watchlist {"ticker":"CMI"}` against `industrials.industrial_conglomerates_machinery` (13 unflagged peers) — confirmed via `psql` the flagged-peer count stayed at 0 before and after (previously this would have jumped to 13). Cleaned up the test user/watchlist row after.
- Verified the nightly-enrichment peer-expansion SQL logic with a read-only `psql` query mirroring the new drizzle queries exactly (no script invocation, no vendor calls, no `api_usage` writes) — found 294 pre-existing unflagged peers in the backlog, confirms the cap/query shape is sound.
- Did **not** invoke `nightly-enrichment.ts` end-to-end (dry-run or real) per explicit user decision — the app is a preview/prototype that isn't always running, and this wasn't a planned test session. The twice-weekly scheduler (`lib/scheduler.ts`, already wired since the 2026-07-10 01:55 DB-maintenance-strategy session) will pick up the new peer-expansion logic on its existing Sun/Thu 02:00 UTC cadence whenever the app happens to be running — no new job was scheduled by this fix.
- `tsc` clean on both touched files (2 pre-existing unrelated errors in `backfill-edgar.ts`/`merge-trusted.ts` confirmed via `git stash` to predate this change). All 35 existing unit tests pass.

**Not done:** end-to-end live run of the real (non-dry-run) nightly-enrichment fetch/merge path — deferred by user request, not a blocker for this bug's acceptance criteria.
