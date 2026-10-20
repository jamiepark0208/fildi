#!/usr/bin/env python3
"""Safely add or replace one row of a shared markdown table (research/studies/INDEX.md, ASKS.md, …) — all agents.

Why: 2026-10-20 a one-liner `open(p, 'w').write(f(open(p).read()))` truncated INDEX.md (Python opens — and empties — the
file for writing before the argument is evaluated) and lost another agent's uncommitted row. This helper reads the whole
file first, changes exactly one row, refuses if anything else would change, and writes atomically (temp + rename).

    scripts/md_rows.py upsert research/studies/INDEX.md S066 "| S066 | 10-20 | … |" [--after S049-crash]
    scripts/md_rows.py get    research/studies/INDEX.md S066
Row key = the first cell (`| <key> |`). upsert replaces the row with that key, else inserts after --after (or after the
last row of the table that holds --after; default: after the last table row in the file).
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def key_of(line: str) -> str | None:
    if not line.startswith("|"):
        return None
    cells = line.split("|")
    return cells[1].strip() if len(cells) > 2 else None


def upsert(path: Path, key: str, row: str, after: str | None) -> str:
    if key_of(row) != key:
        sys.exit(f"row must start with '| {key} |'")
    if "\n" in row:
        sys.exit("one row only (no newlines)")
    text = path.read_text()  # read fully before anything opens the file for writing
    lines = text.split("\n")
    hits = [i for i, l in enumerate(lines) if key_of(l) == key]
    if len(hits) > 1:
        sys.exit(f"{len(hits)} rows have key {key!r} — fix by hand")
    if hits:
        lines[hits[0]] = row
        action = "replaced"
    else:
        anchor = [i for i, l in enumerate(lines) if after and key_of(l) == after]
        if after and not anchor:
            sys.exit(f"--after row {after!r} not found")
        pos = anchor[0] if anchor else max(i for i, l in enumerate(lines) if key_of(l))
        lines.insert(pos + 1, row)
        action = "inserted"
    new = "\n".join(lines)
    old_rows = {key_of(l): l for l in text.split("\n") if key_of(l)}
    new_rows = {key_of(l): l for l in lines if key_of(l)}
    lost = [k for k in old_rows if k not in new_rows]
    if lost or len(new) < len(text) * 0.9:
        sys.exit(f"refusing: would drop rows {lost[:5]} or shrink the file {len(text)} → {len(new)} chars")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(new)
    os.chmod(tmp, path.stat().st_mode & 0o777)
    os.replace(tmp, path)
    return f"{action} {key} in {path}"


def main() -> None:
    a = sys.argv[1:]
    after = a[a.index("--after") + 1] if "--after" in a else None
    a = [x for i, x in enumerate(a) if x != "--after" and (i == 0 or a[i - 1] != "--after")]
    if len(a) >= 3 and a[0] == "get":
        print(next((l for l in Path(a[1]).read_text().split("\n") if key_of(l) == a[2]), ""))
    elif len(a) == 4 and a[0] == "upsert":
        print(upsert(Path(a[1]), a[2], a[3], after))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
