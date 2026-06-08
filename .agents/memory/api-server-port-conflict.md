---
name: API server port conflict
description: Stale node process holds port 8080 after workflow restarts; fix pattern and workaround.
---

**Rule:** Replit's workflow restart mechanism may leave a stale `node dist/index.mjs` process holding port 8080. This causes the new process to fail with `EADDRINUSE`.

**Fix applied:** `artifacts/api-server/kill-port.mjs` reads `/proc/net/tcp` to find the socket inode for port 8080, locates the owning PID via `/proc/<pid>/fd`, and kills it. This script runs as part of the `dev` script before `pnpm run start`.

**How to apply:** If the API server workflow shows "failed" but `curl http://localhost:8080/api/daily-brief` returns data, the old process is still healthy. To get a clean restart: find the PID via `/proc/net/tcp` inode lookup and kill it, then restart the workflow.

**Why:** Replit's `restart_workflow` tool sends SIGTERM but the workflow manager can race — spawning a new process before the old one fully releases the port.
