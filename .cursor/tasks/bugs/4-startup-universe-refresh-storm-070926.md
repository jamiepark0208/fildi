# startup-universe-refresh-storm

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | continuous-run / infra |
| **Effort** | M (~1 session) |
| **Benefit** | High — stable boot under redeploy/crash loops |
| **Implementation risk** | Med — over-gating leaves stale data |
| **Created** | 2026-07-10 |
| **Source** | bugs audit |
| **Related** | [enh/28](../enhancements/28-job-queue-background-workers-070926.md) deferred, [bug/8](8-scheduler-restart-drift-070926.md) |
| **Reuse / update** | [`getStaleTickers`](../artifacts/api-server/src/lib/fundamentals-db.ts) (7d), [`getStaleTechnicalTickers`](../artifacts/api-server/src/lib/technicals-db.ts), [`checkFMPBudget`](../artifacts/api-server/src/lib/fundamentals-db.ts), [`withRetry`](../artifacts/api-server/src/lib/retry.ts), [`index.ts` startup](../artifacts/api-server/src/index.ts) |

### Purpose
Stop full FMP-universe fundamentals + technicals refresh on every process boot.

---

## 1. Finding + evidence

[`index.ts` L38–75](../artifacts/api-server/src/index.ts): on `listen`, loads **all** `fmp_fundamentals` tickers, runs stale fundamentals refresh + stale technicals refresh with retry.

Redeploy / crash loop → repeated FMP/Yahoo/DB work ([enh/28](../enhancements/28-job-queue-background-workers-070926.md) audit noted same).

---

## 2. Repro

1. Restart API 5× in 10 minutes.
2. Logs show `startup: refreshing stale FMP fundamentals` with large count each time.
3. FMP budget counters increment repeatedly.

---

## 3. Why this bug occurred

- **Genesis:** Ensure cold DB gets warm after deploy.
- **Drift:** Universe grew to full FMP table (~257); stale logic correct but **scope too wide on boot**.
- **Category:** overprocessing · missing env gate

---

## 4. Permanent prevention

| Guardrail | Detail |
|---|---|
| Env `STARTUP_REFRESH=off` for dev | Document in CURSOR.md |
| Metrics | Log `{ staleCount, skipped, durationMs }` once per boot |
| **Non-goals** | No pg-boss in this bug (enh/28); no disable scheduler |

---

## 5. Fix side-effects

| Risk | Mitigation |
|---|---|
| Stale data after deploy | Scheduler + manual admin refresh still exist |
| Skipping needed bootstrap | First boot empty DB → admin path or `STARTUP_REFRESH=full` once |
| WATCHLIST-only vs registry | Use `fetchFundamentals=true` registry subset, not entire fmp table |

---

## 6. Fix options

**A:** Env gate `SKIP_STARTUP_REFRESH=true` default false; when true skip block entirely.

**B (recommended):** Cap startup refresh to tickers with `ticker_registry.fetchFundamentals=true` **and** stale >7d, max N per boot (e.g. 20).

---

## 7. Acceptance criteria

- [ ] Boot does not refresh entire FMP universe by default
- [ ] Stale tickers still refresh over time (scheduler/admin)
- [ ] Document env flags in build-and-run skill

---

## 8. Implementation research pack

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/index.ts` | Narrow startup query + cap |
| **P1** | `.claude/skills/build-and-run.md` | Env docs |

---

## 9. Verify (before fix)

1. Restart API 3× in 10 minutes.
2. Logs: `startup: resolved FMP universe` with count ≈ full `fmp_fundamentals` table (~257).
3. `startup: refreshing stale FMP fundamentals` with large `count` each boot.

Read: `artifacts/api-server/src/index.ts` listen callback — `db.select` from `fmpFundamentals`.

---

## 10. Fix (files)

| Order | Path | Change |
|---|---|---|
| 1 | `artifacts/api-server/src/lib/startup-refresh.ts` | **New:** universe = `ticker_registry.fetch_fundamentals=true` (fallback `WATCHLIST`); cap `STARTUP_REFRESH_CAP` (default 25); `SKIP_STARTUP_REFRESH=true` |
| 2 | `artifacts/api-server/src/index.ts` | Replace fmp-universe block with `runStartupStaleRefresh()` |
| 3 | `.claude/skills/build-and-run.md` | Document env vars |

Reuse: `getStaleTickers`, `checkFMPBudget`, `getStaleTechnicalTickers`, `refreshTechnicals`, `withRetry`.

---

## 11. Test (after fix)

| Type | Action | Pass |
|---|---|---|
| Manual | Boot logs show `cap: 25` (or env), not full universe count | ✓ |
| Manual | `SKIP_STARTUP_REFRESH=true` → no startup refresh logs | ✓ |
| Manual | Scheduler + admin refresh still work for stale data | ✓ |
| CI | api-server tests pass | pass |

---

## 12. Manual-only

- FMP budget counter on real API key
- Interaction with bug/9 peer registry growth

---

## 13. Regression watchlist

- `runSeed()` still runs on boot
- `startScheduler()` unchanged
- Do not disable nightly enrichment (bug/8 separate)
