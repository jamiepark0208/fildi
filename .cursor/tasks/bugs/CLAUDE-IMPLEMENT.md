# Claude — bug fix implementation guide

> **Scope:** `.cursor/tasks/bugs/` only. Implement bugs in **wave order** (see [INDEX.md](INDEX.md)).  
> **Do not** edit unrelated features. **Do not** mark tasks `done` until §9–§11 verified.

---

## Before any fix

1. Read **this file** + the specific bug task + [INDEX.md](INDEX.md) cluster/deps.
2. Load skills **one at a time** as needed:
   - `.claude/skills/caching-patterns.md` — TTLCache, registry, **do not shorten TTLs** to fix RAM
   - `.claude/skills/data-architecture.md` — FMP budget, stale windows, registry flags
   - `.claude/skills/api-design-patterns.md` — route auth, batch endpoints
   - `.claude/skills/build-and-run.md` — restart, env vars
   - `.claude/skills/systematic-debugging.md` — repro before patch
3. `codegraph impact <symbol>` before editing shared symbols.
4. Run baseline: `pnpm --filter @workspace/api-server test` + `pnpm --filter @workspace/stock-compare test` (Node 24 in CI; local may need `--experimental-strip-types` without `transform-types` on Node 26).

---

## Workflow map (existing infra — reuse, don't reinvent)

| Concern | SSOT in codebase | Admin / observe |
|---|---|---|
| In-memory API cache | `artifacts/api-server/src/lib/ttl-cache.ts` + per-route instances | `GET /api/admin/cache/status` (Settings → Cache Monitor, admin UI) |
| Cache registry | `artifacts/api-server/src/lib/cache-registry.ts` | Same |
| FMP stale refresh | `getStaleTickers` (7d), `checkFMPBudget` | logs + api-usage |
| Technicals stale | `getStaleTechnicalTickers`, `refreshTechnicals` | Stock DB tab |
| Startup boot refresh | `artifacts/api-server/src/index.ts` listen callback | env gate (bug/4) |
| Scheduler | `lib/scheduler.ts` — Sun/Thu 02:00 UTC, 30m heartbeat | `data-health` `lastEnrichmentRun` |
| KV config in PG | `app_config` table via `lib/scoring-config-db.ts` (`SCORING_CONFIG_KEY`) | **Not** `scoring_config` table |
| Per-user watchlist | `watchlist` table + `routes/watchlist.ts` | `GET /api/watchlist` |
| Registry backfill scope | `ticker_registry.fetch_fundamentals` | watchlist POST flags peers (bug/9) |
| Sessions | `connect-pg-simple` on shared `pool` in `app.ts` | `session` table row count |
| Auth | `requireAuth` / `requireAdmin` | bug/1 router pattern |
| Tests | `src/**/*.test.ts` glob in both packages | enh/3 CI, enh/4 harness |

---

## Standard sections (every bug task)

| § | Purpose |
|---|---|
| **9 Verify** | Repro **before** code change — expected bad behavior |
| **10 Fix** | Files to touch (ordered) |
| **11 Test** | Automated + manual **after** fix |
| **12 Manual-only** | Things Claude cannot confirm in sandbox |
| **13 Regression** | Files/flows that must still work |

When done: set task header `Status` → `done`, add `## DONE (date)` with commit-ish summary, update [INDEX.md](INDEX.md) matrix.

---

## Cluster reading order (read related tasks together)

### A — Watchlist multi-user SSOT
**2, 3, 10, 13** (+ **19** before UX test of 2)  
Shared goal: DB watchlist drives API + FE; `WATCHLIST` = seed template only.

### B — Fetch overprocessing
**9, 11, 12**  
User action → too many HTTP/vendor calls. Fixing **9** affects `ticker_registry` → cross-check **4** startup universe.

### C — Continuous-run server health
**5, 6, 8, 18**  
**5:** prune expired RAM only — **keep TTL values high**. **8:** persist to `app_config`, not fictional `scoring_config`.

### D — Security
**1, 7, 17** — **1** first (auth boundary).

### E — Data correctness
**15, 16** — small, isolated.

### F — Portfolio migration
**14** alone — coordinate [enh/8](../enhancements/8-portfolio-analysis-improvements-070926.md).

---

## Wave 1 (P0) — recommended first PR

| Seq | Task | Notes |
|---|---|---|
| 1 | unauthenticated-vendor-routes | `routes/index.ts` public = health + auth only |
| 4 | startup-universe-refresh-storm | Cap + `SKIP_STARTUP_REFRESH`; not full `fmp_fundamentals` on boot |
| 19 | register-empty-watchlist | Seed `WATCHLIST` on register; before testing 2/3 |

---

## Global do-not

- Do not shorten TTLCache TTLs to fix bug/5 (user intent: fewer API calls).
- Do not add Redis (enh/29 deferred).
- Do not hardcode ticker counts (universe from DB/registry).
- Do not skip `pnpm run typecheck:libs` before api-server typecheck if `explainCache` / schema changed.
- Do not mark bug done without running relevant tests from §11.

---

## CI / test gates (enh/3 + enh/4)

After security or scoring fixes, add or extend tests in:
- `artifacts/api-server/src/**/*.test.ts`
- Wire auth smoke when `app.ts` session store is mockable (enh/4 Phase B deferred).

---

## Soak / multi-user (not filed — post-wave)

- 72h uptime: `admin/cache/status` entryCount plateau
- 2-user browser: logout/login watchlist bleed (bug/13)
- k6: concurrent pool (bug/6)
