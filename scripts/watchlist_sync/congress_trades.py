"""Congress trades (A394): Senate + House STOCK Act disclosures from FMP stable *-latest → watchlist_sync.congress_trades.

Display-only data ("untested"), shown in Breakdown › Congress and Feed › Congress. Whole responses → vendor_raw (AGENTS 4c);
each call counted in api_usage (source 'fmp'). Deadline 20 s per call.

FMP plan limits probed 11-10: *-latest serves page 0 only (≤ 100 newest rows; page ≥ 1 and limit > 25 → 402), and the per-symbol
*-trades endpoints are restricted (402). So history accrues forward from the first run; --backfill probes the per-symbol endpoint
once, and on 402 logs `pending: needs FMP plan upgrade` instead of burning calls. Run at least daily (House posts ~50 rows/day).

    .venv/bin/python congress_trades.py [--backfill]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402

BASE = "https://financialmodelingprep.com/stable"
DDL = [
    """CREATE TABLE IF NOT EXISTS watchlist_sync.congress_trades (
         row_hash text PRIMARY KEY, chamber text NOT NULL, symbol text NOT NULL, member text, party text, district text,
         owner text, txn_date date, disclosure_date date, lag_days integer, txn_type text, raw_type text,
         amount_lo numeric, amount_hi numeric, amount_text text, asset_type text, asset_desc text, link text,
         fetched_at timestamptz DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS congress_trades_sym_idx ON watchlist_sync.congress_trades (symbol, disclosure_date DESC)",
    "CREATE INDEX IF NOT EXISTS congress_trades_disc_idx ON watchlist_sync.congress_trades (disclosure_date DESC)",
]


def key() -> str:
    k = os.environ.get("FMP_API_KEY")
    if not k:
        for line in (HERE.parent.parent / ".env.local").read_text().splitlines():
            if line.startswith("FMP_API_KEY="):
                k = line.split("=", 1)[1].strip().strip("\"' ")
    if not k:
        raise SystemExit("congress: FMP_API_KEY missing")
    return k


def count_call(conn, n: int = 1) -> None:
    conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at)
                    VALUES ('fmp', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
                    ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made, updated_at = now()""", (n,))


def get(conn, endpoint: str, params: str, k: str):
    """One FMP call (20 s deadline) → (status, json|None); raw payload kept in vendor_raw."""
    url = f"{BASE}/{endpoint}?{params}&apikey={k}" if params else f"{BASE}/{endpoint}?apikey={k}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            body, status = r.read().decode(), r.status
    except urllib.error.HTTPError as e:
        body, status = e.read().decode(errors="replace"), e.code
    except Exception as e:  # timeout / network: soft
        print(f"congress: {endpoint} {type(e).__name__}", file=sys.stderr)
        return 0, None
    count_call(conn)
    try:
        d = json.loads(body)
    except ValueError:
        return status, None
    if status == 200:
        payload = json.dumps(d)
        conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                        VALUES ('fmp', %s, %s, %s, %s::jsonb, %s)
                        ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                        payload_sha = EXCLUDED.payload_sha""",
                     (endpoint, params or "p0", date.today(), payload, hashlib.sha256(payload.encode()).hexdigest()))
    return status, d


def money(s: str) -> float:
    return float(s.replace(",", ""))


def parse_amount(t: str | None) -> tuple[float | None, float | None]:
    nums = [money(x) for x in re.findall(r"\$\s*([\d,]+(?:\.\d+)?)", t or "")]
    if len(nums) >= 2:
        return min(nums), max(nums)
    if len(nums) == 1:
        return (nums[0], nums[0]) if "over" not in (t or "").lower() else (nums[0], nums[0])
    return None, None


def norm_type(t: str | None) -> str:
    s = (t or "").lower()
    if s.startswith("purchase") or s == "buy":
        return "buy"
    if s.startswith("sale") or s == "sell":
        return "sell"
    if s.startswith("exchange"):
        return "exchange"
    return "other"


def d(v) -> date | None:
    try:
        return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def to_row(chamber: str, x: dict) -> dict | None:
    sym = (x.get("symbol") or "").strip().upper()
    if not sym:
        return None
    member = f"{x.get('firstName') or ''} {x.get('lastName') or ''}".strip() or (x.get("office") or "")
    td, dd = d(x.get("transactionDate")), d(x.get("disclosureDate"))
    lo, hi = parse_amount(x.get("amount"))
    ident = "|".join(str(x.get(f) or "") for f in ("symbol", "firstName", "lastName", "transactionDate", "disclosureDate",
                                                  "type", "amount", "owner", "assetDescription", "link"))
    return {
        "row_hash": hashlib.sha1(f"{chamber}|{ident}".encode()).hexdigest(), "chamber": chamber, "symbol": sym,
        "member": member, "party": x.get("party"), "district": x.get("district"), "owner": x.get("owner"),
        "txn_date": td, "disclosure_date": dd, "lag_days": (dd - td).days if td and dd else None,
        "txn_type": norm_type(x.get("type")), "raw_type": x.get("type"), "amount_lo": lo, "amount_hi": hi,
        "amount_text": x.get("amount"), "asset_type": x.get("assetType"), "asset_desc": x.get("assetDescription"), "link": x.get("link"),
    }


COLS = ["row_hash", "chamber", "symbol", "member", "party", "district", "owner", "txn_date", "disclosure_date", "lag_days",
        "txn_type", "raw_type", "amount_lo", "amount_hi", "amount_text", "asset_type", "asset_desc", "link"]


def upsert(conn, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        cur = conn.execute(f"""INSERT INTO watchlist_sync.congress_trades ({",".join(COLS)})
                               VALUES ({",".join(["%s"] * len(COLS))}) ON CONFLICT (row_hash) DO NOTHING""", [r[c] for c in COLS])
        n += cur.rowcount
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    conn = connect()
    for s in DDL:
        conn.execute(s)
    k = key()
    new = seen = calls = 0
    msgs: list[str] = []
    for chamber, ep in (("senate", "senate-latest"), ("house", "house-latest")):
        st, data = get(conn, ep, "page=0", k)
        calls += 1
        if st != 200 or not isinstance(data, list):
            msgs.append(f"{chamber} HTTP {st}")
            continue
        rows = [r for r in (to_row(chamber, x) for x in data) if r]
        seen += len(rows)
        new += upsert(conn, rows)
        conn.commit()
        oldest = min((r["disclosure_date"] for r in rows if r["disclosure_date"]), default=None)
        msgs.append(f"{chamber} {len(rows)} rows (oldest disclosed {oldest})")
    if a.backfill:
        st, _ = get(conn, "senate-trades", "symbol=NVDA", k)
        calls += 1
        if st == 200:
            msgs.append("backfill: per-symbol endpoint OPEN — extend this script (pending)")
        else:
            msgs.append(f"backfill: per-symbol endpoints HTTP {st} (restricted on our FMP plan) → pending: needs plan upgrade; history accrues forward only")
        conn.commit()
    tot, first = conn.execute("SELECT count(*), min(disclosure_date) FROM watchlist_sync.congress_trades").fetchone()
    conn.commit()
    print(f"congress: {new} new / {seen} seen, {calls} FMP calls, {time.time() - t0:.1f}s; table {tot} rows since {first}; " + "; ".join(msgs))


if __name__ == "__main__":
    main()
