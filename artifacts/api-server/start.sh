#!/bin/bash
# No set -e — crash-restart loop must survive build failures
cd /home/runner/workspace/artifacts/api-server

echo "$(date): Building API server..." >> /tmp/api-server.log
if ! node build.mjs >> /tmp/api-server.log 2>&1; then
  echo "$(date): Build failed — server will not start. Check /tmp/api-server.log" >> /tmp/api-server.log
  exit 1
fi

echo "$(date): API server built, starting..." >> /tmp/api-server.log
while true; do
  PORT=8080 node --enable-source-maps dist/index.mjs >> /tmp/api-server.log 2>&1
  code=$?
  # bug/20 (2026-08-04): a sibling pid2-managed process squatting our port can make this
  # loop crash-restart forever on EADDRINUSE without ever saying so plainly. If something
  # is answering healthz right after our own process died, flag it loudly instead of
  # letting the ordinary "restarting in 2s" line mask a stuck port collision.
  if [ "$code" != "0" ] && curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/healthz 2>/dev/null | grep -qE "^(200|401)$"; then
    echo "$(date): WARNING — port 8080 is held by a process that is NOT this API server (health check responded while we were down)" >> /tmp/api-server.log
  fi
  echo "$(date): API server exited (code $code), restarting in 2s..." >> /tmp/api-server.log
  sleep 2
done
