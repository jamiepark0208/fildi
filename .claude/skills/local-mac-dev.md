---
name: local-mac-dev
description: Start TradeDash on this Mac (Postgres.app + Vite preview + API hot-reload). Use instead of Replit build-and-run when developing in Cursor on macOS.
---

# TradeDash — Local Mac Dev

| Process | Port | Hot reload? |
|---|---|---|
| Postgres 16 (Postgres.app CLI cluster) | **5432** | n/a |
| `api-server` (`dev:once`) | **8080** | **No** — after editing `api-server/src`, run `scripts/dev-restart.sh --api` |
| `stock-compare` (Vite) | **8081** | **No** — browser refresh shows edits |

10-28: auto-reload was off'd on purpose. Agents' edits restarted the API ~10×/h (every in-memory cache wiped → slow pages) and pushed ~900 hot reloads/day into Jamie's tab. Opt back in only for a solo session: `FILDI_API_WATCH=1` / `FILDI_HMR=1`.

## Secrets
- File: repo-root `.env.local` (gitignored)
- Required: `SESSION_SECRET`, `DATABASE_URL`
- `SESSION_SECRET` signs express-session cookies — required for login; copy from Replit is fine
- Load: `scripts/dev-up.sh` sources `.env.local` automatically

## Postgres (this machine)
- Binaries: `~/Applications/Postgres.app/Contents/Versions/16/bin`
- Data dir: `~/Library/Application Support/tradedash-pg16`
- URL shape: `postgresql://jamiepark@127.0.0.1:5432/tradedash` (trust auth)
- Start if down:
```bash
export PATH="$HOME/Applications/Postgres.app/Contents/Versions/16/bin:$PATH"
pg_ctl -D "$HOME/Library/Application Support/tradedash-pg16" -l "$HOME/Library/Logs/tradedash-pg16.log" -o "-p 5432" start
```
- Schema: `cd lib/db && source ../../.env.local && pnpm exec drizzle-kit push`
- Also create `session` table (connect-pg-simple — **not** in Drizzle schema). Without it, login returns 200 then "session did not persist":
```sql
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
```
- Local admin: `.local-admin-credentials` (gitignored). Email `admin@local.dev`.
- Preview URL: always use `http://localhost:8081` (not `127.0.0.1`) so cookies stick.

**Do not** use `/usr/local/Cellar/postgresql@16` (Intel Homebrew bottle — missing gettext dylib).

## One-shot start / restart (Mac)
```bash
cd /Users/jamiepark/Cursor/fildi
./scripts/dev-restart.sh          # kill :8080/:8081 if needed, start both detached, wait until healthy
./scripts/dev-restart.sh --if-down  # only start what is missing
./scripts/dev-up.sh               # same as dev-restart.sh (detached)
```
Preview: `http://localhost:8081/`

**Important:** Do **not** leave API/Vite as the foreground process of a Cursor agent terminal — aborting that chat kills the stack. `dev-restart.sh` uses `nohup` and exits after health checks.

`maintain.mjs --restart-if-unhealthy` also calls `dev-restart.sh` (fixed: old setTimeout relaunch never ran).

**Auto-heal is daily, not continuous:** LaunchAgent `com.fildi.maintain` runs ~10:30 local with `--restart-if-unhealthy`. Mid-day Vite/API death needs a manual `./scripts/dev-restart.sh` (or wait until next maintain). Plist must use `/opt/homebrew/bin/node` (arm64) — reinstall via `./scripts/install-maintenance-launchd.sh` if it still points at Intel `/usr/local/bin/node`.

## Logs
- `/tmp/fildi-logs/api.log`
- `/tmp/fildi-logs/vite.log`
- `/tmp/fildi-logs/health-check.log`

## Connection health (one-shot)
```bash
node scripts/health-check.mjs     # once (or via maintain.mjs)
node scripts/maintain.mjs         # health + log rotate; exits
```

## Always-on vs periodic
**Keep running while developing (2 node procs + Postgres):**
- API `:8080` (`pnpm run dev:watch`)
- Vite `:8081` (`pnpm run dev`)
- Postgres.app cluster

**Do NOT leave running:** `health-check.mjs --watch`

**Periodic maintenance (exits):** `node scripts/maintain.mjs`
- one-shot health, log compress, optional weekly restart via LaunchAgent
- install: `./scripts/install-maintenance-launchd.sh` (Sun 03:30)

## Migrate Replit users / watchlists / portfolios
Cursor cannot talk to Claude-on-Replit. Data lives in Replit Postgres.

1. Add Replit’s `DATABASE_URL` to `.env.local` as `REPLIT_DATABASE_URL=...`
2. Run: `./scripts/migrate-from-replit.sh`  
   (full dump → wipe local public schema → restore)

Or on Replit shell: `pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f /tmp/fildi-replit.dump`  
then download dump and: `./scripts/migrate-from-replit.sh --from-file /tmp/fildi-replit.dump`

## Do not (Replit habits)
- Do not `pkill` Replit supervisors / ask for Stop+Run
- Do not read secret values into chat — check `/api/healthz` or `health-check.mjs` instead
