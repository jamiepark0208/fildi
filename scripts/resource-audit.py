#!/usr/bin/env python3
"""Mac resource audit for fildi (Jamie 2026-10-16: "monitor RAM + storage, find ways to optimize").

Weekly snapshot (Maintain, Sunday) of disk / RAM / iCloud / growth → watchlist_sync.resource_snapshots,
~/.fildi/resource-latest.json (API reads it) and .agents/context/resource-report.md (caveman report).
Read-only outside fildi; --prune only trims fildi's own logs (/tmp/fildi-logs, ~/.fildi/agent-events.jsonl, logs/).

    python3 scripts/resource-audit.py            # snapshot + report
    python3 scripts/resource-audit.py --prune    # + trim fildi logs (30 d / 50 MB)
    python3 scripts/resource-audit.py --guard    # exit 0 only if safe to load a big local model
Stdlib only.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOME = Path.home()
DB = os.environ.get("RESOURCE_AUDIT_DB", "postgresql://127.0.0.1:5432/tradedash")
LATEST = HOME / ".fildi" / "resource-latest.json"
REPORT = ROOT / ".agents" / "context" / "resource-report.md"
KEEP_DAYS = 30
CAP_MB = 50

# Guard thresholds (OpenJev batch calls resource_guard() before loading the model).
GUARD_MIN_FREE_PCT = 50
GUARD_MAX_SWAP_GB = 6.0


def sh(cmd: list[str], timeout: int = 120) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def du_mb(p: Path) -> float | None:
    if not p.exists():
        return None
    out = sh(["du", "-sk", str(p)], timeout=300).split()
    return round(int(out[0]) / 1024, 1) if out and out[0].isdigit() else None


# ---------- RAM ---------------------------------------------------------------------------------
def mem_free_pct() -> float | None:
    m = re.search(r"free percentage:\s*(\d+)%", sh(["memory_pressure", "-Q"], timeout=20))
    return float(m.group(1)) if m else None


def swap_used_gb() -> float | None:
    m = re.search(r"used\s*=\s*([\d.]+)M", sh(["sysctl", "-n", "vm.swapusage"]))
    return round(float(m.group(1)) / 1024, 2) if m else None


def on_ac_power() -> bool | None:
    out = sh(["pmset", "-g", "batt"])
    if not out:
        return None
    return "AC Power" in out


def top_procs(n: int = 8) -> list[dict]:
    rows = []
    for line in sh(["ps", "-axo", "rss=,comm="]).splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            rows.append((int(parts[0]), parts[1]))
    agg: dict[str, int] = {}
    for rss, comm in rows:  # group helpers by app name (Chrome/Cursor spawn many)
        name = comm.split("/")[-1]
        app = re.search(r"/([^/]+)\.app/", comm)
        key = app.group(1) if app else name
        agg[key] = agg.get(key, 0) + rss
    top = sorted(agg.items(), key=lambda kv: -kv[1])[:n]
    return [{"name": k, "gb": round(v / 1048576, 2)} for k, v in top]


def resource_guard() -> tuple[bool, str]:
    """ok only if RAM free ≥ 50 %, swap < 6 GB and on AC power."""
    free, swap, ac = mem_free_pct(), swap_used_gb(), on_ac_power()
    why = []
    if free is None or free < GUARD_MIN_FREE_PCT:
        why.append(f"RAM free {free}% < {GUARD_MIN_FREE_PCT}%")
    if swap is None or swap >= GUARD_MAX_SWAP_GB:
        why.append(f"swap {swap} GB ≥ {GUARD_MAX_SWAP_GB}")
    if ac is False:
        why.append("on battery")
    return (not why, "; ".join(why) or f"ok (RAM free {free}%, swap {swap} GB, AC)")


# ---------- disk --------------------------------------------------------------------------------
def disk_volume() -> dict:
    out = sh(["df", "-k", "/System/Volumes/Data"]).splitlines()
    if len(out) < 2:
        return {}
    f = out[1].split()
    return {"total_gb": round(int(f[1]) / 1048576, 1), "used_gb": round(int(f[2]) / 1048576, 1),
            "free_gb": round(int(f[3]) / 1048576, 1)}


def fildi_parts() -> dict:
    parts = {
        "repo": ROOT, ".git": ROOT / ".git", "node_modules": ROOT / "node_modules",
        "watchlist_sync/out": ROOT / "scripts/watchlist_sync/out", "logs": ROOT / "logs",
        "venv watchlist_sync": ROOT / "scripts/watchlist_sync/.venv",
        "venv lseg": ROOT / "research/lseg/.venv", "venv wrds": ROOT / "research/wrds/.venv",
        "venv crawl": ROOT / "research/crawl/.venv",
    }
    res = ROOT / "research"
    if res.exists():
        for d in sorted(res.iterdir()):
            if d.is_dir():
                parts[f"research/{d.name}"] = d
    return {k: du_mb(p) for k, p in parts.items()}


def outside_parts() -> dict:
    paths = {
        "~/.fildi": HOME / ".fildi", "/tmp/fildi-logs": Path("/tmp/fildi-logs"),
        "huggingface cache": HOME / ".cache/huggingface", "ms-playwright": HOME / "Library/Caches/ms-playwright",
        "pip cache": HOME / "Library/Caches/pip", "pnpm cache": HOME / "Library/Caches/pnpm",
        "Cursor updater cache (ShipIt)": HOME / "Library/Caches/com.todesktop.230313mzl4w4u92.ShipIt",
        "iCloud Drive local (Mobile Documents)": HOME / "Library/Mobile Documents",
    }
    return {k: du_mb(p) for k, p in paths.items()}


def library_caches_top(n: int = 8) -> list[dict]:
    base = HOME / "Library/Caches"
    if not base.exists():
        return []
    rows = []
    for d in base.iterdir():
        mb = du_mb(d)
        if mb:
            rows.append({"name": d.name, "mb": mb})
    return sorted(rows, key=lambda r: -r["mb"])[:n]


def psql(q: str) -> str:
    return sh(["psql", DB, "-Atc", q], timeout=60)


def db_sizes() -> dict:
    total = psql("select pg_database_size(current_database())").strip()
    rows = psql("""select n.nspname||'.'||c.relname, pg_total_relation_size(c.oid), c.reltuples::bigint
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r'
      order by 2 desc limit 15""")
    tables = []
    for line in rows.splitlines():
        p = line.split("|")
        if len(p) == 3:
            tables.append({"name": p[0], "mb": round(int(p[1]) / 1048576, 1), "rows": int(float(p[2]))})
    return {"total_mb": round(int(total) / 1048576, 1) if total.isdigit() else None, "tables": tables}


# ---------- iCloud ------------------------------------------------------------------------------
def icloud() -> dict:
    cd = HOME / "Library/Mobile Documents/com~apple~CloudDocs"
    opt = sh(["defaults", "read", str(HOME / "Library/Preferences/com.apple.bird"), "optimize-storage"]).strip()
    fildi_real = str(ROOT.resolve())
    return {
        "desktop_synced": (cd / "Desktop").exists(),
        "documents_synced": (cd / "Documents").exists(),
        "optimize_storage": opt == "1",
        "fildi_in_icloud": "Mobile Documents" in fildi_real or fildi_real.startswith(str(HOME / "Desktop"))
        or fildi_real.startswith(str(HOME / "Documents")),
        "fildi_path": fildi_real,
    }


# ---------- growth ------------------------------------------------------------------------------
def flat(snap: dict) -> dict[str, float]:
    out: dict[str, float] = {}
    for k, v in (snap.get("fildi") or {}).items():
        if isinstance(v, (int, float)):
            out[f"fildi:{k}"] = v
    for k, v in (snap.get("outside") or {}).items():
        if isinstance(v, (int, float)):
            out[f"mac:{k}"] = v
    for t in (snap.get("db") or {}).get("tables", []):
        out[f"db:{t['name']}"] = t["mb"]
    db_total = (snap.get("db") or {}).get("total_mb")
    if db_total:
        out["db:total"] = db_total
    for k, v in (snap.get("files") or {}).items():
        out[f"file:{k}"] = v
    return out


def growth(cur: dict, prev: dict | None) -> list[dict]:
    if not prev:
        return []
    days = max((cur["ts_epoch"] - prev.get("ts_epoch", cur["ts_epoch"])) / 86400, 1e-6)
    if days < 0.5:
        return []
    a, b = flat(prev), flat(cur)
    rows = []
    for k, v in b.items():
        if k in a:
            per_day = (v - a[k]) / days
            if abs(per_day) >= 0.5:
                rows.append({"item": k, "mb_now": v, "mb_per_day": round(per_day, 2),
                             "mb_in_1y": round(v + per_day * 365, 0)})
    return sorted(rows, key=lambda r: -r["mb_per_day"])


def unbounded_files() -> dict:
    """Append-only files fildi writes (MB)."""
    files = {
        "agent-events.jsonl": HOME / ".fildi/agent-events.jsonl",
        "out/*.md count": None,
    }
    res: dict[str, float] = {}
    for k, p in files.items():
        if p and p.exists():
            res[k] = round(p.stat().st_size / 1048576, 2)
    out = ROOT / "scripts/watchlist_sync/out"
    if out.exists():
        res["out/*.md count"] = float(sum(1 for _ in out.rglob("*.md")))
    return res


# ---------- prune (fildi's own logs only) -------------------------------------------------------
def prune() -> list[str]:
    done = []
    cutoff = time.time() - KEEP_DAYS * 86400
    for d in (Path("/tmp/fildi-logs"), ROOT / "logs"):
        if not d.exists():
            continue
        freed = 0
        for f in d.rglob("*"):
            if f.is_file() and f.suffix in {".log", ".txt", ".out", ".err", ".jsonl"} and f.stat().st_mtime < cutoff:
                freed += f.stat().st_size
                f.unlink()
        for f in d.rglob("*"):  # cap any single live log at CAP_MB (keep the tail)
            if f.is_file() and f.suffix in {".log", ".out", ".err"} and f.stat().st_size > CAP_MB * 1048576:
                data = f.read_bytes()[-CAP_MB * 1048576 // 2:]
                freed += f.stat().st_size - len(data)
                f.write_bytes(data)
        if freed:
            done.append(f"{d}: freed {freed / 1048576:.1f} MB")
    ev = HOME / ".fildi/agent-events.jsonl"
    if ev.exists():
        keep, before = [], ev.stat().st_size
        cut_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat()
        for line in ev.read_text(errors="ignore").splitlines():
            m = re.search(r'"t"\s*:\s*"([^"]+)"', line)
            if not m or m.group(1) >= cut_iso[:len(m.group(1))]:
                keep.append(line)
        body = "\n".join(keep) + ("\n" if keep else "")
        if len(body.encode()) > CAP_MB * 1048576:
            body = body.encode()[-CAP_MB * 1048576 // 2:].decode(errors="ignore")
            body = body[body.find("\n") + 1:]
        if len(body.encode()) < before:
            tmp = ev.with_suffix(".jsonl.tmp")
            tmp.write_text(body)
            tmp.replace(ev)
            done.append(f"agent-events.jsonl: {before / 1048576:.1f} → {len(body.encode()) / 1048576:.1f} MB")
    return done


# ---------- findings ----------------------------------------------------------------------------
def findings(s: dict) -> list[str]:
    f: list[str] = []
    ram, ic, fl, out = s["ram"], s["icloud"], s["fildi"], s["outside"]
    if ram.get("swap_gb") and ram["swap_gb"] >= 2:
        hogs = ", ".join(f"{p['name']} {p['gb']} GB" for p in ram["top"][:3])
        f.append(f"RAM: swap {ram['swap_gb']} GB used (free {ram['free_pct']}%) — top: {hogs}. [ask-Jamie] close/limit heavy apps before local model runs")
    else:
        f.append(f"RAM: free {ram.get('free_pct')}%, swap {ram.get('swap_gb')} GB — fine")
    if ic["fildi_in_icloud"]:
        f.append(f"iCloud: fildi lives in a synced folder ({ic['fildi_path']}) → move out [ask-Jamie]")
    else:
        f.append("iCloud: fildi not in a synced folder (good); DB, venvs, model weights never sync")
    if ic["desktop_synced"] or ic["documents_synced"]:
        f.append("iCloud: Desktop/Documents sync ON — keep model weights/exports out of them [ask-Jamie if large files land there]")
    sc = out.get("Cursor updater cache (ShipIt)")
    if sc and sc > 300:
        f.append(f"Cursor updater cache {sc:.0f} MB — old update bundles, safe to clear when Cursor is closed [ask-Jamie] (~{sc:.0f} MB)")
    for name in ("pip cache", "pnpm cache"):
        v = out.get(name)
        if v and v > 200:
            f.append(f"{name} {v:.0f} MB — `{'pip cache purge' if 'pip' in name else 'pnpm store prune'}` frees most [safe, ask-Jamie]")
    big_caches = [c for c in s["library_caches"] if c["mb"] > 1000]
    for c in big_caches:
        f.append(f"~/Library/Caches/{c['name']} {c['mb'] / 1024:.1f} GB (browser cache; app manages it) [info]")
    lab = sum(t["mb"] for t in s["db"]["tables"] if t["name"].startswith("watchlist_sync.lab_"))
    if lab:
        f.append(f"DB {s['db']['total_mb']:.0f} MB, research lab tables {lab:.0f} MB — research-only, keep local, exclude from server dumps [info]")
    nm = fl.get("node_modules")
    if nm:
        f.append(f"node_modules {nm:.0f} MB — normal; rebuildable [info]")
    for g in s["growth"][:5]:
        if g["mb_per_day"] >= 1:
            f.append(f"growth: {g['item']} +{g['mb_per_day']} MB/day → ~{g['mb_in_1y']:.0f} MB in 1 y")
    if not s["growth"]:
        f.append("growth: first snapshot — MB/day appears from next weekly run")
    return f


def write_report(s: dict) -> None:
    d = s["disk"]
    fildi_total = s["fildi"].get("repo") or 0
    lines = [
        f"# Mac resource report — {s['ts'][:16]}Z (scripts/resource-audit.py, weekly via Maintain Sunday)",
        "",
        f"Disk: {d.get('free_gb')} GB free of {d.get('total_gb')} · fildi repo {fildi_total / 1024:.1f} GB · DB {s['db']['total_mb']:.0f} MB · RAM free {s['ram'].get('free_pct')}% · swap {s['ram'].get('swap_gb')} GB",
        "",
        "## Findings",
        *[f"- {x}" for x in s["findings"]],
        "",
        "## Biggest fildi parts (MB)",
        *[f"- {k}: {v:.0f}" for k, v in sorted(((k, v) for k, v in s["fildi"].items() if v and k != "repo"), key=lambda kv: -kv[1])[:8]],
    ]
    if s.get("pruned"):
        lines += ["", "## Pruned this run", *[f"- {x}" for x in s["pruned"]]]
    REPORT.write_text("\n".join(lines[:40]) + "\n")


def store(s: dict) -> dict | None:
    psql("create table if not exists watchlist_sync.resource_snapshots (id serial primary key, ts timestamptz not null default now(), snap jsonb not null)")
    prev_raw = psql("select snap from watchlist_sync.resource_snapshots order by ts desc limit 1").strip()
    prev = json.loads(prev_raw) if prev_raw else None
    return prev


def main() -> int:
    if "--guard" in sys.argv:
        ok, why = resource_guard()
        print(why)
        return 0 if ok else 1
    pruned = prune() if "--prune" in sys.argv else []
    now = datetime.now(timezone.utc)
    snap: dict = {
        "ts": now.isoformat(), "ts_epoch": now.timestamp(), "disk": disk_volume(),
        "fildi": fildi_parts(), "outside": outside_parts(), "library_caches": library_caches_top(),
        "db": db_sizes(), "files": unbounded_files(),
        "ram": {"free_pct": mem_free_pct(), "swap_gb": swap_used_gb(), "ac_power": on_ac_power(), "top": top_procs()},
        "icloud": icloud(), "pruned": pruned,
    }
    prev = store(snap)
    snap["growth"] = growth(snap, prev)
    snap["findings"] = findings(snap)
    body = json.dumps(snap).replace("$snap$", "")
    psql(f"insert into watchlist_sync.resource_snapshots (snap) values ($snap${body}$snap$::jsonb)")
    LATEST.parent.mkdir(parents=True, exist_ok=True)
    LATEST.write_text(json.dumps(snap, indent=1))
    write_report(snap)
    print(f"resource-audit: disk {snap['disk'].get('free_gb')} GB free · RAM free {snap['ram']['free_pct']}% · "
          f"{len(snap['findings'])} findings → {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
