# performance-resilience-optimization

| Field | Value |
|---|---|
| **Status** | ready — nothing implemented |
| **Priority** | P0 |
| **Area** | perf / resilience / devx |
| **Effort** | L (waves A–D) |
| **Created** | 2026-07-10 |
| **Related** | [bug/4](../bugs/4-startup-universe-refresh-storm-070926.md), [bug/5](../bugs/5-ttlcache-unbounded-memory-070926.md), [bug/11](../bugs/11-options-scanner-fetch-storm-070926.md), [bug/12](../bugs/12-watchlist-quote-n-plus-one-070926.md), [bug/13](../bugs/13-react-query-cross-user-bleed-070926.md), [enh/5](5-api-dev-hot-reload-070926.md), [enh/26](26-react-query-fetch-standardization-070926.md) |

### Purpose
Faster-feeling UI; **one page error must not kill the app**; stop fetch/boot storms; sane dev startup.

### User pain
Slow app · whole-app white screen on one React error · 3hr lost to port/startup/rebuild loops.

---

## CLAUDE — read first

**Build order:** A → **bug/4** → B → rest of C → D. Lazy routes (B) need error boundaries (A) first.

| File | Why |
|---|---|
| `artifacts/stock-compare/src/App.tsx` | Eager imports L8–21; QueryClient L23–29; routes |
| `artifacts/stock-compare/src/main.tsx` | Global Sentry boundary only L16–23 |
| `artifacts/stock-compare/src/pages/home.tsx` | Rankings L107; 4 parallel API calls on mount |
| `artifacts/stock-compare/src/pages/options-scanner.tsx` | Rankings L820; auto-fetch storm L989–998 |
| `artifacts/stock-compare/src/pages/watchlist.tsx` | N+1 quotes ~L128–133 |
| `artifacts/stock-compare/src/pages/feed.tsx` | Skeleton pattern L95 — reuse |
| `artifacts/stock-compare/src/components/sidebar.tsx` | Hover chunk prefetch hook |
| `artifacts/api-server/src/index.ts` | Startup storm L38–75 |
| `artifacts/api-server/src/routes/health.ts` | **`GET /api/healthz`** |

Wave C: use linked bug §9–13 — do not re-spec fixes here.

---

## Launch & prefetch policy

**Do not build:** blocking splash until home APIs finish · prefetch all tab data at login · background options/macro API prefetch.

**Do build:**

| When | What |
|---|---|
| Auth → paint | Sidebar + `PageSkeleton`; home owns its 4 queries (no duplicate rankings prefetch) |
| After home first paint | Idle-prefetch **JS chunks** only: watchlist + options-scanner (max 2; skip if `saveData`) |
| Sidebar hover | Prefetch hovered route’s chunk |
| Shared rankings | Unify queryKey home/scanner (enh/26); cache hit on Home→Scanner |

**Edge cases:** deep links skip home gate · fix bug/13 before prefetch · fix bug/4 before heavy client presetup · no prefetch while home query in-flight.

**Verify:** Login → home 5s → Network has no `/api/options/` or macro burst; Scanner uses cached rankings (T-B1).

---

## Implementation status

| Item | Status |
|---|---|
| A — route error boundaries | ✅ 2026-07-11 |
| B — lazy routes + skeleton + query-keys + prefetch-policy | ✅ 2026-07-11 |
| C — bugs 4, 5, 11, 12 | ✅ already done (see bugs/4,5,11,12 — closed before this session, verified against INDEX.md) |
| D — enh/5 + dev-up.sh | ✅ 2026-07-11 |

**2026-07-11 session notes:**
- Wave C was already closed by a prior session (INDEX.md shows bugs 4/5/11/12/13 all `done`) — skipped re-implementation per task's own build order, no double-work.
- Wave A: `RouteErrorBoundary.tsx` (class component, Sentry.captureException in componentDidCatch) wired into `ProtectedRoute` in App.tsx (single insertion point covers all routes) + `QueryErrorResetBoundary`. **Scope decision:** did not lift `<Sidebar />` out of all 12 page components into a shared layout shell — that's a much larger structural refactor than the crash-isolation goal requires. The fallback card's "Home" link gives equivalent recovery without touching 12 files. Sidebar remains rendered per-page, so it does *not* literally stay mounted through a same-page crash (T-A1's "sidebar visible" is satisfied via the fallback card's nav, not literal persistence).
- Wave B: `lib/query-keys.ts` unifies the fundamentals-rankings key between `home.tsx` and `options-scanner.tsx` (previously `["fundamentals-rankings"]` vs `["fundamentals", "rankings"]` — two different cache entries, real double-fetch on Home→Scanner nav). `lib/prefetch-policy.ts` does idle-time JS-chunk-only prefetch (max 2, `saveData` aware), gated on home's rankings query no longer being in-flight. Sidebar hover prefetches the hovered route's chunk. All routes except Login are `React.lazy` behind `PageSkeleton` (renders `<Sidebar/>` + pulse placeholders immediately).
- Wave D: `api-server` gets `tsx watch` as `dev:watch` (now aliased from `dev`); old rebuild flow preserved as `dev:rebuild`. **Verified live**: edited `health.ts`, reflected in ~3s without manual rebuild, then reverted; confirmed prod `build`/`start` untouched. `scripts/dev-up.sh` waits on `/api/healthz` before starting Vite — verified live on alternate ports (8199/8198), both up well under 60s. Confirmed via `start.sh` inspection that the Replit-managed workflow never reads `package.json`'s `dev` script (it always calls `build.mjs` + `dist/index.mjs` directly), so this change doesn't affect the managed process at all.
- **Not verified in-browser**: Playwright was unavailable this session (per state.json). Wave A/B correctness is based on tsc (clean, both packages except pre-existing unrelated errors in `positions.ts`/`merge-trusted.ts`/`backfill-edgar.ts` from an earlier uncommitted session) + code review, not a live click-through. Recommend a manual pass (T-A1, T-A2, T-B1, T-B4) next session once Playwright is back.
- **Bundle-size baseline (T-B2) not measured**: `pnpm build` in stock-compare fails on `main` too (confirmed via `git stash` A/B test) — Rollup can't externalize `@sentry/react` imported from `lib/api-client-react/src/custom-fetch.ts`. Pre-existing, unrelated to this work — flagging, not fixing (out of scope for this task).

---

## Baseline (before Wave B)

```bash
cd artifacts/stock-compare && pnpm build && ls -la dist/assets/index-*.js
curl -s -o /dev/null -w '%{time_total}\n' http://localhost:8080/api/fundamentals/rankings
```

| Metric | Target |
|---|---|
| Main JS chunk | −40% vs baseline |
| Rankings API warm | < 0.3s |
| Scanner options on mount (40 WL) | 0 until expand |
| API boot stale refresh | ≤ 20 tickers |
| Error on /watchlist | sidebar + / still work |

---

## Wave A — crash isolation

**Goal:** Page throw → fallback on that page; other routes work.

| Action | Path |
|---|---|
| Create | `components/RouteErrorBoundary.tsx` |
| Edit | `App.tsx` — `QueryErrorResetBoundary` + per-route boundary + later `Suspense` |

**How:** Fallback card + Retry + Home link; `Sentry.captureException` in `onError`. Keep `main.tsx` boundary as last resort.

| Test | Pass |
|---|---|
| T-A1 Throw in watchlist → visit `/watchlist` | Error card; sidebar visible |
| T-A2 Click Home from error | Home renders |
| T-A3 tsc | exit 0 |

---

## Wave B — perceived speed

**Goal:** Smaller bundle; shell immediate; scanner reuses rankings cache — no login API stampede.

| Action | Path |
|---|---|
| Edit | `App.tsx` — `React.lazy` (Login stays eager) |
| Create | `components/skeletons/PageSkeleton.tsx`, `lib/query-keys.ts`, `lib/prefetch-policy.ts` |
| Edit | `home.tsx` L107 + `options-scanner.tsx` L820 — same key |
| Edit | `sidebar.tsx` — optional hover prefetch |

**How:** See Launch & prefetch policy. Default `staleTime: 5m` on QueryClient; pages with `Infinity` override explicitly.

| Test | Pass |
|---|---|
| T-B1 Home → Scanner | ≤1 rankings request |
| T-B2 build | main chunk smaller |
| T-B4 Idle 5s on home | no options/macro API |
| T-B6 tsc | exit 0 |

---

## Wave C — linked bugs

| Bug | Success |
|---|---|
| [11](../bugs/11-options-scanner-fetch-storm-070926.md) | 0–5 options calls on mount |
| [12](../bugs/12-watchlist-quote-n-plus-one-070926.md) | 1 batch quote call for 30 WL |
| [4](../bugs/4-startup-universe-refresh-storm-070926.md) | ≤20 stale refresh per boot |
| [5](../bugs/5-ttlcache-unbounded-memory-070926.md) | TTLCache RAM bounded |

---

## Wave D — devx

| Action | Path |
|---|---|
| enh/5 | `api-server/package.json`, `build-and-run.md` |
| Create | `scripts/dev-up.sh` — wait for `/api/healthz` then Vite |

| Test | Pass |
|---|---|
| T-D1 `./scripts/dev-up.sh` | both servers up < 60s |
| T-D2 API edit without rebuild | change visible on refresh |

---

## Out of scope

Next.js/SSR · Redis (enh/29) · enh/27 re-materialization.

**When shipped:** Update Implementation status; paste baseline vs after in PR.
