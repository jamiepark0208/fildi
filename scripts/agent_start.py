#!/usr/bin/env python3
"""Session start in one command with a short digest (W01, Claude 10-20). Replaces running CLAUDE.md's ~8 startup steps one by one,
whose raw output stayed in context and was re-sent every turn. Each step's full output → one log file; the terminal gets ≤ 2 lines
per step. Steps and their rules are unchanged (CLAUDE.md § STARTUP is the source; this only runs them and summarizes):

  1 validate-workflow        node .claude/scripts/validate-workflow.js
  2 OpenJev audit + pending  python3 scripts/oj.py audit · pending (a listed verify = run one, AGENTS.md)
  3 git sync                 scripts/agent-git-sync.sh (never pull/stash by hand)
  4 Ideas dismissals         watchlist_sync.agent_idea_dismissals newer than ASKS 'declined (Jamie dismissed …)' marks
  5 inbox                    research/inbox.md lines below the '---' header → triage
  6 ASKS for this agent      open index rows "→ <Agent>" / "needs <Agent>" (not done/verified/declined)
  7 Muse rows to plan-review open "Muse →" rows without a "<Agent> plan" in their file (Claude only)
  8 commit review            git log <Last reviewed SHA>..HEAD with Refs: trailers (Claude: quant diffs)
  9 state rotation           scripts/state_rotate.py (state.md budget, verbatim archive)
 10 workflow audit           scripts/workflow_audit.py --short (W-registry: did each workflow change pay off?)

    python3 scripts/agent_start.py [--agent claude] [--no-sync]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGDIR = Path.home() / ".fildi" / "logs"
USAGE = Path.home() / ".fildi" / "workflow-usage.jsonl"


def sh(cmd: str, log, timeout: int = 600) -> tuple[int, str]:
    t0 = time.time()
    try:
        p = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        out, rc = (p.stdout or "") + (p.stderr or ""), p.returncode
    except subprocess.TimeoutExpired:
        out, rc = "TIMEOUT", 124
    log.write(f"\n===== {cmd} (rc {rc}, {time.time() - t0:.0f}s)\n{out}")
    return rc, out


def last(out: str, n: int = 1, pat: str | None = None) -> str:
    ls = [l.strip() for l in out.splitlines() if l.strip() and (pat is None or re.search(pat, l))]
    return " · ".join(ls[-n:])[:220] if ls else "—"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="claude")
    ap.add_argument("--no-sync", action="store_true")
    a = ap.parse_args()
    Agent = a.agent.capitalize()
    LOGDIR.mkdir(parents=True, exist_ok=True)
    logp = LOGDIR / f"agent-start-{a.agent}-{datetime.now():%Y%m%d-%H%M}.log"
    lines: list[str] = []
    say = lines.append
    with logp.open("w") as log:
        rc, out = sh("node .claude/scripts/validate-workflow.js", log)
        say(f"1 workflow check: {'ok' if rc == 0 else 'FAIL'} — {last(out, 2, r'❌|passed')}")
        rc, out = sh("python3 scripts/oj.py audit", log)
        say(f"2 OpenJev audit: {last(out, 2)}")
        rc, out = sh("python3 scripts/oj.py pending", log)
        say(f"  OpenJev pending verify: {last(out, 2)}")
        if not a.no_sync:
            rc, out = sh("scripts/agent-git-sync.sh", log)
            say(f"3 git sync: {'ok' if rc == 0 else f'rc {rc} (2 = real conflict: fix in temp worktree, never Jamie)'} — {last(out)}")
        asks = (ROOT / "research/common/ASKS.md").read_text()
        env = {**os.environ}
        try:
            for ln in (ROOT / ".env.local").read_text().splitlines():
                if ln.startswith("DATABASE_URL="):
                    env["DATABASE_URL"] = ln.split("=", 1)[1].strip().strip('"')
            n = subprocess.run(["psql", env.get("DATABASE_URL", ""), "-Atc",
                                "SELECT count(*) FROM watchlist_sync.agent_idea_dismissals"], capture_output=True, text=True, env=env).stdout.strip()
            marked = len(re.findall(r"declined \(Jamie dismissed", asks))
            say(f"4 Ideas dismissals: {n} in DB vs {marked} marked in ASKS" + (" → mark the rest declined" if n.isdigit() and int(n) > marked else ""))
        except Exception as e:  # noqa: BLE001
            say(f"4 Ideas dismissals: skipped ({e.__class__.__name__})")
        inbox = (ROOT / "research/inbox.md").read_text().split("\n---", 1)
        items = [l for l in (inbox[1] if len(inbox) > 1 else "").splitlines() if l.strip()]
        say(f"5 inbox: {len(items)} line(s)" + (" → triage (split, dedupe, P1–P3, file, clear)" if items else ""))
        open_rows = [l for l in asks.splitlines() if l.startswith("| [A") and not re.search(r"\|\s*(done|verified|declined)\b[^|]*\|\s*$", l)]
        mine = [re.search(r"\[(A\d+)\]", l).group(1) for l in open_rows if re.search(rf"→ {Agent}\b|needs {Agent}", l)]
        say(f"6 ASKS for {Agent}: {len(mine)} open — {', '.join(mine[:15])}{' …' if len(mine) > 15 else ''}")
        if a.agent == "claude":
            need = []
            for l in open_rows:
                if "Muse →" in l and re.search(r"\|\s*open\b", l):
                    aid = re.search(r"\[(A\d+)\]", l).group(1)
                    f = ROOT / "research/common/asks" / f"{aid}.md"
                    if not f.exists() or "Claude plan" not in f.read_text():
                        need.append(aid)
            say(f"7 Muse rows needing Claude plan review: {len(need)} — {', '.join(need) or '—'}")
            st = (ROOT / ".agents/context/state.md").read_text()
            m = re.search(r"Last reviewed SHA:\s*([0-9a-f]{7,40})", st)
            if m:
                rc, out = sh(f"git log --format='%h %ad %s%n%b' --date=short {m.group(1)}..HEAD", log)
                refs = sorted(set(re.findall(r"Refs:\s*(A\d+)", out)))
                n = len(re.findall(r"^[0-9a-f]{7,} \d{4}-", out, re.M))
                say(f"8 commit review since {m.group(1)}: {n} commits, Refs {', '.join(refs) or '—'} → review quant ones, then update Last reviewed SHA")
        rc, out = sh("python3 scripts/state_rotate.py", log)
        say(f"9 state: {last(out)}")
        rc, out = sh("python3 scripts/workflow_audit.py --short", log)
        say(f"10 workflow audit: {last(out, 3)}")
    digest = "\n".join(lines)
    print(digest + f"\nfull log: {logp}")
    with USAGE.open("a") as f:
        f.write(json.dumps({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tool": "agent_start", "agent": a.agent,
                            "digest_chars": len(digest), "log_chars": logp.stat().st_size}) + "\n")


if __name__ == "__main__":
    main()
