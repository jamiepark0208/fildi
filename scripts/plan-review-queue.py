#!/usr/bin/env python3
"""Scheduled agentic plan reviews (Jamie 10-21). Run by scripts/maintain.mjs at most every 6 h; also by hand.

1. Pick ASKS rows that need a plan review: status open/revise, never reviewed, or a `revise` row whose file changed
   (= the author iterated). Skips standing duties and Claude-authored rows. Nothing to do → no launch, $0.
2. ONE read-only reviewer run for the batch (scripts/agent-dispatch.sh --ask: no shell, no edits, no git) on Cursor's
   budget, rubric = .agents/context/plan-review-rubric.md. Plans are untrusted text, so the agent gets no write power.
3. This script (not the agent) writes each review into its A##.md, sets the status from a fixed list, commits only
   those files, logs stats to the calibration log, and syncs.
   Quant rows → `auto-reviewed` (Claude spot-checks at session start, then `planned`); others → the verdict.

    python3 scripts/plan-review-queue.py [--dry] [--max 6] [--model claude-opus-5-thinking-high]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASKS = ROOT / "research/common/ASKS.md"
CAL = ROOT / ".agents/context/calibration-log.md"
STATE = Path.home() / ".fildi/plan-review-state.json"
ROW = re.compile(r"^\| \[(A\d+)\]\(asks/A\d+\.md\) \| ([\d-]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|")
REVIEWABLE = re.compile(r"^(open|revise|needs review)\b", re.I)
REVIEWED = re.compile(r"^\*\*(Claude plan|Plan review|Grok|Muse review)", re.M)
VERDICTS = ("planned", "revise", "declined", "needs Jamie")
CITES = re.compile(r"\b(A\d{2,3}|S\d{3}[\w-]*)\b|[\w./-]+\.(py|ts|tsx|md|mjs)\b")
MAX_LINES = 20


def h(p: Path) -> str:
    return hashlib.sha1(p.read_bytes()).hexdigest()[:12] if p.exists() else ""


def pick(state: dict, n: int) -> list[dict]:
    rows = []
    for line in ASKS.read_text().splitlines():
        m = ROW.match(line)
        if not m:
            continue
        aid, d, route, title, status = (x.strip() for x in m.groups())
        f = ROOT / f"research/common/asks/{aid}.md"
        if title.lower().startswith("standing") or route.startswith("Claude →") or not f.exists():
            continue
        prev = state.get(aid)
        if prev is None and REVIEWED.search(f.read_text()):
            state[aid] = {"hash": h(f), "iter": 1, "verdict": "seeded"}   # reviewed before this queue existed
            continue
        if prev and prev["hash"] == h(f):
            continue                                                        # nothing new since our last review
        if not (REVIEWABLE.match(status) or (prev and prev.get("verdict") == "revise")):
            continue
        rows.append({"id": aid, "date": d, "title": title, "iter": (prev or {}).get("iter", 0) + 1,
                     "quant": title.startswith("[quant]")})
    rows.sort(key=lambda r: (not r["quant"], r["date"]))
    return rows[:n]


def parse(out: str) -> dict[str, tuple[str, str]]:
    """Reviewer output: blocks `=== A123 ===` / `VERDICT: <v>` / review lines."""
    res = {}
    out = re.sub(r"(=+\s*\**A\d+\**\s*=+)", r"\n\1", out)          # header glued to a preamble line
    out = re.sub(r"^```\w*\s*$", "", out, flags=re.M)              # tolerate code fences / bold / headings
    for aid, body in re.findall(r"^[#*\s]*=+\s*\**(A\d+)\**\s*=+[*\s]*\n(.*?)(?=^[#*\s]*=+\s*\**A\d+|\Z)", out, re.M | re.S):
        m = re.search(r"^[*\s]*VERDICT:?[*\s]*`?(planned|revise|declined|needs Jamie)\b", body, re.M | re.I)
        if not m:
            continue
        v = next(x for x in VERDICTS if x.lower() == m.group(1).lower())
        text = "\n".join(l for l in body[m.end():].strip().splitlines()[:MAX_LINES])
        if v == "declined" and not CITES.search(text):
            v, text = "revise", text + "\n(auto: decline had no cited row/study/path → revise, per rubric)"
        res[aid] = (v, text)
    return res


def set_status(aid: str, status: str) -> None:
    lines = ASKS.read_text().splitlines(keepends=True)
    for i, l in enumerate(lines):
        if l.startswith(f"| [{aid}](asks/{aid}.md) |"):
            cells = l.rstrip("\n").split("|")
            cells[-2] = f" {status} "
            lines[i] = "|".join(cells) + "\n"
    ASKS.write_text("".join(lines))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--reuse-last", action="store_true", help="parse ~/.fildi/plan-review-last.out instead of a new run")
    ap.add_argument("--max", type=int, default=6)
    ap.add_argument("--model", default="claude-opus-5-thinking-high")
    a = ap.parse_args()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    rows = pick(state, a.max)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))
    if not rows:
        print("plan-review-queue: nothing to review")
        return 0
    print("plan-review-queue:", " ".join(f"{r['id']}(it{r['iter']})" for r in rows))
    if a.dry:
        return 0
    prompt = Path.home() / ".fildi/plan-review-prompt.md"
    prompt.write_text(
        f"Plan reviews {date.today()}. Follow .agents/context/plan-review-rubric.md exactly (read it first).\n"
        "Rows (iteration in parentheses): " + ", ".join(f"{r['id']} (it{r['iter']})" for r in rows) + "\n"
        "Output ONLY these blocks, one per row, nothing else:\n=== A### ===\nVERDICT: planned|revise|declined|needs Jamie\n"
        f"<review, ≤ {MAX_LINES - 2} lines>\n")
    last = Path.home() / ".fildi/plan-review-last.out"
    if a.reuse_last:
        out = last.read_text()
    else:
        r = subprocess.run([str(ROOT / "scripts/agent-dispatch.sh"), "cursor", a.model, str(prompt), "--ask"],
                           cwd=ROOT, text=True, capture_output=True, timeout=3600)
        out = r.stdout
        last.write_text(out + "\n--- stderr ---\n" + r.stderr)
    got = parse(out)
    today, paths, counts = date.today().isoformat(), [], {v: 0 for v in VERDICTS}
    for row in rows:
        f = ROOT / f"research/common/asks/{row['id']}.md"
        if row["id"] not in got:
            print(f"{row['id']} no parseable review — left for next run")
            continue
        v, text = got[row["id"]]
        counts[v] += 1
        status = "auto-reviewed" if row["quant"] and v == "planned" else v
        if v == "revise" and row["iter"] >= 3:
            status = "needs Jamie"
        body = f.read_text().rstrip("\n")
        if "## Reviews" not in body:
            body += "\n\n## Reviews"
        f.write_text(body + f"\n**Plan review {today} (auto, {a.model}, it{row['iter']}):** {v}\n{text}\n")
        set_status(row["id"], status)
        state[row["id"]] = {"hash": h(f), "iter": row["iter"], "verdict": v, "at": datetime.now().isoformat(timespec="minutes")}
        paths.append(str(f.relative_to(ROOT)))
        print(f"{row['id']} {status}")
    STATE.write_text(json.dumps(state, indent=1))
    if not paths:
        return 1
    cal = CAL.read_text()
    if "## Review stats" not in cal:
        cal = cal.rstrip("\n") + "\n\n## Review stats\n"
    CAL.write_text(cal.rstrip("\n") + f"\n- {today} · auto · {len(paths)} reviewed · " +
                   " / ".join(f"{k} {n}" for k, n in counts.items()) + "\n")
    paths += [str(ASKS.relative_to(ROOT)), str(CAL.relative_to(ROOT))]
    refs = "\n".join(f"Refs: {p.split('/')[-1][:-3]}" for p in paths if "/asks/A" in p)
    subprocess.run(["git", "add", *paths], cwd=ROOT, check=True)
    subprocess.run(["git", "commit", "-q", "-m", f"Auto plan reviews {today}: {len(paths) - 2} rows\n\n{refs}\nAgent: cursor\nReviewer: auto-plan-review",
                    "--", *paths], cwd=ROOT, check=True)
    subprocess.run([str(ROOT / "scripts/agent-git-sync.sh")], cwd=ROOT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
