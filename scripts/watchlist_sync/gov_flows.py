#!/usr/bin/env python3
"""Government money flows (Key Themes › Money flows, Jamie 10-28: "how much stimulus is pumped into the markets monthly").

Source: Treasury Fiscal Data API (free, no key). Raw responses kept in vendor_raw (rule 4c).
  Daily Treasury Statement (DTS), $M, one row per business day → watchlist_sync.gov_flows_daily
    spend        TGA withdrawals minus public-debt cash redemptions  (cash the government paid out)
    receipts     TGA deposits minus public-debt cash issues          (taxes, fees …)
    deficit      spend − receipts                                     (the cash "pump" into the economy)
    net_borrow   public-debt cash issues − redemptions                (Treasury supply the market must absorb)
    tga_close    TGA closing balance                                  (cash parked at the Fed = drained from reserves)
    interest, defense   withdrawals for interest on Treasuries / DoD
  Monthly Treasury Statement (MTS table 1), $M → watchlist_sync.gov_flows_monthly (receipts, outlays, deficit)
Net liquidity (Fed assets − TGA − RRP) already lives in Macro › Liquidity; this adds where the cash goes.

    .venv/bin/python gov_flows.py              # daily.py: incremental (last stored day − 7 → today)
    .venv/bin/python gov_flows.py --since 2023-01-01
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402

BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service"
DDL = [
    """CREATE TABLE IF NOT EXISTS watchlist_sync.gov_flows_daily (
         date date PRIMARY KEY, spend numeric, receipts numeric, deficit numeric, net_borrow numeric,
         tga_close numeric, interest numeric, defense numeric, updated_at timestamptz DEFAULT now())""",
    """CREATE TABLE IF NOT EXISTS watchlist_sync.gov_flows_monthly (
         month date PRIMARY KEY, receipts numeric, outlays numeric, deficit numeric, updated_at timestamptz DEFAULT now())""",
]
DW_LINES = {
    "Treasury General Account Total Deposits": "dep_total",
    "Treasury General Account Total Withdrawals": "wd_total",
}
DW_CATG = {
    "Public Debt Cash Issues (Table IIIB)": "issues",
    "Public Debt Cash Redemp. (Table IIIB)": "redemp",
    "Interest on Treasury Securities": "interest",
    "Dept of Defense (DoD) - misc": "defense",
}
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]


def fetch(conn, path: str, params: dict[str, str]) -> list[dict]:
    """All pages of one Fiscal Data query; each page's raw JSON → vendor_raw."""
    out: list[dict] = []
    page = 1
    while True:
        q = {**params, "page[size]": "10000", "page[number]": str(page)}
        url = f"{BASE}/{path}?{urllib.parse.urlencode(q, safe='[]:,()')}"
        with urllib.request.urlopen(url, timeout=60) as r:
            d = json.load(r)
        payload = json.dumps(d)
        conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                        VALUES ('fiscaldata', %s, %s, %s, %s::jsonb, %s)
                        ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                        payload_sha = EXCLUDED.payload_sha""",
                     (path, f"{params.get('filter', '')}:p{page}", date.today(), payload,
                      hashlib.sha256(payload.encode()).hexdigest()))
        out += d.get("data") or []
        if page >= int((d.get("meta") or {}).get("total-pages") or 1):
            return out
        page += 1


def num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def sync_daily(conn, since: date) -> int:
    f = f"record_date:gte:{since.isoformat()}"
    days: dict[str, dict[str, float]] = {}
    for r in fetch(conn, "v1/accounting/dts/deposits_withdrawals_operating_cash", {"filter": f}):
        key = DW_LINES.get(r["account_type"]) if r["transaction_catg"] in (None, "null") else DW_CATG.get(r["transaction_catg"])
        if key and r["account_type"].startswith("Treasury General Account"):
            v = num(r["transaction_today_amt"])
            if v is not None:
                d = days.setdefault(r["record_date"], {})
                d[key] = d.get(key, 0.0) + v
    for r in fetch(conn, "v1/accounting/dts/operating_cash_balance",
                   {"filter": f + ",account_type:eq:Treasury General Account (TGA) Closing Balance"}):
        # the closing balance row carries today's value in open_today_bal (close_today_bal is null since 2021)
        v = num(r["close_today_bal"]) or num(r["open_today_bal"])
        if v is not None:
            days.setdefault(r["record_date"], {})["tga"] = v
    n = 0
    for d, x in sorted(days.items()):
        if "dep_total" not in x or "wd_total" not in x:
            continue
        spend = x["wd_total"] - x.get("redemp", 0.0)
        receipts = x["dep_total"] - x.get("issues", 0.0)
        conn.execute("""INSERT INTO watchlist_sync.gov_flows_daily
                          (date, spend, receipts, deficit, net_borrow, tga_close, interest, defense)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (date) DO UPDATE SET spend=EXCLUDED.spend, receipts=EXCLUDED.receipts,
                          deficit=EXCLUDED.deficit, net_borrow=EXCLUDED.net_borrow, tga_close=EXCLUDED.tga_close,
                          interest=EXCLUDED.interest, defense=EXCLUDED.defense, updated_at=now()""",
                     (d, spend, receipts, spend - receipts, x.get("issues", 0.0) - x.get("redemp", 0.0),
                      x.get("tga"), x.get("interest"), x.get("defense")))
        n += 1
    return n


def sync_monthly(conn, since: date) -> int:
    """MTS table 1: each record_date (fiscal year-to-date report) lists month rows under an 'FY yyyy' parent."""
    rows = fetch(conn, "v1/accounting/mts/mts_table_1", {"filter": f"record_date:gte:{since.isoformat()}"})
    parents = {r["classification_id"]: r["classification_desc"] for r in rows if r["classification_desc"].startswith("FY ")}
    n = 0
    for r in rows:
        fy = parents.get(r["parent_id"])
        if not fy or r["classification_desc"] not in MONTHS:
            continue
        m = MONTHS.index(r["classification_desc"]) + 1
        y = int(fy[3:]) - (1 if m >= 10 else 0)   # fiscal year starts in October
        rec, out = num(r["current_month_gross_rcpt_amt"]), num(r["current_month_gross_outly_amt"])
        if rec is None or out is None:
            continue
        conn.execute("""INSERT INTO watchlist_sync.gov_flows_monthly (month, receipts, outlays, deficit)
                        VALUES (%s,%s,%s,%s) ON CONFLICT (month) DO UPDATE SET receipts=EXCLUDED.receipts,
                          outlays=EXCLUDED.outlays, deficit=EXCLUDED.deficit, updated_at=now()""",
                     (date(y, m, 1), rec / 1e6, out / 1e6, (out - rec) / 1e6))
        n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=date.fromisoformat)
    a = ap.parse_args()
    conn = connect()
    for s in DDL:
        conn.execute(s)
    last = conn.execute("SELECT max(date) FROM watchlist_sync.gov_flows_daily").fetchone()[0]
    since = a.since or ((last - timedelta(days=7)) if last else date.today() - timedelta(days=800))
    nd = sync_daily(conn, since)
    nm = sync_monthly(conn, min(since, date.today() - timedelta(days=400)))
    conn.commit()
    t = conn.execute("""SELECT date, deficit, net_borrow, tga_close FROM watchlist_sync.gov_flows_daily
                        ORDER BY date DESC LIMIT 1""").fetchone()
    print(f"gov flows: {nd} days, {nm} month rows; last {t[0]} deficit ${t[1]:,.0f}M net borrow ${t[2]:,.0f}M "
          f"TGA ${float(t[3] or 0) / 1e3:,.0f}B" if t else "gov flows: no rows")


if __name__ == "__main__":
    main()
