#!/usr/bin/env python3
"""Where do Claude session tokens go? Sums tool-result chars by tool + command/path key.

Usage: python3 scripts/session_bloat.py [--days 14] [--top 25]
Reads ~/.claude/projects/<repo>/*.jsonl (local, $0). Chars ≈ 4 per token; a result stays in
context for every later request, so `weight` = chars × requests remaining after it.
"""
import argparse, json, re, time
from collections import defaultdict
from pathlib import Path

LOGS = Path.home() / ".claude/projects/-Users-jamiepark-Cursor-fildi"


def key_for(name: str, inp: dict) -> str:
    if name == "Bash":
        cmd = inp.get("command", "").strip()
        cmd = re.sub(r"^cd \S+ && ", "", cmd)
        m = re.search(r"(scripts/\S+|python3 -c|node -e|sqlite3|psql|git \w+|curl|cat|sed|grep|rg|head|tail|ls|find|pnpm \w+|npm \w+|npx \S+)", cmd)
        return f"Bash:{m.group(1) if m else cmd.split()[0] if cmd else '?'}"
    if name in ("Read", "Edit", "Write"):
        p = inp.get("file_path", "")
        return f"{name}:{'/'.join(p.split('/')[-2:])}"
    if name.startswith("mcp__"):
        return name.split("__")[-1]
    return name


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--top", type=int, default=25)
    a = ap.parse_args()
    cut = time.time() - a.days * 86400
    by_key = defaultdict(lambda: [0, 0, 0])  # calls, chars, weight
    by_tool = defaultdict(lambda: [0, 0])
    user_chars = sys_chars = 0
    nsess = 0
    for f in LOGS.glob("*.jsonl"):
        if f.stat().st_mtime < cut:
            continue
        nsess += 1
        rows = [json.loads(l) for l in f.open() if l.strip()]
        reqs = [i for i, r in enumerate(rows) if r.get("type") == "assistant"]
        pending = {}
        for i, r in enumerate(rows):
            msg = r.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                if r.get("type") == "user" and isinstance(content, str):
                    user_chars += len(content)
                continue
            for c in content:
                if c.get("type") == "tool_use":
                    pending[c["id"]] = key_for(c.get("name", "?"), c.get("input") or {})
                elif c.get("type") == "tool_result":
                    body = c.get("content")
                    n = len(json.dumps(body)) if not isinstance(body, str) else len(body)
                    k = pending.get(c.get("tool_use_id"), "?")
                    left = sum(1 for j in reqs if j > i)
                    by_key[k][0] += 1
                    by_key[k][1] += n
                    by_key[k][2] += n * left
                    t = k.split(":")[0]
                    by_tool[t][0] += 1
                    by_tool[t][1] += n
                elif c.get("type") == "text" and r.get("type") == "user":
                    t = c.get("text", "")
                    if "<system-reminder>" in t:
                        sys_chars += len(t)
                    else:
                        user_chars += len(t)
    tot = sum(v[2] for v in by_key.values()) or 1
    print(f"{nsess} sessions / {a.days} d · reminders {sys_chars:,} chars · user text {user_chars:,}")
    print("by tool (calls, chars):", ", ".join(f"{t} {v[0]}/{v[1]//1000}k" for t, v in sorted(by_tool.items(), key=lambda x: -x[1][1])[:8]))
    print(f"{'key':48} {'calls':>5} {'chars':>9} {'avg':>6} {'ctx-weight%':>11}")
    for k, (n, ch, w) in sorted(by_key.items(), key=lambda x: -x[1][2])[: a.top]:
        print(f"{k[:48]:48} {n:5} {ch:9,} {ch//n:6,} {100*w/tot:10.1f}%")


if __name__ == "__main__":
    main()
