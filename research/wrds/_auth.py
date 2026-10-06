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

    def close(self) -> None:
        return self._db.close()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._db, name)


def connect(retries: int = 3, backoff_sec: float = 2.0):
    """Open WRDS Postgres with simple reconnect (Duo/network blips).

    Does not prompt interactively. Prefer WRDS_USERNAME + WRDS_PASSWORD or ~/.pgpass.
    Retries only connection establishment — not query failures mid-sync.
    Returns MeteredWrds so Settings → API Monitor can see query counts.
    """
    import time

    import wrds

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
            return MeteredWrds(wrds.Connection(**kwargs))
        except Exception as e:  # wrds raises various network/auth errors
            last_err = e
            if attempt >= retries:
                break
            time.sleep(backoff_sec * attempt)
    assert last_err is not None
    raise RuntimeError(
        f"WRDS connect failed after {retries} attempts — check network/Duo, "
        "WRDS_USERNAME/PASSWORD or ~/.pgpass, then retry sync. Last error: "
        f"{last_err}"
    ) from last_err
