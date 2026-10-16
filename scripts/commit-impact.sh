#!/usr/bin/env bash
# Commit impact (A128 v3, user 10-16: script on codegraph instead of a second MCP).
# What a commit/range touches: changed files, changed top-level symbols (declarations on +/- lines and the
# enclosing function of each hunk), and who calls each symbol (codegraph CLI; grep fallback). ≤ 40 lines.
# Usage: scripts/commit-impact.sh <sha | a..b>   (default HEAD)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
REV="${1:-HEAD}"
if [[ "$REV" == *..* ]]; then RANGE="$REV"; else RANGE="$REV^..$REV"; fi
git rev-parse -q --verify "${RANGE%%..*}" >/dev/null 2>&1 || { echo "commit-impact: bad rev '$REV'" >&2; exit 2; }

CODE='\.(ts|tsx|js|mjs|cjs|py)$'
files="$(git diff --name-only "$RANGE")"
code_files="$(printf '%s\n' "$files" | grep -E "$CODE" | grep -vE '(^|/)(dist|node_modules|generated)/' || true)"
# symbols come from non-test files only (tests still listed as changed files)
src_files="$(printf '%s\n' "$code_files" | grep -vE '(^|/)(tests?|__tests__)/|(^|/)test_[^/]*$|\.(test|spec)\.' || true)"
n_files=$(printf '%s\n' "$files" | grep -c . || true)
n_code=$(printf '%s\n' "$code_files" | grep -c . || true)
echo "commit-impact $RANGE: $n_files files changed ($n_code code)"
printf '%s\n' "$code_files" | grep . | head -8 | sed 's/^/  /'
[ "$n_code" -gt 8 ] && echo "  … +$((n_code - 8)) more code files"
[ "$n_code" -eq 0 ] && exit 0

# Symbols: declarations on changed lines + hunk-header enclosing functions.
DECL='(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?(function\*?|class|interface|type|const|let|def)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)'
syms="$(
  while IFS= read -r f; do
    git diff -U0 "$RANGE" -- "$f" | grep -E '^[+-][^+-]|^@@' | while IFS= read -r l; do
      # top-level only: hunk-header context, or a +/- line whose declaration starts at column 0
      if [[ "$l" == @@* ]]; then l="${l#*@@*@@}"; l="${l# }"; else l="${l:1}"; fi
      printf '%s\n' "$l" | grep -oE "^$DECL" | awk '{print $NF}'
    done
  done <<<"$src_files" | grep -vE '^(if|for|while|return|const|let|function|default|async|export|main|run|Run|handler|index|init|setup|props|Props|_)$' | sort | uniq -c | sort -rn | awk '{print $2}'
)"
n_syms=$(printf '%s\n' "$syms" | grep -c . || true)
echo "symbols touched: $n_syms (top 10 by edits)"

have_cg=0; command -v codegraph >/dev/null 2>&1 && have_cg=1
shown=0
for s in $syms; do
  [ $shown -ge 10 ] && break
  summary="" out=""
  if [ $have_cg = 1 ] && out="$(codegraph callers "$s" -j -l 50 2>/dev/null)" && [ -n "$out" ]; then
    summary="$(printf '%s' "$out" | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const c=j.callers||[];
      const ext=c.filter(x=>x.filePath);const files=[...new Set(ext.map(x=>x.filePath))];
      if(c.length===0){console.log("ZERO");return}
      console.log(c.length+" callers in "+files.length+" files"+(c.length?": "+ext.slice(0,3).map(x=>x.name+" ("+x.filePath.replace(/^artifacts\//,"")+":"+x.startLine+")").join(", "):""))}catch{console.log("?")}})')"
  fi
  if [ "${summary:-}" = "ZERO" ] || [ "${summary:-}" = "?" ] || [ $have_cg = 0 ] || [ -z "${out:-}" ]; then
    hits="$(git grep -n -w "$s" -- '*.ts' '*.tsx' '*.py' '*.mjs' ':!**/generated/**' ':!**/dist/**' 2>/dev/null | wc -l | tr -d ' ')"
    summary="0 call edges (JSX/imports?) · grep: $hits refs"
  fi
  echo "  $s — $summary"
  shown=$((shown + 1))
done
[ "$n_syms" -gt 10 ] && echo "  … +$((n_syms - 10)) more symbols"
exit 0
