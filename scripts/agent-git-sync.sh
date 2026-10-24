#!/usr/bin/env bash
# Push this checkout's local commits without disturbing anyone's uncommitted work (user 10-16).
#
# Never stashes, rebases, checks out, resets or pulls in the shared worktree. When origin moved on,
# the local commits are cherry-picked onto origin in a temp worktree (mergiraf / union / rerere apply),
# pushed from there, then only the paths that changed are brought into this checkout:
#   clean path → new content + index entry; dirty path → 3-way merge kept on top of the owner's edits;
#   unmergeable dirty path → file untouched, new version saved as <path>.incoming.
#
# Usage: scripts/agent-git-sync.sh [branch]   (default cursor/mac-dev)
# Exit: 0 ok · 1 ok but .incoming files written · 2 conflict, nothing changed · 3 push failed
set -uo pipefail

BRANCH="${1:-cursor/mac-dev}"
ROOT="$(git rev-parse --show-toplevel)" || exit 3
cd "$ROOT"

cur="$(git symbolic-ref -q --short HEAD || true)"
if [ "$cur" != "$BRANCH" ]; then echo "agent-git-sync: on '$cur', not $BRANCH — nothing done" >&2; exit 3; fi

git fetch -q origin "$BRANCH" || { echo "agent-git-sync: fetch failed" >&2; exit 3; }
REMOTE="origin/$BRANCH"
OLD="$(git rev-parse HEAD)"
behind="$(git rev-list --count "HEAD..$REMOTE")"
ahead="$(git rev-list --count "$REMOTE..HEAD")"

if [ "$behind" = 0 ]; then
  if [ "$ahead" = 0 ]; then echo "agent-git-sync: up to date"; exit 0; fi
  # A94 lesson: never push boot-breaking TS (Jamie 2026-10-18)
  "$ROOT/scripts/agent-ship-check.sh" "$REMOTE" HEAD || { echo "agent-git-sync: ship-check failed — not pushed" >&2; exit 3; }
  "$ROOT/scripts/asks-check.sh" "$REMOTE" HEAD || { echo "agent-git-sync: asks-check failed — not pushed" >&2; exit 3; }
  git push -q origin "HEAD:$BRANCH" || { echo "agent-git-sync: push failed" >&2; exit 3; }
  echo "agent-git-sync: pushed $ahead commit(s)"; exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/agent-git-sync.XXXXXX")"
WT="$TMP/wt"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$TMP"; git worktree prune >/dev/null 2>&1; }
trap cleanup EXIT

git worktree add -q --detach "$WT" "$REMOTE" || { echo "agent-git-sync: worktree add failed" >&2; exit 3; }

# --- 1. replay local commits on origin in the temp worktree --------------------------------------
for c in $(git rev-list --reverse "$REMOTE..$OLD"); do
  if git -C "$WT" cherry-pick --allow-empty --keep-redundant-commits "$c" >/dev/null 2>&1; then continue; fi
  bad=()
  while IFS= read -r -d '' p; do
    case "$p" in
      *.md)
        b="$TMP/b" o="$TMP/o" t="$TMP/t"
        git -C "$WT" show ":1:$p" >"$b" 2>/dev/null || : >"$b"
        git -C "$WT" show ":2:$p" >"$o" 2>/dev/null || : >"$o"
        git -C "$WT" show ":3:$p" >"$t" 2>/dev/null || : >"$t"
        git merge-file --union -p "$o" "$b" "$t" >"$WT/$p" && git -C "$WT" add -- "$p" || bad+=("$p")
        ;;
      *) bad+=("$p") ;;
    esac
  done < <(git -C "$WT" diff --name-only --diff-filter=U -z)
  if [ "${#bad[@]}" -gt 0 ]; then
    git -C "$WT" cherry-pick --abort >/dev/null 2>&1
    echo "agent-git-sync: CONFLICT replaying $(git log -1 --format=%h "$c") — nothing changed: ${bad[*]}" >&2
    exit 2
  fi
  GIT_EDITOR=true git -C "$WT" -c core.editor=true cherry-pick --continue >/dev/null 2>&1 \
    || GIT_EDITOR=true git -C "$WT" commit -q --allow-empty -C "$c" \
    || { git -C "$WT" cherry-pick --abort >/dev/null 2>&1; echo "agent-git-sync: replay of $c failed — nothing changed" >&2; exit 2; }
done

NEW="$(git -C "$WT" rev-parse HEAD)"
# Ship-check on replayed tip (same tree that will push). Fail → nothing pushed, local unchanged.
"$ROOT/scripts/agent-ship-check.sh" "$REMOTE" "$NEW" || { echo "agent-git-sync: ship-check failed — not pushed" >&2; exit 3; }
"$ROOT/scripts/asks-check.sh" "$REMOTE" "$NEW" || { echo "agent-git-sync: asks-check failed — not pushed" >&2; exit 3; }
git -C "$WT" push -q origin "HEAD:$BRANCH" || { echo "agent-git-sync: push failed (origin moved again? rerun)" >&2; exit 3; }

# --- 2. bring this checkout to NEW, path by path --------------------------------------------------
incoming=() merged=0 updated=0
mergiraf_ok() { command -v mergiraf >/dev/null 2>&1 && mergiraf languages 2>/dev/null | grep -q "\*\.${1##*.}[,)]"; }

while IFS= read -r -d '' p; do
  in_old=0 in_new=0
  git cat-file -e "$OLD:$p" 2>/dev/null && in_old=1
  git cat-file -e "$NEW:$p" 2>/dev/null && in_new=1

  clean=1
  if [ $in_old = 1 ]; then
    git diff --quiet "$OLD" -- "$p" && git diff --cached --quiet "$OLD" -- "$p" || clean=0
  else
    [ -e "$p" ] && clean=0
    git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && clean=0
  fi

  if [ $in_new = 1 ]; then
    mode="$(git ls-tree "$NEW" -- "$p" | awk '{print $1}')"
    blob="$(git rev-parse "$NEW:$p")"
  fi

  if [ $clean = 1 ]; then
    if [ $in_new = 1 ]; then
      mkdir -p "$(dirname "$p")"
      git cat-file blob "$blob" >"$p"
      [ "$mode" = 100755 ] && chmod +x "$p"
      git update-index --add --cacheinfo "$mode,$blob,$p"
    else
      rm -f "$p"
      git update-index --force-remove -- "$p"
    fi
    updated=$((updated + 1))
    continue
  fi

  # dirty: keep the owner's edits, merge the incoming change on top
  if [ $in_new = 0 ]; then incoming+=("$p (deleted upstream; kept local)"); continue; fi
  b="$TMP/m_base" t="$TMP/m_new" out="$TMP/m_out"
  if [ $in_old = 1 ]; then git cat-file blob "$OLD:$p" >"$b"; else : >"$b"; fi
  git cat-file blob "$blob" >"$t"
  ok=1
  if [ ! -f "$p" ]; then ok=0
  elif mergiraf_ok "$p"; then mergiraf merge "$b" "$p" "$t" -o "$out" -p "$p" >/dev/null 2>&1 || ok=0
  else git merge-file -p "$p" "$b" "$t" >"$out" 2>/dev/null || ok=0
  fi
  if [ $ok = 1 ] && ! grep -q '^<<<<<<< ' "$out"; then
    cat "$out" >"$p"
    git update-index --add --cacheinfo "$mode,$blob,$p"
    merged=$((merged + 1))
  else
    git cat-file blob "$blob" >"$p.incoming"
    git update-index --add --cacheinfo "$mode,$blob,$p"
    incoming+=("$p")
  fi
done < <(git diff --name-only --no-renames -z "$OLD" "$NEW")

git update-ref "refs/heads/$BRANCH" "$NEW" "$OLD" || { echo "agent-git-sync: branch moved during sync — pushed, but local ref not updated; rerun" >&2; exit 3; }

echo "agent-git-sync: replayed $ahead commit(s) on $behind upstream, pushed $(git rev-parse --short "$NEW"); $updated path(s) updated, $merged merged into local edits"
if [ "${#incoming[@]}" -gt 0 ]; then
  echo "agent-git-sync: kept local edits, saved upstream as .incoming: ${incoming[*]}"
  exit 1
fi
exit 0
