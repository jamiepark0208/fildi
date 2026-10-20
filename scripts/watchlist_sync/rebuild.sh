#!/bin/sh
# Model List rebuild in one command, quiet (W04, Claude 10-20): build_plan (L1) → verify_plan evaluate (L2) → publish → funnel summary.
# Full output goes to a log (path printed); the terminal gets ~6 lines. Same steps/order as daily.py's plan/verify/publish stages.
#   scripts/watchlist_sync/rebuild.sh [--side calls]
set -e
cd "$(dirname "$0")"
LOG="${TMPDIR:-/tmp}/fildi-rebuild-$(date +%Y%m%d-%H%M%S).log"
PY=.venv/bin/python
$PY build_plan.py >"$LOG" 2>&1 || { echo "build_plan FAILED — tail:"; tail -5 "$LOG"; exit 1; }
PLAN=$($PY -c "from build_plan import connect; print(connect().execute('SELECT MAX(id) FROM watchlist_sync.plans').fetchone()[0])")
$PY verify_plan.py evaluate --plan "$PLAN" >>"$LOG" 2>&1 || { echo "verify FAILED — tail:"; tail -5 "$LOG"; exit 1; }
$PY publish_model_list.py >>"$LOG" 2>&1 || { echo "publish FAILED — tail:"; tail -5 "$LOG"; exit 1; }
$PY funnel.py "$@"
echo "full log: $LOG"
printf '{"t":"%s","tool":"rebuild.sh","agent":"%s","log_bytes":%s}\n' "$(date -u +%FT%TZ)" "${FILDI_AGENT:-claude}" "$(wc -c <"$LOG" | tr -d ' ')" >> "$HOME/.fildi/workflow-usage.jsonl"
