#!/usr/bin/env bash
# Running agent-dispatch jobs: task, age, minutes since last output, CPU, last event (10-24: stuck runs went unseen for an hour).
# Usage: scripts/dispatch-status.sh
now=$(date +%s); n=0
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
for pid in $(pgrep -f "^bash scripts/agent-dispatch.sh|^bash .*/scripts/agent-dispatch.sh"); do
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  ps -o command= -p "$ppid" | grep -qE "^bash .*agent-dispatch.sh" && continue   # the watchdog subshell, not a second job
  args=$(ps -o command= -p "$pid"); prompt=${args##* }
  task=$(grep -oE '\b(A[0-9]{3}|S[0-9]{3}[a-z]?)\b' "$prompt" 2>/dev/null | head -2 | tr '\n' ' ')
  start=$(ps -o lstart= -p "$pid" | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null)
  log=""
  for c in $(pgrep -P "$pid"); do
    log=$(lsof -p "$c" -a -d 1 -Fn 2>/dev/null | sed -n 's/^n//p' | grep fildi-logs/dispatch/ | head -1); [[ -n "$log" ]] && break
  done
  cpu=$(tree_cpu "$pid")
  if [[ -n "$log" ]]; then
    idle="quiet $(( (now - $(stat -f %m "$log")) / 60 )) min"
    last=$(tail -n 5 "$log" | grep -oE '"(command|path)":"[^"]{0,70}' | tail -1 | sed 's/^"[a-z]*":"//')
  else idle="no live log (pre-10-24 run, no watchdog)"; last=""; fi
  printf '%-14s pid %-6s age %3s min · cpu %4ss · %s · %s\n' "${task:-?}" "$pid" "$(( (now - ${start:-$now}) / 60 ))" "$cpu" "$idle" "$last"
  n=$((n + 1))
done
(( n == 0 )) && echo "no dispatch running"
grep '"dispatch-stalled"' ~/.fildi/agent-events.jsonl 2>/dev/null | tail -3 | cut -c1-200
