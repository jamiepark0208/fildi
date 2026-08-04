#!/bin/bash
# Crash-restart loop for Vite dev server (mirrors api-server/start.sh pattern)
cd /home/runner/workspace/artifacts/stock-compare

while true; do
  # Something may already be serving 8081. `fuser` isn't available in this environment
  # so it can never evict a squatter, and per build-and-run.md we must never kill a
  # pid2-parented process anyway (a past attempt cascaded into taking down the whole
  # workflow) — so retrying instantly just burns CPU on a doomed EADDRINUSE forever.
  #
  # But not every 200/302 on 8081 is actually us — bug/20 (2026-08-04): mockup-sandbox
  # (a separate pid2-managed process, unrelated to this app) won the boot-time race for
  # 8081 and this loop backed off for good, assuming "someone already started my app,"
  # when it was really a different app entirely serving every route including
  # /watchlist. That took down the whole site through a full presentation undetected,
  # because this loop went silent instead of ever flagging the mismatch.
  #
  # So confirm it's genuinely US (not just anything alive on the port) by checking for
  # our index.html's title, and treat "someone else is squatting" as a distinct,
  # loudly-logged case with a short retry so we grab the port within seconds of it
  # freeing up instead of parking in a 15s backoff that masks the outage indefinitely.
  body="$(curl -s http://localhost:8081/ 2>/dev/null)"
  if echo "$body" | grep -q "Stock Comparison Tool"; then
    sleep 15
    continue
  elif [ -n "$body" ]; then
    echo "$(date): WARNING — port 8081 is serving a DIFFERENT app (not stock-compare), retrying in 3s..." >> /tmp/vite-dev.log
    sleep 3
    continue
  fi
  PORT=8081 BASE_PATH=/ pnpm run dev >> /tmp/vite-dev.log 2>&1
  echo "$(date): Vite exited (code $?), restarting in 2s..." >> /tmp/vite-dev.log
  sleep 2
done
