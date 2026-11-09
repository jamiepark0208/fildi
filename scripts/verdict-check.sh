#!/usr/bin/env bash
# Verdict gate (Jamie 11-08, S169): a negative study verdict may not land on BOARD/INDEX unless its packet
# (1) has a "## Winner pass" section (winners defined, pre-entry pattern, next rule) and
# (2) its verdict line names the rule tested ("RULE" + entry/exit), not the instrument, and
# (3) reports independent events (n_indep / episodes) so < 30 reads UNDERPOWERED, not FAIL.
# Memory notes did not stop the repeat; this blocks the push instead.
# Usage: scripts/verdict-check.sh <base> <head>   · escape hatch on the added line: "winner-pass: n/a <reason>"
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
base="${1:?base}"; head="${2:-HEAD}"
added="$(git diff -U0 "$base"..."$head" -- research/studies/BOARD.md research/studies/INDEX.md 2>/dev/null \
  | grep -E '^\+[^+]' | grep -iE 'no-lift|NO-LIFT|\bFAIL\b|\bdead\b' | grep -viE 'winner-pass: n/a' || true)"
[ -z "$added" ] && exit 0
bad=0
# row's own study id: INDEX = first cell; BOARD = the "Study" cell (3rd); first S### in that cell
ids="$(echo "$added" | sed 's/^+//' | awk -F'|' '{c=($2 ~ /^ *S[0-9]{3} *$/)?$2:$4; if (match(c,/S[0-9][0-9][0-9]/)) print substr(c,RSTART,4)}' | sort -u)"
for id in $ids; do
  pk="$(ls scripts/watchlist_sync/out/opt/$id.md scripts/watchlist_sync/out/studies/$id.md research/studies/$id*.md 2>/dev/null | head -1 || true)"
  if [ -z "$pk" ]; then echo "verdict-check: $id negative verdict but no packet (out/opt|out/studies/$id.md)" >&2; bad=1; continue; fi
  grep -q '^## Winner pass' "$pk" || { echo "verdict-check: $id ($pk) lacks '## Winner pass' — define winners, find pre-entry pattern, name next rule before a negative verdict" >&2; bad=1; }
  grep -qiE 'verdict.*RULE' "$pk" || { echo "verdict-check: $id verdict must name the RULE tested (entry × exit × structure), not the instrument" >&2; bad=1; }
  grep -qiE 'n_indep|independent|episodes' "$pk" || { echo "verdict-check: $id must report independent events (< 30 → UNDERPOWERED)" >&2; bad=1; }
done
[ "$bad" = 0 ] || { echo "verdict-check: FAIL (see .agents/dispatch/_study-contract.md item 11)" >&2; exit 1; }
