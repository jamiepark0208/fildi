#!/bin/bash
# Detached local restart for Mac Cursor/dev — API :8080 + Vite :8081.
# Exits after both are healthy (does NOT stay in foreground — safe for agents /
# LaunchAgent). Unlike a bare `pnpm run` in a Cursor terminal, aborting the
# agent does not kill these processes.
#
#   ./scripts/dev-restart.sh           # kill ports if busy, then start both
#   ./scripts/dev-restart.sh --if-down # only start what is missing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/fildi-logs"
API_PORT="${API_PORT:-8080}"
VITE_PORT="${VITE_PORT:-8081}"
BASE_PATH="${BASE_PATH:-/}"
IF_DOWN=0
[[ "${1:-}" == "--if-down" ]] && IF_DOWN=1

mkdir -p "$LOG_DIR"

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi
if [[ -f /tmp/fildi-env-export.sh ]]; then
  # shellcheck disable=SC1091
  source /tmp/fildi-env-export.sh 2>/dev/null || true
fi

export PATH="$HOME/Applications/Postgres.app/Contents/Versions/16/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export DATABASE_URL="${DATABASE_URL:-postgresql://jamiepark@127.0.0.1:5432/tradedash}"
export NODE_ENV="${NODE_ENV:-development}"
export DISABLE_SCHEDULER_ENRICHMENT="${DISABLE_SCHEDULER_ENRICHMENT:-1}"

if [[ -z "${SESSION_SECRET:-}" ]]; then
  echo "ERROR: SESSION_SECRET missing (set in .env.local)" >&2
  exit 1
fi

listener_pid() {
  /usr/sbin/lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

ensure_postgres() {
  if pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
    return 0
  fi
  local pgdata="${PGDATA:-$HOME/Library/Application Support/tradedash-pg16}"
  if [[ -d "$pgdata" ]]; then
    echo "Starting Postgres ($pgdata)..."
    pg_ctl -D "$pgdata" -l "$HOME/Library/Logs/tradedash-pg16.log" -o "-p 5432" start || true
    sleep 1
  fi
  if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
    echo "ERROR: Postgres not ready on 127.0.0.1:5432" >&2
    exit 1
  fi
}

wait_http() {
  local url=$1
  local label=$2
  local timeout=${3:-45}
  local elapsed=0
  until curl -sf -o /dev/null "$url"; do
    if (( elapsed >= timeout )); then
      echo "ERROR: $label not healthy within ${timeout}s ($url)" >&2
      echo "  api log:  $LOG_DIR/api.log" >&2
      echo "  vite log: $LOG_DIR/vite.log" >&2
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  echo "$label ok after ${elapsed}s"
}

sweep_ports() {
  echo "Sweeping :$API_PORT / :$VITE_PORT (canonical + orphans)..."
  node "$ROOT/scripts/local-stack.mjs" down || true
}

start_api() {
  echo "Starting API (tsx watch) on :$API_PORT → $LOG_DIR/api.log"
  node "$ROOT/scripts/dev-spawn.mjs" \
    --cwd="$ROOT/artifacts/api-server" \
    --log="$LOG_DIR/api.log" \
    --pidfile="$LOG_DIR/api.pid.json" \
    --port="$API_PORT" \
    -- \
    PORT="$API_PORT" \
    NODE_ENV=development \
    DATABASE_URL="$DATABASE_URL" \
    SESSION_SECRET="$SESSION_SECRET" \
    DISABLE_SCHEDULER_ENRICHMENT="$DISABLE_SCHEDULER_ENRICHMENT" \
    PATH="$PATH" \
    pnpm run dev:watch
}

start_vite() {
  echo "Starting Vite on :$VITE_PORT → $LOG_DIR/vite.log"
  node "$ROOT/scripts/dev-spawn.mjs" \
    --cwd="$ROOT/artifacts/stock-compare" \
    --log="$LOG_DIR/vite.log" \
    --pidfile="$LOG_DIR/vite.pid.json" \
    --port="$VITE_PORT" \
    -- \
    PORT="$VITE_PORT" \
    BASE_PATH="$BASE_PATH" \
    PATH="$PATH" \
    pnpm run dev
}

ensure_postgres

api_up=0
vite_up=0
[[ -n "$(listener_pid "$API_PORT")" ]] && api_up=1
[[ -n "$(listener_pid "$VITE_PORT")" ]] && vite_up=1

if [[ "$IF_DOWN" -eq 1 ]]; then
  if [[ "$api_up" -eq 1 && "$vite_up" -eq 1 ]]; then
    echo "Already up: API :$API_PORT + Vite :$VITE_PORT"
    # Still report drift if any
    node "$ROOT/scripts/local-stack.mjs" status || true
    exit 0
  fi
  [[ "$api_up" -eq 0 ]] && start_api
  [[ "$vite_up" -eq 0 ]] && start_vite
else
  sweep_ports
  start_api
  start_vite
fi

wait_http "http://127.0.0.1:${API_PORT}/api/healthz" "API"
wait_http "http://127.0.0.1:${VITE_PORT}/" "Vite" 30

echo "Preview: http://localhost:${VITE_PORT}/"
echo "Detached. Aborting this shell will not stop API/Vite."
echo "Status:  ./scripts/dev-status.sh   Stop: ./scripts/dev-down.sh"
