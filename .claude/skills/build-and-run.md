---
name: build-and-run
description: Rebuild the API server and restart it. Use after ANY change to api-server/src/**. Also covers diagnosing 502 errors and verifying the stack is healthy.
---

# TradeDash — Build & Run Reference

The app has two independently running processes. Both must be running for the UI to work.

| Process | Port | Tech | Restarts on change? |
|---|---|---|---|
| `stock-compare` (Vite dev server) | varies (env PORT) | React/Vite | **Yes** — hot-reload |
| `api-server` | **8080** | Node/Express (built ESM bundle) | **NO** — must rebuild + restart manually |

Vite proxies all `/api/*` requests to `http://localhost:8080`. If the API server is not running → **502 Bad Gateway** in the browser.

---

## Step 1 — Check what's running

```bash
ps aux | grep "dist/index" | grep -v grep
```

Expected output: a node process running `dist/index.mjs` on port 8080.  
If missing → 502 errors everywhere. Go to Step 3.

## Step 2 — Check server logs (if running but returning errors)

```bash
tail -30 /tmp/api-server.log
```

## Step 3 — Full rebuild + restart (do this after ANY api-server/src change)

```bash
# 1. Kill any old server
pkill -f "api-server/dist/index" 2>/dev/null; sleep 0.5

# 2. Build
cd /home/runner/workspace/artifacts/api-server && node build.mjs

# 3. Start in background
PORT=8080 node --enable-source-maps /home/runner/workspace/artifacts/api-server/dist/index.mjs >> /tmp/api-server.log 2>&1 &
echo "Started PID: $!"

# 4. Verify (wait 2s for boot)
sleep 2 && curl -s "http://localhost:8080/api/daily-brief" | head -c 80
```

Expected: JSON response (not HTML, not connection refused).

## Step 4 — Verify specific routes after a new route is added

```bash
# Pattern: curl -s "http://localhost:8080/api/<your-new-route>"
curl -s "http://localhost:8080/api/indicators/NVDA" | python3 -m json.tool | head -20
```

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 502 Bad Gateway on all `/api/*` | API server not running | Step 3 |
| 404 on a new route | Built old code, forgot to rebuild | Step 3 |
| 404 on a new route after rebuild | Route missing `/api` prefix, or mounted wrong | Check `src/index.ts` router mount |
| Old behavior after code change | Forgot to kill old process before restart | `pkill -f "api-server/dist/index"` then Step 3 |
| Build succeeds but crashes on start | Runtime error in new code | Check `/tmp/api-server.log` |

---

## Routing rules (never repeat these bugs)

- Route files define paths **WITHOUT** `/api` prefix  
  ✅ `router.get("/indicators/:ticker", ...)`  
  ❌ `router.get("/api/indicators/:ticker", ...)`
- The router is mounted at `/api` in `src/index.ts` — the prefix is added there only
- Vite proxy: `"/api"` → `http://localhost:8080` in `vite.config.ts`

---

## Quick one-liner (use this after every backend change)

```bash
pkill -f "api-server/dist/index" 2>/dev/null; sleep 0.3 && cd /home/runner/workspace/artifacts/api-server && node build.mjs && PORT=8080 node --enable-source-maps /home/runner/workspace/artifacts/api-server/dist/index.mjs >> /tmp/api-server.log 2>&1 & sleep 2 && echo "✓ server up" && curl -s "http://localhost:8080/api/daily-brief" | head -c 60
```

---

## Frontend TypeScript check (run after any .tsx/.ts change)

```bash
cd /home/runner/workspace/artifacts/stock-compare && npx tsc --noEmit
```

No output = clean. Fix all errors before testing in browser.
