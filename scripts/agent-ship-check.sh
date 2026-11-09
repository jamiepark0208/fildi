#!/usr/bin/env bash
# Gate before pushing agent commits that touch app TS/TSX (Jamie 2026-10-18).
# Prevents A94-class breaks: wrong import → api-server won't boot → Vite proxies die.
#
# Usage:
#   scripts/agent-ship-check.sh                 # files changed vs origin/cursor/mac-dev + dirty tree
#   scripts/agent-ship-check.sh <base> <head>   # files in that commit range
# Exit 0 = ok · Exit 1 = typecheck failed (do not push)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

base="${1:-}"
head="${2:-HEAD}"
if [ -z "$base" ]; then
  if git rev-parse --verify origin/cursor/mac-dev >/dev/null 2>&1; then
    base="$(git merge-base HEAD origin/cursor/mac-dev 2>/dev/null || git rev-parse HEAD~1)"
  else
    base="$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)"
  fi
fi

# Push path (explicit range from agent-git-sync): only what is being pushed — another agent's unsaved edit in the shared
# tree must not block an unrelated push (10-26: dirty quarantine-delisted.ts blocked a Python-only push). Manual run: also
# the working tree, so an agent checks its own edits before committing.
if [ -n "${1:-}" ]; then
  files="$(git diff --name-only "$base"..."$head" 2>/dev/null | sort -u || true)"
else
  files="$(
    { git diff --name-only "$base"..."$head" 2>/dev/null || true
      git diff --name-only
      git diff --cached --name-only
    } | sort -u
  )"
fi

# 11-08: negative study verdicts need a winner pass + rule-named verdict + independent n (S169 repeat).
"$ROOT/scripts/verdict-check.sh" "$base" "$head" || exit 1

# 11-04: A332 t1 split of maintain.mjs dropped two imports (maybePlanReviews, LOG_DIR) → nightly job crashed for a day.
# .mjs has no typecheck, so lint changed scripts/**/*.mjs for undefined names.
mjs="$(echo "$files" | grep -E '^scripts/.*\.mjs$' | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)"
if [ -n "$mjs" ]; then
  # shellcheck disable=SC2086
  if ! npx -y eslint@8.57.0 --no-eslintrc --env node,es2022 --parser-options=ecmaVersion:2022,sourceType:module \
       --rule 'no-undef:error' $mjs 2>/dev/null; then
    echo "agent-ship-check: FAIL undefined name in scripts/*.mjs (missing import?)" >&2
    exit 1
  fi
fi

need_api=0
need_ui=0
echo "$files" | grep -qE '^artifacts/api-server/src/.*\.(ts|tsx)$' && need_api=1 || true
echo "$files" | grep -qE '^artifacts/stock-compare/src/.*\.(ts|tsx)$' && need_ui=1 || true

if [ "$need_api" -eq 0 ] && [ "$need_ui" -eq 0 ]; then
  echo "agent-ship-check: no api-server/stock-compare TS in range — skip"
  exit 0
fi

# 11-03: typecheck the commit being pushed, not the shared dirty tree — another agent's uncommitted TS (peerRep WIP,
# untracked fund-score-explain.ts) blocked every push. Range mode + local TS changes → clean temp worktree at $head:
# per-package node_modules copied as symlinks (relative @workspace links stay inside it), root store symlinked.
TC="$ROOT"
TSC="pnpm exec tsc"
if [ -n "${1:-}" ] && [ -n "$(git status --porcelain -- artifacts lib | grep -E '\.(ts|tsx)$' | head -1)" ]; then
  TC="$(mktemp -d)/wt"
  git worktree add -q --detach "$TC" "$head"
  trap 'git -C "$ROOT" worktree remove --force "$TC" >/dev/null 2>&1; git -C "$ROOT" worktree prune >/dev/null 2>&1' EXIT
  ln -s "$ROOT/node_modules" "$TC/node_modules"
  for d in artifacts/*/node_modules lib/*/node_modules; do [ -d "$TC/${d%/node_modules}" ] && cp -RP "$ROOT/$d" "$TC/$d"; done
  TSC="$ROOT/node_modules/.bin/tsc"  # pnpm exec refuses a symlinked hoist dir
  echo "agent-ship-check: dirty TS in shared tree → typecheck clean checkout of ${head:0:8}"
fi
fail=0
# 11-03 (A332 65934a2e): new @ts-nocheck blinded tsc ("0 errors") while the router threw at import. Block added ones.
nocheck="$( { git diff "$base"..."$head" -- 'artifacts/*/src/*.ts' 'artifacts/*/src/*.tsx' 2>/dev/null
              [ -z "${1:-}" ] && git diff HEAD -- 'artifacts/*/src/*.ts' 'artifacts/*/src/*.tsx' 2>/dev/null; } \
            | grep -E '^\+[^+].*@ts-nocheck|^\+//.*@ts-nocheck' | head -3 || true)"
if [ -n "$nocheck" ]; then
  echo "agent-ship-check: FAIL new @ts-nocheck added — fix the types instead" >&2
  fail=1
fi
if [ "$need_api" -eq 1 ]; then
  echo "agent-ship-check: typecheck api-server…"
  # Referenced lib/* projects resolve through emitted .d.ts — rebuild them first or new lib exports look missing.
  # api-zod too — temp worktrees often lack dist/; TS6305 otherwise flakes the push ship-check.
  (cd "$TC/artifacts/api-server" && $TSC -b ../../lib/option-scoring ../../lib/db ../../lib/api-zod ../../lib/indicators >/dev/null 2>&1) || true
  if ! (cd "$TC/artifacts/api-server" && $TSC -p tsconfig.json --noEmit); then
    echo "agent-ship-check: FAIL api-server typecheck — fix before push (A94)" >&2
    fail=1
  fi
fi
if [ "$need_ui" -eq 1 ]; then
  echo "agent-ship-check: typecheck stock-compare…"
  # Temp worktrees often lack lib/*/dist — rebuild before UI tsc (same flake as api-server TS6305).
  (cd "$TC/artifacts/stock-compare" && $TSC -b ../../lib/option-scoring ../../lib/api-client-react ../../lib/api-zod ../../lib/indicators >/dev/null 2>&1) || true
  if ! (cd "$TC/artifacts/stock-compare" && $TSC -p tsconfig.json --noEmit); then
    echo "agent-ship-check: FAIL stock-compare typecheck — fix before push (A94)" >&2
    fail=1
  fi
fi

[ "$fail" -eq 0 ] || exit 1

# Optional warn only — ui-crash-guards are brittle string checks (false positives block A94 ships).
# Run explicitly: node scripts/ui-crash-guards.mjs  ·  or when INDEX / Agents / Research / feed reset paths change.
if echo "$files" | grep -qE '^(research/studies/INDEX\.md|artifacts/stock-compare/src/components/settings/(AgentsTab|ResearchTab)\.tsx|artifacts/api-server/src/(routes/feed|lib/ticker-pnl)\.ts)$'; then
  echo "agent-ship-check: ui-crash-guards (advisory)…"
  if ! node "$ROOT/scripts/ui-crash-guards.mjs"; then
    echo "agent-ship-check: WARN ui-crash-guards failed — fix or re-run; not blocking push" >&2
  fi
fi

# A305: hard-fail on tab-bar revival / CDN fonts / rogue font-family in stock-compare src
if [ "$need_ui" -eq 1 ] || echo "$files" | grep -qE '^artifacts/stock-compare/src/'; then
  echo "agent-ship-check: ui-style-guard…"
  # 11-06: scan the commit being pushed ($TC = clean worktree when the tree is dirty), not another agent's WIP.
  if ! node "$TC/scripts/ui-style-guard.mjs"; then
    echo "agent-ship-check: FAIL ui-style-guard — fix before push (A305)" >&2
    fail=1
  fi
fi
[ "$fail" -eq 0 ] || exit 1

if [ "$need_api" -eq 1 ]; then
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/api/healthz 2>/dev/null; then
    echo "agent-ship-check: healthz ok on :8080"
  else
    sleep 2
    if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/api/healthz 2>/dev/null; then
      echo "agent-ship-check: healthz ok after wait"
    else
      echo "agent-ship-check: WARN :8080 healthz down (typecheck passed; restart api if app should be live)" >&2
    fi
  fi
fi

# 10-28: advisory perf-guards on the lines being pushed (timeouts, unref'd intervals, poll/hover storms, watch mode).
"$(dirname "$0")/perf-guards.sh" "$(git merge-base "$base" "$head" 2>/dev/null || echo "$base")" "$head" || true

echo "agent-ship-check: ok"
exit 0
