#!/usr/bin/env python3
"""Committed code may not import an uncommitted local module (Jamie 11-15: A357 fixes imported a357_sample.py,
which existed only in one working tree — every clean checkout would crash). Blocking in agent-ship-check.

Checks the files being pushed (or all tracked .py with --all): each `import X` / `from X import` where X.py exists
untracked next to it under scripts/ → fail.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def git(*a: str) -> str:
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout


def main(argv: list[str]) -> int:
    tracked = set(git("ls-files", "scripts").split())
    tracked_stems = {Path(f).stem for f in tracked if f.endswith(".py")}
    untracked = {Path(l[3:]).stem: l[3:] for l in git("status", "--short", "--untracked-files=all", "scripts").splitlines()
                 if l.startswith("??") and l.endswith(".py")}
    if len(argv) >= 2 and argv[0] != "--all":
        files = [f for f in git("diff", "--name-only", argv[0], argv[1]).split() if f.endswith(".py")]
    else:
        files = [f for f in tracked if f.endswith(".py")]
    bad = []
    for f in files:
        p = ROOT / f
        if not p.exists():
            continue
        # check the committed blob, not the working copy: another agent's uncommitted import in the same file
        # must not block (or pass) this commit (11-26: put_recs.py)
        src = p.read_text(errors="ignore")
        if len(argv) >= 2 and argv[0] != "--all":
            try:
                src = git("show", f"{argv[1]}:{f}")
            except Exception:
                pass
        for m in re.finditer(r"^\s*(?:from\s+([A-Za-z_]\w*)\s+import|import\s+([A-Za-z_]\w*))", src, re.M):
            name = m.group(1) or m.group(2)
            if name in untracked and name not in tracked_stems:
                bad.append(f"{f} imports {name} → {untracked[name]} is not committed")
    for b in bad:
        print("import_guard:", b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
