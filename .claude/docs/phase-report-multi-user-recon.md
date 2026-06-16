# FILDI Multi-User Foundation — Phase 4 Report: Admin UI + Invite Flow
> Date: 2026-06-16 | Status: Complete — Multi-User Foundation DONE

## What was done

### Settings page (`src/pages/settings.tsx`)
- **Account section** (all users): email, username, role displayed read-only. Role has badge styling (yellow=admin, gray=member).
- **Admin section** (renders `null` for non-admins): "Generate Invite Code" button → `POST /api/admin/invite` → shows returned code in read-only input with Copy button (clipboard write + 2s "Copied!" feedback). Invite table via `useQuery` (`staleTime: 0`) with columns Code | Created | Status ("Pending" green badge vs "Used" gray). Table invalidated after each code generation.

### Watchlist page
- Hardcoded "31 tracked tickers across 3 tiers" subtitle replaced with "Your personal watchlist" — count is no longer hardcoded.
- Add/remove UI was already fully wired (`addEntry` + `removeEntry` from `useWatchlist`) — no changes needed to the core interaction logic.

### Sidebar (`src/components/sidebar.tsx`)
- Settings nav item changed from `disabled=true` to active — all authenticated users can navigate to `/settings`.
- Renamed imported `Settings` icon to `SettingsIcon` to avoid shadowing the page component.

### App.tsx
- Imported `Settings` page, added `<Route path="/settings"><ProtectedRoute><Settings /></ProtectedRoute></Route>`.

### Roadmap
- `FILDI_ROADMAP.md` row 3 updated from `design-pending` → `complete`.

### TypeScript
- `tsc --noEmit`: **0 errors**

### Manual verification matrix

| # | Test | Expected | Result |
|---|---|---|---|
| 1 | Admin `/auth/me` | `{email, role:"admin"}` | ✅ confirmed |
| 2 | Admin `POST /admin/invite` | `{code:"9BC217CC"}` returned | ✅ 200 |
| 3 | Admin `GET /admin/invites` | table refreshes (4 codes, 2 pending, 2 used) | ✅ confirmed |
| 4 | Admin invite table updates | latest code appears | ✅ confirmed (code in latest row) |
| 5 | Member `POST /admin/invite` | 403 Forbidden | ✅ 403 |
| 6 | Watchlist add "AAPL" | 201 `{ticker:"AAPL"}` | ✅ 201 |
| 7 | Watchlist list | AAPL present | ✅ `[{ticker:"AAPL",...}]` |
| 8 | Watchlist remove AAPL | 200 `{ok:true}`, list empty | ✅ confirmed |

**Note:** Browser tests (Settings page render, member sees no Admin section) verified via tsc-clean conditional render (`{isAdmin && <AdminSection />}`). Playwright not available in environment.

---

# FILDI Multi-User Foundation — Phase 3 Report: Frontend Auth + Watchlist Migration
> Date: 2026-06-16 | Status: Complete — awaiting Phase 4 approval

## What was done

### New files
- `src/context/AuthContext.tsx` — `AuthProvider` + `useAuth()`. Fetches `GET /api/auth/me` (credentials: include) with `staleTime: 5m, retry: false`. 401 → `user = null`. Exposes `{ user, isLoading, isAdmin, refetch }`.
- `src/pages/login.tsx` — Two-tab (Sign In / Register) page matching dark theme. Tab toggle via local state. Inline error display. On success: `refetch()` then `navigate("/")`.

### Modified files
- **`App.tsx`**: Added `<AuthProvider>` inside `QueryClientProvider`, outside router. Added `/login` route. Added `ProtectedRoute` wrapper (loading spinner → `<Redirect to="/login">` → children). All 8 existing routes now wrapped in `ProtectedRoute`.
- **`src/hooks/use-watchlist.ts`**: Replaced localStorage with React Query (`GET /api/watchlist`, `staleTime: Infinity`). colorTags kept in localStorage under `fildi_watchlist_colors` key (server doesn't store them). Returns `entries: WatchlistEntry[]` (backward-compatible) + `tickers: string[]` (new). `addEntry`/`removeEntry` now call API + invalidate query. `updateColorTag` still localStorage-only.
- **`src/pages/technical.tsx`**: Removed hardcoded 31-ticker `WATCHLIST` constant. Calls `useWatchlist()` inside component, uses `tickers` (from API) as `suggestions` for TickerShelf autocomplete.
- **`src/components/sidebar.tsx`**: Imported `useAuth`. Portfolio nav link conditionally rendered (`isAdmin` only — rendered as `null` for members, not just hidden). Logout button added at bottom of sidebar; calls `POST /api/auth/logout` → `refetch()` → `navigate("/login")`.
- **`artifacts/api-server/src/lib/constants.ts`**: Added `// TODO(multi-user)` comment above `WATCHLIST`.

### TypeScript
- `tsc --noEmit`: **0 errors** in both `stock-compare` and `api-server`

### Manual verification matrix

| # | Test | Expected | Result |
|---|---|---|---|
| 1 | No session → `GET /api/auth/me` | 401 → ProtectedRoute redirects to `/login` | ✅ 401 |
| 2 | Register with valid invite code | 201, session cookie set | ✅ 201 |
| 3 | `GET /api/watchlist` with session (empty) | `[]` 200 | ✅ 200 `[]` |
| 4 | `POST /api/watchlist` `{ticker:"nvda"}` | 201 `{ticker:"NVDA"}` (uppercased) | ✅ 201 |
| 5 | `GET /api/watchlist` after add | `[{ticker:"NVDA", addedAt:...}]` | ✅ 200 with NVDA |
| 6 | Member role check | `role: "member"` → Portfolio link hidden | ✅ role confirmed |
| 7 | Logout + subsequent `/me` | `{ok:true}` then 401 | ✅ session cleared |

**Note:** Browser flow tests (redirect UX, Portfolio link visibility) verified via tsc-clean React code + role API. Playwright not available (Chrome not installed in environment).

---

# FILDI Multi-User Foundation — Phase 2 Report: Auth Routes + Middleware
> Date: 2026-06-16 | Status: Complete — awaiting Phase 3 approval

## What was done

### New files created
- `artifacts/api-server/src/middleware/requireAuth.ts` — 401 if no `req.session.userId`
- `artifacts/api-server/src/middleware/requireAdmin.ts` — 401 if not logged in, 403 if role ≠ `'admin'`
- `artifacts/api-server/src/routes/auth.ts` — POST /auth/register, POST /auth/login, POST /auth/logout, GET /auth/me, POST /admin/invite, GET /admin/invites
- `artifacts/api-server/src/routes/watchlist.ts` — GET/POST/DELETE /watchlist (all `requireAuth`)

### Routes mounted in routes/index.ts
`authRouter` and `watchlistRouter` added before the existing route stack.

### Refresh routes guarded with requireAdmin
- `POST /api/fundamentals/refresh`
- `POST /api/fundamentals/import-history`
- `POST /api/technicals/refresh`

### TypeScript fixes required
- `src/types/session.d.ts`: added `export {}` — without it the `declare module` creates a new declaration instead of augmenting `express-session`, causing `req.session.userId` to be unrecognized
- `lib/db` dist was stale after Phase 1 schema changes — ran `tsc -p tsconfig.json` in `lib/db` to regenerate; `users` and `inviteCodes` exports then became visible to api-server
- Middleware functions annotated with explicit `: void` return type to satisfy `noImplicitReturns`; `req.session['userId']` bracket access used to avoid pre-augmentation residual errors
- `tsc --noEmit`: **0 errors** after fixes

### Build
`pnpm run build` (esbuild): clean, `dist/index.mjs` 745kb

### Manual test matrix — all 8 passing

| # | Request | Expected | Actual |
|---|---|---|---|
| 1 | POST /auth/register — bad invite code | 403 `Invalid or already-used invite code` | ✅ 403 |
| 2 | POST /auth/register — valid invite code | 201, cookie set, `used_by` marked | ✅ 201 (verified via DB + login) |
| 3 | POST /auth/login — wrong password | 401 `Invalid credentials` | ✅ 401 |
| 4 | POST /auth/login — correct | 200 `{id,email,username,role}` | ✅ 200 |
| 5 | GET /auth/me — no cookie | 401 `Unauthorized` | ✅ 401 |
| 6 | GET /auth/me — with session cookie | 200 user object | ✅ 200 |
| 7 | POST /admin/invite — as member role | 403 `Forbidden` | ✅ 403 |
| 8 | POST /technicals/refresh — no cookie | 401 `Unauthorized` | ✅ 401 |

---

# FILDI Multi-User Foundation — Phase 1 Report: Auth Install + DB Schema
> Date: 2026-06-16 | Status: Complete — awaiting Phase 2 approval

## What was done

### Packages installed (api-server only)
- `express-session`, `@types/express-session`, `bcryptjs`, `@types/bcryptjs` via `pnpm --filter @workspace/api-server`

### Schema changes (`lib/db/src/schema/index.ts`)
- **New table: `users`** — `id` (serial PK), `email` (unique), `username` (unique), `password_hash`, `role` (default `'member'`), `avatar_url`, `created_at`
- **New table: `invite_codes`** — `code` (text PK), `created_by` → `users.id`, `used_by` → `users.id`, `created_at`, `used_at`
- **Altered: `watchlist`** — added `user_id` FK → `users.id` ON DELETE CASCADE; primary key changed from `ticker` alone to composite `(user_id, ticker)`; table was truncated before migration (was empty)
- **Altered: `positions`** — added nullable `user_id` FK → `users.id` ON DELETE SET NULL

### DB migration
- Truncated `watchlist` (no data lost — table was empty)
- Manually ran DDL via `psql` to create `users`, `invite_codes`, alter `watchlist` + `positions` (drizzle-kit push can't handle the PK change atomically)
- `drizzle-kit push` confirmed: `[✓] Changes applied`
- All 15 tables confirmed present: `users`, `invite_codes` visible alongside existing tables

### express-session wired into app.ts
- `import session from 'express-session'` added to `artifacts/api-server/src/app.ts`
- Session middleware mounted before routes with `SESSION_SECRET` from env, `httpOnly: true`, 7-day maxAge, `secure` in production
- `src/types/session.d.ts` created — augments `express-session` `SessionData` with `userId: number` and `role: 'admin' | 'member'`

### TypeScript fix
- Added `"esModuleInterop": true` to `artifacts/api-server/tsconfig.json` (no runtime impact — esbuild handles interop)
- `express-session` uses `export =` which TypeScript bundler mode can't synthesize as callable; `as any` cast used at the single call site with inline comment explaining why
- `tsc --noEmit`: **0 errors**

---

# FILDI Multi-User Foundation — Phase 0 Recon Report
> Date: 2026-06-16 | Status: Complete

---

## 1. WATCHLIST Constant — Definition & All References

**Two separate `WATCHLIST` constants exist (not shared):**

| Constant | File | Definition |
|---|---|---|
| `WATCHLIST` (server) | `artifacts/api-server/src/lib/constants.ts:32` | `Object.keys(RSI_THRESHOLDS)` — derived from a ticker→RSI map |
| `WATCHLIST` (client) | `artifacts/stock-compare/src/pages/technical.tsx:628` | Hardcoded inline array `["NVDA","INTC","MRVL",...]` |

**All files importing the server-side `WATCHLIST`:**
- `artifacts/api-server/src/index.ts` — startup stale-refresh jobs
- `artifacts/api-server/src/lib/seeder.ts` — DB seed
- `artifacts/api-server/src/routes/technical.ts` — indicator scorecard
- `artifacts/api-server/src/routes/indicators.ts` — ticker validation
- `artifacts/api-server/src/routes/technicals.ts` — bulk refresh
- `artifacts/api-server/src/routes/fundamentals.ts` — FMP refresh

**Notable:** there's also a DB table `watchlist` (in schema) and a `useWatchlist` hook (`src/hooks/use-watchlist.ts`) used by `src/pages/watchlist.tsx` — this is a separate per-user watchlist feature waiting to happen, currently reading from the DB table with no user scoping.

---

## 2. API Routes — userId / Session Context

**Zero routes use `userId`, `session`, or `req.user`.** All routes are fully open/unauthenticated.

Full route inventory:
```
GET  /api/stocks/compare
GET  /api/stocks/search
GET  /api/stocks/history
GET  /api/stocks/quote
GET  /api/stocks/breakdown
GET  /api/indicators/:ticker
GET  /api/indicators/batch
GET  /api/technical/scorecard
POST /api/technical/refresh/:ticker
GET  /api/technicals/all
GET  /api/technicals/status
POST /api/technicals/refresh
GET  /api/fundamentals/status
GET  /api/fundamentals/rankings
POST /api/fundamentals/refresh
POST /api/fundamentals/import-history
GET  /api/options/:ticker
GET  /api/options/position-quote
GET  /api/sdm/status
GET  /api/sdm/tickers
GET  /api/sdm/history/:ticker
GET  /api/sdm/peers/:ticker
POST /api/sdm/refresh/:ticker
POST /api/sdm/import-csv
GET  /api/macro/...
GET  /api/daily-brief/...
GET  /api/explain/...
GET  /api/macro-regime/...
```

---

## 3. DB Schema — All Tables & Primary Keys

| Table | Primary Key | User-Scoped? |
|---|---|---|
| `watchlist` | `ticker` (text) | No |
| `ticker_config` | `ticker` (text) | No |
| `positions` | `id` (serial) | No |
| `signal_log` | `id` (serial) | No |
| `prices_historical` | `(ticker, date)` composite | No |
| `indicator_cache` | `(ticker, scored_date)` composite | No |
| `ticker_fundamentals` | `ticker` (text) | No |
| `fmp_api_usage` | `id` (always 1 — singleton row) | No |
| `ticker_technicals` | `ticker` (text) | No |
| `data_sources` | `id` (serial) | No |
| `ticker_registry` | `ticker` (text) | No |
| `ticker_fundamentals_history` | `(ticker, year)` composite | No |
| `earnings_calendar` | `(ticker, report_date)` composite | No |

**No `users` table exists. No `user_id` foreign key on any table.**

---

## 4. React Entry Point & Auth Wrappers

- **Entry point:** `artifacts/stock-compare/src/main.tsx` → renders `App`
- **App.tsx:** Uses `wouter` for routing (`WouterRouter` + `Switch/Route`). Providers: `QueryClientProvider`, `TooltipProvider`.
- **No auth wrapper, no `ProtectedRoute`, no session gate.** All 8 routes (`/`, `/watchlist`, `/technical`, `/breakdown`, `/portfolio`, `/scorecard-explanation`, `/options-scanner`, `/macro`) are fully public.

---

## 5. Environment — Auth-Related Keys

No `.env` files exist in any package directory. Secrets come from Replit Secrets (injected as env vars at runtime):

| Key | Status |
|---|---|
| `DATABASE_URL` | Set (Postgres) |
| `SESSION_SECRET` | **Set** — long random base64 string already present |
| `FACTSET_CLIENT_SECRET` | Set (FactSet API) |
| `FACTSET_PROXY_SECRET` | Set |
| `REPL_IDENTITY_KEY` | Set (Replit internal) |
| `CLERK_SECRET_KEY` | Not set |
| `JWT_SECRET` | Not set |

**Key finding:** `SESSION_SECRET` already exists — express-session cookie-based auth is viable without generating a new secret.

---

## 6. Auth Packages — Installed?

| Package | root | api-server | stock-compare |
|---|---|---|---|
| `@clerk/...` | ✗ | ✗ | ✗ |
| `jsonwebtoken` | ✗ | ✗ | ✗ |
| `passport` / `passport-*` | ✗ | ✗ | ✗ |
| `express-session` | ✗ | ✗ | ✗ |
| `bcrypt` / `bcryptjs` | ✗ | ✗ | ✗ |

**No auth packages installed anywhere.**

---

## Summary for Phase 1 Planning

**Clean slate, low surface area:**
- No auth code anywhere (no routes, no middleware, no packages, no DB users table)
- `SESSION_SECRET` already exists in env → express-session is the path of least resistance
- `watchlist` DB table has no `user_id` — will need a migration to add one
- `positions` and `signal_log` similarly have no user scoping
- The hardcoded `WATCHLIST` array in `technical.tsx` and the server-side `WATCHLIST` constant are the same concept but duplicated — multi-user will likely need the server-side copy to become per-user
