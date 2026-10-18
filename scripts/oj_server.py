"""Single OpenJev instance for every caller (Jamie 10-18: never two 21 GB models; agents share one, queued).

One port (8091), one launcher guarded by an exclusive file lock: the first caller loads the model while later callers wait on
the lock, then everyone reuses the same server. The server queues requests itself (max_inflight slots, 512 waiting, then 529 →
clients retry). One idle watchdog stops it 10 min after the last request from anyone (callers touch STAMP on every ask).
Used by scripts/oj.py (agents) and watchlist_sync/openjev_local.py (05:30 batch, studies) — the only home for start/stop.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("FILDI_OJ_PORT", "8091"))
LEGACY_PORTS = (8092,)   # pre-10-18 per-agent dev servers: reuse until they idle out, never load a second model
BASE = f"http://127.0.0.1:{PORT}"
LOGS = Path("/tmp/fildi-logs")
LOCK = LOGS / "openjev.lock"
PIDF = LOGS / "openjev-server.pid"
STAMP = LOGS / "openjev-last-request"
IDLE_S = 600
MIN_FREE_GB = 26.0
OJ_PY = Path(os.environ.get("FILDI_OJ_PY", ROOT / "research/openjev/.venv/bin/python"))
OJ_CWD = Path(os.environ.get("FILDI_OJ_CWD", ROOT / "research/openjev/src"))   # env overrides = tests only


def _health(port: int) -> bool:
    """Something is listening on the port. A TCP connect, not an HTTP reply: a busy server can take > 2 s to answer
    /health, and treating 'slow' as 'down' is how a second 21 GB model got spawned (10-18)."""
    import socket
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def up() -> bool:
    return _health(PORT)


def running_port() -> int | None:
    """The port of whatever OpenJev is already loaded (shared one first, then a legacy per-agent one)."""
    return next((p for p in (PORT, *LEGACY_PORTS) if _health(p)), None)


def touch() -> None:
    LOGS.mkdir(exist_ok=True)
    STAMP.touch()


def pid() -> int | None:
    try:
        p = int(PIDF.read_text())
        os.kill(p, 0)
        return p
    except (OSError, ValueError):
        return None


def free_ram_gb() -> float | None:
    vm = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    m = re.search(r"free percentage:\s*(\d+)", vm)
    return round(int(m.group(1)) / 100 * total / 2 ** 30, 1) if m and total else None


def ensure(cache_gb: float = 3.0, min_free: float = MIN_FREE_GB, who: str = "?", wait_s: int = 300) -> int | None:
    """Port of THE OpenJev server, starting it if nobody has. None = not enough RAM or failed (caller decides itself)."""
    if (rp := running_port()) is not None:
        touch()
        return rp
    LOGS.mkdir(exist_ok=True)
    with open(LOCK, "w") as lf:
        deadline = time.time() + wait_s
        while True:                      # wait for the lock: another caller may be loading the model right now
            try:
                fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if up():
                    touch()
                    return PORT
                if time.time() > deadline:
                    return None
                time.sleep(1)
        try:
            if up():                     # someone finished loading while we waited
                touch()
                return PORT
            free = free_ram_gb()
            if free is not None and free < min_free:
                print(f"openjev: only {free} GB free RAM (< {min_free}); not starting", file=sys.stderr)
                return None
            env = {**os.environ, "OPENJEV_BACKEND": "mlx", "OPENJEV_HOST": "127.0.0.1", "OPENJEV_PORT": str(PORT),
                   "OPENJEV_MLX_CACHE_LIMIT_GB": str(cache_gb), "OPENJEV_MLX_PROMPT_CACHE": "2", "OPENJEV_MLX_MAX_PROMPT": "8192",
                   "HF_HUB_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
            p = subprocess.Popen([str(OJ_PY), "-m", "openjev"], cwd=str(OJ_CWD), env=env,
                                 stdout=open(LOGS / "openjev-server.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
            PIDF.write_text(str(p.pid))
            touch()
            subprocess.Popen(["/bin/sh", "-c", f"while kill -0 {p.pid} 2>/dev/null; do sleep 30; "
                              f"if [ $(( $(date +%s) - $(stat -f %m {STAMP}) )) -gt {IDLE_S} ]; then kill -TERM -{p.pid} 2>/dev/null; fi; done"],
                             start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _event("start", f"model loading for {who}", who)
            t0 = time.time()
            while time.time() - t0 < wait_s:
                if p.poll() is not None:
                    print("openjev: server exited during load (see /tmp/fildi-logs/openjev-server.log)", file=sys.stderr)
                    return None
                if up():
                    return PORT
                time.sleep(2)
            return None
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def stop(who: str = "?") -> None:
    p = pid()
    if p:
        try:
            os.killpg(p, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        _event("stop", f"stopped by {who}", who)
    PIDF.unlink(missing_ok=True)


def _event(event: str, detail: str, caller: str | None = None) -> None:
    import datetime as dt
    try:
        t = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        row = {"t": t, "agent": "openjev", "event": event, "detail": detail[:120]}
        if caller and caller not in ("?", "openjev-batch"):
            row["caller"] = caller
        with (Path.home() / ".fildi/agent-events.jsonl").open("a") as f:
            f.write(json.dumps(row) + "\n")
    except OSError:
        pass
