#!/usr/bin/env bash
# Wait for A357 LSE backfill, then run regrade (step 4).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PY="$ROOT/scripts/watchlist_sync/.venv/bin/python"
BACKFILL="$ROOT/scripts/watchlist_sync/analysis/a357_lse_option_backfill.py"
REG="$ROOT/scripts/watchlist_sync/analysis/a357_regrade.py"
LOG="$ROOT/logs/a357-lse-backfill.log"
TARGET_OCC=500

while true; do
  if ! pgrep -f "a357_lse_option_backfill.py" >/dev/null 2>&1; then
    n=$(cd "$ROOT/scripts/watchlist_sync" && "$PY" -c "
from build_plan import connect
with connect() as c:
    print(c.execute('SELECT COUNT(DISTINCT occ)::int FROM lse_option_daily').fetchone()[0])
" 2>/dev/null || echo 0)
    if [[ "$n" -ge "$TARGET_OCC" ]]; then
      exec "$PY" "$REG" >>"$ROOT/logs/a357-regrade.log" 2>&1
    fi
    echo "backfill exited but only $n OCC(s) in daily (need $TARGET_OCC); see $LOG" >&2
    exit 1
  fi
  sleep 120
done
