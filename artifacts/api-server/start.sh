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
  echo "$(date): API server exited (code $?), restarting in 2s..." >> /tmp/api-server.log
  sleep 2
done
