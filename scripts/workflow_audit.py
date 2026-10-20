#!/usr/bin/env python3
"""Workflow learning loop (Jamie 10-20): did each agent-workflow change actually save tokens / help? Measures every row of
.agents/context/workflow-learning.md (W-registry) from real data and says keep / fix / propose.

Data (all local, $0): Claude Code session logs (~/.claude/projects/<repo>/*.jsonl — per-request usage, same source as the Agents
tab), ~/.fildi/workflow-usage.jsonl (tools log each run), file sizes. Each run appends one snapshot to ~/.fildi/workflow-metrics.jsonl
(trend). A row past its review date that misses its target prints FAIL → its owner fixes or reverts it, or (shared files) files an
ASKS proposal for the other agents to review (AGENTS.md rule proposed in A210).

    python3 scripts/workflow_audit.py [--short] [--days 14]
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REG = ROOT / ".agents/context/workflow-learning.md"
LOGS = Path.home() / ".claude/projects" / ("-" + str(ROOT).strip("/").replace("/", "-"))
USAGE = Path.home() / ".fildi/workflow-usage.jsonl"
SNAP = Path.home() / ".fildi/workflow-metrics.jsonl"
MEM = LOGS / "memory/MEMORY.md"
SQL_MISS = re.compile(r'(?:column|relation) \\?"[^"\\]+\\?" does not exist')


def sessions(days: int) -> list[dict]:
    """Per Claude session: requests, total context tokens sent, output, first-request context, SQL-guess errors."""
    since = datetime.now().timestamp() - days * 86400
    out = []
    for f in LOGS.glob("*.jsonl") if LOGS.exists() else []:
        if f.stat().st_mtime < since:
            continue
        seen, s = set(), {"id": f.stem[:8], "req": 0, "ctx": 0, "out": 0, "first_ctx": None, "sql_miss": 0, "start": None}
        with f.open(errors="ignore") as fh:
            for line in fh:
                if '"usage"' in line:
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    u, rid = (o.get("message") or {}).get("usage"), o.get("requestId") or o.get("uuid")
                    if not u or rid in seen:
                        continue
                    seen.add(rid)
                    c = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                    s["req"] += 1
                    s["ctx"] += c
                    s["out"] += u.get("output_tokens", 0)
                    s["first_ctx"] = s["first_ctx"] or c
                    s["start"] = s["start"] or o.get("timestamp")
                elif '"tool_result"' in line and "does not exist" in line:
                    s["sql_miss"] += len(SQL_MISS.findall(line))
        if s["req"]:
            out.append(s)
    return out


def usage(days: int) -> dict[str, list[dict]]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    by: dict[str, list[dict]] = {}
    if USAGE.exists():
        for line in USAGE.read_text().splitlines():
            try:
                o = json.loads(line)
                if datetime.fromisoformat(o["t"].replace("Z", "+00:00")) >= since:
                    by.setdefault(o["tool"], []).append(o)
            except (ValueError, KeyError):
                continue
    return by


def registry() -> list[dict]:
    rows = []
    for l in REG.read_text().splitlines() if REG.exists() else []:
        if re.match(r"^\| W\d+ ", l):
            c = [x.strip() for x in l.strip("|").split("|")]
            rows.append({"id": c[0], "change": c[1], "owner": c[2], "metric": c[4], "target": c[6], "review": c[7], "status": c[8]})
    return rows


def measure(metric: str, ss: list[dict], us: dict, files: dict) -> float | None:
    """metric keys used in the registry's Metric column (first `code` span)."""
    m = re.search(r"`([a-z_]+)`", metric)
    k = m.group(1) if m else ""
    med = lambda xs: statistics.median(xs) if xs else None  # noqa: E731
    if k == "start_chars_saved":
        r = us.get("agent_start", [])
        return med([x["log_chars"] - x["digest_chars"] for x in r])
    if k == "state_chars":
        return files["state"]
    if k == "instr_chars":
        return files["claude"] + files["agents"] + files["memory"]
    if k == "first_ctx":
        return med([s["first_ctx"] for s in ss])
    if k == "rebuild_uses":
        return len(us.get("rebuild.sh", []))
    if k == "funnel_uses":
        return len(us.get("funnel", []))
    if k == "sql_miss_per_session":
        return med([s["sql_miss"] for s in ss])
    if k == "ctx_per_request":
        return med([s["ctx"] / s["req"] for s in ss])
    if k == "ctx_per_session":
        return med([s["ctx"] for s in ss])
    return None


def verdict(val: float | None, target: str, review: str) -> str:
    m = re.match(r"\s*([<>]=?)\s*([\d.,]+)", target)
    if val is None or not m:
        return "no data yet"
    lim = float(m.group(2).replace(",", ""))
    ok = {"<": val < lim, "<=": val <= lim, ">": val > lim, ">=": val >= lim}[m.group(1)]
    due = date.fromisoformat(review) <= date.today() if re.match(r"\d{4}-\d\d-\d\d", review) else False
    return "PASS" if ok else ("FAIL → fix/revert or ASKS proposal" if due else "tracking")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--short", action="store_true")
    ap.add_argument("--days", type=int, default=14)
    a = ap.parse_args()
    ss, us = sessions(a.days), usage(a.days)
    size = lambda p: p.stat().st_size if p.exists() else 0  # noqa: E731
    files = {"state": size(ROOT / ".agents/context/state.md"), "claude": size(ROOT / "CLAUDE.md"), "agents": size(ROOT / "AGENTS.md"),
             "memory": size(MEM)}
    rows = registry()
    res = [(r, measure(r["metric"], ss, us, files)) for r in rows if r["status"].lower() not in ("retired", "reverted")]
    snap = {"t": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sessions": len(ss), **files,
            **{r["id"]: v for r, v in res}}
    SNAP.parent.mkdir(parents=True, exist_ok=True)
    with SNAP.open("a") as f:
        f.write(json.dumps(snap) + "\n")
    fails = [(r, v) for r, v in res if verdict(v, r["target"], r["review"]).startswith("FAIL")]
    if a.short:
        tot = statistics.median([s["ctx"] for s in ss]) if ss else 0
        print(f"{len(res)} W-rows tracked · {len(ss)} sessions/{a.days}d · median {tot / 1e6:.1f}M context tokens/session")
        print("FAIL: " + "; ".join(f"{r['id']} {r['change'][:40]} ({r['owner']})" for r, _ in fails) if fails else "no failing rows")
        return
    print(f"Workflow audit · {len(ss)} Claude sessions in {a.days} d · files: state {files['state']:,} / CLAUDE {files['claude']:,} / "
          f"AGENTS {files['agents']:,} / MEMORY {files['memory']:,} chars")
    for r, v in res:
        print(f"  {r['id']} {r['change'][:48]:48} {('—' if v is None else f'{v:,.0f}'):>12}  target {r['target']:10} "
              f"review {r['review']}: {verdict(v, r['target'], r['review'])}")
    for s in sorted(ss, key=lambda s: s["start"] or "")[-5:]:
        print(f"  session {s['id']} {str(s['start'])[:10]}: {s['req']} req · {s['ctx'] / 1e6:.1f}M ctx · first {s['first_ctx']:,} · "
              f"SQL misses {s['sql_miss']}")


if __name__ == "__main__":
    main()
