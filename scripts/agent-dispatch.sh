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

# 10-24 (Jamie waited hours on a stuck run): stream progress to a persistent file the watchdog and dispatch-status read.
mkdir -p /tmp/fildi-logs/dispatch
OUT="/tmp/fildi-logs/dispatch/$(date +%m%d-%H%M%S)-$CHILD.jsonl"
STALL_MIN="${DISPATCH_STALL_MIN:-20}"     # no new output AND < 2 s CPU in the agent's process tree for this long → stalled
MAX_MIN="${DISPATCH_MAX_MIN:-120}"        # hard cap per run
# Claim the first ASKS row the prompt names (.agents/claims/ convention) so the IDE Cursor doesn't run it too (10-22: S081/A245 ran twice).
ASK_ID=$(grep -oE '\bA[0-9]{3}\b' "$PROMPT_FILE" | head -1 || true)
# Jamie 11-07 (A359 fix3/fix3b ran 40+ min on an engine with open High review findings → wasted).
# Gate 1: an open REVIEW row naming this ask must be handled by the prompt (cite its id), else refuse.
if [[ -n "$ASK_ID" && -z "${DISPATCH_IGNORE_REVIEWS:-}" ]]; then
  ASKS_MD="$(dirname "$0")/../research/common/ASKS.md"
  OPEN_REV=$(grep -E "^\| \[A[0-9]{3}\]" "$ASKS_MD" 2>/dev/null | grep -i "REVIEW" | grep -w "$ASK_ID" \
    | grep -viE "\| *(done|verified|declined|parked)[^|]*\| *$" | grep -oE "^\| \[A[0-9]{3}\]" | grep -oE "A[0-9]{3}" | grep -vx "$ASK_ID" || true)
  for r in $OPEN_REV; do
    if ! grep -qw "$r" "$PROMPT_FILE"; then
      echo "agent-dispatch: REFUSED — open review $r has findings on $ASK_ID; fix those first or name $r in the prompt (override DISPATCH_IGNORE_REVIEWS=1)." >&2
      exit 3
    fi
  done
fi
# Gate 2: build runs need a smoke gate (small slice + sanity checks before any long run).
if [[ -z "$ASK" ]] && ! grep -qi "smoke gate" "$PROMPT_FILE"; then
  echo "agent-dispatch: REFUSED — prompt has no 'Smoke gate' section (≤ 2-min slice, sanity checks that must pass before the full run)." >&2
  exit 3
fi
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
  const lines = fs.readFileSync(process.env.OUT, "utf8").trim().split("\n");
  const r = JSON.parse(lines.reverse().find((l) => l.includes("\"type\":\"result\"")) || lines[0]);
  if (r.usage) row.usage = r.usage;
  if (r.duration_ms) row.ms = r.duration_ms;
  if (r.result) process.stdout.write(r.result + "\n");
} catch { process.stdout.write(fs.readFileSync(process.env.OUT, "utf8").slice(-2000)); }
fs.appendFileSync(process.env.EVENTS, JSON.stringify(row) + "\n");
'
}
trap 'kill "$RUN" "$WD" 2>/dev/null; end_event 143; exit 143' INT TERM   # killed runs still close their Stage beam

ARGS+=(--output-format stream-json)
set +e
# Prompt = calibration lessons + files other agents edited in the last 30 min (IDE Cursor etc.) + task
FULL="$(mktemp -t agent-dispatch-prompt)"
{
  echo "Read .agents/context/calibration-log.md first (lessons from past reviews)."
  # 11-03 audit: Cursor runs averaged 23 reads + 17 greps re-finding files the ask already names (~2.6M input tokens/run)
  echo "Token budget: start from the paths/functions the task and its asks/A###.md name. Locate anything else with codegraph (MCP) or one narrow rg; read line ranges, not whole files over 300 lines; no repo-wide exploration."
  BUSY=$(node "$(dirname "$0")/busy-files.mjs" --one-line 2>/dev/null || true)
  [[ -n "$BUSY" ]] && echo "Busy files (another agent edited in the last 30 min — do not edit unless the task below names them; the dispatching agent edited those for you): $BUSY"
  # 11-06: a run read its own dispatcher's claim + task files as another agent's work and quit.
  [[ -n "${ASK_ID:-}" ]] && echo "The claim .agents/claims/dispatch-$ASK_ID.json is THIS run's own (agent-dispatch pid $$) — not a collision; proceed."
  echo "Smoke gate (mandatory): before any command that runs > 5 min, run the smallest slice (≤ 2 min) and print SANITY lines — trade/row count plausible, output CHANGES when the main parameter changes, one trade/row hand-checked against raw data. Any SANITY fail → stop, write the failure in the packet, do NOT start the full run. Print the first full-run result line within 10 min."
  echo
  cat "$PROMPT_FILE"
} > "$FULL"
# Jamie 10-22: stay awake while the run lasts (-i idle, -s system on AC); ends with the run, never longer.
caffeinate -i -s "$BIN" "${ARGS[@]}" < "$FULL" > "$OUT" 2>&1 &
RUN=$!
tree_cpu() {   # total CPU seconds of a process and all its descendants
  local all="$1" frontier="$1" kids p
  while :; do
    kids=""
    for p in $frontier; do kids="$kids $(pgrep -P "$p" | tr '\n' ' ')"; done
    [[ -z "${kids// /}" ]] && break
    all="$all $kids"; frontier="$kids"
  done
  ps -o time= -p "$(echo $all | tr -s ' ' ',')" 2>/dev/null | awk -F'[:.]' '{ s += (NF > 3 ? $1*3600 + $2*60 + $3 : $1*60 + $2) } END { print s+0 }'
}
watchdog() {   # stalled / reconnect loop / over the cap → kill, record, say so (exit 124)
  local start=$(date +%s) last_size=-1 last_change=$(date +%s) last_cpu=0 cpu size now why=""
  while kill -0 "$RUN" 2>/dev/null; do
    sleep 60
    now=$(date +%s); size=$(stat -f %z "$OUT" 2>/dev/null || echo 0); cpu=$(tree_cpu "$RUN")
    if (( size != last_size || cpu - last_cpu >= 2 )); then last_change=$now; fi
    last_size=$size; last_cpu=$cpu
    [[ -n "$CLAIM" && -f "$CLAIM" ]] && sed -i '' -E "s/\"heartbeat_at\": \"[^\"]*\"/\"heartbeat_at\": \"$(date -u +%FT%TZ)\"/" "$CLAIM"
    if (( now - last_change > STALL_MIN * 60 )); then why="stalled: no output or CPU for ${STALL_MIN} min"
    elif (( $(tail -n 40 "$OUT" 2>/dev/null | grep -c -i "connection lost") >= 5 )); then why="reconnect loop (Cursor connection lost x5)"
    elif (( now - start > MAX_MIN * 60 )); then why="over ${MAX_MIN} min cap"; fi
    if [[ -n "$why" ]]; then
      echo "agent-dispatch: KILLED $CHILD ($ASK_ID) — $why · log $OUT"
      printf '{"t":"%s","agent":"%s","event":"dispatch-stalled","child":"%s","ask":"%s","why":"%s","log":"%s"}\n' \
        "$(date -u +%FT%TZ)" "$FROM" "$CHILD" "$ASK_ID" "$why" "$OUT" >> "$EVENTS"
      kill -TERM "$RUN" 2>/dev/null; pkill -TERM -P "$RUN" 2>/dev/null
      return 0
    fi
  done
}
watchdog &
WD=$!
wait "$RUN"
EC=$?
kill "$WD" 2>/dev/null
grep -q '"event":"dispatch-stalled","child":"'"$CHILD"'"' "$EVENTS" 2>/dev/null && EC=124
rm -f "$FULL"
set -e
end_event "$EC"
exit "$EC"
