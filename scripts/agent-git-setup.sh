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

# Pre-push: typecheck when api-server / stock-compare TS is in the push range (A94 lesson).
HOOK_DIR="$(git rev-parse --git-path hooks)"
mkdir -p "$HOOK_DIR"
HOOK="$HOOK_DIR/pre-push"
cat >"$HOOK" <<'EOF'
#!/usr/bin/env bash
# Installed by scripts/agent-git-setup.sh — blocks push of TS that fails typecheck.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
# stdin: <local_ref> <local_sha> <remote_ref> <remote_sha> per line
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [ -z "${local_sha:-}" ] && continue
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue
  base="$remote_sha"
  if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ]; then
    base="$(git merge-base "$local_sha" origin/cursor/mac-dev 2>/dev/null || git rev-parse "$local_sha~1")"
  fi
  "$ROOT/scripts/agent-ship-check.sh" "$base" "$local_sha" || exit 1
done
exit 0
EOF
chmod +x "$HOOK"

echo "agent-git-setup: merge drivers + rerere + pre-push ship-check configured"
