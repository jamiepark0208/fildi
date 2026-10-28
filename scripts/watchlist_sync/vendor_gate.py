"""One vendor budget for every process on the Mac (A303, runtime audit 10-28) — Python side of
artifacts/api-server/src/lib/vendor-gate.ts. Same files, same protocol, same gaps:

  /tmp/fildi-logs/gate/<Vendor>.slot   next free time (epoch ms) reserved by ANY process
  /tmp/fildi-logs/gate/<Vendor>.lock   exclusive-create mutex, held for microseconds; > 2 s old = dead holder → removed

`wait(vendor)` reserves slot = max(now, last + gap) under the lock, releases it, then sleeps outside it.
Gaps mirror http-client.ts VENDOR_POLICY.crossGapMs — change both together. Polygon has its own gate (polygon_gate.py).
"""
from __future__ import annotations

import os
import random
import time
from pathlib import Path

GATE_DIR = Path(os.environ.get("FILDI_GATE_DIR", "/tmp/fildi-logs/gate"))
GAP_MS = {"Finnhub": 1100, "FMP": 130, "EDGAR": 115}
STALE_LOCK_S = 2.0


def wait(vendor: str) -> None:
    gap = GAP_MS.get(vendor)
    if not gap:
        return
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    lock, slot_file = GATE_DIR / f"{vendor}.lock", GATE_DIR / f"{vendor}.slot"
    deadline = time.time() + 10
    while True:
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > STALE_LOCK_S:
                    lock.unlink()
            except FileNotFoundError:
                pass
            if time.time() > deadline:
                raise TimeoutError(f"vendor gate {vendor}: lock timeout")
            time.sleep(0.005 + random.random() * 0.01)
    try:
        try:
            last = float(slot_file.read_text().strip() or 0)
        except (FileNotFoundError, ValueError):
            last = 0.0
        now = time.time() * 1000
        slot = max(now, last + gap)
        slot_file.write_text(str(int(slot)))
    finally:
        try:
            lock.unlink()
        except FileNotFoundError:
            pass
    pause = (slot - time.time() * 1000) / 1000
    if pause > 0:
        time.sleep(pause)
