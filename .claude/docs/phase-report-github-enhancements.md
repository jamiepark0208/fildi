# Phase Report: GitHub Enhancements — 01-security-setup

**Session date:** 2026-06-18
**Branch:** main
**Status:** Complete ✅

---

## Task: 01-security-setup

Implemented security middleware layer and startup retry logic for `artifacts/api-server`.

### Files Created

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/retry.ts` | Generic `withRetry<T>` utility — exponential backoff, 3 attempts, 500ms base delay, optional `onRetry` callback |
| `artifacts/api-server/src/middleware/rateLimiter.ts` | `generalLimiter` (200 req/15min, global) + `authLimiter` (20 req/15min, auth routes only) via `express-rate-limit` |
| `artifacts/api-server/src/middleware/errorHandler.ts` | Global Express error handler — ZodErrors → 400 with field errors, all others → 500 `INTERNAL_ERROR`, no stack trace leakage |
| `artifacts/api-server/src/middleware/validate.ts` | `validate(schema: ZodSchema)` middleware factory — parses `req.body`, calls `next(err)` on failure for errorHandler to catch |

### Files Modified

| File | Change |
|---|---|
| `artifacts/api-server/src/app.ts` | CORS locked to `FRONTEND_URL` env (fallback `http://localhost:3000`); `generalLimiter` added after CORS; `errorHandler` mounted last |
| `artifacts/api-server/src/routes/auth.ts` | `authLimiter` applied to `/auth/register` and `/auth/login` before handlers |
| `artifacts/api-server/src/index.ts` | All 3 startup tasks (seed, fundamentals, technicals) wrapped with `withRetry` — 3 attempts with warn logging on each retry |

### Package Added

- `express-rate-limit ^7.5.0` (ships own types, no `@types` package needed)

---

## UX Impact

- **Rate limiting:** Normal browsing won't hit limits. Auth brute-force protection active. Startup tasks are DB-direct (not HTTP), so unaffected.
- **CORS:** Transparent to users. Third-party direct API calls now blocked.
- **Error handler:** Users see `{ code, message }` JSON instead of hanging requests or raw stack traces.
- **Retry logic:** Server starts with fresher data after restarts. Invisible to users.

---

## Pre-existing Errors (not introduced by this work)

Three tsc errors exist in the codebase before this session:
- `src/lib/scoring-config-db.ts` — `appConfig` missing from `@workspace/db`
- `src/routes/feed.ts` — `stockBuckets` missing from `@workspace/db`
- `src/routes/positions.ts` — schema mismatch on `notes`/`userId` insert

None of the new/modified files produce type errors.

---

---

## Caching Audit (read-only, no code changes)

### Master Yahoo Finance Call Index

| # | Function | Modules / Args | HTTP Endpoint | Cache? | TTL |
|---|---|---|---|---|---|
| 1 | `yahooFinance.quoteSummary` | price, summaryDetail, financialData, defaultKeyStatistics, assetProfile | `GET /stocks/compare` | ✅ `compareCache` | 10 min |
| 2 | `yahooFinance.search` | newsCount:0, quotesCount:8 | `GET /stocks/search` | ✅ `searchCache` | 5 min |
| 3 | `yahooFinance.chart` | period1, interval | `GET /stocks/history` | ✅ `historyCache` / `historyCache1D` | 30 min / 5 min |
| 4 | `yahooFinance.quoteSummary` | price, summaryDetail, financialData, defaultKeyStatistics, assetProfile | `GET /stocks/quote` | ✅ `quoteCache` | 10 min |
| 5 | `yahooFinance.quoteSummary` | + recommendationTrend, upgradeDowngradeHistory | `GET /stocks/breakdown` | ✅ `breakdownCache` | 10 min |
| 6 | `yahooFinance.search` | newsCount:6, quotesCount:0 | `GET /stocks/breakdown` (sub-call) | ✅ same `breakdownCache` | 10 min |
| 7 | `(yahooFinance as any).quote` | batch ["^VIX","^GSPC","^IXIC","^RUT"] | `GET /macro/regime` | ✅ module-level `_cache` | 5 min |
| 8 | `yahooFinance.options` | ticker, no date | `GET /options/:ticker`, `GET /options/position-quote` | ❌ None | — |
| 9 | `yahooFinance.options` | ticker, specific expiry (loop up to 3×) | `GET /options/:ticker` | ❌ None | — |
| 10 | `(yahooFinance as any).options` | ticker, no date | technicals refresh (startup + stale) | ❌ None | — |
| 11 | `(yahooFinance as any).options` | ticker, second expiry (IV term structure) | technicals refresh | ❌ None | — |
| 12 | `fetchAndStoreOHLCV` (chart) | 420-day OHLCV window | technicals refresh (bootstrap only) | ✅ Skips if DB ≥ 200 rows | DB-backed |

### Key Gaps

- **Options routes** — zero caching; every click fires 1–3 live Yahoo calls
- **Technicals options fields** — IV/skew fetched live on every 23h refresh cycle
- **Cache type inconsistency** — `stocks.ts` uses custom `TTLCache`, `macro-regime.ts` uses a raw nullable variable; no shared utility
- **No Redis** — all caches are in-process; restart wipes everything

### Stale Thresholds

| Data | Threshold | Source |
|---|---|---|
| Technicals (OHLCV, indicators) | 23 hours | `lib/technicals-db.ts` |
| Fundamentals | 7 days | `lib/fundamentals-db.ts` |

---

---

## Options Caching Deep Audit (read-only)

### lib/options.ts

**Constants (lines 56–58)**
- `FLAT_MIN_OTM = 0.03` (3% minimum OTM), `FLAT_MAX_OTM = 0.22` (22% maximum OTM), `RISK_FREE_RATE = 0.045`
- No named "max expiries" constant — capped via inline `.slice(0, 3)` at line 261

**Expiry discovery flow**
- Line 255: initial `fetchChain(key)` with no date — Yahoo returns `expirationDates` in the response
- Line 259: all `Date` objects extracted from `raw0.expirationDates`
- Line 261: filtered to 1–28 DTE, capped at 3 targets

**Yahoo Finance call count per request**
- `fetchChain()` wraps a single `yahooFinance.options()` call (lines 238–245)
- Call 1 (line 255): initial fetch, no date — returns spot price + all expiries + first chain
- Calls 2–3 (lines 285–290): loop over `targets`; index 0 reuses `raw0` if DTE matches (`canReuse` check line 287), otherwise calls again
- **Worst case: 3 calls per ticker request. No cache at any level.**

### routes/options.ts

- Two endpoints: `GET /options/position-quote` (lines 8–29) and `GET /options/:ticker` (lines 32–43)
- Thin router, no caching, no constants — delegates entirely to `lib/options.ts`
- Handles one ticker at a time

### routes/stocks.ts — TTLCache implementation

**Class definition (lines 13–30)** — defined inline, not imported:
- `CacheEntry<T>` interface: `{ value: T, expiresAt: number }`
- `TTLCache<T>`: in-memory `Map`, lazy expiry (deleted on read miss)

**Cache instances and keys**

| Cache | Line | TTL | Key format | Example |
|---|---|---|---|---|
| `searchCache` | 32 | 5 min | `q.toUpperCase()` | `"AAPL"` |
| `compareCache` | 33 | 10 min | `"TICKER1:TICKER2"` (uppercase) | `"AAPL:MSFT"` |
| `historyCache` | 454 | 30 min | `"TICKER_PERIOD"` | `"AAPL_1M"` |
| `historyCache1D` | 455 | 5 min | `"TICKER_PERIOD"` | `"AAPL_1D"` |
| `quoteCache` | 513 | 10 min | `ticker.toUpperCase()` | `"AAPL"` |
| `breakdownCache` | 626 | 10 min | `ticker.toUpperCase()` | `"AAPL"` |

**Cache check pattern (quoteCache, lines 526–528):** get → if cached return early → on miss: fetch, build, set.

### routes/macro-regime.ts — raw cache variable

- Line 48: `let _cache: MacroRegimeResult | null = null;`
- Line 49: `const CACHE_TTL_MS = 5 * 60 * 1000;`
- Line 54 TTL check: `if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS)`
- Fallback (error path) also written to cache at line 88 — failed fetches are not retried until TTL expires

---

---

## Options + Cache Efficiency Improvements

**Status:** Complete ✅

### Step 1 — TTLCache extracted to shared utility
- Created `lib/ttl-cache.ts` — exported `TTLCache<T>` class
- Removed inline definition from `routes/stocks.ts`, replaced with import

### Step 2 — Options constants tightened
- `FLAT_MAX_OTM` 0.22 → 0.15 in `lib/options.ts:57`
- `.slice(0, 3)` → `.slice(0, 2)` (max 2 expiries per request)

### Step 3 — Shared expiry date cache in lib/options.ts
- Added `expiryCache = new TTLCache<Date[]>(24h)` at module level
- `getOptionsChain` checks `expiryCache.get('shared')` first
- Cache hit: skips undated initial Yahoo call entirely, jumps to per-date fetches
- Cache miss: makes initial call, stores all expiry dates, proceeds as normal
- `canReuse` logic for `raw0` preserved

### Step 4 — Route-level options cache in routes/options.ts
- Added `optionsCache = new TTLCache<OptionsChainResult[]>(30 min)`
- `GET /options/:ticker` checks cache before calling `getOptionsChain`
- Cache key: `ticker.toUpperCase()`

### Step 5 — TTL updates

| Cache | Before | After | File |
|---|---|---|---|
| `searchCache` | 5 min | 24 hours | `routes/stocks.ts` |
| `quoteCache` | 10 min | 1 hour | `routes/stocks.ts` |
| `compareCache` | 10 min | 1 hour | `routes/stocks.ts` |
| `breakdownCache` | 10 min | 2 hours | `routes/stocks.ts` |
| `historyCache` | 30 min | 1 hour | `routes/stocks.ts` |
| `historyCache1D` | 5 min | 15 min | `routes/stocks.ts` |
| `CACHE_TTL_MS` (macro) | 5 min | 30 min | `routes/macro-regime.ts` |
| `optionsCache` (new) | — | 30 min | `routes/options.ts` |
| `expiryCache` (new) | — | 24 hours | `lib/options.ts` |

### tsc result
0 new errors. 3 pre-existing schema errors unchanged (`appConfig`, `stockBuckets`, `positions.ts`).

---

---

## Admin Cache Dashboard

**Status:** Complete ✅

### Backend (Steps 1–3)

**TTLCache stats** (`lib/ttl-cache.ts`):
- Added `hits`, `misses`, `name` fields; increments on every `get()` call
- New `getStats()` returns `{ name, ttlMs, entryCount, hits, misses, hitRate, entries[] }`
- New `clear()` resets entries (not hit/miss counters)

**Named cache instances** — all 8 TTLCache instances now pass a name string:
- `routes/stocks.ts`: search, compare, history, history-1d, quote, breakdown (all exported)
- `routes/options.ts`: options (exported)
- `lib/options.ts`: options-expiry (exported)
- `routes/macro-regime.ts`: `_cache` and `CACHE_TTL_MS` exported for dashboard read access

**New route** (`routes/admin-cache.ts`, wired in `routes/index.ts`):
- `GET /api/admin/cache/status` (requireAdmin) — returns all 9 caches with stats + `generatedAt`
- `DELETE /api/admin/cache/clear/:name` (requireAdmin) — clears by name, 400 on unknown name
- macro-regime row is static (no TTLCache) — shows `hits: null`, `hitRate: "—"`, entry built from `_cache.fetchedAt`

### Frontend (Step 4)

**`CacheMonitor` component** added to `settings.tsx` — rendered inside `{isAdmin && ...}` block below invite codes:
- `useQuery` with `staleTime: 0` — always fresh on mount
- Manual Refresh button with spinning icon while fetching
- Table: Cache | TTL | Entries | Hits | Misses | Hit Rate | Next Expiry | Actions
- Hit rate color: green ≥70%, yellow 40–69%, red <40%, gray "—"
- "Next Expiry" = minimum `expiresInSec` across all entries in that cache
- Clear button per row (not shown for macro-regime) — confirm dialog before calling DELETE
- Auto-invalidates cache status query on successful clear

### Docs updated
- `.claude/skills/data-architecture.md` — Tier C updated, TTLCache reference + TTL table added
- `.agents/context/project.md` — architecture note updated with cache dashboard
- `CLAUDE.md` — skill row updated

### tsc result
0 new errors. 3 pre-existing schema errors unchanged.

---

---

## Validation + TSC Error Recon (read-only)

### 1. routes/auth.ts — validate() / Zod
- **No** `validate()` middleware applied to `/auth/register` or `/auth/login`
- **No** Zod schemas imported or defined anywhere in the file
- Raw `req.body as { ... }` casting is the current pattern

### 2. lib/validators/ — does not exist

### 3 & 4. Pre-existing tsc errors — root causes

**`scoring-config-db.ts` — `appConfig` missing**
- Table IS defined in `lib/db/src/schema/index.ts` line 406 as `pgTable('app_config', ...)`
- IS exported from `lib/db/src/index.ts` via `export * from "./schema"`
- Error is a **build artifact mismatch** — the compiled dist output of `@workspace/db` was not rebuilt after `appConfig` was added to the schema. Drizzle/tsc sees the stale compiled package, not the source.
- Fix: rebuild `lib/db` (`pnpm build` or `tsc` in that workspace) so the compiled export includes `appConfig`.

**`routes/feed.ts` — `stockBuckets` missing**
- Same issue — `stockBuckets` table is defined in schema (line 476), exported, but stale compiled dist doesn't include it.
- Fix: same — rebuild `lib/db`.

**`routes/positions.ts` — schema mismatch on insert**
- The `positions` table schema (lines 68–83) has NO `notes` column — the table ends at `pnl`.
- `routes/positions.ts` line 36 inserts `notes: b.notes ?? null` which doesn't exist in the schema.
- The `userId` error in overload 2 is a cascade from the array-overload type mismatch, not a real missing column (`userId` exists in the schema as `integer('user_id')`).
- Fix: add `notes text('notes')` column to the `positions` table in the schema (+ migration), OR remove `notes` from the insert in `routes/positions.ts`.

### 5. helmet — NOT installed
- Absent from `artifacts/api-server/package.json`

### Summary of required actions
| Error | Fix needed |
|---|---|
| `appConfig` tsc error | Rebuild `lib/db` package |
| `stockBuckets` tsc error | Rebuild `lib/db` package (same run) |
| `notes` on positions insert | Add `notes` column to DB schema + migration, OR remove from route |
| `validate()` on auth routes | Create Zod schemas for login/register, apply `validate()` middleware |
| `helmet` | Install if desired — not blocking anything currently |

---

---

## Validation + TSC Error Fixes

**Status:** Complete ✅ — tsc now exits with 0 errors

### Task 1 — lib/db rebuild (fixed appConfig + stockBuckets)
- `lib/db` has no build script — uses TypeScript project references with `composite: true`
- `dist/` was stale; ran `npx tsc --build` in `lib/db` to regenerate `.d.ts` output
- `appConfig` and `stockBuckets` now visible in compiled dist; both tsc errors gone

### Task 2 — positions.notes column
- Added `notes: text('notes')` to `positions` table in `lib/db/src/schema/index.ts`
- `drizzle-kit push` and `push-force` both fail without TTY (interactive resolver required)
- Applied migration directly via raw SQL: `ALTER TABLE positions ADD COLUMN IF NOT EXISTS notes text`
- Rebuilt `lib/db` dist; `positions.ts` insert error gone

### Task 3 — Zod validation on auth routes
- Created `lib/validators/auth.ts` with `registerSchema` and `loginSchema`
- `registerSchema`: email format, username 3–20 chars, password ≥8 chars, inviteCode required
- `loginSchema`: email format, password non-empty
- Applied `validate(registerSchema)` and `validate(loginSchema)` as middleware on `/auth/register` and `/auth/login` (after `authLimiter`, before handlers)
- Removed manual `req.body as {...}` casting and manual `if (!email || !password)` guards — Zod handles all validation now

### Task 4 — helmet
- Installed `helmet` (ships own types, no @types needed)
- Added `app.use(helmet())` as the first middleware in `app.ts` (before pinoHttp, CORS, rate limiter)

### Final tsc result
`0 errors` — all 3 pre-existing errors resolved

---

## Next Steps (not completed this session)

- Apply `validate()` middleware to auth routes (login/register) with Zod schemas — `validate.ts` is ready, schemas not yet wired
- Consider adding `helmet` for HTTP security headers (not installed)
- Fix the 3 pre-existing tsc schema errors
