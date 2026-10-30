"""All WRDS syncs in one process on one connection → one Duo approval (Jamie 10-29: "streamline", no retry loops).
Research-only data (academic license): feeds studies, never live scores.

Usage: .venv/bin/python run_batch.py [job ...]      default = all jobs below, in order
       .venv/bin/python run_batch.py --list
A rejected login stops the whole batch at once (no per-job reconnects); status → ~/.fildi/wrds-status.json.
"""
from __future__ import annotations

import importlib
import sys
import time

from _auth import connect

# (name, module, argv) — order: cheap reference data first, so a mid-batch failure still leaves the joins current
JOBS: list[tuple[str, str, list[str]]] = [
    ("gics", "sync_gics", []),
    ("ibes", "sync_ibes", ["--universe", "book"]),
    ("ibes_xeps", "sync_ibes_xeps", []),
    ("crsp", "sync_crsp", ["--universe", "book"]),
    ("finratio", "sync_finratio", []),
    ("cboe", "sync_cboe", []),
]


def main() -> int:
    if "--list" in sys.argv:
        print("\n".join(f"{n:10s} {m}.py {' '.join(a)}" for n, m, a in JOBS))
        return 0
    want = [a for a in sys.argv[1:] if not a.startswith("--")]
    jobs = [j for j in JOBS if not want or j[0] in want]
    try:
        db = connect()  # the one Duo push; every job's connect() returns this same session
    except RuntimeError as e:
        print(f"wrds batch: stopped before any job — {e}")
        return 2
    failed = 0
    for name, mod, argv in jobs:
        t0 = time.time()
        sys.argv = [f"{mod}.py", *argv]
        try:
            rc = importlib.import_module(mod).main()
            ok = rc in (None, 0)
        except SystemExit as e:
            ok = e.code in (None, 0)
        except Exception as e:  # one job's bug must not stop the rest; its line says why
            print(f"  {name}: error {str(e)[:160]}")
            ok = False
        failed += not ok
        print(f"wrds {name}: {'ok' if ok else 'FAILED'} ({time.time() - t0:.0f} s)")
    db.close(force=True)
    print(f"wrds batch: {len(jobs) - failed}/{len(jobs)} ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
