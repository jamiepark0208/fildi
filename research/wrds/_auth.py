"""Load WRDS credentials from env / .env.local — never print password."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


def load_wrds_env() -> None:
    here = Path(__file__).resolve().parent
    root = here.parents[1]  # repo root (fildi/)
    for path in (here / ".env", root / ".env.local", root / ".env"):
        if path.is_file():
            load_dotenv(path, override=False)


class MeteredWrds:
    """Wrap wrds.Connection — each raw_sql counts as 1 api_usage call (source=wrds)."""

    def __init__(self, db: Any) -> None:
        self._db = db

    def raw_sql(self, *args: Any, **kwargs: Any) -> Any:
        from db import record_api_usage

        record_api_usage(1)
        return self._db.raw_sql(*args, **kwargs)

    def close(self, force: bool = False) -> None:
        # shared per process (connect()): a sync's own close() must not end the batch's one Duo-approved session
        if force:
            return self._db.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


STATUS = Path.home() / ".fildi" / "wrds-status.json"
_shared: Any = None  # one connection per process → one Duo approval per batch (run_batch.py)
AUTH_ERRORS = ("PAM authentication failed", "password authentication failed", "EOF when reading a line", "Duo")


def _status(ok: bool, msg: str) -> None:
    """Last connect result for agent_start (no network call there). Jamie 10-29: a broken WRDS login was never surfaced."""
    import json
    from datetime import datetime, timezone

    try:
        STATUS.parent.mkdir(parents=True, exist_ok=True)
        prev = json.loads(STATUS.read_text()) if STATUS.exists() else {}
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        STATUS.write_text(json.dumps({"ok": ok, "at": now, "msg": msg[:300],
                                      "last_ok": now if ok else prev.get("last_ok")}))
    except OSError:
        pass


def connect(retries: int = 2, backoff_sec: float = 2.0):
    """Open WRDS Postgres once per process (reused by every sync in run_batch.py).

    Does not prompt interactively. Prefer WRDS_USERNAME + WRDS_PASSWORD or ~/.pgpass.
    An auth/Duo rejection is NOT retried (10-29: 4 rejected tries while the Duo app was missing → account disabled);
    only network blips retry. Writes ~/.fildi/wrds-status.json either way.
    Returns MeteredWrds so Settings → API Monitor can see query counts.
    """
    import time

    import wrds

    global _shared
    if _shared is not None:
        return _shared
    # Unattended callers (monthly GICS in openjev_controls, agents) never try again after a failed login: each try could
    # be one more rejection toward a Duo lockout. Only a run with Jamie present (WRDS_ATTENDED=1) clears it.
    if os.environ.get("WRDS_ATTENDED") != "1" and STATUS.exists():
        import json

        try:
            last = json.loads(STATUS.read_text())
        except ValueError:
            last = {}
        if last.get("ok") is False:
            raise RuntimeError(f"WRDS skipped: last login failed {str(last.get('at'))[:16]} — Jamie runs "
                               "`WRDS_ATTENDED=1 .venv/bin/python run_batch.py` once with Duo at hand")
    load_wrds_env()
    user = os.environ.get("WRDS_USERNAME") or None
    password = os.environ.get("WRDS_PASSWORD") or None
    kwargs = {}
    if user:
        kwargs["wrds_username"] = user
    if password:
        kwargs["wrds_password"] = password

    last_err: Exception | None = None
    for attempt in range(1, max(1, retries) + 1):
        try:
            import builtins

            real_input = builtins.input
            builtins.input = lambda *a, **k: (_ for _ in ()).throw(EOFError("EOF when reading a line"))  # never prompt
            try:
                _shared = MeteredWrds(wrds.Connection(**kwargs))
            finally:
                builtins.input = real_input
            _status(True, "connected")
            return _shared
        except Exception as e:  # wrds raises various network/auth errors
            last_err = e
            if any(a in str(e) for a in AUTH_ERRORS) or attempt >= retries:
                break
            time.sleep(backoff_sec * attempt)
    assert last_err is not None
    auth = any(a in str(last_err) for a in AUTH_ERRORS)
    msg = ("WRDS login rejected — approve Duo / check the account at wrds-www.wharton.upenn.edu, then rerun once "
           "(not retried, to avoid a lockout)" if auth else f"WRDS unreachable (network): {str(last_err)[:120]}")
    _status(False, msg)
    raise RuntimeError(msg) from last_err
