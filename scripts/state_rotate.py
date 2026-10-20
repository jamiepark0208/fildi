#!/usr/bin/env python3
"""Keep .agents/context/state.md small without losing anything (W02, Jamie 10-20: "state.md shouldn't grow forever").

Moves, never deletes. Rotated text goes verbatim to state-archive.md under a dated header; a long rotated line leaves a one-line
pointer behind so the fact stays findable. Run by scripts/agent_start.py every session; safe to re-run (no-op under budget).

Rules (in order, until state.md ≤ BUDGET chars):
  1. Log bullets ("- …" / "N. …", plus indented continuation lines) older than KEEP_DAYS → archive, oldest first. Age = the
     date the bullet starts with, else its last git edit (uncommitted = today).
     The newest KEEP_MIN dated bullets always stay, whatever their age (the current "next" lives there).
  2. Any single line > LONG chars whose last edit (git blame) is older than KEEP_DAYS → archive, leave a pointer line.
Never touched: headings, blank lines, `Last reviewed SHA:`, and lines under "## Standing" (pinned decisions / open
items), "## Open facts", "## FactSet", "## RSI". Pin anything that must stay visible by moving it under ## Standing.

    python3 scripts/state_rotate.py [--dry-run] [--budget 12000]
"""
from __future__ import annotations

import argparse
import re
import subprocess
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".agents/context/state.md"
ARCHIVE = ROOT / ".agents/context/state-archive.md"
BUDGET, KEEP_DAYS, KEEP_MIN, LONG = 12000, 1, 4, 1500
PROTECTED_SECTIONS = ("## Standing", "## Open facts", "## FactSet", "## RSI")
DATED = re.compile(r"^\s*(?:-|\d+\.)\s+(?:\*\*)?(?:NEXT SESSION FIRST \(Claude )?(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\b")


def entry_date(line: str, today: date) -> date | None:
    m = DATED.match(line)
    if not m:
        return None
    y, mo, d = int(m.group(1) or today.year), int(m.group(2)), int(m.group(3))
    try:
        dt = date(y, mo, d)
    except ValueError:
        return None
    return dt.replace(year=y - 1) if dt > today + timedelta(days=1) else dt


def blame_dates(path: Path) -> list[date | None]:
    """Last-edit date per line (None for uncommitted lines = edited now)."""
    try:
        out = subprocess.run(["git", "blame", "--line-porcelain", str(path)], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except subprocess.CalledProcessError:
        return []
    dates, cur = [], None
    for ln in out.splitlines():
        if ln.startswith("committer-time "):
            cur = date.fromtimestamp(int(ln.split()[1]))
        elif ln.startswith("\t"):
            dates.append(None if cur and cur.year < 1980 else cur)
    return dates


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--budget", type=int, default=BUDGET)
    a = ap.parse_args()
    today = date.today()
    cutoff = today - timedelta(days=KEEP_DAYS)
    lines = STATE.read_text().splitlines()
    size = len("\n".join(lines))
    if size <= a.budget:
        print(f"state_rotate: {size:,} chars ≤ budget {a.budget:,} — nothing to do")
        return
    section, protected = "", [False] * len(lines)
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            section = ln
        protected[i] = ln.startswith("#") or not ln.strip() or "Last reviewed SHA" in ln or section.startswith(PROTECTED_SECTIONS)
    # group dated bullets with their indented continuation lines
    bd = blame_dates(STATE)
    bullet = re.compile(r"^(?:-|\d+\.)\s")
    groups, i = [], 0
    while i < len(lines):
        d = None
        if not protected[i] and bullet.match(lines[i]):
            d = entry_date(lines[i], today) or (bd[i] if i < len(bd) and bd[i] else today)
        j = i + 1
        if d:
            while j < len(lines) and lines[j].startswith("  ") and not protected[j]:
                j += 1
            groups.append((d, i, j))
        i = j
    newest = {g[1] for g in sorted(groups, key=lambda g: g[0], reverse=True)[:KEEP_MIN]}
    move: dict[int, str | None] = {}   # line index → replacement (None = drop from state, kept in archive)
    for d, s, e in sorted(groups, key=lambda g: g[0]):           # oldest first
        if size <= a.budget:
            break
        if d < cutoff and s not in newest:
            for k in range(s, e):
                move[k] = None
            size -= sum(len(lines[k]) + 1 for k in range(s, e))
    if size > a.budget:
        for k, ln in sorted(enumerate(lines), key=lambda x: -len(x[1])):
            if size <= a.budget or len(ln) <= LONG:
                break
            last = bd[k] if k < len(bd) else None
            if protected[k] or k in move or last is None or last >= cutoff:
                continue
            stub = f"{ln[:len(ln) - len(ln.lstrip())]}- → archived {today} (state-archive.md): {ln.strip()[:140]}…"
            move[k] = stub
            size -= len(ln) - len(stub)
    if not move:
        print(f"state_rotate: {size:,} chars over budget but nothing eligible (all recent or protected) — trim by hand / raise budget")
        return
    moved = [lines[k] for k in sorted(move)]
    kept = [move[k] if k in move else ln for k, ln in enumerate(lines) if not (k in move and move[k] is None)]
    print(f"state_rotate: moved {len(moved)} line(s) ({sum(map(len, moved)):,} chars) → state-archive.md; state.md now {len(chr(10).join(kept)):,} chars")
    if a.dry_run:
        for m in moved:
            print("  would move:", m[:110])
        return
    with ARCHIVE.open("a") as f:
        f.write(f"\n## Archived from state.md {today} (scripts/state_rotate.py, verbatim)\n" + "\n".join(moved) + "\n")
    STATE.write_text("\n".join(kept) + "\n")


if __name__ == "__main__":
    main()
