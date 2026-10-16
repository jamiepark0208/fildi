#!/usr/bin/env bash
# Local git config for auto-merging (user 10-16: agents must not hand merge conflicts to Jamie).
# Idempotent. Pairs with .gitattributes (merge=mergiraf / union / ours) and scripts/agent-git-sync.sh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

git config merge.mergiraf.name mergiraf
git config merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L"
git config merge.ours.driver true
git config rerere.enabled true
git config rerere.autoupdate true
git config merge.conflictStyle diff3

if ! command -v mergiraf >/dev/null 2>&1; then
  echo "warn: mergiraf not installed — code files fall back to plain text merges (brew install mergiraf)" >&2
fi
echo "agent-git-setup: merge drivers + rerere configured"
