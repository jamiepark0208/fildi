---
name: build-and-run
description: Rebuild the API server and restart it. Use after ANY change to api-server/src/**. Also covers diagnosing 502 errors and verifying the stack is healthy. Read the PID-24 warning before touching any process that isn't a dist/index.mjs child.
---

# TradeDash — Build & Run Reference

| Process | Port | Restarts on change? |
|---|---|---|
| `stock-compare` (Vite) | **8081** | **Yes** — hot-reload |
| `api-server` (Express ESM) | **8080** | **NO** under the Replit-managed workflow below — must rebuild + restart manually. Manual local sessions (outside the managed workflow) can use `pnpm --filter @workspace/api-server dev:watch` (tsx watch) for hot-reload instead — see enh/5. |

## Process topology (the ONLY two processes that should exist)

The `.replit` "Project" workflow runs exactly two supervised tasks, each an infinite crash-restart loop that already holds all secrets (ANTHROPIC_API_KEY, DATABASE_URL, PORT):

Optional tuning env vars (unset = safe default, don't need to be secrets): `DATABASE_POOL_MAX` (default 20) — shared Postgres pool size for Drizzle + connect-pg-simple sessions in `lib/db/src/index.ts`, see bugs/6.

- `bash artifacts/stock-compare/start.sh` → `pnpm run dev` → vite on **8081**
- `bash artifacts/api-server/start.sh` → `node dist/index.mjs` on **8080**

Both loops **auto-relaunch their child within 2s if it exits** — so you never need to (and never should) hand-construct a fresh `node`/`pnpm` invocation with your own env vars. That always fails or drifts from the managed environment.

**Do NOT read `/proc/<pid>/environ` or probe individual secret var names (even just checking presence with `[ -n "$VAR" ]`)** — both leak information about secrets into the conversation. If you need to confirm secrets are available, check the health endpoint instead (below).

## Optional: local hot-reload dev server (does NOT apply to the Replit workflow)

`start.sh` (the process the Replit "Project" workflow runs) always calls `node build.mjs` then `node dist/index.mjs` directly — it never reads `package.json`'s `dev` script, so this doesn't change anything about the managed restart procedure below. It's a separate convenience for a manually-started local session (e.g. a bare terminal outside `.replit`'s supervisors) where you want edits to `src/**` to reload without a manual rebuild:

```bash
cd /home/runner/workspace/artifacts/api-server
PORT=<free-port> pnpm run dev:watch   # tsx watch — reflects src/** edits in ~1-3s
```

Requires the same env as `dev:rebuild` (`SESSION_SECRET`, `DATABASE_URL`, etc.) and a `PORT` not already bound by the managed workflow (8080). `pnpm run dev` now aliases to `dev:watch`; the old rebuild-then-start behavior is preserved as `dev:rebuild`. Production (`build` / `start`) is untouched — still esbuild to `dist/index.mjs`.

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

## NEVER kill a process whose parent is PID 24 (`pid2`) — even if it looks like a duplicate

`pid2` (PID 24) is Replit's own platform-level process supervisor, not anything in this repo. It sometimes launches extra processes directly (e.g. `mockup-sandbox`, a second stock-compare instance) outside the two `.replit` workflow tasks — `stock-compare/start.sh` even has a comment acknowledging this ("Replit agent starting mockup-sandbox"). These processes look redundant, but **you cannot tell from inside the container whether Replit's platform depends on them or is tracking their health as part of the workflow.**

**Incident (2026-07-10 → 2026-07-11):** a prior session diagnosed such a process as a "safe stray" and killed it directly. The kill produced `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`, which cascaded and tore down the *entire* Project workflow — both the stock-compare and api-server supervisors — not just the targeted process. Only an orphaned leftover `node dist/index.mjs` kept the API alive by accident; the frontend was fully down until the user restarted the workflow from Replit's UI.

**The only processes safe to `kill` directly are children spawned by our own `start.sh` loops** (i.e. `node dist/index.mjs` under api-server's supervisor — see Step 2 above). Everything else — anything with `ppid 24`, or anything whose supervisor you didn't personally verify is one of the two `start.sh` scripts — do not touch. If you see what looks like a duplicate or stray process at that level, just report it to the user; don't kill it.

If the app is unreachable and `pgrep -af start.sh` shows **fewer than 2** processes (i.e. a supervisor itself is gone, not just its child), you cannot recover this yourself — starting `start.sh` by hand won't have Replit's injected secrets, and you don't know why the supervisor died. Tell the user: **"Please Stop and Run the Replit app"** — this is the one legitimate case for that ask, don't try to route around it with manual process surgery.

```bash
pgrep -af "start.sh"                 # expect exactly 2: stock-compare + api-server. Fewer = need Stop/Run. More = report, don't kill.
pgrep -af "dist/index.mjs"           # expect exactly 1
```

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
