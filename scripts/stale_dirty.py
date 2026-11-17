#!/usr/bin/env python3
"""agent_start 6k (Jamie 11-16): uncommitted edits that block other agents.

Shared tree: an agent that leaves a big uncommitted rewrite (11-16: stock-breakdown.tsx +292/−270, options-scanner.tsx)
blocks every other agent from that file. Flags tracked code files whose uncommitted edit is > 24 h old, or > 200 changed
lines at any age. Owner = the agent that touched it (state files mention it) — commit in small pieces or say why not.
  stale_dirty.py [--hours 24] [--lines 200]
"""
import argparse, os, re, subprocess, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = re.compile(r"^(artifacts/[^/]+/src/|scripts/|lib/).*\.(ts|tsx|py|mjs|js|sh)$")
STATE = {".cursor/context/cursor-state.md": "cursor", ".agents/context/codex-state.md": "codex", ".agents/context/state.md": "claude notes",
         ".cursor/context/session.md": "cursor session"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--lines", type=int, default=200)
    a = ap.parse_args()
    num = subprocess.run(["git", "diff", "--numstat"], cwd=ROOT, capture_output=True, text=True).stdout
    state = {STATE[p]: open(os.path.join(ROOT, p), errors="ignore").read() for p in STATE if os.path.exists(os.path.join(ROOT, p))}
    hits = []
    for ln in num.splitlines():
        add, dele, path = ln.split("\t", 2)
        if not CODE.match(path) or add == "-":
            continue
        full = os.path.join(ROOT, path)
        if not os.path.exists(full):
            continue
        age_h = (time.time() - os.path.getmtime(full)) / 3600
        n = int(add) + int(dele)
        if age_h > a.hours or n > a.lines:
            base = os.path.basename(path)
            who = [k for k, t in state.items() if base in t]
            hits.append((n, age_h, path, who))
    hits.sort(reverse=True)
    if not hits:
        print("stale uncommitted code: none")
        return
    top = "; ".join(f"{os.path.basename(p)} {n} lines {h:.0f} h" + (f" (named in {'/'.join(w)})" if w else "") for n, h, p, w in hits[:8])
    print(f"stale uncommitted code: {len(hits)} files (> {a.hours:.0f} h or > {a.lines} lines) — {top}"
          + (" …" if len(hits) > 8 else "") + " → owner commits in small pieces; others don't edit these")


if __name__ == "__main__":
    main()
