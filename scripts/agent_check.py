"""Explicit local check runner. No model, hooks, automatic retries or test skipping."""
import collections
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time


def fingerprint(paths):
    return {str(Path(p).resolve()): hashlib.sha256(Path(p).read_bytes()).hexdigest()
            for p in paths}


def summarize(path, limit=3500):
    """Keep early failures as well as the tail; full output remains on disk."""
    failures = []
    tail = collections.deque(maxlen=8)
    count = 0
    pattern = re.compile(r"error|fail|traceback|exception|not ok|assert|fatal", re.I)
    with open(path, errors="replace") as stream:
        for count, line in enumerate(stream, 1):
            text = f"{count}: {line.rstrip()[:400]}"
            tail.append(text)
            if len(failures) < 6 and pattern.search(line):
                failures.append(text)
    lines = list(dict.fromkeys(failures + list(tail)))
    return count, "\n".join(lines)[:limit]


def run(argv, inputs=(), timeout=120):
    if not argv or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("A command and positive timeout are required")
    before = fingerprint(inputs)  # Missing input fails before executing anything.
    directory = Path(tempfile.mkdtemp(prefix="fildi-check-"))
    log = directory / "output.log"
    started = time.monotonic()
    timed_out = False
    launch_error = None
    with log.open("wb") as output:
        try:
            process = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                code = 124
        except OSError as error:
            code = 127
            launch_error = type(error).__name__
    try:
        after = fingerprint(inputs)
    except OSError:
        after = None
    count, excerpt = summarize(log)
    receipt = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "cwd": os.getcwd(), "argv": argv, "exit_code": code,
        "timed_out": timed_out, "launch_error": launch_error,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "inputs_before": before, "inputs_after": after,
        "declared_inputs_unchanged": bool(before) and before == after,
        "log": str(log), "log_bytes": log.stat().st_size, "log_lines": count,
        "scope": "Declared files only; environment, services and dependency closure not verified. Never a skip authorization.",
    }
    receipt_path = directory / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"exit {code} · {count} lines · {receipt['log_bytes']} bytes"
          f" · timeout={timed_out} · declared inputs unchanged={receipt['declared_inputs_unchanged']}")
    if launch_error:
        print(f"Launch failed: {launch_error}")
    print(excerpt)
    print(f"Full log: {log}\nReceipt: {receipt_path}")
    return code if code >= 0 else 128 - code
