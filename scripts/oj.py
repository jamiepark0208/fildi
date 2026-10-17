#!/usr/bin/env python3
"""oj — OpenJev for every agent (framework: .agents/openjev/README.md). Local DiffusionGemma 26B, $0, typed answers.

    scripts/oj.py ask  --q "Is this file relevant to: fix stale prices?" [--pattern P10] [--state-file F | stdin]
                       [--type noul|choice|score] [--options '{"a":"…"}' | '["low","mid","high"]']
    scripts/oj.py list                       # registry: which question patterns are proven / rejected (+ confidence)
    scripts/oj.py eval P10 [--build] [--limit N]   # run a pattern's labelled eval set → evidence + metrics (only way numbers enter)
    scripts/oj.py verify [P10]               # recompute every registry number from stored answers; re-ask a 20 % sample live
    scripts/oj.py outcome <usage_id> yes|no  # after you checked anyway: was OpenJev right? (feeds live accuracy / demotion)
    scripts/oj.py audit                      # live accuracy per pattern from outcomes; demotes drifting patterns
    scripts/oj.py render                     # registry.json → REGISTRY.md (generated; never edit the .md by hand)
    scripts/oj.py stop                       # stop the dev server now (else it stops itself after 10 idle minutes)

Server: dev server on 127.0.0.1:8092, started on demand (needs ≥ 26 GB free RAM; ~15 s load), idle shutdown 10 min.
If the 05:30 batch server (8091) is up, asks go there instead. Unavailable → exit 3: decide yourself, never block on OpenJev.
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
DEV_PORT, BATCH_PORT, IDLE_S, MIN_FREE_GB = 8092, 8091, 600, 26.0
OJ_PY = ROOT / "research/openjev/.venv/bin/python"
STAMP = Path("/tmp/fildi-logs/oj-dev-last-ask")
MODEL = "openjev-latest"


# ---------- server ---------------------------------------------------------------------------------------------

def _up(port: int) -> bool:
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2)
        return True
    except Exception:
        return False


def free_ram_gb() -> float | None:
    vm = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    import re
    m = re.search(r"free percentage:\s*(\d+)", vm)
    return round(int(m.group(1)) / 100 * total / 2 ** 30, 1) if m and total else None


def ensure_server() -> int | None:
    """Port of a running OpenJev server, starting the dev one if RAM allows. None = unavailable (caller decides itself)."""
    if _up(BATCH_PORT):
        return BATCH_PORT
    if _up(DEV_PORT):
        return DEV_PORT
    free = free_ram_gb()
    if free is not None and free < MIN_FREE_GB:
        print(f"oj: only {free} GB free RAM (< {MIN_FREE_GB}); not starting OpenJev", file=sys.stderr)
        return None
    os.makedirs("/tmp/fildi-logs", exist_ok=True)
    env = {**os.environ, "OPENJEV_BACKEND": "mlx", "OPENJEV_HOST": "127.0.0.1", "OPENJEV_PORT": str(DEV_PORT),
           "OPENJEV_MLX_CACHE_LIMIT_GB": "2", "OPENJEV_MLX_PROMPT_CACHE": "2", "OPENJEV_MLX_MAX_PROMPT": "8192",
           "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
    p = subprocess.Popen([str(OJ_PY), "-m", "openjev"], cwd=str(ROOT / "research/openjev/src"), env=env,
                         stdout=open("/tmp/fildi-logs/oj-dev-server.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
    Path("/tmp/fildi-logs/oj-dev-server.pid").write_text(str(p.pid))
    # idle watchdog: a detached shell loop that kills the dev server after IDLE_S without asks
    STAMP.touch()
    subprocess.Popen(["/bin/sh", "-c", f"while kill -0 {p.pid} 2>/dev/null; do sleep 30; "
                      f"if [ $(( $(date +%s) - $(stat -f %m {STAMP}) )) -gt {IDLE_S} ]; then kill -TERM -{p.pid} 2>/dev/null; fi; done"],
                     start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        if p.poll() is not None:
            print("oj: server exited during load (see /tmp/fildi-logs/oj-dev-server.log)", file=sys.stderr)
            return None
        if _up(DEV_PORT):
            return DEV_PORT
        time.sleep(2)
    return None


def stop() -> None:
    f = Path("/tmp/fildi-logs/oj-dev-server.pid")
    if f.exists():
        try:
            os.killpg(int(f.read_text()), 15)
        except (ProcessLookupError, ValueError, PermissionError):
            pass
        f.unlink()


def post(port: int, state: str, questions: dict, **extra) -> dict:
    STAMP.touch()
    body = json.dumps({"model": MODEL, "state": state, "questions": questions, **extra}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/systemone", data=body, method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())


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
    m = e.get("measured")
    if not m:
        return "C"
    lo, hi, tgt = m.get("lo"), m.get("hi"), e["rule"]["target"]
    if hi is not None and hi < tgt:
        return "X"
    if lo is not None and lo >= tgt and e.get("verified_by") and e["verified_by"] != m.get("by"):
        return "A"
    return "B"


def render() -> None:
    reg = load_reg()
    out = ["# OpenJev question registry (GENERATED by `scripts/oj.py render` from registry.json — do not edit by hand)", "",
           "Tier: **A** proven (lower bound ≥ target, re-checked by a 2nd agent) · **B** promising (not yet proven) · **C** untested idea · "
           "**X** rejected (upper bound < target). Numbers come only from `oj.py eval` or a cited study; `oj.py verify` recomputes them.", "",
           "| Tier | ID | Ask OpenJev… | Use | Pass rule | Measured (90 % CI) | n | Evidence | By / verified |", "|---|---|---|---|---|---|---|---|---|"]
    order = {"A": 0, "B": 1, "C": 2, "X": 3}
    for e in sorted(reg["patterns"], key=lambda e: (order[tier(e)], e["id"])):
        m = e.get("measured") or {}
        g = lambda x: "?" if x is None else f"{x:.3g}"
        meas = f"{g(m['value'])} [{g(m.get('lo'))}, {g(m.get('hi'))}]" if m else "—"
        out.append(f"| {tier(e)} | {e['id']} | {e['question']} | {e['use']} | {e['rule']['metric']} ≥ {e['rule']['target']} "
                   f"({e['rule'].get('baseline', 'no baseline')}) | {meas} | {m.get('n', '—')} | {m.get('evidence', '—')} | "
                   f"{m.get('by', e.get('created_by', '?'))} / {e.get('verified_by') or '—'} |")
    (FW / "REGISTRY.md").write_text("\n".join(out) + "\n")
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


def run_eval(pid: str, build: bool, limit: int | None) -> None:
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
    port = ensure_server()
    if port is None:
        sys.exit("oj eval: OpenJev unavailable (RAM)")
    with ans_f.open("w") as w:
        for x in items:
            r = post(port, x["state"], {"q": x["question"]})["answers"]["q"]
            w.write(json.dumps({"id": x["id"], "answer": r}) + "\n")
    m = oj_evals.score(pid, items, [json.loads(x) for x in ans_f.open()], e)
    m.update({"by": os.environ.get("FILDI_AGENT", "?"), "at": dt.date.today().isoformat(), "model": MODEL,
              "items_sha": sha(items_f), "answers_sha": sha(ans_f), "evidence": f"oj eval {pid}"})
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
    p = sp.add_parser("eval")
    p.add_argument("pid")
    p.add_argument("--build", action="store_true")
    p.add_argument("--limit", type=int)
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
    if a.cmd == "eval":
        run_eval(a.pid, a.build, a.limit)
    if a.cmd == "verify":
        return verify(a.pid, 0 if a.no_live else 0.2)
    if a.cmd == "outcome":
        outcome(a.uid, a.right)
    return 0


if __name__ == "__main__":
    sys.exit(main())
