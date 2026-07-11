#!/bin/bash
# Local dev startup: api-server (hot-reload) + Vite, only starting once
# /api/healthz responds. Not used by the Replit-managed workflow — that
# runs its own two supervisor loops (see .claude/skills/build-and-run.md).
#
# Usage: PORT=8080 SESSION_SECRET=... DATABASE_URL=... ./scripts/dev-up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8080}"
VITE_PORT="${VITE_PORT:-8081}"
BASE_PATH="${BASE_PATH:-/}"
HEALTH_URL="http://localhost:${API_PORT}/api/healthz"
TIMEOUT_SECS=60

: "${SESSION_SECRET:?SESSION_SECRET is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

echo "Starting api-server (tsx watch) on port ${API_PORT}..."
(cd "$ROOT/artifacts/api-server" && PORT="$API_PORT" pnpm run dev:watch) &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Waiting for ${HEALTH_URL}..."
elapsed=0
until curl -sf "$HEALTH_URL" > /dev/null 2>&1; do
  if [ "$elapsed" -ge "$TIMEOUT_SECS" ]; then
    echo "api-server did not become healthy within ${TIMEOUT_SECS}s" >&2
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
echo "api-server healthy after ${elapsed}s."

echo "Starting stock-compare (Vite) on port ${VITE_PORT}..."
(cd "$ROOT/artifacts/stock-compare" && PORT="$VITE_PORT" BASE_PATH="$BASE_PATH" pnpm run dev) &
VITE_PID=$!

cleanup() {
  kill "$API_PID" "$VITE_PID" 2>/dev/null || true
}

wait "$API_PID" "$VITE_PID"
