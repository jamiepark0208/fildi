#!/usr/bin/env python3
"""List WRDS libraries visible to this account; flag TradeDash-relevant ones."""
from __future__ import annotations

import os
import sys

from _auth import connect

KEYS = (
    "crsp", "comp", "ibes", "optionm", "trace", "raven", "boardex",
    "taq", "cboe", "ff_", "frb", "tr_13f", "insider", "dealscan",
    "finratio", "evtstudy", "factset", "ciq", "markit", "short",
)


def main() -> int:
    print("Connecting to WRDS…", flush=True)
    db = connect()
    libs = sorted(db.list_libraries())
    print(f"Accessible libraries: {len(libs)}\n")
    for key in KEYS:
        hits = [l for l in libs if key in l.lower()]
        print(f"{key:12} {hits if hits else '—'}")
    out = os.path.join(os.path.dirname(__file__), "out", "libraries.txt")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(libs) + "\n")
    print(f"\nWrote full list → {out}")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
