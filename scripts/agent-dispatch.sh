#!/usr/bin/env bash
# A239 — launch cursor-agent (or Grok via same binary) with Stage dispatch beams.
# Usage: scripts/agent-dispatch.sh <to-agent> <model> <prompt-file> [--ask]
#   to-agent: cursor | grok | grokbot
#   --ask: read-only (--mode ask)
set -euo pipefail

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

set +e
"$BIN" "${ARGS[@]}" < "$PROMPT_FILE"
EC=$?
set -e

FROM="$FROM" TARGET="$TARGET" CHILD="$CHILD" EC="$EC" EVENTS="$EVENTS" \
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
fs.appendFileSync(process.env.EVENTS, JSON.stringify(row) + "\n");
'

exit "$EC"
