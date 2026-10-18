#!/usr/bin/env python3
"""oj — OpenJev for every agent (framework: .agents/openjev/README.md). Local DiffusionGemma 26B, $0, typed answers.

    scripts/oj.py ask  --q "Is this file relevant to: fix stale prices?" [--pattern P10] [--state-file F | stdin]
                       [--type noul|choice|score] [--options '{"a":"…"}' | '["low","mid","high"]']
    --- token savers (OpenJev reads the text; you read only the result) ---
    scripts/oj.py files --task "fix stale prices" [--grep 'ohlcv|stale'] [dirs/files]   # P10: which files to read
    scripts/oj.py run -- npm test                # P11: exit code + tail + only chunks that show problems
    scripts/oj.py studies "does IV rank predict put outcomes?"   # P14: already answered by a study?
    scripts/oj.py dupes "alert when a held name gaps down"      # P13: already an ASKS row?
    scripts/oj.py skill "add a new API route"    # P15: which skill file
    --- heavier analysis ---
    scripts/oj.py analyze --spec .agents/openjev/specs/P21_overnight_put_risk.json [--record]   # decomposed, learned weights
    --- registry ---
    scripts/oj.py list                       # registry: which question patterns are proven / rejected (+ confidence)
    scripts/oj.py eval P10 [--build] [--limit N]   # run a pattern's labelled eval set → evidence + metrics (only way numbers enter)
    scripts/oj.py verify [P10]               # recompute every registry number from stored answers; re-ask a 20 % sample live
    scripts/oj.py outcome <usage_id> yes|no  # after you checked anyway: was OpenJev right? (feeds live accuracy / demotion)
    scripts/oj.py audit                      # live accuracy per pattern from outcomes; demotes drifting patterns
    scripts/oj.py render                     # registry.json → REGISTRY.md (generated; never edit the .md by hand)
    scripts/oj.py stop                       # stop the dev server now (else it stops itself after 10 idle minutes)

Server: ONE shared OpenJev on 127.0.0.1:8091 for every agent and the 05:30 batch (scripts/oj_server.py: start lock, server-side
queue, idle stop 10 min after anyone's last request; needs ≥ 26 GB free RAM, ~15 s load). Unavailable → exit 3: decide yourself.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FW = ROOT / ".agents/openjev"
REG = FW / "registry.json"
EVALS = FW / "evals"                       # manifests (committed): items hash, answers hash, metrics
EVAL_DATA = ROOT / "research/openjev/evals"  # raw items + answers (gitignored, rebuildable with --build)
USAGE = Path.home() / ".fildi/openjev-usage.jsonl"
MODEL = "openjev-latest"
import oj_server  # noqa: E402  — the single OpenJev instance (one port, start lock, shared queue, one idle stop)


def ensure_server() -> int | None:
    """Port of THE shared OpenJev server (starts it once for everyone; None = unavailable → decide yourself)."""
    return oj_server.ensure(who=me())


EVENTS = Path.home() / ".fildi/agent-events.jsonl"


def ev(event: str, detail: str, caller: str | None = None) -> None:
    """AI tab (Settings › Agents): OpenJev orb pulses + beam from the calling agent's orb. Never raises."""
    try:
        t = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        row = {"t": t, "agent": "openjev", "event": event, "detail": detail[:120]}
        if caller and caller != "?":
            row["caller"] = caller
        with EVENTS.open("a") as f:
            f.write(json.dumps(row) + "\n")
    except OSError:
        pass


def me() -> str:
    """Calling agent: FILDI_AGENT, else guessed from the parent process chain (claude / cursor / kiro), else '?'."""
    if os.environ.get("FILDI_AGENT"):
        return os.environ["FILDI_AGENT"]
    pid = os.getppid()
    for _ in range(8):
        out = subprocess.run(["ps", "-o", "ppid=,command=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if not out:
            break
        ppid, cmd = out.split(None, 1)
        low = cmd.lower()
        for name in ("claude", "cursor", "kiro"):
            if f"/{name}" in low or low.startswith(name):
                os.environ["FILDI_AGENT"] = name
                return name
        pid = int(ppid)
    return "?"


def stop() -> None:
    oj_server.stop(me())


_last_ev = [0.0]
WHAT = ["typed question"]   # set by each command: shown on the AI-tab beam


def post(port: int, state: str, questions: dict, **extra) -> dict:
    """One typed request to the shared server; it queues concurrent callers itself. 529 (queue full) / restart → retry."""
    oj_server.touch()
    if time.time() - _last_ev[0] > 3:   # throttle: one AI-tab ping per 3 s of asking
        _last_ev[0] = time.time()
        ev("batch", f"{me()}: {WHAT[0]}", me())
    body = json.dumps({"model": MODEL, "state": state, "questions": questions, **extra}).encode()
    for attempt in range(6):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/systemone", data=body, method="POST", headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 529 or attempt == 5:
                raise
            time.sleep(1 + attempt)
        except (urllib.error.URLError, ConnectionError):
            if attempt == 5 or (port := ensure_server()) is None:   # server idled out / restarted → bring it back once
                raise
    raise RuntimeError("unreachable")


# ---------- registry -------------------------------------------------------------------------------------------

def load_reg() -> dict:
    return json.loads(REG.read_text())


def save_reg(reg: dict) -> None:
    REG.write_text(json.dumps(reg, indent=1, ensure_ascii=False) + "\n")


def wilson(k: int, n: int, z: float = 1.645) -> tuple[float, float]:
    """90 % Wilson interval for k successes of n."""
    if n == 0:
        return 0.0, 1.0
    p = k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return round(c - h, 3), round(c + h, 3)


def tier(e: dict) -> str:
    """A proven (lower bound ≥ target, verified by a second agent) · B promising · C untested · X rejected (upper bound < target)."""
    if e.get("retired"):
        return "R"
    m = e.get("measured")
    if not m:
        return "C"
    lo, hi, tgt = m.get("lo"), m.get("hi"), e["rule"]["target"]
    if hi is not None and hi < tgt:
        return "X"
    if lo is not None and lo >= tgt and e.get("verified_by") and e["verified_by"] != m.get("by"):
        return "A"
    return "B"


def render(quiet: bool = False) -> None:
    reg = load_reg()
    out = ["# OpenJev question registry (GENERATED by `scripts/oj.py render` from registry.json — do not edit by hand)", "",
           "Tier: **A** proven (lower bound ≥ target, re-checked by a 2nd agent) · **B** promising (not yet proven) · **C** untested idea · "
           "**X** rejected (upper bound < target) · **R** retired. Numbers come only from `oj.py eval`/`analyze` or a cited study; `oj.py verify` recomputes them. Edits to a measured question = new version id (`P10v2`), old row gets `superseded_by`.", "",
           "| Tier | ID | Ask OpenJev… | Use | Pass rule | Measured (90 % CI) | n | Evidence | By / verified |", "|---|---|---|---|---|---|---|---|---|"]
    order = {"A": 0, "B": 1, "C": 2, "X": 3, "R": 4}
    for e in sorted(reg["patterns"], key=lambda e: (order[tier(e)], e["id"])):
        m = e.get("measured") or {}
        g = lambda x: "?" if x is None else f"{x:.3g}"
        meas = f"{g(m['value'])} [{g(m.get('lo'))}, {g(m.get('hi'))}]" if m else "—"
        out.append(f"| {tier(e)} | {e['id']} | {e['question']} | {e['use']} | {e['rule']['metric']} ≥ {e['rule']['target']} "
                   f"({e['rule'].get('baseline', 'no baseline')}) | {meas} | {m.get('n', '—')} | {m.get('evidence', '—')} | "
                   f"{m.get('by', e.get('created_by', '?'))} / {e.get('verified_by') or '—'} |")
    (FW / "REGISTRY.md").write_text("\n".join(out) + "\n")
    if not quiet:
        print(f"rendered {len(reg['patterns'])} patterns")


def _find(reg: dict, pid: str) -> dict:
    return next(e for e in reg["patterns"] if e["id"] == pid)


# ---------- ask + usage ----------------------------------------------------------------------------------------

def ask(a) -> int:
    state = Path(a.state_file).read_text() if a.state_file else ("" if sys.stdin.isatty() else sys.stdin.read())
    q: dict = {"type": a.type, "instructions": a.q}
    if a.options:
        q["criteria"] = json.loads(a.options)
    port = ensure_server()
    if port is None:
        print(json.dumps({"available": False}))
        return 3
    r = post(port, state[:30000], {"q": q})["answers"]["q"]
    uid = hashlib.sha1(f"{time.time()}{a.q}".encode()).hexdigest()[:10]
    USAGE.parent.mkdir(exist_ok=True)
    with USAGE.open("a") as f:
        f.write(json.dumps({"id": uid, "at": dt.datetime.now().isoformat(timespec="seconds"), "agent": os.environ.get("FILDI_AGENT", "?"),
                            "pattern": a.pattern, "q": a.q[:200], "answer": r, "state_chars": len(state)}) + "\n")
    tierv = tier(_find(load_reg(), a.pattern)) if a.pattern else "unregistered"
    print(json.dumps({"usage_id": uid, "pattern_tier": tierv, **r}))
    return 0


def outcome(uid: str, right: str) -> None:
    with USAGE.open("a") as f:
        f.write(json.dumps({"outcome_for": uid, "right": right == "yes", "at": dt.datetime.now().isoformat(timespec="seconds")}) + "\n")


# ---------- eval + verify --------------------------------------------------------------------------------------

def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def qsha(e: dict) -> str:
    """Fingerprint of what was measured (question + pass rule). Changing either after measuring = a new version, not an edit."""
    return hashlib.sha256(json.dumps([e["question"], e["rule"]], sort_keys=True).encode()).hexdigest()[:12]


def run_eval(pid: str, build: bool, limit: int | None, model: str | None = None, port: int | None = None, dry: bool = False) -> None:
    import oj_evals
    reg = load_reg()
    e = _find(reg, pid)
    d = EVAL_DATA / pid
    d.mkdir(parents=True, exist_ok=True)
    items_f, ans_f = d / "items.jsonl", d / "answers.jsonl"
    if build or not items_f.exists():
        items = oj_evals.BUILDERS[pid]()
        items_f.write_text("".join(json.dumps(x) + "\n" for x in items))
    items = [json.loads(x) for x in items_f.open()][:limit]
    WHAT[0] = f"eval {pid} ({len(items)} items{', ' + model if model else ''})"
    global MODEL
    if model:
        MODEL = model
        ans_f = d / f"answers_{model}.jsonl"
    port = port or ensure_server()
    if port is None:
        sys.exit("oj eval: OpenJev unavailable (RAM)")
    t0 = time.time()
    with ans_f.open("w") as w:
        for x in items:
            r = post(port, x["state"], {"q": x["question"]})["answers"]["q"]
            w.write(json.dumps({"id": x["id"], "answer": r}) + "\n")
    m = oj_evals.score(pid, items, [json.loads(x) for x in ans_f.open()], e)
    m["s_per_item"] = round((time.time() - t0) / max(1, len(items)), 3)
    if dry:
        print(json.dumps({"model": MODEL, **m}, indent=1))
        return
    m.update({"by": os.environ.get("FILDI_AGENT", "?"), "at": dt.date.today().isoformat(), "model": MODEL,
              "items_sha": sha(items_f), "answers_sha": sha(ans_f), "evidence": f"oj eval {pid}", "question_sha": qsha(e)})
    e["measured"], e["verified_by"] = m, None    # a new measurement always needs a fresh second-agent verify
    EVALS.mkdir(exist_ok=True)
    (EVALS / f"{pid}.json").write_text(json.dumps(m, indent=1) + "\n")
    save_reg(reg)
    render()
    print(json.dumps(m, indent=1))


def verify(pid: str | None, live_frac: float = 0.2) -> int:
    """Recompute metrics from stored answers; hashes must match; re-ask a live sample (same model → answers must agree)."""
    import oj_evals
    reg = load_reg()
    me = os.environ.get("FILDI_AGENT", "?")
    bad = 0
    for e in reg["patterns"]:
        if pid and e["id"] != pid:
            continue
        m = e.get("measured")
        if not m or not m.get("items_sha"):
            continue                       # study-cited entries: tier ≤ B until re-measured with oj eval
        if e["rule"]["kind"] == "analyze_auc":      # deterministic re-run of the decomposed analysis from the same inputs
            import oj_analyze
            spec_p = ROOT / m["evidence"].split()[-1]
            src = ROOT / json.loads(spec_p.read_text())["source"]["path"]
            ok = sha(src) == m["items_sha"] and sha(spec_p) == m["answers_sha"]
            re_v = oj_analyze.run(spec_p, quiet=True)["value"]
            ok &= abs(re_v - m["value"]) < 1e-9
            print(f"{e['id']}: {'OK' if ok else 'MISMATCH'} (stored {m['value']}, recomputed {re_v})")
            if ok and me not in ("?", m.get("by")):
                e["verified_by"], e["verified_at"] = me, dt.date.today().isoformat()
            elif not ok:
                e["verified_by"] = None
                bad += 1
            continue
        d = EVAL_DATA / e["id"]
        items = [json.loads(x) for x in (d / "items.jsonl").open()]
        ans = [json.loads(x) for x in (d / "answers.jsonl").open()]
        ok = sha(d / "items.jsonl") == m["items_sha"] and sha(d / "answers.jsonl") == m["answers_sha"]
        re_m = oj_evals.score(e["id"], items, ans, e)
        ok &= abs(re_m["value"] - m["value"]) < 1e-9
        port = ensure_server() if live_frac else None
        if port:
            rnd = random.Random()
            sample = rnd.sample(list(zip(items, ans)), max(5, int(len(items) * live_frac)))
            agree = sum(oj_evals.same(post(port, x["state"], {"q": x["question"]})["answers"]["q"], a["answer"]) for x, a in sample)
            ok &= agree >= 0.9 * len(sample)
            print(f"{e['id']}: live re-ask agreement {agree}/{len(sample)}")
        print(f"{e['id']}: {'OK' if ok else 'MISMATCH'} (stored {m['value']:.4g}, recomputed {re_m['value']:.4g})")
        if ok and me not in ("?", m.get("by")):
            e["verified_by"], e["verified_at"] = me, dt.date.today().isoformat()
        elif not ok:
            e["verified_by"] = None
            bad += 1
    save_reg(reg)
    render()
    return 1 if bad else 0


# ---------- token-saving commands (OpenJev reads, the agent reads only the result) ------------------------------

CODE_EXT = (".ts", ".tsx", ".py", ".mjs", ".js", ".sh", ".sql", ".md")


def _need(pid: str) -> int | None:
    port = ensure_server()
    if port is None:
        print(json.dumps({"available": False, "hint": "decide yourself"}))
    return port


def _log_use(pid: str, q: str, n_items: int, chars: int) -> str:
    uid = hashlib.sha1(f"{time.time()}{q}".encode()).hexdigest()[:10]
    USAGE.parent.mkdir(exist_ok=True)
    with USAGE.open("a") as f:
        f.write(json.dumps({"id": uid, "at": dt.datetime.now().isoformat(timespec="seconds"), "agent": me(), "pattern": pid,
                            "q": q[:200], "items": n_items, "state_chars": chars}) + "\n")
    return uid


def cmd_files(task: str, paths: list[str], grep: str | None, top: int) -> int:
    """P10: rank candidate files for a task; read only the kept ones. Candidates = --grep hits and/or paths (dirs expand)."""
    WHAT[0] = f"which files for: {task[:50]}"
    cands: list[str] = []
    if grep:
        cands += subprocess.run(["git", "grep", "-l", "-i", "-E", grep], cwd=ROOT, capture_output=True, text=True).stdout.split()
    for p in paths:
        q = ROOT / p
        cands += ([str(f.relative_to(ROOT)) for f in sorted(q.rglob("*")) if f.is_file() and f.suffix in CODE_EXT and "node_modules" not in f.parts]
                  if q.is_dir() else [p])
    cands = [c for c in dict.fromkeys(cands) if c.endswith(CODE_EXT)][:80]
    if not cands:
        print("no candidate files")
        return 1
    port = _need("P10")
    if port is None:
        return 3
    rows, chars = [], 0
    for c in cands:
        try:
            text = (ROOT / c).read_text(errors="ignore")
        except OSError:
            continue
        chars += len(text)
        body = "\n".join(text.splitlines()[:80])[:3000]
        a = post(port, f"Task: {task}\nFile: {c}\n---\n{body}", {"q": {"type": "noul", "instructions": "Would a developer need to read or edit this file to do the task?"}})
        rows.append((a["answers"]["q"]["noul"], c, len(text)))
    rows.sort(reverse=True)
    reg = load_reg()
    t = _find(reg, "P10")
    uid = _log_use("P10", task, len(rows), chars)
    keep = [r for r in rows if r[0] >= t["rule"]["threshold"]]
    print(f"P10 tier {tier(t)} · usage_id {uid} · keep {len(keep)}/{len(rows)} (P ≥ {t['rule']['threshold']}); "
          f"skip saves ~{sum(r[2] for r in rows if r[0] < t['rule']['threshold']) // 4:,} tokens if you trust it")
    for p, c, n in rows[:max(top, len(keep))]:
        print(f"  {p:.2f}  {c}  ({n // 4:,} tok)")
    return 0


FAIL_RX = r"(?i)(traceback|error|exception|fail(ed|ure)?|✗|err!|fatal|panic|exit code [1-9]|not ok|assert)"


def cmd_run(argv: list[str], max_chars: int = 6000) -> int:
    """P11: run a command; print exit code, the tail, and only the chunks that show problems (regex OR OpenJev)."""
    import re
    WHAT[0] = f"triage output of: {' '.join(argv)[:50]}"
    p = subprocess.run(" ".join(argv), shell=True, cwd=os.getcwd(), capture_output=True, text=True)
    out = (p.stdout + p.stderr).rstrip()
    lines = out.splitlines()
    print(f"exit {p.returncode} · {len(lines)} lines")
    if len(out) <= max_chars:
        print(out)
        return p.returncode
    chunks = [lines[i:i + 40] for i in range(0, len(lines), 40)]
    port = ensure_server()
    shown = []
    for i, ch in enumerate(chunks[:-1]):
        txt = "\n".join(ch)
        hit = bool(re.search(FAIL_RX, txt))
        pj = None
        if port and not hit:
            pj = post(port, txt[:4000], {"q": {"type": "noul", "instructions": "Does this part of a command's output show an error, failure, "
                                                "data problem (0 rows, skipped, stale, missing) or warning that needs action?"}})["answers"]["q"]["noul"]
        if hit or (pj is not None and pj >= 0.5):
            shown.append((i, hit, pj, txt))
    uid = _log_use("P11", " ".join(argv), len(chunks), len(out))
    for i, hit, pj, txt in shown[:6]:
        print(f"--- lines {i * 40 + 1}–{i * 40 + 40} ({'regex' if hit else f'OpenJev {pj:.2f}'}) ---\n{txt[:2500]}")
    if len(shown) > 6:
        print(f"... {len(shown) - 6} more flagged chunks")
    print(f"--- tail ---\n" + "\n".join(chunks[-1]))
    print(f"[oj run: showed {min(len(shown), 6) * 40 + len(chunks[-1])} of {len(lines)} lines · usage_id {uid}"
          f"{'' if port else ' · OpenJev unavailable: regex only'}]")
    return p.returncode


def _rank(pid: str, query: str, rows: list[tuple[str, str]], instr: str, top: int) -> int:
    port = _need(pid)
    if port is None:
        return 3
    res = []
    for key, text in rows:
        a = post(port, f"Question: {query}\n---\n{text[:2500]}", {"q": {"type": "noul", "instructions": instr}})
        res.append((a["answers"]["q"]["noul"], key, text))
    res.sort(reverse=True)
    uid = _log_use(pid, query, len(rows), sum(len(t) for _, t in rows))
    print(f"{pid} tier {tier(_find(load_reg(), pid))} · usage_id {uid} · top {top} of {len(rows)}")
    for p, k, t in res[:top]:
        print(f"  {p:.2f}  {k}  {t[:160].replace(chr(10), ' ')}")
    return 0


def study_rows() -> list[tuple[str, str]]:
    import re
    return [(m.group(1), l) for l in (ROOT / "research/studies/INDEX.md").read_text().splitlines()
            if (m := re.match(r"\| (S\d{3}) \|", l))]


def asks_rows() -> list[tuple[str, str]]:
    import re
    out = []
    for f in ("research/common/ASKS.md", "research/common/ASKS-archive.md"):
        for l in (ROOT / f).read_text().splitlines():
            if m := re.match(r"\| \[?(A\d+)", l):
                out.append((m.group(1), l))
    return out


def _kw_rank(query: str, rows: list[tuple[str, str]]) -> list[tuple[int, str, str]]:
    import re
    w = set(re.findall(r"[a-z0-9]{4,}", query.lower()))
    return sorted(((len(w & set(re.findall(r"[a-z0-9]{4,}", t.lower()))), k, t) for k, t in rows), key=lambda r: -r[0])


def cmd_studies(q: str, top: int) -> int:
    """P14 'already studied?' — keyword overlap, NO model: measured 10-18, keywords top-3 24/54 vs OpenJev 14/54 (P14 = X)."""
    res = _kw_rank(q, study_rows())
    _log_use("P14-keyword", q, len(res), 0)
    print(f"studies (keyword rank; OpenJev was worse here, P14 X) · top {top}:")
    for n, k, t in res[:top]:
        print(f"  {n:2d} words  {k}  {t[:170]}")
    return 0


def cmd_dupes(idea: str, top: int, use_oj: bool) -> int:
    """P13: is this idea already an ASKS row? Keyword rank (same lesson as P14); --oj adds OpenJev P as a 2nd opinion (P13 unmeasured)."""
    res = _kw_rank(idea, asks_rows())[:max(top, 10)]
    if not use_oj:
        _log_use("P13-keyword", idea, len(res), 0)
        print(f"dupes (keyword rank) · top {top}:")
        for n, k, t in res[:top]:
            print(f"  {n:2d} words  {k}  {t[:170]}")
        return 0
    WHAT[0] = f"duplicate ASKS? {idea[:50]}"
    return _rank("P13", idea, [(k, t) for _, k, t in res], "Is the new idea the same underlying need as this existing row?", top)


def cmd_skill(task: str) -> int:
    """P15: which skill file does this task need? (choice over the CLAUDE.md SKILLS table, 2 shuffled reads)"""
    import re
    WHAT[0] = f"which skill: {task[:50]}"
    rows = re.findall(r"^\| ([^|]+?) \| (\.claude/skills/[\w.-]+) \|", (ROOT / "CLAUDE.md").read_text(), re.M)
    opts = {Path(s).stem: need for need, s in rows}
    port = _need("P15")
    if port is None:
        return 3
    tot: dict = {}
    for seed in (1, 2):
        keys = list(opts)
        random.Random(seed).shuffle(keys)
        a = post(port, f"Task: {task}", {"q": {"type": "choice", "instructions": "Which skill guide is most useful for this task?",
                                               "criteria": {k: opts[k] for k in keys} | {"none": "no skill needed"}}})["answers"]["q"]
        for k, v in (a.get("probabilities") or {}).items():
            tot[k] = tot.get(k, 0) + v / 2
    uid = _log_use("P15", task, 1, len(task))
    print(f"P15 tier {tier(_find(load_reg(), 'P15'))} · usage_id {uid}")
    for k, v in sorted(tot.items(), key=lambda kv: -kv[1])[:3]:
        print(f"  {v:.2f}  {k}" + (f"  → .claude/skills/{k}.md" if k != "none" else ""))
    return 0


def audit() -> None:
    """Live accountability: per pattern, share of logged uses that agents later marked right. If the upper bound of live
    accuracy falls below the pass target (≥ 20 outcomes), the pattern loses its verification → tier drops to B, flagged."""
    if not USAGE.exists():
        print("no usage yet")
        return
    rows = [json.loads(x) for x in USAGE.open()]
    pat = {r["id"]: r.get("pattern") for r in rows if "id" in r}
    agg: dict = {}
    for r in rows:
        if "outcome_for" in r and pat.get(r["outcome_for"]):
            k, n = agg.get(pat[r["outcome_for"]], (0, 0))
            agg[pat[r["outcome_for"]]] = (k + r["right"], n + 1)
    reg = load_reg()
    ids = {e["id"] for e in reg["patterns"]}
    # lifecycle 1 — new: questions agents keep asking that the registry doesn't cover → propose as C rows
    import re
    norm = lambda q: re.sub(r"[^a-z ]", "", (q or "").lower())[:60]
    asked: dict = {}
    for r in rows:
        if "id" in r and not (r.get("pattern") or "").split("-")[0] in ids:
            asked[norm(r.get("q"))] = asked.get(norm(r.get("q")), 0) + 1
    for q, n in sorted(asked.items(), key=lambda kv: -kv[1]):
        if n >= 5:
            print(f"NEW? asked {n}× unregistered: '{q}' → add a C row (question, use, rule, label source) or map it to a pattern")
    # lifecycle 2 — retire: untested ideas > 30 days, patterns unused > 60 days
    last_use: dict = {}
    for r in rows:
        if "id" in r and r.get("pattern"):
            k = r["pattern"].split("-")[0]
            last_use[k] = max(last_use.get(k, ""), r.get("at", ""))
    today = dt.date.today()
    for e in reg["patterns"]:
        if e.get("retired"):
            continue
        age = (today - dt.date.fromisoformat(e.get("created", today.isoformat()))).days
        if tier(e) == "C" and age > 30:
            print(f"STALE? {e['id']} untested for {age} days → measure (oj.py eval) or retire (\"retired\": {{date, reason}})")
        if tier(e) in ("A", "B") and age > 60 and last_use.get(e["id"], "") < (today - dt.timedelta(days=60)).isoformat():
            print(f"UNUSED? {e['id']} no use in 60 days → retire or promote its command in AGENTS.md")
    for e in reg["patterns"]:
        if e["id"] in agg:
            k, n = agg[e["id"]]
            lo, hi = wilson(k, n)
            e["live"] = {"right": k, "n": n, "lo": lo, "hi": hi, "at": dt.date.today().isoformat()}
            if n >= 20 and hi < e["rule"]["target"] and e.get("verified_by"):
                e["verified_by"], e["notes"] = None, (e.get("notes") or "") + f" | DEMOTED {dt.date.today()}: live {k}/{n}"
            print(f"{e['id']}: live {k}/{n} right [{lo}, {hi}] → tier {tier(e)}")
    save_reg(reg)
    render()


def cmd_analyze(spec_path: str, record: bool) -> int:
    """Decomposed analysis (oj_analyze): many typed questions → learned combination → calibrated P. --record writes the
    result into the registry as the spec's pattern (numbers via script only; verify re-runs it)."""
    import oj_analyze
    sp = (ROOT / spec_path) if not Path(spec_path).is_absolute() else Path(spec_path)
    spec = json.loads(sp.read_text())
    WHAT[0] = f"analyze {spec['id']}"
    ev("batch", f"{me()}: decomposed analysis {spec['id']}", me())
    res = oj_analyze.run(sp)
    if record:
        reg = load_reg()
        try:
            e = _find(reg, spec["id"])
        except StopIteration:
            e = {"id": spec["id"], "question": spec["title"] + " (decomposed: " + ", ".join(f["name"] for f in spec["features"]) + ")",
                 "type": "analyze", "use": spec.get("why", ""), "created_by": me(), "verified_by": None, "notes": "",
                 "rule": {"kind": "analyze_auc", "metric": "test AUC (time split), learned weights", "target": 0.65,
                          "baseline": "best single question"}, "label_source": spec["source"]["path"]}
            reg["patterns"].append(e)
        e["measured"] = {**{k: res[k] for k in ("value", "lo", "hi", "n")}, "by": me(), "at": dt.date.today().isoformat(),
                         "model": MODEL, "items_sha": sha(ROOT / spec["source"]["path"]), "answers_sha": sha(sp),
                         "evidence": f"oj analyze {spec_path}", "question_sha": qsha(e), "secondary": f"best single {res['best_single']['name']} {res['best_single']['auc']}; Brier {res['brier']} vs base {res['brier_base']}"}
        e["verified_by"] = None
        EVALS.mkdir(exist_ok=True)
        (EVALS / f"{spec['id']}.json").write_text(json.dumps({**e["measured"], **res}, indent=1) + "\n")
        save_reg(reg)
        render()
    return 0


def pending() -> int:
    """Work waiting for YOU (any agent, session start; no relaying through Jamie): measured patterns you did not author that
    still need a second key. Prints the exact commands."""
    who = me()
    rows = [e for e in load_reg()["patterns"] if e.get("measured") and e["measured"].get("items_sha")
            and not e.get("verified_by") and not e.get("retired") and e["measured"].get("by") != who]
    if not rows:
        print("oj pending: nothing to verify")
        return 0
    print(f"oj pending for {who}: {len(rows)} pattern(s) need a second agent's verify (~3–10 min each, local, $0):")
    for e in rows:
        print(f"  FILDI_AGENT={who if who != '?' else '<you>'} python3 scripts/oj.py verify {e['id']}   # {e['question'][:70]}")
    return 0


def check() -> int:
    """Server-free registry integrity (runs in validate-workflow every session): any number without script evidence,
    self-verification, manifest mismatch, or a hand-edited REGISTRY.md fails."""
    reg = load_reg()
    errs = []
    for e in reg["patterns"]:
        m = e.get("measured")
        if e.get("verified_by") and m and e["verified_by"] == m.get("by"):
            errs.append(f"{e['id']}: verified by its own author")
        if e.get("verified_by") and (not m or not m.get("items_sha")):
            errs.append(f"{e['id']}: verified without an oj eval measurement")
        if m and m.get("items_sha"):
            f = EVALS / f"{e['id']}.json"
            if not f.exists():
                errs.append(f"{e['id']}: no manifest .agents/openjev/evals/{e['id']}.json")
            else:
                man = json.loads(f.read_text())
                for k in ("value", "items_sha", "answers_sha", "n"):
                    if man.get(k) != m.get(k):
                        errs.append(f"{e['id']}: registry {k} {m.get(k)} ≠ manifest {man.get(k)}")
        elif m and not m.get("evidence"):
            errs.append(f"{e['id']}: number without evidence")
        if m and m.get("question_sha") and m["question_sha"] != qsha(e):
            errs.append(f"{e['id']}: question/rule edited after it was measured → revert and add a new version (e.g. {e['id']}v2)")
        if e.get("verified_at") and (dt.date.today() - dt.date.fromisoformat(e["verified_at"])).days > 60:
            errs.append(f"{e['id']}: verification older than 60 days → re-verify")
    md = (FW / "REGISTRY.md").read_text()
    render(quiet=True)
    if (FW / "REGISTRY.md").read_text() != md:
        errs.append("REGISTRY.md was edited by hand or not re-rendered (now re-rendered — commit it)")
    print("\n".join(errs) if errs else f"ok: {len(reg['patterns'])} patterns consistent")
    return 1 if errs else 0


def main() -> int:
    sys.path.insert(0, str(ROOT / "scripts"))
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("ask")
    p.add_argument("--q", required=True)
    p.add_argument("--type", default="noul", choices=("noul", "choice", "score"))
    p.add_argument("--options")
    p.add_argument("--state-file")
    p.add_argument("--pattern")
    sp.add_parser("list")
    sp.add_parser("render")
    sp.add_parser("stop")
    sp.add_parser("audit")
    sp.add_parser("check")
    sp.add_parser("pending")
    p = sp.add_parser("analyze")
    p.add_argument("--spec", required=True)
    p.add_argument("--record", action="store_true")
    p = sp.add_parser("files")
    p.add_argument("--task", required=True)
    p.add_argument("--grep")
    p.add_argument("--top", type=int, default=8)
    p.add_argument("paths", nargs="*")
    p = sp.add_parser("run")
    p.add_argument("argv", nargs=argparse.REMAINDER)
    for name in ("studies", "dupes"):
        p = sp.add_parser(name)
        p.add_argument("text")
        p.add_argument("--top", type=int, default=5)
        p.add_argument("--oj", action="store_true")
    p = sp.add_parser("skill")
    p.add_argument("text")
    p = sp.add_parser("eval")
    p.add_argument("pid")
    p.add_argument("--build", action="store_true")
    p.add_argument("--limit", type=int)
    p.add_argument("--model")
    p.add_argument("--port", type=int)
    p.add_argument("--dry", action="store_true", help="print metrics, don't record (model comparisons)")
    p = sp.add_parser("verify")
    p.add_argument("pid", nargs="?")
    p.add_argument("--no-live", action="store_true")
    p = sp.add_parser("outcome")
    p.add_argument("uid")
    p.add_argument("right", choices=("yes", "no"))
    a = ap.parse_args()
    if a.cmd == "ask":
        return ask(a)
    if a.cmd == "list":
        print((FW / "REGISTRY.md").read_text())
    if a.cmd == "render":
        render()
    if a.cmd == "stop":
        stop()
    if a.cmd == "audit":
        audit()
    if a.cmd == "check":
        return check()
    if a.cmd == "pending":
        return pending()
    if a.cmd == "analyze":
        return cmd_analyze(a.spec, a.record)
    if a.cmd == "files":
        return cmd_files(a.task, a.paths, a.grep, a.top)
    if a.cmd == "run":
        return cmd_run([x for x in a.argv if x != "--"])
    if a.cmd == "studies":
        return cmd_studies(a.text, a.top)
    if a.cmd == "dupes":
        return cmd_dupes(a.text, a.top, a.oj)
    if a.cmd == "skill":
        return cmd_skill(a.text)
    if a.cmd == "eval":
        run_eval(a.pid, a.build, a.limit, a.model, a.port, a.dry)
    if a.cmd == "verify":
        return verify(a.pid, 0 if a.no_live else 0.2)
    if a.cmd == "outcome":
        outcome(a.uid, a.right)
    return 0


if __name__ == "__main__":
    sys.exit(main())
