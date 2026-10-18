"""Labelled eval sets + scoring for OpenJev registry patterns (scripts/oj.py eval|verify). Builders are deterministic
(seeded, from repo history) so a second agent can rebuild the same items and re-check. Add a builder + scorer kind
for every new pattern; never hand-type metrics into registry.json."""
from __future__ import annotations

import json
import random
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORR = ROOT / ".agents/openjev/corrections"
CODE = (".ts", ".tsx", ".py", ".mjs", ".sh")

IDEA_PHASES = ("needs you", "filed", "reviewed", "building", "done", "parked", "verified")


def git(*a: str) -> str:
    return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True).stdout


def load_corrections(pid: str) -> list[dict]:
    """Hard examples from `oj.py teach` — miss → label → next eval --build. Never throw away a miss."""
    paths = [CORR / f"{pid}.jsonl"]
    if pid == "P10v2":
        paths.append(CORR / "P10.jsonl")  # teaches apply to the successor prompt too
    out: list[dict] = []
    for p in paths:
        if p.exists():
            out.extend(json.loads(x) for x in p.open() if x.strip())
    return out


def idea_phase(status: str) -> str:
    """Mirror artifacts/api-server/src/routes/agents.ts ideaPhase (keep in sync)."""
    raw = status.strip()
    s = raw.lower()
    if s.startswith("verified"):
        return "verified"
    if s.startswith("done"):
        return "done"
    if s.startswith(("declined", "deferred", "parked")):
        return "parked"
    if "STOP" in raw or "stop: no build" in s or "stop: no library" in s:
        return "parked"
    if s.startswith(("accepted", "partial")):
        return "building"
    if s.startswith("planned"):
        return "reviewed"
    if "needs jamie" in s or "user call" in s:
        return "needs you"
    return "filed"


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
    # Agent corrections (missed keeps / false keeps) — upweighted by appearing after history items.
    items.extend(load_corrections("P10"))
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
    items.extend(load_corrections("P14"))
    return items


def build_p27() -> list[dict]:
    """P27 Ideas phase: index status + Reviews excerpt → Ideas column. Label = ideaPhase(status) (same rules as Agents tab)."""
    import re
    asks = ROOT / "research/common/ASKS.md"
    items = []
    opts = {p: p for p in IDEA_PHASES}
    for line in asks.read_text().splitlines():
        m = re.match(
            r"^\| \[(A\d+)\][^|]*\| (\d{4}-\d{2}-\d{2}) \| ([^|]+?) → ([^|]+?) \| (.*) \| ([^|]*) \|$",
            line,
        )
        if not m:
            continue
        aid, _d, _f, _to, title, status = m.groups()
        st = status.strip()
        phase = idea_phase(st)
        reviews = ""
        path = ROOT / f"research/common/asks/{aid}.md"
        if path.exists():
            text = path.read_text(errors="ignore")
            if "## Reviews" in text:
                reviews = text.split("## Reviews", 1)[1][:2000]
            else:
                reviews = "\n".join(text.splitlines()[:40])
        items.append({
            "id": aid,
            "label": phase,
            "state": f"ASKS {aid}: {title.strip()}\nIndex status: {st}\n---\nReviews:\n{reviews}",
            "question": {
                "type": "choice",
                "instructions": "Which Ideas stage is this row in right now? "
                "reviewed = Ready to build (status starts with planned). "
                "needs you = Jamie must act. filed = open, not yet planned. "
                "building = accepted/partial/in progress. done/verified/parked as usual.",
                "options": opts,
            },
        })
    items.extend(load_corrections("P27"))
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
    base = rnd.sample(pos, min(150, len(pos))) + rnd.sample(neg, min(150, len(neg)))
    return base + load_corrections("P11")


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
    items.extend(load_corrections("P17"))
    return items


def build_p16(seed: int = 17) -> list[dict]:
    """P16 needs-Jamie gate. Yes = every J item ever in .agents/needs-jamie.md (git history; strong) + ASKS lines that say the
    row waits on Jamie (keyword-picked, Claude-checked). No = agent plan/review lines + hard negatives where Jamie already
    acted ("Jamie OK 10-18", "approved by Jamie") — info, not an ask. 'Reply …' lines are dropped (format giveaway)."""
    import re
    rnd = random.Random(seed)
    root = Path(__file__).resolve().parent.parent
    pos, seen = [], set()
    for h in git("log", "--format=%H", "--", ".agents/needs-jamie.md").split():
        txt = git("show", f"{h}:.agents/needs-jamie.md")
        for sec in re.split(r"\n(?=## J)", txt)[1:]:
            head = sec.splitlines()[0]
            if head in seen:
                continue
            seen.add(head)
            body = "\n".join(l for l in sec.splitlines() if not l.lower().lstrip("0123456789. ").startswith("reply"))
            # a J item already settled ("Done", "not needed", "resolved") is info, not an ask (label fix 10-18)
            lines2 = sec.splitlines()[1:2]
            settled = bool(re.search(r"not needed|resolved|no action", head, re.I)) or bool(lines2 and lines2[0].lower().startswith("done"))
            pos.append({"id": f"J:{head[:40]}", "label": not settled, "state": body[:1500]})
    ask_rx = re.compile(r"needs jamie|jamie's call|awaiting jamie|waiting on jamie|needs your (ok|call)|jamie to (decide|approve)", re.I)
    done_rx = re.compile(r"jamie (ok|approved|said|asked|agreed)|approved by jamie|\(jamie 20", re.I)
    neg, hard = [], []
    for f in sorted((root / "research/common/asks").glob("A*.md")):
        for i, l in enumerate(f.read_text(errors="ignore").splitlines()):
            l = l.strip()
            if len(l) < 60 or not l.startswith(("-", "**")):
                continue
            if ask_rx.search(l):
                pos.append({"id": f"{f.stem}:{i}", "label": True, "state": l[:1500]})
            elif done_rx.search(l):
                hard.append({"id": f"{f.stem}:{i}", "label": False, "state": l[:1500]})
            elif re.match(r"[-*\s]*\*\*(Claude|Muse|Grok|Cursor)", l):
                neg.append({"id": f"{f.stem}:{i}", "label": False, "state": l[:1500]})
    items = pos + rnd.sample(hard, min(len(hard), len(pos))) + rnd.sample(neg, min(len(neg), len(pos)))
    q = {"type": "noul", "instructions": "Does this item need Jamie (the user) to act or decide now — approve, choose, run "
         "something, reply? Answer no if it is information, a status update, or something Jamie already approved."}
    for x in items:
        x["question"] = q
    return items + load_corrections("P16")


def build_p10v2(n_commits: int = 400, seed: int = 17) -> list[dict]:
    """Same labels as P10; richer instructions (few-shot in registry question). Merges P10 + P10v2 teaches."""
    instr = (
        "Would a developer need to read or edit this file to do the task? "
        "Think beyond filename matching. UI tasks touch shared components; "
        "API tasks touch routes and everything they import."
    )
    out = []
    for x in build_p10(n_commits, seed):
        if str(x.get("id", "")).startswith("teach:"):
            continue
        y = dict(x)
        y["question"] = {"type": "noul", "instructions": instr}
        out.append(y)
    for c in load_corrections("P10v2"):
        y = dict(c)
        y["question"] = {"type": "noul", "instructions": instr}
        out.append(y)
    return out


BUILDERS = {
    "P16": build_p16,
    "P10": build_p10,
    "P10v2": build_p10v2,
    "P11": build_p11,
    "P14": build_p14,
    "P17": build_p17,
    "P27": build_p27,
}


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
