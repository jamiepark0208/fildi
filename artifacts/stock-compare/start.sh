#!/bin/bash
# Crash-restart loop for Vite dev server (mirrors api-server/start.sh pattern)
cd /home/runner/workspace/artifacts/stock-compare

while true; do
  PORT=8081 BASE_PATH=/ pnpm run dev >> /tmp/vite-dev.log 2>&1
  echo "$(date): Vite exited (code $?), restarting in 2s..." >> /tmp/vite-dev.log
  sleep 2
done
