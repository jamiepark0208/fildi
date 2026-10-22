#!/usr/bin/env bash
# A239 — launch cursor-agent (or Grok via same binary) with Stage dispatch beams.
# Usage: scripts/agent-dispatch.sh <to-agent> <model> <prompt-file> [--ask]
#   to-agent: cursor | grok | grokbot
#   --ask: read-only (--mode ask)
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:$PATH"   # launchd PATH has no node (10-22 plan-review failure)

TO="${1:?usage: agent-dispatch.sh <to-agent> <model> <prompt-file> [--ask]}"
MODEL="${2:?}"
PROMPT_FILE="${3:?}"
ASK=0
[[ "${4:-}" == "--ask" ]] && ASK=1

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "agent-dispatch: prompt file not found: $PROMPT_FILE" >&2
  exit 2
fi

EVENTS="${HOME}/.fildi/agent-events.jsonl"
mkdir -p "${HOME}/.fildi"
BIN="${HOME}/.local/bin/cursor-agent"
if [[ ! -x "$BIN" ]]; then
  echo "agent-dispatch: cursor-agent not at $BIN" >&2
  exit 2
fi

# from = claude when parent chain has .claude/shell-snapshots (same test as agents.ts owner())
FROM="${FILDI_AGENT:-}"
if [[ -z "$FROM" ]]; then
  FROM=cursor
  if [[ -n "${CLAUDE_CODE_ENTRYPOINT:-}" || -n "${CLAUDECODE:-}" || -n "${CLAUDE_CODE_SSE_PORT:-}" ]]; then
    FROM=claude
  else
    pid=$$
    for _ in $(seq 1 12); do
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      if [[ "$cmd" == *".claude/shell-snapshots"* ]]; then
        FROM=claude
        break
      fi
      ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
      [[ -z "$ppid" || "$ppid" == "0" || "$ppid" == "1" ]] && break
      pid=$ppid
    done
  fi
fi

TARGET="$TO"
case "$TO" in
  grok|grokbot) TARGET=grok ;;
  cursor|cursor-agent) TARGET=cursor ;;
esac

CHILD=$(uuidgen | tr '[:upper:]' '[:lower:]' | cut -c1-8)
DETAIL=$(head -n 1 "$PROMPT_FILE" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-80)

FROM="$FROM" TARGET="$TARGET" MODEL="$MODEL" DETAIL="$DETAIL" CHILD="$CHILD" EVENTS="$EVENTS" \
  node -e '
const fs = require("fs");
const row = {
  t: new Date().toISOString(),
  agent: process.env.FROM,
  event: "dispatch",
  target: process.env.TARGET,
  model: process.env.MODEL,
  detail: process.env.DETAIL || undefined,
  child: process.env.CHILD,
};
fs.appendFileSync(process.env.EVENTS, JSON.stringify(row) + "\n");
'

export FILDI_PARENT="${FROM}:${CHILD}"

ARGS=(-p --trust --model "$MODEL")
if [[ "$ASK" == "1" ]]; then ARGS+=(--mode ask); else ARGS+=(--force); fi   # headless -p without --force rejects every shell command

OUT="$(mktemp -t agent-dispatch)"
# Claim the first ASKS row the prompt names (.agents/claims/ convention) so the IDE Cursor doesn't run it too (10-22: S081/A245 ran twice).
ASK_ID=$(grep -oE '\bA[0-9]{3}\b' "$PROMPT_FILE" | head -1 || true)
CLAIM=""
if [[ -n "$ASK_ID" ]]; then
  CLAIM="$(cd "$(dirname "$0")/.." && pwd)/.agents/claims/dispatch-$ASK_ID.json"
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"agent": "cursor←%s", "task": "%s (agent-dispatch pid %s)", "claimed_at": "%s", "heartbeat_at": "%s"}\n' "$FROM" "$ASK_ID" "$$" "$NOW" "$NOW" > "$CLAIM"
fi
end_event() {   # dispatch-end + Cursor-side token usage (from --output-format json) → Stage + token ledger
  [[ -n "$CLAIM" ]] && rm -f "$CLAIM"
FROM="$FROM" TARGET="$TARGET" CHILD="$CHILD" EC="$1" EVENTS="$EVENTS" OUT="$OUT" \
  node -e '
const fs = require("fs");
const row = {
  t: new Date().toISOString(),
  agent: process.env.FROM,
  event: "dispatch-end",
  target: process.env.TARGET,
  child: process.env.CHILD,
  exit: Number(process.env.EC),
};
try {
  const r = JSON.parse(fs.readFileSync(process.env.OUT, "utf8").trim().split("\n").pop());
  if (r.usage) row.usage = r.usage;
  if (r.duration_ms) row.ms = r.duration_ms;
  if (r.result) process.stdout.write(r.result + "\n");
} catch { process.stdout.write(fs.readFileSync(process.env.OUT, "utf8")); }
fs.appendFileSync(process.env.EVENTS, JSON.stringify(row) + "\n");
'
}
trap 'end_event 143; rm -f "$OUT"; exit 143' INT TERM   # killed runs still close their Stage beam

ARGS+=(--output-format json)
set +e
# Prompt = calibration lessons + files other agents edited in the last 30 min (IDE Cursor etc.) + task
FULL="$(mktemp -t agent-dispatch-prompt)"
{
  echo "Read .agents/context/calibration-log.md first (lessons from past reviews)."
  BUSY=$(node "$(dirname "$0")/busy-files.mjs" --one-line 2>/dev/null || true)
  [[ -n "$BUSY" ]] && echo "Busy files (another agent edited in the last 30 min — do not edit): $BUSY"
  echo
  cat "$PROMPT_FILE"
} > "$FULL"
# Jamie 10-22: stay awake while the run lasts (-i idle, -s system on AC); ends with the run, never longer.
caffeinate -i -s "$BIN" "${ARGS[@]}" < "$FULL" > "$OUT"
rm -f "$FULL"
EC=$?
set -e
end_event "$EC"
rm -f "$OUT"
exit "$EC"
