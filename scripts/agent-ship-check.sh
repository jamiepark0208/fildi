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

need_api=0
need_ui=0
echo "$files" | grep -qE '^artifacts/api-server/src/.*\.(ts|tsx)$' && need_api=1 || true
echo "$files" | grep -qE '^artifacts/stock-compare/src/.*\.(ts|tsx)$' && need_ui=1 || true

if [ "$need_api" -eq 0 ] && [ "$need_ui" -eq 0 ]; then
  echo "agent-ship-check: no api-server/stock-compare TS in range — skip"
  exit 0
fi

fail=0
if [ "$need_api" -eq 1 ]; then
  echo "agent-ship-check: typecheck api-server…"
  # Referenced lib/* projects resolve through emitted .d.ts — rebuild them first or new lib exports look missing.
  # api-zod too — temp worktrees often lack dist/; TS6305 otherwise flakes the push ship-check.
  (cd artifacts/api-server && pnpm exec tsc -b ../../lib/option-scoring ../../lib/db ../../lib/api-zod >/dev/null 2>&1) || true
  if ! (cd artifacts/api-server && pnpm exec tsc -p tsconfig.json --noEmit); then
    echo "agent-ship-check: FAIL api-server typecheck — fix before push (A94)" >&2
    fail=1
  fi
fi
if [ "$need_ui" -eq 1 ]; then
  echo "agent-ship-check: typecheck stock-compare…"
  # Temp worktrees often lack lib/*/dist — rebuild before UI tsc (same flake as api-server TS6305).
  (cd artifacts/stock-compare && pnpm exec tsc -b ../../lib/option-scoring ../../lib/api-client-react ../../lib/api-zod >/dev/null 2>&1) || true
  if ! (cd artifacts/stock-compare && pnpm exec tsc -p tsconfig.json --noEmit); then
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

echo "agent-ship-check: ok"
exit 0
