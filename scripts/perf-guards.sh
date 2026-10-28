#!/bin/bash
# perf-guards — flags risky patterns in ADDED lines only (Jamie 10-28: the "only shows up under real use" bug class).
# Advisory: prints findings, exit 0. Run by agent-ship-check on every push; agents fix or say why in the commit.
#
#   scripts/perf-guards.sh [base] [head]     # default origin/cursor/mac-dev..HEAD + working tree
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"
BASE="${1:-origin/cursor/mac-dev}"; HEAD="${2:-}"
if [[ -n "$HEAD" ]]; then diff="$(git diff -U0 "$BASE" "$HEAD" -- artifacts/api-server/src artifacts/stock-compare/src scripts artifacts/api-server/package.json 2>/dev/null)"
else diff="$(git diff -U0 "$BASE" -- artifacts/api-server/src artifacts/stock-compare/src scripts artifacts/api-server/package.json 2>/dev/null)"; fi

[[ -n "${PERF_GUARDS_DIFF_FILE:-}" ]] && diff="$(cat "$PERF_GUARDS_DIFF_FILE")"   # self-test hook
n=0
flag() { echo "perf-guards: $1 — $2"; echo "    $3"; n=$((n + 1)); }
file=""
while IFS= read -r line; do
  if [[ "$line" == "+++ b/"* ]]; then file="${line#+++ b/}"; continue; fi
  [[ "$line" == "+"* && "$line" != "+++"* ]] || continue
  l="${line#+}"
  [[ "$file" == *.test.* || "$file" == scripts/perf-guards.sh ]] && continue
  case "$file" in
    artifacts/api-server/src/*)
      if [[ "$l" =~ yahooFinance\.(quote|chart|quoteSummary|options|search|historical)\( && "$l" != *withDeadline* ]]; then
        flag "$file" "Yahoo call without withDeadline (a hung call stalls every caller sharing its cache)" "$l"; fi
      if [[ "$l" =~ setInterval\( && "$l" != *unref* ]]; then
        flag "$file" "setInterval without .unref() (keeps scripts alive; check it can't start in scripts/tests)" "$l"; fi
      if [[ "$l" =~ fetch\([\"\'\`]https?:// && "$l" != *signal* && "$l" != *timeout* ]]; then
        flag "$file" "outbound fetch without a timeout/AbortSignal" "$l"; fi
      if [[ "$l" =~ (readFileSync|execSync|execFileSync|spawnSync)\( && "$file" == */routes/* ]]; then
        flag "$file" "synchronous I/O in a request handler (blocks every request while it runs)" "$l"; fi
      ;;
    artifacts/stock-compare/src/*)
      if [[ "$l" =~ refetchInterval:[[:space:]]*([0-9_][0-9_[:space:]*]*) ]]; then
        expr="${BASH_REMATCH[1]//_/}"; v=$(( ${expr%%[[:space:]]} ))
        (( v < 30000 )) && flag "$file" "refetchInterval < 30 s (poll storm risk; match the server cache TTL)" "$l"; fi
      if [[ "$l" =~ on(MouseEnter|MouseOver|Scroll)=\{ && "$l" =~ (fetch|[Pp]refetch|ensure|load|query) ]]; then
        flag "$file" "fetch-on-hover/scroll handler (cap in-flight requests; one per row floods the browser's 6 connections)" "$l"; fi
      ;;
  esac
  if [[ "$l" =~ (node|tsx)[^\"]*--watch && "$l" != *pgrep* && ( "$file" == scripts/dev-* || "$file" == */package.json ) ]]; then
    flag "$file" "API watch mode (agents' edits restart the API and wipe caches)" "$l"; fi
done <<< "$diff"

(( n > 0 )) && echo "perf-guards: $n finding(s) — fix, or say why in the commit message (advisory)" || echo "perf-guards: ok"
exit 0
