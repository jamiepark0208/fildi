"""Unusual options activity (A396, north-star gap #2): LSE OPRA prints ≥ $25k premium → options_flow_prints + options_flow_daily.

Source  London Strategic Edge `/v3/options/flow` (every OPRA trade since 2025-10 with greeks/IV; LSE_KEY, free plan:
        60 calls/min, 12.5M rows/day). A day publishes ~1 day late, so the job fetches every unstored trading day up to the
        latest published one (probe = AAPL limit 1).
Rows    one per print (all vendor fields; the typed table is lossless, so whole payloads are NOT copied to vendor_raw —
        ~30 MB/day of duplicate JSON; data-inventory.md says so).
Daily   per name-day: call / put premium, prints, blocks (≥ $250k), multi-venue bursts (same contract, ≥ 3 venues inside
        2 s), premium × the name's median of the prior ≤ 20 stored days (needs ≥ 5), top 5 contracts by premium with
        that day's volume / open interest from option_chain_history when the contract is stored there.
Caveat  trades only, no bid/ask → a print's side (bought vs sold) is unknown. Display only, untested edge.

    .venv/bin/python options_flow.py                 # every unstored published day (daily.py, soft)
    .venv/bin/python options_flow.py --days 20       # backfill the last 20 trading days (baseline)
    .venv/bin/python options_flow.py --tickers RDDT,AAPL --day 2026-11-09
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
sys.path.insert(0, str(HERE.parent))
import lse_client as L  # noqa: E402
from build_plan import connect  # noqa: E402

MIN_PREMIUM = 25_000
BLOCK = 250_000
PAGE = 5000
EXTRA = ("SPY", "QQQ", "IWM")
DDL = [
    """CREATE TABLE IF NOT EXISTS watchlist_sync.options_flow_prints (
         day date NOT NULL, underlying text NOT NULL, occ text NOT NULL, ts_ns text NOT NULL, ts timestamptz NOT NULL,
         side text, strike numeric, expiry date, dte integer, size integer, price numeric, premium numeric,
         iv numeric, delta numeric, gamma numeric, theta numeric, vega numeric, venue text, underlying_price numeric,
         pair_id bigint, seq integer NOT NULL, PRIMARY KEY (day, underlying, seq))""",
    "CREATE INDEX IF NOT EXISTS options_flow_prints_und_idx ON watchlist_sync.options_flow_prints (underlying, day DESC)",
    """CREATE TABLE IF NOT EXISTS watchlist_sync.options_flow_daily (
         day date NOT NULL, ticker text NOT NULL, prints integer NOT NULL, call_premium numeric NOT NULL,
         put_premium numeric NOT NULL, blocks integer NOT NULL, bursts integer NOT NULL, max_print numeric,
         premium_x_norm numeric, baseline_days integer, top jsonb, computed_at timestamptz DEFAULT now(),
         PRIMARY KEY (day, ticker))""",
    "CREATE INDEX IF NOT EXISTS options_flow_daily_day_idx ON watchlist_sync.options_flow_daily (day DESC, premium_x_norm DESC)",
]


class RowsExhausted(Exception):
    pass


class SkipName(Exception):
    """Network failed 3× for one name-day: leave it unstored so the next run retries it."""


def universe(conn) -> list[str]:
    ts = {r[0] for r in conn.execute("SELECT DISTINCT ticker FROM source_fundamentals WHERE ticker ~ '^[A-Z.]{1,6}$'")}
    return sorted(ts | set(EXTRA))


def fetch(conn, ticker: str, day: date) -> list[dict]:
    """Every print ≥ MIN_PREMIUM for ticker on day (paged by offset)."""
    out, off = [], 0
    while True:
        url = (f"{L.BASE}/options/flow?underlying={ticker}&from={day}&to={day}&min_premium={MIN_PREMIUM}"
               f"&limit={PAGE}&offset={off}&order=asc")
        for attempt in range(3):   # 11-10: one ConnectionResetError killed the backfill mid-day
            try:
                status, body, _ = L._request(conn, url, endpoint="options/flow", vkey=f"{ticker}|{day}|{off}")
                break
            except OSError as e:
                print(f"flow: {ticker} {day} {type(e).__name__} (try {attempt + 1})", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
        else:
            raise SkipName()
        if status == 429 and b"rows-exhausted" in body:
            raise RowsExhausted()
        if status != 200:
            print(f"flow: {ticker} {day} HTTP {status} {body[:120]!r}", file=sys.stderr)
            return out
        d = json.loads(body.decode())
        rows = d.get("rows") or []
        out += rows
        if len(rows) < PAGE:
            return out
        off += PAGE


def published(conn, day: date) -> bool:
    url = f"{L.BASE}/options/flow?underlying=AAPL&from={day}&to={day}&limit=1"
    status, body, _ = L._request(conn, url, endpoint="options/flow", vkey=f"probe|{day}")
    return status == 200 and bool(json.loads(body.decode()).get("rows"))


def parse_ts(s: str) -> datetime:
    base, _, frac = s.partition(".")
    return datetime.strptime(base, "%Y-%m-%d %H:%M:%S").replace(
        microsecond=int((frac + "000000")[:6]) if frac else 0, tzinfo=timezone.utc)


def store_prints(conn, day: date, ticker: str, rows: list[dict]) -> None:
    conn.execute("DELETE FROM watchlist_sync.options_flow_prints WHERE day = %s AND underlying = %s", (day, ticker))
    vals = [(day, ticker, r["ticker"], r["ts"], parse_ts(r["ts"]), r.get("contract_type"), r.get("strike"), r.get("expiry"),
             r.get("dte"), r.get("size"), r.get("price"), r.get("premium"), r.get("iv"), r.get("delta"), r.get("gamma"),
             r.get("theta"), r.get("vega"), r.get("venue"), r.get("underlying_price"), r.get("pair_id"), i) for i, r in enumerate(rows)]
    if vals:
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO watchlist_sync.options_flow_prints VALUES
                   (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", vals)


def bursts(rows: list[dict]) -> int:
    """Same contract, ≥ 3 venues inside a 2 s window = one burst (sweep-like; legs < $25k are not seen)."""
    by = defaultdict(list)
    for r in rows:
        by[r["ticker"]].append((parse_ts(r["ts"]), r.get("venue")))
    n = 0
    for prints in by.values():
        prints.sort()
        i = 0
        while i < len(prints):
            j = i
            while j + 1 < len(prints) and (prints[j + 1][0] - prints[i][0]).total_seconds() <= 2:
                j += 1
            if len({v for _, v in prints[i:j + 1]}) >= 3:
                n += 1
            i = j + 1
    return n


def summarize(conn, day: date, ticker: str, rows: list[dict]) -> None:
    call = sum(r["premium"] or 0 for r in rows if r.get("contract_type") == "call")
    put = sum(r["premium"] or 0 for r in rows if r.get("contract_type") == "put")
    prior = [float(x[0]) for x in conn.execute(
        """SELECT call_premium + put_premium FROM watchlist_sync.options_flow_daily
           WHERE ticker = %s AND day < %s ORDER BY day DESC LIMIT 20""", (ticker, day))]
    med = statistics.median(prior) if len(prior) >= 5 else None
    xnorm = (call + put) / med if med else None
    agg = defaultdict(lambda: {"premium": 0.0, "size": 0, "prints": 0})
    for r in rows:
        a = agg[r["ticker"]]
        a["premium"] += r["premium"] or 0
        a["size"] += r.get("size") or 0
        a["prints"] += 1
        a.update(side=r.get("contract_type"), strike=r.get("strike"), expiry=r.get("expiry"), dte=r.get("dte"))
        if r.get("iv") is not None:
            a["iv"], a["delta"] = r["iv"], r.get("delta")
    top = sorted(agg.items(), key=lambda kv: -kv[1]["premium"])[:5]
    out = []
    for occ, a in top:
        ch = conn.execute(
            """SELECT volume, open_interest FROM option_chain_history WHERE ticker = %s AND as_of = %s AND expiry = %s
               AND side = %s AND strike = %s ORDER BY fetched_at DESC LIMIT 1""",
            (ticker, day, a["expiry"], a["side"], a["strike"])).fetchone()
        out.append({"occ": occ, **a, "volume": ch[0] if ch else None, "oi": ch[1] if ch else None})
    conn.execute(
        """INSERT INTO watchlist_sync.options_flow_daily
           (day, ticker, prints, call_premium, put_premium, blocks, bursts, max_print, premium_x_norm, baseline_days, top)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
           ON CONFLICT (day, ticker) DO UPDATE SET prints = EXCLUDED.prints, call_premium = EXCLUDED.call_premium,
             put_premium = EXCLUDED.put_premium, blocks = EXCLUDED.blocks, bursts = EXCLUDED.bursts,
             max_print = EXCLUDED.max_print, premium_x_norm = EXCLUDED.premium_x_norm,
             baseline_days = EXCLUDED.baseline_days, top = EXCLUDED.top, computed_at = now()""",
        (day, ticker, len(rows), call, put, sum(1 for r in rows if (r["premium"] or 0) >= BLOCK), bursts(rows),
         max((r["premium"] or 0 for r in rows), default=None), xnorm, len(prior), json.dumps(out)))


def trading_days_back(n: int, end: date) -> list[date]:
    out, d = [], end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return sorted(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0, help="backfill the last N trading days")
    ap.add_argument("--day", type=date.fromisoformat)
    ap.add_argument("--tickers")
    ap.add_argument("--max-minutes", type=float, default=40)
    a = ap.parse_args()
    t0 = time.monotonic()
    with connect() as conn:
        for s in DDL:
            conn.execute(s)
        conn.commit()
        names = a.tickers.upper().split(",") if a.tickers else universe(conn)
        today = date.today()
        if a.day:
            days = [a.day]
        else:
            last = conn.execute("SELECT max(day) FROM watchlist_sync.options_flow_daily").fetchone()[0]
            cand = trading_days_back(a.days, today - timedelta(days=1)) if a.days else \
                [d for d in trading_days_back(10, today) if last is None or d >= last][-3:]
            days = [d for d in cand if published(conn, d)]
        if not days:
            print("options flow: no new published day")
            return
        prints = calls = 0
        try:
            for day in days:
                done = {r[0] for r in conn.execute(
                    "SELECT ticker FROM watchlist_sync.options_flow_daily WHERE day = %s", (day,))} if not a.tickers else set()
                for t in names:
                    if t in done:
                        continue
                    if time.monotonic() - t0 > a.max_minutes * 60:
                        raise TimeoutError
                    try:
                        rows = fetch(conn, t, day)
                    except SkipName:
                        continue
                    calls += 1 + len(rows) // PAGE
                    store_prints(conn, day, t, rows)
                    summarize(conn, day, t, rows)
                    conn.commit()
                    prints += len(rows)
        except RowsExhausted:
            print("options flow: LSE daily row quota exhausted — resumes next run", file=sys.stderr)
        except TimeoutError:
            print(f"options flow: stopped at --max-minutes {a.max_minutes} — resumes next run", file=sys.stderr)
        print(f"options flow: days {','.join(map(str, days))} · {len(names)} names · {calls} calls · {prints} prints "
              f"· {time.monotonic() - t0:.0f} s")


if __name__ == "__main__":
    main()
