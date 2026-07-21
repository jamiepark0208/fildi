#!/bin/bash
# Crash-restart loop for Vite dev server (mirrors api-server/start.sh pattern)
cd /home/runner/workspace/artifacts/stock-compare

while true; do
  # If something is already serving 8081 (e.g. Replit's platform spawning its own
  # stock-compare instance directly, outside this workflow — a known quirk), back off
  # instead of crash-looping every 2s. `fuser` isn't available in this environment so
  # it can never evict a squatter, and per build-and-run.md we must never kill a
  # pid2-parented process anyway (a past attempt cascaded into taking down the whole
  # workflow) — so retrying instantly just burns CPU on a doomed EADDRINUSE forever.
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/ 2>/dev/null | grep -qE "^(200|302)$"; then
    sleep 15
    continue
  fi
  PORT=8081 BASE_PATH=/ pnpm run dev >> /tmp/vite-dev.log 2>&1
  echo "$(date): Vite exited (code $?), restarting in 2s..." >> /tmp/vite-dev.log
  sleep 2
done
