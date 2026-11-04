"""DB connection and row helpers for build_plan."""
from __future__ import annotations

import os
import re
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
_SYNC = Path(__file__).resolve().parent.parent


def connect() -> psycopg.Connection:
    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.is_file():
            load_dotenv(p, override=False)
    return psycopg.connect(os.environ["DATABASE_URL"])


def ensure_schema(conn: psycopg.Connection) -> None:
    sql = re.sub(r"--[^\n]*", "", (_SYNC / "schema.sql").read_text())
    for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
        conn.execute(stmt)
    conn.commit()


def chk(name: str, ok: bool, detail: str, severity: str = "block") -> dict:
    return {"check": name, "pass": bool(ok), "severity": severity, "detail": detail}


def rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [c.name for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]
