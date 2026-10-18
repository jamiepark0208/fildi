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


def build_p14() -> list[dict]:
    """P14 'already studied?': query = an ASKS row title; positives = studies its file cites (S0xx); every study row is a candidate.
    Label source = citations (weak: citing ≠ answering) — scored as top-3 hit rate per query."""
    import re
    import oj
    studies = dict(oj.study_rows())
    items = []
    for f in sorted((ROOT / "research/common/asks").glob("A*.md")):
        text = f.read_text(errors="ignore")
        title = re.sub(r"^#\s*A\d+\s*[:—-]\s*", "", text.splitlines()[0]).strip() if text else ""
        cited = sorted(set(re.findall(r"\bS0\d\d\b", text)) & set(studies))
        if not title or not cited:
            continue
        for s, row in studies.items():
            items.append({"id": f"{f.stem}|{s}", "qid": f.stem, "label": s in cited,
                          "state": f"Question: {title}\n---\n{row[:2500]}",
                          "question": {"type": "noul", "instructions": "Does this study answer, or largely answer, the question?"}})
    return items


def build_p11(seed: int = 17) -> list[dict]:
    """P11 long-output triage: 40-line chunks of real local logs (/tmp/fildi-logs). Label = regex failure keywords (weak labels:
    measures whether OpenJev keeps what regex would catch; semantic catches beyond regex are counted separately)."""
    import re
    from oj import FAIL_RX
    rnd = random.Random(seed)
    items = []
    for f in sorted(Path("/tmp/fildi-logs").glob("*.log")):
        lines = f.read_text(errors="ignore").splitlines()
        for i in range(0, len(lines), 40):
            txt = "\n".join(lines[i:i + 40])
            if len(txt) > 200:
                items.append({"id": f"{f.name}:{i}", "label": bool(re.search(FAIL_RX, txt)), "state": txt[:4000],
                              "question": {"type": "noul", "instructions": "Does this part of a command's output show an error, failure, "
                                           "data problem (0 rows, skipped, stale, missing) or warning that needs action?"}})
    pos = [x for x in items if x["label"]]
    neg = [x for x in items if not x["label"]]
    return rnd.sample(pos, min(150, len(pos))) + rnd.sample(neg, min(150, len(neg)))


def build_p17(n_commits: int = 300, seed: int = 17) -> list[dict]:
    """P17 commit message vs change: each commit's diff paired with its own subject (match) and with another commit's subject
    (mismatch). State = message + changed files + first 60 changed lines. Labels = git history (strong)."""
    rnd = random.Random(seed)
    commits = []
    for line in git("log", "--no-merges", f"-n{n_commits}", "--format=%H%x09%s").splitlines():
        sha, subj = line.split("\t", 1)
        files = git("show", "--name-only", "--format=", sha).split()
        diff = [l for l in git("show", "--format=", "--unified=0", sha).splitlines() if l[:1] in "+-" and not l.startswith(("+++", "---"))][:60]
        if files and diff:
            commits.append((sha, subj, files, "\n".join(diff)[:2500]))
    items = []
    for i, (sha, subj, files, diff) in enumerate(commits):
        other = commits[(i + rnd.randrange(1, len(commits))) % len(commits)][1]
        for msg, label in ((subj, True), (other, False)):
            items.append({"id": f"{sha[:8]}:{label}", "label": label,
                          "state": f"Commit message: {msg}\nFiles changed: {', '.join(files[:15])}\n---\n{diff}",
                          "question": {"type": "noul", "instructions": "Does the commit message describe this change?"}})
    return items


BUILDERS = {"P10": build_p10, "P11": build_p11, "P14": build_p14, "P17": build_p17}


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
    if rule["kind"] == "topk":
        # retrieval: share of queries whose top-k candidates contain at least one true answer
        k = rule["k"]
        by_q: dict = {}
        for x, a in rows:
            by_q.setdefault(x["qid"], []).append((p_yes(a), x["label"]))
        hits = sum(any(l for _, l in sorted(v, key=lambda z: -z[0])[:k]) for v in by_q.values())
        lo, hi = wilson(hits, len(by_q))
        return {"value": round(hits / len(by_q), 4), "lo": lo, "hi": hi, "n": len(by_q),
                "secondary": f"{len(rows)} query×study pairs; random top-{k} would hit ~{k / max(len(v) for v in by_q.values()):.0%} per cited study"}
    if rule["kind"] == "accuracy":
        k = sum((p_yes(a) >= .5) == x["label"] if "noul" in a else a.get("choice") == x["label"] for x, a in rows)
        lo, hi = wilson(k, len(rows))
        return {"value": round(k / len(rows), 4), "lo": lo, "hi": hi, "n": len(rows)}
    raise ValueError(rule["kind"])
