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
# A251: intentional downtime — touch /tmp/fildi-stack-hold (optional expiry ISO in file). --if-down honors it.
HOLD_FILE="/tmp/fildi-stack-hold"
if [[ "$IF_DOWN" -eq 1 && -f "$HOLD_FILE" ]]; then
  exp="$(head -1 "$HOLD_FILE" 2>/dev/null || true)"
  now_epoch="$(date +%s)"
  if [[ -z "$exp" ]]; then
    echo "dev-restart: hold file $HOLD_FILE present (no expiry) — skip --if-down"
    exit 0
  fi
  # Accept unix epoch or ISO-ish; date -j on macOS for ISO
  exp_epoch=""
  if [[ "$exp" =~ ^[0-9]+$ ]]; then
    exp_epoch="$exp"
  else
    exp_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%S" "${exp%Z}" "+%s" 2>/dev/null || date -d "$exp" "+%s" 2>/dev/null || true)"
  fi
  if [[ -n "$exp_epoch" && "$now_epoch" -lt "$exp_epoch" ]]; then
    echo "dev-restart: hold until $exp — skip --if-down"
    exit 0
  fi
  echo "dev-restart: hold expired ($exp) — removing $HOLD_FILE"
  rm -f "$HOLD_FILE"
fi

# One restart at a time (maintain heal, the login LaunchAgent and agents all call this); a dead holder's lock is taken over.
LOCKD="$LOG_DIR/dev-restart.lock.d"
if ! mkdir "$LOCKD" 2>/dev/null; then
  holder="$(cat "$LOCKD/pid" 2>/dev/null || true)"
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then echo "dev-restart: another restart (pid $holder) is running — skip"; exit 0; fi
  rm -rf "$LOCKD"; mkdir "$LOCKD"
fi
echo $$ > "$LOCKD/pid"
trap 'rm -rf "$LOCKD"' EXIT

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

# 10-24: a crashed API leaves its tsx watcher alive ("waiting for file changes", no port) → --if-down started a second
# (then third) watcher; the next file edit would restart all of them. Kill this repo's API watchers before starting one.
kill_stale_api_watchers() {
  local pid
  for pid in $(pgrep -f "tsx --watch --watch-path=src src/index.ts" 2>/dev/null || true); do
    if [[ "$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" == "$ROOT/artifacts/api-server" ]]; then
      echo "Stopping stale API watcher pid=$pid"
      kill -TERM "-$(ps -o pgid= -p "$pid" | tr -d ' ')" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}

start_api() {
  kill_stale_api_watchers
  echo "Starting API (tsx watch) on :$API_PORT → $LOG_DIR/api.log"
  # Explicit SCHWAB_* so a stripped spawn env cannot drop MD credentials.
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
    SCHWAB_CLIENT_ID="${SCHWAB_CLIENT_ID:-}" \
    SCHWAB_SECRET="${SCHWAB_SECRET:-}" \
    SCHWAB_APP_KEY="${SCHWAB_APP_KEY:-}" \
    SCHWAB_APP_SECRET="${SCHWAB_APP_SECRET:-}" \
    FACTSET_PROXY_URL="${FACTSET_PROXY_URL:-}" \
    FACTSET_PROXY_SECRET="${FACTSET_PROXY_SECRET:-}" \
    FMP_API_KEY="${FMP_API_KEY:-}" \
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
  # A tsx-watch reload after a file edit leaves the port down for a few seconds — give it 20 s before replacing it.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ "$api_up" -eq 1 ]] && break
    sleep 2; [[ -n "$(listener_pid "$API_PORT")" ]] && api_up=1
  done
  [[ "$api_up" -eq 0 ]] && start_api
  [[ "$vite_up" -eq 0 ]] && start_vite
else
  sweep_ports
  start_api
  start_vite
fi

wait_http "http://127.0.0.1:${API_PORT}/api/healthz" "API"
wait_http "http://127.0.0.1:${VITE_PORT}/" "Vite" 30

# A251 boot proof line (first reboot / LaunchAgent) — one line, no agent watching required.
api_watchers="$(pgrep -f "tsx --watch --watch-path=src src/index.ts" 2>/dev/null | wc -l | tr -d ' ')"
printf '%s pg=ok api=200 vite=200 api_watchers=%s root=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$api_watchers" "$ROOT" >> "$LOG_DIR/stack-boot.log" || true

echo "Preview: http://localhost:${VITE_PORT}/"
echo "Detached. Aborting this shell will not stop API/Vite."
echo "Status:  ./scripts/dev-status.sh   Stop: ./scripts/dev-down.sh"
