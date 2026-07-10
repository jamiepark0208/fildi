---
name: build-and-run
description: Rebuild the API server and restart it. Use after ANY change to api-server/src/**. Also covers diagnosing 502 errors and verifying the stack is healthy.
---

# TradeDash — Build & Run Reference

| Process | Port | Restarts on change? |
|---|---|---|
| `stock-compare` (Vite) | varies | **Yes** — hot-reload |
| `api-server` (Express ESM) | **8080** | **NO** — must rebuild + restart manually |

## Quick rebuild (use after every backend change)

**NEVER start the server manually.** The Replit-managed `pnpm run dev` process holds all env vars (ANTHROPIC_API_KEY, DATABASE_URL, PORT=8080). Starting manually always fails with missing secrets.

**NEVER read /proc/<pid>/environ** — it exposes secrets in the conversation.

### Step 1 — Build the dist (safe, no restart needed)
```bash
cd /home/runner/workspace/artifacts/api-server && node build.mjs
```

### Step 2 — Restart the server
Tell the user: **"Please Stop and Run the Replit app to pick up the backend changes."**
The Replit wrapper (`pnpm run dev`) will rebuild from source and start with all secrets.

### Step 3 — Verify
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/daily-brief
```
Expected: 401 (auth required = server is up).

## Check logs

```bash
tail -30 /tmp/api-server.log
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 502 Bad Gateway on all `/api/*` | API server not running | Run rebuild command above |
| 404 on a new route after rebuild | Route missing `/api` prefix, or not mounted in `src/index.ts` | Check router mount |
| Old behavior after code change | Forgot to kill old process | `pkill -f "api-server/dist/index"` then rebuild |
| Build succeeds but crashes on start | Runtime error in new code | Check `/tmp/api-server.log` |

## Routing rules (never repeat these bugs)

- Route files define paths **WITHOUT** `/api` prefix: `router.get("/indicators/:ticker", ...)`
- Router is mounted at `/api` in `src/index.ts` — prefix added there only
- Specific routes (`/options/position-quote`) **MUST** be declared **BEFORE** wildcard routes (`/options/:ticker`)

## Frontend TypeScript check

```bash
cd /home/runner/workspace/artifacts/stock-compare && npx tsc --noEmit
```
