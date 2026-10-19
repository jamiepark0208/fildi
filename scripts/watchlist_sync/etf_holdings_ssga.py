#!/usr/bin/env python3
"""A98 P3 — SSGA daily holdings → watchlist_sync.etf_holdings (monthly cadence OK).

Source: https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-<tkr>.xlsx

Usage:
  python3 scripts/watchlist_sync/etf_holdings_ssga.py
  python3 scripts/watchlist_sync/etf_holdings_ssga.py XLK XLF --dry-run
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable
from urllib.request import Request, urlopen

from etf_flows_ssga import DEFAULT_ETFS, SECTOR_SPDRS, parse_ssga_date

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
HOLDINGS_URL = (
    "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-{tkr}.xlsx"
)
COL_RE = re.compile(r"([A-Z]+)(\d+)")


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    out: list[str] = []
    for si in root.findall("m:si", NS):
        texts = [t.text or "" for t in si.iter("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")]
        out.append("".join(texts))
    return out


def _cell_val(c: ET.Element, ss: list[str]) -> str | None:
    v = c.find("m:v", NS)
    if v is None or v.text is None:
        return None
    if c.attrib.get("t") == "s":
        return ss[int(v.text)]
    return v.text


def parse_holdings_xlsx(data: bytes) -> tuple[str | None, list[tuple[str, float, float | None, str]]]:
    """→ (as_of YYYY-MM-DD, [(ticker, weight_pct, shares, name), ...])."""
    z = zipfile.ZipFile(io.BytesIO(data))
    ss = _shared_strings(z)
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    by_row: dict[int, dict[str, str | None]] = {}
    for c in sheet.findall("m:sheetData/m:row/m:c", NS):
        ref = c.attrib.get("r")
        if not ref:
            continue
        m = COL_RE.match(ref)
        if not m:
            continue
        col, row = m.group(1), int(m.group(2))
        by_row.setdefault(row, {})[col] = _cell_val(c, ss)

    as_of: str | None = None
    for d in by_row.values():
        for v in d.values():
            if isinstance(v, str) and v.startswith("As of "):
                as_of = parse_ssga_date(v.replace("As of ", "").strip())
                break
        if as_of:
            break

    header_row = None
    for r, d in by_row.items():
        if d.get("B") == "Ticker" and d.get("E") == "Weight":
            header_row = r
            break
    if header_row is None:
        return as_of, []

    out: list[tuple[str, float, float | None, str]] = []
    for r in sorted(k for k in by_row if k > header_row):
        d = by_row[r]
        tkr = (d.get("B") or "").strip().upper()
        if not tkr or tkr == "TICKER" or len(tkr) > 8:
            continue
        try:
            w = float(d.get("E") or "")
        except (TypeError, ValueError):
            continue
        if w <= 0:
            continue
        try:
            shares: float | None = float(d.get("G") or "")
        except (TypeError, ValueError):
            shares = None
        name = (d.get("A") or "").strip()
        out.append((tkr, w, shares, name))
    return as_of, out


def fetch_holdings(ticker: str) -> bytes:
    url = HOLDINGS_URL.format(tkr=ticker.lower())
    req = Request(url, headers={"User-Agent": "fildi-etf-holdings/1.0"})
    with urlopen(req, timeout=60) as resp:
        return resp.read()


def ensure_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_sync.etf_holdings (
          etf text NOT NULL,
          as_of date NOT NULL,
          ticker text NOT NULL,
          weight_pct double precision NOT NULL,
          shares double precision,
          name text,
          source text NOT NULL DEFAULT 'ssga-holdings',
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (etf, as_of, ticker)
        )
        """)
        cur.execute(
            "CREATE INDEX IF NOT EXISTS etf_holdings_ticker_idx "
            "ON watchlist_sync.etf_holdings (ticker, as_of DESC)"
        )
    conn.commit()


def upsert(conn, etf: str, as_of: str, rows: Iterable[tuple[str, float, float | None, str]]) -> int:
    n = 0
    with conn.cursor() as cur:
        for tkr, w, shares, name in rows:
            cur.execute(
                """
                INSERT INTO watchlist_sync.etf_holdings
                  (etf, as_of, ticker, weight_pct, shares, name, source, updated_at)
                VALUES (%s, %s::date, %s, %s, %s, %s, 'ssga-holdings', now())
                ON CONFLICT (etf, as_of, ticker) DO UPDATE SET
                  weight_pct = EXCLUDED.weight_pct,
                  shares = EXCLUDED.shares,
                  name = EXCLUDED.name,
                  updated_at = now()
                """,
                (etf.upper(), as_of, tkr, w, shares, name or None),
            )
            n += 1
    conn.commit()
    return n


def _load_database_url() -> str | None:
    root = Path(__file__).resolve().parents[2]
    for name in (".env.local", ".env"):
        envp = root / name
        if not envp.exists():
            continue
        for line in envp.read_text().splitlines():
            if line.startswith("DATABASE_URL=") and "DATABASE_URL" not in os.environ:
                os.environ["DATABASE_URL"] = line.split("=", 1)[1].strip().strip("\"'")
    return os.environ.get("DATABASE_URL")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("tickers", nargs="*", help="ETF tickers (default: sector+theme SPDRs)")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--sector-only", action="store_true", help="11 sector SPDRs only")
    args = p.parse_args(argv)
    etfs = [t.upper() for t in args.tickers] or list(
        SECTOR_SPDRS if args.sector_only else DEFAULT_ETFS
    )

    conn = None
    if not args.dry_run:
        try:
            import psycopg  # type: ignore
        except ImportError:
            print("psycopg required for DB write (or use --dry-run)", file=sys.stderr)
            return 2
        url = _load_database_url()
        if not url:
            print("DATABASE_URL not set", file=sys.stderr)
            return 2
        conn = psycopg.connect(url)
        ensure_table(conn)
        conn.commit()

    ok = 0
    for etf in etfs:
        try:
            raw = fetch_holdings(etf)
            as_of, rows = parse_holdings_xlsx(raw)
        except Exception as e:
            if conn:
                conn.rollback()
            print(f"{etf}: FAIL {e}", file=sys.stderr)
            continue
        if not as_of or not rows:
            print(f"{etf}: empty", file=sys.stderr)
            continue
        ok += 1
        print(f"{etf}: as_of={as_of} holdings={len(rows)} top={rows[0][0]}@{rows[0][1]:.2f}%")
        if args.dry_run or conn is None:
            continue
        try:
            n = upsert(conn, etf, as_of, rows)
            print(f"  upserted {n}")
        except Exception as e:
            conn.rollback()
            print(f"{etf}: upsert FAIL {e}", file=sys.stderr)
            return 1
    if conn:
        conn.close()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
