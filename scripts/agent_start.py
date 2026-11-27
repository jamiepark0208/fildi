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
 10b context lint           scripts/context_lint.py (orphan docs, rules restated in > 2 files, entry-context char ratchet)
 11 data freshness           scripts/watchlist_sync/data_freshness.py (key tables vs job cadence, future-dated rows, today's daily.py)
 12 UI crashes (48h)         ~/.fildi/ui-crashes.jsonl — browser RouteErrorBoundary + window.error; fix without Jamie re-report

    python3 scripts/agent_start.py [--agent claude] [--no-sync]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
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
        # 5b Ops digest (rail A) — read-only pointer; never writes ASKS.md
        dig = ROOT / ".cursor/context/ops-digest-latest.md"
        if dig.exists():
            head = dig.read_text()[:500]
            empty = "Empty-OK:** yes" in head or "Empty-OK: yes" in head
            stale_m = re.search(r"stale[^:]*:\s*\*\*(\d+)\*\*", head)
            say(f"5b ops-digest: {'empty-OK' if empty else 'needs eyes'}"
                + (f" · stale={stale_m.group(1)}" if stale_m else "")
                + " → .cursor/context/ops-digest-latest.md")
        else:
            say("5b ops-digest: missing — run node scripts/ops-digest.mjs (or wait for Sunday LaunchAgent)")
        # 5c perf-watch (10-28): restart loops, slow/hung routes, 5xx, poll storms, blocked event loop — from the live API log
        rc, out = sh("node scripts/perf-watch.mjs", log, timeout=90)
        say(f"5c {last(out)}" + (" → read ~/.fildi/perf-watch.md, run each signal's check, fix the cause (don't wait for Jamie)" if rc == 1 else ""))
        # 5d rec scoreboard (Jamie 11-10: "how can you not measure if any of it changed a trade or a model rec?")
        # Jamie's put sales vs engine PASS vs Model List, same window, real-fill grading. Engine trailing Jamie = fix producer, no new study.
        rc, out = sh("scripts/watchlist_sync/.venv/bin/python scripts/rec_scoreboard.py --brief", log, timeout=120)
        for l in (out or "").strip().splitlines()[-3:]:
            say(f"5d {l[:300]}")
        open_rows = [l for l in asks.splitlines() if l.startswith("| [A") and not re.search(r"\|\s*(done|verified|declined)\b[^|]*\|\s*$", l)]
        mine = [re.search(r"\[(A\d+)\]", l).group(1) for l in open_rows if re.search(rf"→ {Agent}\b|needs {Agent}", l)]
        say(f"6 ASKS for {Agent}: {len(mine)} open — {', '.join(mine[:15])}{' …' if len(mine) > 15 else ''}")
        inv = ROOT / "research/common/data-inventory.md"
        inv_ts = subprocess.run(["git", "log", "-1", "--format=%ct", "--", str(inv)], cwd=ROOT, capture_output=True, text=True).stdout.strip()
        if not inv_ts or time.time() - int(inv_ts) > 30 * 86400:
            say("6c data inventory > 30 d old (or missing) → re-run A263 audit: unused endpoints + dropped fields, then fix them (AGENTS 4c)")
        # Key Themes (Jamie 10-28): views that disagree with their own signposts, grades due, stale manual inputs
        th = subprocess.run(["sh", "-c", "export $(grep -h '^DATABASE_URL=' .env.local | xargs) && psql \"$DATABASE_URL\" -Atc "
                             "\"SELECT string_agg(DISTINCT theme_id, ',') FILTER (WHERE divergence), "
                             "string_agg(s->>'id', ',') FILTER (WHERE s->>'status' IN ('stale','missing')) "
                             "FROM watchlist_sync.theme_snapshots t LEFT JOIN LATERAL jsonb_array_elements("
                             "CASE WHEN theme_id <> '_read' THEN signposts ELSE '[]' END) s ON true "
                             "WHERE snap_date = (SELECT max(snap_date) FROM watchlist_sync.theme_snapshots)\""],
                            cwd=ROOT, capture_output=True, text=True).stdout.strip()
        if th and th != "|":
            div, stale = (th.split("|") + [""])[:2]
            say(f"6d key themes: view ≠ signposts [{div or 'none'}] · stale/missing signposts [{stale or 'none'}] "
                "→ update research/market-views/themes.json (fildi-market-thesis § 5)")
        # 10-29 (Jamie): megacap reports → market-level read. Per-name notes are automatic (earnings_notes.py, daily via
        # transcripts.py); the cross-company thesis needs an agent, so flag megacap prints newer than the last THESIS file.
        theses = sorted((ROOT / "research/market-views").glob("THESIS_*.md"))
        since = theses[-1].stem.split("_", 1)[1] if theses else "2000-01-01"
        mc = subprocess.run(["sh", "-c", "export $(grep -h '^DATABASE_URL=' .env.local | xargs) && psql \"$DATABASE_URL\" -Atc "
                             "\"SELECT string_agg(ticker || ' ' || to_char(report_date, 'MM-DD'), ', ' ORDER BY report_date) "
                             "FROM public.earnings_calendar WHERE ticker IN ('AAPL','MSFT','NVDA','GOOGL','AMZN','META','AVGO','TSLA') "
                             f"AND report_date > '{since}' AND report_date < CURRENT_DATE\""],
                            cwd=ROOT, capture_output=True, text=True).stdout.strip()
        if mc:
            say(f"6f megacap earnings since THESIS_{since}: {mc} → market read with fildi-market-thesis (new THESIS + LOG C#); "
                "per-name notes are automatic")
        learn_digest = Path.home() / ".fildi" / "learn-digest.txt"
        if learn_digest.exists():
            ld_lines = [ln for ln in learn_digest.read_text(encoding="utf-8").splitlines() if ln.strip()]
            if ld_lines:
                say(f"6e learning loop: {ld_lines[-1][:220]}")
        # 10-24 (Jamie): A228 sat in 'revise' 3 days with no owner action → new work duplicated it. Untouched > 3 days = stalled.
        stalled = []
        for l in open_rows:
            aid = re.search(r"\[(A\d+)\]", l).group(1)
            st_ = re.search(r"\|\s*(open|planned|revise|accepted|blocked)\b", l)
            f = f"research/common/asks/{aid}.md"
            ts = subprocess.run(["git", "log", "-1", "--format=%ct", "--", f], cwd=ROOT, capture_output=True, text=True).stdout.strip()
            if st_ and ts and time.time() - int(ts) > 3 * 86400:
                route = re.search(r"\|\s*([A-Za-z]+ → [^|]+?)\s*\|", l)
                stalled.append(f"{aid} {st_.group(1)} ({route.group(1) if route else '?'})")
        say(f"6b stalled ASKS (no change > 3 d): {len(stalled)}" + (" — " + "; ".join(stalled[:12]) + (" …" if len(stalled) > 12 else "")
            + " → owner acts or re-routes; a 'revise' goes back to its author" if stalled else ""))
        # 11-15 (Jamie): findings can't vanish; verdicts can't outrun open High bugs; shared logic copies may only fall.
        for nm, cmd in (("6h findings", [sys.executable, "scripts/findings_guard.py"]), ("6i copies", [sys.executable, "scripts/copy_ratchet.py"]),
                        ("6k", [sys.executable, "scripts/stale_dirty.py"])):  # 11-16 Jamie: half-edited files block other agents
            fg = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
            say(f"{nm}: " + " | ".join(((fg.stdout or fg.stderr).strip().splitlines() or ["no output"])[:4])[:400])
        try:
            bq = subprocess.run([str(ROOT / "scripts/watchlist_sync/.venv/bin/python"), "-m", "quantcore.bars"],
                                cwd=ROOT / "scripts" / "watchlist_sync", capture_output=True, text=True, timeout=90, env=env)
        except subprocess.TimeoutExpired:
            bq = subprocess.CompletedProcess([], 1, "bars audit: timeout (90 s)", "")
        say("6j " + ((bq.stdout or bq.stderr).strip().splitlines() or ["bars audit: no output"])[-1][:300])
        # A380 (Jamie 11-07): a Works rule whose live record fell below half its claim → owner opens a re-test row.
        try:
            lg = subprocess.run([str(ROOT / "scripts/watchlist_sync/.venv/bin/python"), "strategy_live_grade.py", "--dry-run"],
                                cwd=ROOT / "scripts" / "watchlist_sync", capture_output=True, text=True, timeout=60, env=env)
            lines = lg.stdout.strip().splitlines()
            drift = [x[:160] for x in lines if " drift " in x]
            say("6l live vs claim: " + ("DRIFT " + "; ".join(drift) + " → open a re-test row" if drift
                                        else f"no drift ({len(lines)} rules; most underpowered < 30 expiry weeks)" if lines
                                        else "no output: " + (lg.stderr or "")[-200:]))
        except subprocess.TimeoutExpired:
            say("6l live vs claim: timeout (60 s)")
        # 11-07 (Jamie): parked/declined rows and BOARD dead rows must not sit forever → triggers flip them back.
        rv = subprocess.run([sys.executable, "scripts/asks_revisit.py", "--apply"], cwd=ROOT, capture_output=True, text=True)
        say("6g " + ((rv.stdout or rv.stderr).strip().splitlines() or ["revisit: no output"])[-1][:300])
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
        rc, out = sh("python3 scripts/context_lint.py", log)  # A381 Part C: context-rot guard
        say(f"10b context lint: {last(out, 4)}")
        rc, out = sh("scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/data_freshness.py", log)
        bad = [l for l in out.splitlines() if l.startswith("✗")]
        say(f"11 data freshness: {last(out, pat='freshness')}" + (f" — STALE: {'; '.join(b[2:90] for b in bad[:4])} → fix the job (not just re-run)" if bad else ""))
        # 11a data issues (Jamie 11-11): skipped bad data points / soft-failed steps / data gaps → the session reviews + fixes the source
        rc, out = sh("scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/data_issues.py digest", log)
        say(f"11a {last(out, pat='data issues')}")
        # 11c weekly goal-gap scan (Jamie 11-06: agents must find improvements themselves). Due when goals.md log has no row in 7 d.
        gp = ROOT / '.agents/context/goals.md'
        if gp.exists():
            rows = re.findall(r'^\| (\d{4}-\d{2}-\d{2})', gp.read_text(encoding='utf-8'), re.M)
            lastw = max(rows) if rows else None
            if not lastw or (datetime.now().date() - datetime.fromisoformat(lastw).date()).days >= 7:
                say(f"11c goal-gap scan DUE (last {lastw or 'never'}) → Claude: run § Weekly gap scan in .agents/context/goals.md, ship one fix")
        # 11b WRDS login (Jamie 10-29: a broken login went unreported). Reads the last connect result only — no network,
        # no Duo push. A failure is told to Jamie in one line, never retried by the agent.
        try:
            ws = json.loads((Path.home() / ".fildi" / "wrds-status.json").read_text())
            if not ws.get("ok"):
                say(f"11b WRDS: FAILED {ws.get('at', '')[:16]} — {ws.get('msg', '')} (last ok {str(ws.get('last_ok'))[:10]}) → tell Jamie in one line")
        except (OSError, ValueError):
            pass
        # UI crashes from Jamie's browser → ~/.fildi/ui-crashes.jsonl (RouteErrorBoundary + window.error).
        # Agents act on these without Jamie re-reporting. Token-cheap: ≤2 lines.
        try:
            crash_p = Path.home() / ".fildi" / "ui-crashes.jsonl"
            if crash_p.exists():
                cutoff = time.time() - 48 * 3600
                rows = []
                for ln in crash_p.read_text().splitlines()[-80:]:
                    try:
                        j = json.loads(ln)
                        ts = j.get("t") or ""
                        epoch = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() if ts else 0
                        if epoch >= cutoff:
                            rows.append(j)
                    except Exception:  # noqa: BLE001
                        continue
                if rows:
                    last_m = str(rows[-1].get("message", ""))[:80]
                    path = rows[-1].get("path") or "?"
                    say(f"12 UI crashes (48h): {len(rows)} — last: {last_m} @ {path} → investigate + fix (do not wait for Jamie)")
                else:
                    say("12 UI crashes (48h): 0")
            else:
                say("12 UI crashes (48h): 0 (no log yet)")
        except Exception as e:  # noqa: BLE001
            say(f"12 UI crashes: skipped ({e.__class__.__name__})")
    digest = "\n".join(lines)
    print(digest + f"\nfull log: {logp}")
    with USAGE.open("a") as f:
        f.write(json.dumps({"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tool": "agent_start", "agent": a.agent,
                            "digest_chars": len(digest), "log_chars": logp.stat().st_size}) + "\n")


if __name__ == "__main__":
    main()
