#!/usr/bin/env python3
"""A98 P1 — SSGA NAV history → watchlist_sync.etf_flows (daily creations/redemptions).

Source: https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-<tkr>.xlsx
Columns: Date, NAV, Shares Outstanding, Total Net Assets.
flow_usd ≈ Δshares × NAV (same-day NAV × share change vs prior row).

Usage:
  python3 scripts/watchlist_sync/etf_flows_ssga.py            # 11 sector SPDRs
  python3 scripts/watchlist_sync/etf_flows_ssga.py XLK SMH    # subset
  python3 scripts/watchlist_sync/etf_flows_ssga.py --dry-run XLK
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.request import Request, urlopen

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
SSGA_URL = "https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-{tkr}.xlsx"

# 11 Select Sector SPDRs (Claude plan A98).
SECTOR_SPDRS = ("XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY", "XLRE", "XLC")
# Theme / market SPDRs with live navhist (probed 2026-10-18). SMH/ITA = not SSGA → skip.
THEME_ETFS = ("SPY", "MDY", "GLD", "XBI", "KRE", "XOP", "XHB")
DEFAULT_ETFS = SECTOR_SPDRS + THEME_ETFS

DATE_RE = re.compile(r"^(\d{1,2})-([A-Za-z]{3})-(\d{4})$")
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


@dataclass(frozen=True)
class NavRow:
    date: str  # YYYY-MM-DD
    nav: float
    shares: float
    net_assets: float


def parse_ssga_date(s: str) -> str | None:
    m = DATE_RE.match(s.strip())
    if not m:
        return None
    day, mon, year = m.group(1), m.group(2).title(), m.group(3)
    mi = MONTHS.get(mon)
    if not mi:
        return None
    return f"{int(year):04d}-{mi:02d}-{int(day):02d}"


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


def parse_navhist_xlsx(data: bytes) -> list[NavRow]:
    """Parse SSGA navhist workbook → oldest→newest NavRow list."""
    z = zipfile.ZipFile(io.BytesIO(data))
    ss = _shared_strings(z)
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows_out: list[NavRow] = []
    for row in sheet.findall("m:sheetData/m:row", NS):
        vals = [_cell_val(c, ss) for c in row.findall("m:c", NS)]
        if len(vals) < 4 or not vals[0]:
            continue
        d = parse_ssga_date(str(vals[0]))
        if not d:
            continue
        try:
            nav = float(vals[1])  # type: ignore[arg-type]
            shares = float(vals[2])  # type: ignore[arg-type]
            assets = float(vals[3])  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        rows_out.append(NavRow(d, nav, shares, assets))
    rows_out.sort(key=lambda r: r.date)
    return rows_out


def flows_from_nav(rows: list[NavRow]) -> list[tuple[str, float, float, float, float]]:
    """→ (date, nav, shares, flow_usd, aum). First day flow=0."""
    out: list[tuple[str, float, float, float, float]] = []
    prev_shares: float | None = None
    for r in rows:
        flow = 0.0 if prev_shares is None else (r.shares - prev_shares) * r.nav
        out.append((r.date, r.nav, r.shares, flow, r.net_assets))
        prev_shares = r.shares
    return out


def fetch_navhist(ticker: str) -> bytes:
    url = SSGA_URL.format(tkr=ticker.lower())
    req = Request(url, headers={"User-Agent": "fildi-etf-flows/1.0"})
    with urlopen(req, timeout=60) as resp:
        return resp.read()


def ensure_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_sync.etf_flows (
          etf text NOT NULL,
          date date NOT NULL,
          nav double precision NOT NULL,
          shares double precision NOT NULL,
          flow_usd double precision NOT NULL,
          aum double precision,
          source text NOT NULL DEFAULT 'ssga-navhist',
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (etf, date)
        );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_etf_flows_date ON watchlist_sync.etf_flows (date DESC);")


def upsert_flows(conn, etf: str, rows: Iterable[tuple[str, float, float, float, float]]) -> int:
    n = 0
    with conn.cursor() as cur:
        for date, nav, shares, flow, aum in rows:
            cur.execute(
                """
                INSERT INTO watchlist_sync.etf_flows (etf, date, nav, shares, flow_usd, aum, source, updated_at)
                VALUES (%s, %s::date, %s, %s, %s, %s, 'ssga-navhist', now())
                ON CONFLICT (etf, date) DO UPDATE SET
                  nav = EXCLUDED.nav, shares = EXCLUDED.shares, flow_usd = EXCLUDED.flow_usd,
                  aum = EXCLUDED.aum, source = EXCLUDED.source, updated_at = now()
                """,
                (etf.upper(), date, nav, shares, flow, aum),
            )
            n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("tickers", nargs="*", help="ETF tickers (default: sector SPDRs + theme set)")
    p.add_argument("--dry-run", action="store_true", help="parse + print only; no DB")
    args = p.parse_args(argv)
    tickers = [t.upper() for t in (args.tickers or list(DEFAULT_ETFS))]

    conn = None
    if not args.dry_run:
        try:
            import psycopg  # type: ignore
        except ImportError:
            print("psycopg required for DB write (or use --dry-run)", file=sys.stderr)
            return 2
        # Same env load as build_plan.py
        root = Path(__file__).resolve().parents[2]
        for name in (".env.local", ".env"):
            envp = root / name
            if not envp.exists():
                continue
            for line in envp.read_text().splitlines():
                if line.startswith("DATABASE_URL=") and "DATABASE_URL" not in os.environ:
                    os.environ["DATABASE_URL"] = line.split("=", 1)[1].strip().strip("\"'")
        url = os.environ.get("DATABASE_URL")
        if not url:
            print("DATABASE_URL not set", file=sys.stderr)
            return 2
        conn = psycopg.connect(url)
        ensure_table(conn)
        conn.commit()

    for t in tickers:
        try:
            raw = fetch_navhist(t)
            nav_rows = parse_navhist_xlsx(raw)
            flows = flows_from_nav(nav_rows)
            if not flows:
                print(f"{t}: no rows")
                continue
            if args.dry_run or conn is None:
                last = flows[-1]
                print(f"{t}: {len(flows)} days  last={last[0]} nav={last[1]:.2f} flow={last[3]:,.0f}")
            else:
                n = upsert_flows(conn, t, flows)
                conn.commit()
                print(f"{t}: upserted {n} rows ({flows[0][0]}→{flows[-1][0]})")
        except Exception as e:
            if conn:
                conn.rollback()
            print(f"{t}: FAIL {e}", file=sys.stderr)
            return 1

    if conn:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
