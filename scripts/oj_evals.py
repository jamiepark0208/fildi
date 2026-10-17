"""Labelled eval sets + scoring for OpenJev registry patterns (scripts/oj.py eval|verify). Builders are deterministic
(seeded, from repo history) so a second agent can rebuild the same items and re-check. Add a builder + scorer kind
for every new pattern; never hand-type metrics into registry.json."""
from __future__ import annotations

import json
import random
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE = (".ts", ".tsx", ".py", ".mjs", ".sh")


def git(*a: str) -> str:
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout


def build_p10(n_commits: int = 400, seed: int = 17) -> list[dict]:
    """P10 file relevance: task = commit subject; relevant = code files it changed; not relevant = 2 untouched code files
    from the same folder at that commit. State = path + first 80 lines of the file as of the parent commit."""
    rnd = random.Random(seed)
    items = []
    for line in git("log", "--no-merges", f"-n{n_commits}", "--format=%H%x09%s").splitlines():
        sha, subj = line.split("\t", 1)
        changed = [f for f in git("show", "--name-only", "--format=", sha).split() if f.endswith(CODE)]
        if not 1 <= len(changed) <= 5:
            continue
        tree = git("ls-tree", "-r", "--name-only", f"{sha}^").split()
        tree_set = set(tree)
        for f in rnd.sample(changed, min(2, len(changed))):
            folder = f.rsplit("/", 1)[0]
            negs = [g for g in tree if g.startswith(folder + "/") and g.endswith(CODE) and g not in changed and "/" not in g[len(folder) + 1:]]
            for path, label in [(f, True)] + [(g, False) for g in rnd.sample(negs, min(2, len(negs)))]:
                if path not in tree_set:
                    continue
                body = "\n".join(git("show", f"{sha}^:{path}").splitlines()[:80])[:3000]
                items.append({"id": f"{sha[:8]}:{path}", "label": label,
                              "state": f"Task: {subj}\nFile: {path}\n---\n{body}",
                              "question": {"type": "noul", "instructions": "Would a developer need to read or edit this file to do the task?"}})
    return items


BUILDERS = {"P10": build_p10}


def p_yes(a: dict) -> float:
    return a.get("noul", 0.0)


def same(a: dict, b: dict) -> bool:
    if "noul" in a:
        return abs(a["noul"] - b.get("noul", -1)) < 0.15 or (a["noul"] >= .5) == (b.get("noul", 0) >= .5)
    return a.get("choice") == b.get("choice")


def score(pid: str, items: list[dict], answers: list[dict], entry: dict) -> dict:
    from oj import wilson
    by = {a["id"]: a["answer"] for a in answers}
    rule = entry["rule"]
    rows = [(x, by[x["id"]]) for x in items if x["id"] in by]
    if rule["kind"] == "gate_keep":
        # gate: skip the item when P(yes) < threshold. Success = share of truly relevant items KEPT (misses cost rework).
        t = rule["threshold"]
        pos = [p_yes(a) for x, a in rows if x["label"]]
        neg = [p_yes(a) for x, a in rows if not x["label"]]
        kept = sum(p >= t for p in pos)
        lo, hi = wilson(kept, len(pos))
        skipped = sum(p < t for p in neg)
        return {"value": round(kept / len(pos), 4), "lo": lo, "hi": hi, "n": len(rows),
                "secondary": f"skips {skipped}/{len(neg)} irrelevant ({skipped / max(len(neg), 1):.0%}) at P<{t}"}
    if rule["kind"] == "accuracy":
        k = sum((p_yes(a) >= .5) == x["label"] if "noul" in a else a.get("choice") == x["label"] for x, a in rows)
        lo, hi = wilson(k, len(rows))
        return {"value": round(k / len(rows), 4), "lo": lo, "hi": hi, "n": len(rows)}
    raise ValueError(rule["kind"])
