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

```bash
pkill -f "api-server/dist/index" 2>/dev/null; sleep 0.3 && cd /home/runner/workspace/artifacts/api-server && node build.mjs && PORT=8080 node --enable-source-maps /home/runner/workspace/artifacts/api-server/dist/index.mjs >> /tmp/api-server.log 2>&1 & sleep 2 && echo "✓ server up" && curl -s "http://localhost:8080/api/daily-brief" | head -c 60
```

Expected: JSON response (not HTML, not connection refused).

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
