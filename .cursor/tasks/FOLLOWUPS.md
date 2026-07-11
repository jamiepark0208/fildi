# Verifier follow-ups (2026-07-11)

Action items from gatekeeper re-audits (bugs 1–19). **Status lives in INDEX/CLUSTERS** — task files stay put. Replit: treat rows here as the carry-forward queue after the bugs audit closed.

---

## P0 — ship blockers / broken on fresh DB

| ID | What | Where | Notes |
|---|---|---|---|
| bug/14 | **`user_portfolio_names` table missing** — `positions.ts` raw SQL references it; no Drizzle schema, no migration in `lib/db/drizzle/` | `routes/positions.ts`, `lib/db/src/schema/index.ts` | `/api/portfolio-names` 500 on fresh DB; "Add Portfolio" broken. Positions CRUD via `positions` table works. **Fix first** before enh/8 Phase A1 nav unlock. |
| bug/14 | **`portfolioSnapshots` has no `userId`** — ingest + `/portfolio/snapshot/latest` global to all authed users | `portfolio-ingest.ts`, `portfolio-snapshot.ts`, schema | Mitigated while Portfolio nav is `adminOnly: true`. Block before second admin or nav unlock. |

---

## P1 — correctness / security / data loss

| ID | What | Where | Notes |
|---|---|---|---|
| bug/14 | Migration shim clears legacy localStorage in `finally` even when POST fails — silent data loss, no retry | `use-portfolio.ts` `migrateLegacyLocalStorage()` | Set flag only after successful imports; or retry on next load if flag unset. |
| bug/14 | React Query keys `["positions"]` / `["portfolio-names"]` lack `userId`; logout does not clear them | `use-portfolio.ts`, `sidebar.tsx` | Same class as bug/13. Fold into enh/26 or fix with bug/14 patch. |
| bug/13 | React Query bleed: `peer-groups`, `indicators`, `fundamentals-rankings` keys lack user scope | `home.tsx`, `technical.tsx` | → enh/26 |
| bug/1 | `macro-regime` still public Yahoo on cache miss | `routes/macro-regime.ts` | Confirmed still open 2026-07-11: `macroRegimeRouter` mounted at `routes/index.ts:41`, before the `requireAuth` gate at line 58 — its own `/macro/regime` handler has no auth. bug/1 AC partial. |
| bug/9 | `findNullFields()` skips peers with no `ticker_fundamentals` row — flagged but unfetched | `nightly-enrichment.ts` | Live enrichment path not re-run in bug/9 close. |
| bug/16 | Profile SQL vs `feed.tsx` TopPerformers: client skips resolved rows when `resolvedPnl == null`; server counts `EXPIRED_*` regardless | `feed.ts`, `feed.tsx` | Align when expiry job lands. |
| bug/5 | `indicatorHistoryCache` + `sepActualsCache` not in sweep/registry | `routes/macro.ts` | Confirmed still open 2026-07-11: both defined in `routes/macro.ts` but absent from `ttlCaches` array in `lib/cache-registry.ts:75`. Low risk; inconsistent with bug/5 AC. |

---

## P2 — docs / tests / manual verification

| ID | What | Where | Notes |
|---|---|---|---|
| bug/4 | Document `STARTUP_REFRESH_CAP` / `SKIP_STARTUP_REFRESH` | `.claude/skills/build-and-run.md` | bug/4 done in code; env docs still open. |
| bug/16 | Document resolved-status set for win-rate (not just status flow) | `.claude/skills/api-design-patterns.md` | Inline comment in `feed.ts` only today. |
| enh/4 | Route supertest for 401-without-cookie (bug/1 AC); wire `catalysts.test.ts` to CI | api-server test harness | Phase B blocked on MemoryStore seam for `app.ts`. |
| bug/15 | `catalysts.test.ts` exists (20 pass) but not in CI pipeline | enh/4, enh/3 | Pure-function tests ready; harness gap. |
| bug/6 | Load test: pool timeout under enrichment + concurrent API | manual / k6 | Code fix landed (`DATABASE_POOL_MAX` default 20); §12 never run. |
| bug/7 | Live `X-Forwarded-For` verify behind Replit proxy | manual curl | `trust proxy` prod-only is in code. Multi-instance → enh/29. |
| bug/8 | Manual restart-at-02:15 UTC Sun/Thu — dedupe guard holds | manual | Persisted to `app_config`; no restart test run. |
| bug/8 | Unit test for `shouldRunNow()` / `loadPersistedLastRun()` | `scheduler.ts` | Optional per task; DB-backed logic untested. |
| bug/17 | Member session → 403 on admin GETs (not curl-tested) | manual | Anonymous → 401 verified; member path same middleware as PATCH. |
| bug/18 | Manual: insert expired session row → pruned within 15 min | manual | `pruneSessionInterval: 900` in `app.ts`. |
| bug/14 | Portfolio mutations ignore `res.ok` — failed CRUD looks silent until refetch | `use-portfolio.ts` | Throw on !ok + toast/error state. |
| bug/14 | Admin `/portfolio` still runs `usePortfolio()` + migration shim | `portfolio.tsx` | Wasteful; admin legacy localStorage could POST junk positions. |
| naf/3 | `ExplainableScore.tsx` has zero imports — wire or delete | `stock-compare/src/components/` | Dead component. |

---

## Product / deferred (not bugs — tracked for sequencing)

| ID | What | Where | Notes |
|---|---|---|---|
| enh/8 | Phase A1: unlock Portfolio nav for regular users (`adminOnly: false`) | `sidebar.tsx` | **Deferred 2026-07-11** until bug/14 P0 rows fixed. Manual-entry UI already at `/portfolio`. |
| enh/8 | Phases A2–A4 portfolio analysis improvements | enh/8 task | Open after A1. |
| enh/26 | React Query fetch standardization (userId in keys, logout cleanup pattern) | cross-app | Absorbs bug/13 + bug/14 query-key debt. |
| enh/29 | Redis shared rate-limit store when horizontally scaling | `rateLimiter.ts` | bug/7 documented single-instance limit. |
| enh/34 | Performance/resilience Wave A | enh/34 task | Next build after bug audit. |

---

## Verified closed (no re-do)

All **bugs 1–18** marked done in INDEX — gatekeeper **pass** or **pass (conditional)**. **bug/19 rejected** (product decision).

Highlights:
- **bug/11–12:** batch `/options` + `/stocks/quotes`
- **bug/5:** prune + maxEntries + sweep (macro.ts orphan caches noted above)
- **bug/6,8,18:** Cluster C closed 2026-07-11
- **bug/15,16:** Cluster E closed 2026-07-11
- **bug/7,17:** Cluster D remainder closed 2026-07-11
- **bug/14:** pass (conditional) — server-backed `positions` + router mount verified; P0 rows above remain

Also closed (non-bug): enh/3, enh/4 (partial), enh/7 · naf/3 conditional.

---

## Corrections from 2026-07-11 verification pass (best-effort code check, no live server)

Went through every row above against current code. Two rows in the original doc did not hold up and were removed above rather than left to rot:

- **bug/2** (`/indicators/batch` auth leak) — **not an issue.** `routes/index.ts:58` applies `requireAuth` to `["/stocks", "/indicators", ...]` *before* `indicatorsRouter` is mounted at line 60 — Express runs middleware in registration order, so `/indicators/batch` is already gated. The FOLLOWUPS row was speculative ("may still leak") and didn't hold up under a direct read of the mount order. Closed, no code change needed.
- **bug/5 `ttl-cache.test.ts` "35/36 pass"** — **not reproducible.** Ran the suite via the project's actual test script (`node --experimental-strip-types ... --test 'src/**/*.test.ts'`, not raw `vitest`, which mis-reads the `node:test` syntax and reports a false failure). Full suite: **40/40 pass, 0 fail.** Whatever produced "35/36" either used the wrong runner or was stale. Closed.

Correction to my own note above (not a new finding — checked bugs/5's own task file after writing this): `api-server` still fails `tsc --noEmit` with 2 errors (`scripts/backfill-edgar.ts:70` arg not assignable to `Record<string, unknown>`; `scripts/merge-trusted.ts:276` `result` possibly null). bug/5's DONE note already disclosed these as **pre-existing on main before that change** — not a regression, not new. The inaccurate part is the later session checkpoint commit message claiming "both packages typecheck clean," which was wrong for `api-server` (confirmed clean only for `stock-compare`). Leaving both errors untriaged here since neither bug/5 nor bug/14 own them.

No live server/DB was available to re-run the manual/curl-verification rows (bug/6,7,8,17,18) — those are unchanged from prior session notes, not re-verified here.

## Suggested fix order for Replit

1. **bug/14 P0** — migration + schema for `user_portfolio_names`; optional `portfolioSnapshots.userId` in same pass (confirmed still open 2026-07-11 — not actually resolved by the bug/14 commit despite INDEX.md's prior unconditional "done")
2. **bug/14 P1** — migration shim safety + query keys + logout cleanup (or batch with enh/26)
3. **pre-existing** — `api-server` tsc errors (`backfill-edgar.ts`, `merge-trusted.ts`), open since before bug/5; low urgency, but stop writing "typecheck clean" in checkpoints until fixed
4. **enh/8 Phase A1** — nav unlock after #1
5. **enh/34** Wave A

(bug/5 `ttl-cache.test.ts` and bug/2 `/indicators/batch` rows removed above — verified not actual issues, see Corrections section.)

**Bug audit backlog: complete, with bug/14 downgraded to "done (conditional)"** in INDEX.md/CLUSTERS.md to match reality. Remaining work lives in this file + enhancements/ai/naf folders.
