---
name: build-and-run
description: Rebuild the API server and restart it. Use after ANY change to api-server/src/**. Also covers diagnosing 502 errors, duplicate/stray processes, and verifying the stack is healthy.
---

# TradeDash — Build & Run Reference

| Process | Port | Restarts on change? |
|---|---|---|
| `stock-compare` (Vite) | **8081** | **Yes** — hot-reload |
| `api-server` (Express ESM) | **8080** | **NO** — must rebuild + restart manually |

## Process topology (the ONLY two processes that should exist)

The `.replit` "Project" workflow runs exactly two supervised tasks, each an infinite crash-restart loop that already holds all secrets (ANTHROPIC_API_KEY, DATABASE_URL, PORT):

- `bash artifacts/stock-compare/start.sh` → `pnpm run dev` → vite on **8081**
- `bash artifacts/api-server/start.sh` → `node dist/index.mjs` on **8080**

Both loops **auto-relaunch their child within 2s if it exits** — so you never need to (and never should) hand-construct a fresh `node`/`pnpm` invocation with your own env vars. That always fails or drifts from the managed environment.

**Do NOT read `/proc/<pid>/environ` or probe individual secret var names (even just checking presence with `[ -n "$VAR" ]`)** — both leak information about secrets into the conversation. If you need to confirm secrets are available, check the health endpoint instead (below).

## Quick rebuild + restart (use after every backend change)

### Step 1 — Build the dist
```bash
cd /home/runner/workspace/artifacts/api-server && node build.mjs
```

### Step 2 — Restart: kill the CHILD, not the supervisor
The supervisor loop (`start.sh`) already has your secrets. Killing its child process makes it relaunch immediately with the freshly built dist — no need to touch the supervisor or ask the user to click anything:
```bash
pkill -f "node --enable-source-maps dist/index.mjs"
sleep 3
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/daily-brief   # expect 200
```
If this doesn't come back up, check `pgrep -af start.sh` — if NO api-server supervisor is running at all (rare; only happens if something killed it directly), tell the user: **"Please Stop and Run the Replit app"** since only Replit's workflow can spawn the first supervisor with secrets attached.

### Step 3 — Verify
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/daily-brief
```
200 or 401 both mean the server is up (401 = auth required on that route).

## Check for duplicate/stray processes

Ask "how many servers are running" whenever something behaves inconsistently (stale code, flaky ports) — duplicates have happened before (2026-07-10 incident: a hook auto-spawned an extra api-server supervisor on a transient health-check failure, which then crash-looped forever on EADDRINUSE; separately a stray root-level `pnpm run dev` had fanned out extra stock-compare/mockup-sandbox instances not managed by any supervisor).

```bash
pgrep -af "start.sh"                 # expect exactly 2: stock-compare + api-server
pgrep -af "dist/index.mjs"           # expect exactly 1
pgrep -af "vite.*stock-compare|stock-compare.*vite"   # expect exactly 1
```

If you find more than expected:
- Prefer the process whose parent chain traces back to the `.replit` workflow (`ps -o pid,ppid,cmd -p <pid>`, walk ppid) — orphans get reparented to `ppid 1`.
- `mockup-sandbox` running as a dev server is **not** part of the workflow at all (`.replit` only declares stock-compare + api-server) — if you see it, it's a stray, safe to kill.
- Kill stray/orphaned processes directly with `kill <pid>`; never `pkill -9` broadly since that can catch the legitimate supervisor too — target specific PIDs found via the checks above.

`.claude/scripts/rehydrate.js`'s health-check-triggered auto-spawn now checks `pgrep` before spawning a new supervisor, so it won't recreate this problem on its own — but manual `pnpm run dev` at the workspace root (bypassing the supervised `start.sh` scripts) is still a way to reintroduce strays. Don't run it.

## Check logs

```bash
tail -30 /tmp/api-server.log
tail -30 /tmp/vite-dev.log
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 502 Bad Gateway on all `/api/*` | API server not running | Check `pgrep -af start.sh`; if missing entirely, ask user to Stop/Run |
| 404 on a new route after rebuild | Route missing `/api` prefix, or not mounted in `src/index.ts` | Check router mount |
| Old behavior after code change | Forgot to rebuild dist, or killed the wrong process | Re-run Step 1, then Step 2 above |
| Build succeeds but crashes on start | Runtime error in new code | Check `/tmp/api-server.log` |
| `EADDRINUSE` spam in `/tmp/api-server.log` | Duplicate supervisor running | See "Check for duplicate/stray processes" above |

## Routing rules (never repeat these bugs)

- Route files define paths **WITHOUT** `/api` prefix: `router.get("/indicators/:ticker", ...)`
- Router is mounted at `/api` in `src/index.ts` — prefix added there only
- Specific routes (`/options/position-quote`, `/options/batch`) **MUST** be declared **BEFORE** wildcard routes (`/options/:ticker`)

## Frontend TypeScript check

```bash
cd /home/runner/workspace/artifacts/stock-compare && npx tsc --noEmit
```
