#!/bin/bash
# Local Mac: prefer detached restart (survives agent/terminal abort).
# For a foreground pair that dies when this shell exits, use: FILDI_FOREGROUND=1 ./scripts/dev-up.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${FILDI_FOREGROUND:-}" == "1" ]]; then
  if [[ -f "$ROOT/.env.local" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env.local"
    set +a
  fi
  API_PORT="${API_PORT:-8080}"
  VITE_PORT="${VITE_PORT:-8081}"
  BASE_PATH="${BASE_PATH:-/}"
  : "${SESSION_SECRET:?SESSION_SECRET is required}"
  : "${DATABASE_URL:?DATABASE_URL is required}"
  echo "FOREGROUND mode — aborting this shell will stop API/Vite."
  (cd "$ROOT/artifacts/api-server" && PORT="$API_PORT" pnpm run dev:watch) &
  API_PID=$!
  VITE_PID=""
  cleanup() { kill "$API_PID" ${VITE_PID:+$VITE_PID} 2>/dev/null || true; }
  trap cleanup EXIT
  elapsed=0
  until curl -sf "http://localhost:${API_PORT}/api/healthz" >/dev/null 2>&1; do
    if (( elapsed >= 60 )); then exit 1; fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  (cd "$ROOT/artifacts/stock-compare" && PORT="$VITE_PORT" BASE_PATH="$BASE_PATH" pnpm run dev) &
  VITE_PID=$!
  wait "$API_PID" "$VITE_PID"
  exit 0
fi

exec "$ROOT/scripts/dev-restart.sh" "$@"
