#!/bin/bash
# Migrate Replit Postgres → local tradedash DB.
#
# I cannot talk to Claude-on-Replit. You (or Replit Claude) must expose the
# Replit DATABASE_URL once, then this script does the rest.
#
# Setup (pick ONE):
#   A) Add to .env.local (never commit):
#        REPLIT_DATABASE_URL=postgresql://...   # from Replit Secrets → DATABASE_URL
#   B) Or drop a dump file produced on Replit:
#        /tmp/fildi-replit.dump   (custom format from pg_dump -Fc)
#
# Usage:
#   ./scripts/migrate-from-replit.sh              # full restore (replaces local data)
#   ./scripts/migrate-from-replit.sh --dump-only  # only fetch dump, don't restore
#   ./scripts/migrate-from-replit.sh --from-file /path/to.dump
#
# After restore: local admin password may change to Replit's users — use
#   node scripts/reset-password.mjs you@email.com 'NewPassword123'
# or re-seed .local-admin-credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${HOME}/Applications/Postgres.app/Contents/Versions/16/bin"
export PATH="${PG_BIN}:/usr/bin:/bin:/usr/local/bin:${PATH}"

DUMP_ONLY=0
FROM_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump-only) DUMP_ONLY=1; shift ;;
    --from-file) FROM_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -f "$ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.local"
  set +a
fi

# Always restore into local Postgres — never into a remote/Replit URL
LOCAL_URL="postgresql://jamiepark@127.0.0.1:5432/tradedash"
DUMP_PATH="${FROM_FILE:-/tmp/fildi-replit.dump}"
mkdir -p /tmp/fildi-logs

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "Starting local Postgres..."
  pg_ctl -D "${HOME}/Library/Application Support/tradedash-pg16" \
    -l "${HOME}/Library/Logs/tradedash-pg16.log" -o "-p 5432" start
  sleep 2
fi

if [[ -z "$FROM_FILE" ]]; then
  if [[ -z "${REPLIT_DATABASE_URL:-}" ]]; then
    cat >&2 <<'EOF'
Missing REPLIT_DATABASE_URL.

Do this on Replit (Secrets → copy DATABASE_URL), then either:

  1) Append to .env.local on this Mac:
       REPLIT_DATABASE_URL='postgresql://USER:PASS@HOST/DB'

  2) Or paste this to Claude-on-Replit and download the dump:
       pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc -f /tmp/fildi-replit.dump
       # then download /tmp/fildi-replit.dump into this Mac as /tmp/fildi-replit.dump
       ./scripts/migrate-from-replit.sh --from-file /tmp/fildi-replit.dump

EOF
    exit 1
  fi

  echo "Dumping Replit DB (custom format, no owners)..."
  # Host only for logging — never print full URL
  python3 - <<'PY'
import os, urllib.parse
u=urllib.parse.urlparse(os.environ["REPLIT_DATABASE_URL"])
print(f"  source host={u.hostname} db={(u.path or '/')[1:]}")
PY
  pg_dump "$REPLIT_DATABASE_URL" --no-owner --no-acl -Fc -f "$DUMP_PATH"
  echo "  wrote $DUMP_PATH ($(du -h "$DUMP_PATH" | awk '{print $1}'))"
fi

if [[ ! -f "$DUMP_PATH" ]]; then
  echo "Dump not found: $DUMP_PATH" >&2
  exit 1
fi

if [[ "$DUMP_ONLY" -eq 1 ]]; then
  echo "Dump-only mode complete: $DUMP_PATH"
  exit 0
fi

echo "Restoring into local DB (this REPLACES local data)..."
echo "  target: local tradedash @ 127.0.0.1:5432"
# Drop+recreate public schema is safer than --clean against role mismatches
psql "$LOCAL_URL" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
SQL

pg_restore --no-owner --no-acl -d "$LOCAL_URL" "$DUMP_PATH" || {
  echo "pg_restore exited non-zero (often OK for extension/comment noise). Checking tables..."
}

# Ensure connect-pg-simple session table exists even if dump omitted it
psql "$LOCAL_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
SQL

echo "=== row counts ==="
psql "$LOCAL_URL" -Atc "
SELECT 'users='||(SELECT count(*) FROM users)
||' watchlist='||(SELECT count(*) FROM watchlist)
||' positions='||(SELECT count(*) FROM positions)
||' portfolio_snapshots='||(SELECT count(*) FROM portfolio_snapshots)
||' portfolio_positions='||(SELECT count(*) FROM portfolio_positions)
||' ticker_fundamentals='||(SELECT count(*) FROM ticker_fundamentals)
||' peer_groups='||(SELECT count(*) FROM peer_groups);
"

echo
echo "Done. Restart API if it was running so pools reconnect."
echo "Login with your Replit user email/password, or:"
echo "  source .env.local && node scripts/reset-password.mjs you@email.com 'TempPass1234'"
