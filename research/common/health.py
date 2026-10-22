#!/usr/bin/env python3
"""Unified research health (loop F) — both sync_state tables + LSEG desktop port.

Manual only. Does not call WRDS Cloud or open an LSEG session (no quota burn).
Exit 0 = usable caches; 1 = local DB down or critical missing schema; 2 = warn/stale.

Usage:
  cd research/common && python health.py
  python health.py --json
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / ".env.local", ROOT / ".env"):
    if p.is_file():
        load_dotenv(p, override=False)

LSEG_HOST = "127.0.0.1"
# Workspace writes the live port to .portInUse; SDK also tries 9000/9060. 9001 is common when 9000 is taken.
LSEG_PROXY_PORTS = (9000, 9001, 9060)
LSEG_PORT_FILES = (
    Path.home() / "Library/Application Support/Data API Proxy/.portInUse",
    Path.home() / "Library/Application Support/Eikon API proxy/.portInUse",
    Path.home() / "Library/Application Support/Eikon Scripting Proxy/.portInUse",
)
STALE_HOURS = {
    "ibes_statsum": 40 * 24,
    "ibes_surpsum": 40 * 24,
    "crsp_dsf": 45 * 24,
    "signals_daily": 36,
    "events": 36,
    "security_map_ids": 35 * 24,  # sync TTL 30d + grace (was 14d → false stale)
    "starmine_history": 90 * 24,
}


def _tcp(host: str, port: int, timeout: float = 0.8) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _port_in_use() -> int | None:
    for p in LSEG_PORT_FILES:
        try:
            raw = p.read_text().strip().split()[0]
            n = int(raw)
            if 0 < n < 65536:
                return n
        except (OSError, ValueError, IndexError):
            continue
    return None


def _probe_lseg_desktop(host: str = LSEG_HOST) -> tuple[bool, int | None]:
    """Match lseg-data DesktopSession discovery: .portInUse, then 9000/9001/9060."""
    from_file = _port_in_use()
    tried: list[int] = []
    if from_file is not None:
        tried.append(from_file)
    for port in LSEG_PROXY_PORTS:
        if port not in tried:
            tried.append(port)
    for port in tried:
        if _tcp(host, port):
            return True, port
    return False, from_file


def _age_status(dataset: str, last_ok) -> str:
    if last_ok is None:
        return "missing"
    if last_ok.tzinfo is None:
        last_ok = last_ok.replace(tzinfo=timezone.utc)
    age_h = (datetime.now(timezone.utc) - last_ok).total_seconds() / 3600
    max_h = STALE_HOURS.get(dataset, 7 * 24)
    if age_h > max_h * 2:
        return "down"
    if age_h > max_h:
        return "warn"
    return "ok"


def _load_state(conn, schema: str) -> list[dict]:
    rows = conn.execute(
        f"SELECT dataset, watermark, last_ok_at, last_rows FROM {schema}.sync_state ORDER BY dataset"
    ).fetchall()
    out = []
    for dataset, watermark, last_ok, last_rows in rows:
        out.append(
            {
                "dataset": dataset,
                "watermark": watermark,
                "last_ok_at": last_ok.isoformat() if last_ok else None,
                "last_rows": last_rows,
                "status": _age_status(dataset, last_ok),
            }
        )
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="WRDS + LSEG research ops health")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    url = os.environ.get("DATABASE_URL")
    report: dict = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "local_db": False,
        "wrds": {"schema": False, "datasets": []},
        "lseg": {
            "schema": False,
            "desktop_proxy": {"reachable": False, "host": LSEG_HOST, "port": None},
            "datasets": [],
        },
        "hints": [],
        "app_note": (
            "TradeDash scores use local Postgres caches only. "
            "Vendor down = no refresh; last snapshot still serves."
        ),
    }
    up, port = _probe_lseg_desktop()
    report["lseg"]["desktop_proxy"] = {
        "reachable": up,
        "host": LSEG_HOST,
        "port": port if port is not None else LSEG_PROXY_PORTS[0],
    }

    if not url:
        report["hints"].append("DATABASE_URL missing in .env.local")
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print("FAIL: DATABASE_URL missing")
        return 1

    try:
        with psycopg.connect(url) as conn:
            report["local_db"] = True
            for schema, key in (("wrds_research", "wrds"), ("lseg_research", "lseg")):
                exists = conn.execute(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = %s)",
                    (schema,),
                ).fetchone()[0]
                report[key]["schema"] = bool(exists)
                if exists:
                    report[key]["datasets"] = _load_state(conn, schema)
                else:
                    report["hints"].append(f"Apply research/{key.split('_')[0]}/schema.sql — {schema} missing")
    except Exception as e:
        report["hints"].append(f"Postgres: {e}")
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"FAIL: {e}")
        return 1

    if not report["lseg"]["desktop_proxy"]["reachable"]:
        report["hints"].append(
            "LSEG Workspace proxy not reachable (.portInUse then :9000/:9001/:9060) — "
            "open desktop app before sync_*.py. App UI still shows last lseg_research rows."
        )

    for ds in report["wrds"]["datasets"]:
        if ds["status"] in ("warn", "down", "missing"):
            report["hints"].append(f"WRDS {ds['dataset']}: {ds['status']} — python research/wrds/sync_ibes.py (etc)")
            break
    for ds in report["lseg"]["datasets"]:
        if ds["status"] in ("warn", "down", "missing"):
            report["hints"].append(f"LSEG {ds['dataset']}: {ds['status']} — need Workspace + sync script")
            break

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        desk = "UP" if report["lseg"]["desktop_proxy"]["reachable"] else "DOWN"
        print(f"local_db={'ok' if report['local_db'] else 'FAIL'}  LSEG_desktop={desk}")
        for lane in ("wrds", "lseg"):
            print(f"\n[{lane}] schema={report[lane]['schema']}")
            for d in report[lane]["datasets"]:
                print(f"  {d['status']:7} {d['dataset']:20} last_ok={d['last_ok_at']} rows={d['last_rows']}")
        if report["hints"]:
            print("\nhints:")
            for h in report["hints"]:
                print(f"  - {h}")
        print(f"\n{report['app_note']}")

    statuses = [d["status"] for lane in ("wrds", "lseg") for d in report[lane]["datasets"]]
    if not report["wrds"]["schema"] and not report["lseg"]["schema"]:
        return 1
    if any(s == "down" for s in statuses) or not report["lseg"]["desktop_proxy"]["reachable"]:
        return 2
    if any(s in ("warn", "missing") for s in statuses):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
