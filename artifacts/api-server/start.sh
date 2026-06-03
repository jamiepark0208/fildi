#!/bin/bash
set -e
cd /home/runner/workspace/artifacts/api-server

echo "$(date): Building API server..." >> /tmp/api-server.log
node build.mjs

echo "$(date): API server built, starting..." >> /tmp/api-server.log
while true; do
  PORT=8080 node --enable-source-maps dist/index.mjs >> /tmp/api-server.log 2>&1
  echo "$(date): API server exited (code $?), restarting in 2s..." >> /tmp/api-server.log
  sleep 2
done
