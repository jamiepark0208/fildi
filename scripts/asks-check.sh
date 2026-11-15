#!/usr/bin/env bash
# ASKS guard on push (Jamie 2026-10-24: A263/S092 duplicated Muse's A228; Claude overwrote Muse's A252 with a new row).
# Runs from agent-git-sync.sh for every agent. Fails the push when, in the commit range:
#   1. a NEW research/common/asks/A###.md has no "**Dupe check:**" line (rows searched + why this is not one of them —
#      `python3 scripts/oj.py dupes "<idea>"` + grep ASKS.md / research/studies/INDEX.md), or
#   2. an EXISTING ask file's title line (# A###: …) changed — that is an overwrite of another row, never an edit.
# Usage: scripts/asks-check.sh <base> <head>     Exit 0 ok · 1 blocked
set -uo pipefail
base="$1"; head="$2"; bad=0
while IFS=$'\t' read -r st path; do
  [[ "$path" =~ ^research/common/asks/A[0-9]+\.md$ ]] || continue
  if [[ "$st" == A ]]; then
    if ! git show "$head:$path" 2>/dev/null | grep -q '\*\*Dupe check:\*\*'; then
      echo "asks-check: $path is a new row without a '**Dupe check:**' line (search ASKS.md, INDEX.md, oj.py dupes; name the rows checked)" >&2
      bad=1
    fi
  elif [[ "$st" == M ]]; then
    old="$(git show "$base:$path" 2>/dev/null | head -1 | sed -E 's/^# (A[0-9]+)[:— -]+//')"
    new="$(git show "$head:$path" 2>/dev/null | head -1 | sed -E 's/^# (A[0-9]+)[:— -]+//')"
    if [[ -n "$old" && "$old" != "$new" ]]; then
      echo "asks-check: $path title changed ('$old' → '$new') — overwriting another row? file a new id instead" >&2
      bad=1
    fi
  fi
done < <(git diff --name-status --no-renames "$base" "$head" 2>/dev/null)
# 11-15 (Jamie): a (High) finding can't be closed without a fix SHA; 'done (uncommitted)' is not done.
python3 "$(dirname "$0")/findings_guard.py" --strict >&2 || bad=1
exit $bad
