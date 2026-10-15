"""Option price history from Polygon free (Claude, PM role, user 2026-10-14) → schema `optlab` for studies S017–S020.

Polygon free Basic: 5 calls/min, end-of-day, ~2 years back. Probed 10-14:
  /v3/reference/options/contracts?underlying_ticker=T&expiration_date=E&expired=true → every strike for one expiry (1 call;
      `as_of` returns nothing, don't use it)
  /v2/aggs/ticker/O:{OCC}/range/1/day/{from}/{to}  → one contract's whole daily life (1 call)
  /v2/aggs/ticker/{T}/range/1/day/...?adjusted=false → underlying closes (prices_historical only starts 2025-04-15;
      unadjusted so they match listed strikes)

Queue, in priority order (each step skips what is already stored → safe to stop and restart any time):
  1 underlying   2 years of daily bars for every ticker below
  2 trades       the trader's short puts (S015 trades.csv): the sold put, the next 2 lower strikes (put-spread long legs),
                 the strike nearest spot on entry day (ATM put + call = straddle), the call mirrored around spot (strangle)
  3 earnings     each report in the last 2 years for the study universe: ATM put + call on the first Friday expiry after the
                 report, priced the close before (implied move vs realized move)
  4 ivrank       book names only, monthly expiries over 2 years: the put nearest spot 30 days before expiry
                 → ~30-day ATM IV series (true IV rank; technicals-math ivRank is a realized-vol rank). User 10-14 cut scope.
Storage (user 10-14): bars keep high/close/volume as real; only strikes within ±30 % of entry spot are stored (~20 MB total).

Study universe = trader tickers ∪ current book names ∪ the 30 most frequent model_recs tickers.
Shares Polygon's 5/min with lib/short-interest.ts (a 429 waits 65 s and retries). Calls counted in api_usage ('polygon').

    .venv/bin/python analysis/option_history.py            # run the queue (hours; resumable)
    .venv/bin/python analysis/option_history.py --plan     # print queue sizes only
"""
from __future__ import annotations

import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect, rows  # noqa: E402

API = "https://api.polygon.io"
GAP_S = 12.5
LAST_RUN = Path("/tmp/fildi-logs/option-history-last.json")
TODAY = date.today()
START = TODAY - timedelta(days=730)

DDL = """
CREATE SCHEMA IF NOT EXISTS optlab;
CREATE TABLE IF NOT EXISTS optlab.contracts (occ text PRIMARY KEY, underlying text NOT NULL, expiry date NOT NULL,
  type text NOT NULL, strike double precision NOT NULL);
CREATE INDEX IF NOT EXISTS idx_optlab_contracts ON optlab.contracts (underlying, expiry, type, strike);
CREATE TABLE IF NOT EXISTS optlab.chains_fetched (underlying text, expiry date, n int, fetched_at timestamptz DEFAULT now(),
  PRIMARY KEY (underlying, expiry));
CREATE TABLE IF NOT EXISTS optlab.bars (occ text, date date, h real, c real, v real, PRIMARY KEY (occ, date));
CREATE TABLE IF NOT EXISTS optlab.bars_fetched (occ text PRIMARY KEY, n int, fetched_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS optlab.underlying (ticker text, date date, o double precision, h double precision,
  l double precision, c double precision, v double precision, PRIMARY KEY (ticker, date));
CREATE TABLE IF NOT EXISTS optlab.underlying_fetched (ticker text PRIMARY KEY, n int, fetched_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS optlab.legs (study text, key text, role text, occ text, PRIMARY KEY (study, key, role));
"""

_last = 0.0
_calls = 0


def key() -> str:
    if os.environ.get("POLYGON_API_KEY"):
        return os.environ["POLYGON_API_KEY"]
    for line in open(HERE.parent.parent.parent / ".env.local"):
        if line.startswith("POLYGON_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("POLYGON_API_KEY missing")


def get(path: str) -> dict:
    global _last, _calls
    sep = "&" if "?" in path else "?"
    url = f"{API}{path}{sep}apiKey={key()}"
    for attempt in range(5):
        wait = _last + GAP_S - time.time()
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        _calls += 1
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(65)
                continue
            if e.code in (403, 404):
                return {}
            time.sleep(15 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError):
            time.sleep(15 * (attempt + 1))
    return {}


def day(ms: int) -> date:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).date()


def flush_usage(conn) -> None:
    global _calls
    if not _calls:
        return
    conn.execute("""INSERT INTO api_usage (source, date, calls_made, updated_at)
                    VALUES ('polygon', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s, now())
                    ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + excluded.calls_made,
                    updated_at = now()""", (_calls,))
    conn.commit()
    _calls = 0


# ── fetchers (each idempotent) ────────────────────────────────────────────────────────────────────────────────────────

def fetch_underlying(conn, t: str) -> None:
    if conn.execute("SELECT 1 FROM optlab.underlying_fetched WHERE ticker = %s", (t,)).fetchone():
        return
    d = get(f"/v2/aggs/ticker/{t}/range/1/day/{START}/{TODAY}?adjusted=false&sort=asc&limit=50000")
    res = d.get("results") or []
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO optlab.underlying VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        [(t, day(r["t"]), r.get("o"), r.get("h"), r.get("l"),
                          r.get("c"), r.get("v")) for r in res])
        cur.execute("INSERT INTO optlab.underlying_fetched (ticker, n) VALUES (%s, %s) ON CONFLICT DO NOTHING", (t, len(res)))
    conn.commit()


def chain(conn, t: str, exp: date, ref: float | None = None) -> list[dict]:
    """Listed contracts for (t, exp), one call; only strikes within ±30 % of `ref` (spot when the study enters) are stored."""
    if not conn.execute("SELECT 1 FROM optlab.chains_fetched WHERE underlying = %s AND expiry = %s", (t, exp)).fetchone():
        res, path = [], f"/v3/reference/options/contracts?underlying_ticker={t}&expiration_date={exp}&expired=true&limit=1000"
        if exp >= TODAY:
            path = path.replace("&expired=true", "")
        d = get(path)
        res += d.get("results") or []
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO optlab.contracts VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(r["ticker"], t, exp, r["contract_type"], float(r["strike_price"])) for r in res
                             if not ref or abs(float(r["strike_price"]) / ref - 1) <= 0.30])
            cur.execute("INSERT INTO optlab.chains_fetched (underlying, expiry, n) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                        (t, exp, len(res)))
        conn.commit()
    return rows(conn, "SELECT occ, type, strike FROM optlab.contracts WHERE underlying = %s AND expiry = %s ORDER BY strike",
                (t, exp))


def fetch_bars(conn, occ: str, exp: date) -> None:
    if conn.execute("SELECT 1 FROM optlab.bars_fetched WHERE occ = %s", (occ,)).fetchone():
        return
    lo = max(START, exp - timedelta(days=120))
    d = get(f"/v2/aggs/ticker/{occ}/range/1/day/{lo}/{exp}?adjusted=false&sort=asc&limit=50000")
    res = d.get("results") or []
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO optlab.bars VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                        [(occ, day(r["t"]), r.get("h"), r.get("c"), r.get("v")) for r in res])
        cur.execute("INSERT INTO optlab.bars_fetched (occ, n) VALUES (%s,%s) ON CONFLICT DO NOTHING", (occ, len(res)))
    conn.commit()


def spot(conn, t: str, d: date) -> float | None:
    r = conn.execute("SELECT c FROM optlab.underlying WHERE ticker = %s AND date <= %s ORDER BY date DESC LIMIT 1",
                     (t, d)).fetchone()
    return r[0] if r else None


def nearest(cs: list[dict], typ: str, k: float) -> dict | None:
    c = [x for x in cs if x["type"] == typ]
    return min(c, key=lambda x: abs(x["strike"] - k)) if c else None


def leg(conn, study: str, k: str, role: str, c: dict | None, exp: date) -> None:
    if not c:
        return
    conn.execute("INSERT INTO optlab.legs VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING", (study, k, role, c["occ"]))
    fetch_bars(conn, c["occ"], exp)


# ── queues ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def load_trades() -> list[dict]:
    with open(HERE.parent / "out/mistakes/trades.csv") as fh:
        return list(csv.DictReader(fh))


def book_names() -> list[str]:
    book = HERE.parent / "out/pm/book-latest.json"
    return sorted({p["ticker"] for p in json.loads(book.read_text()).get("positions", []) if p.get("ticker")}) if book.is_file() else []


def universe(conn, trades: list[dict]) -> list[str]:
    tick = Counter(t["ticker"] for t in trades)
    out = list(tick)
    book = Path(HERE.parent / "out/pm/book-latest.json")
    if book.is_file():
        for p in json.loads(book.read_text()).get("positions", []):
            if p.get("ticker") and p["ticker"] not in out:
                out.append(p["ticker"])
    for r in rows(conn, """SELECT ticker FROM model_recs GROUP BY ticker ORDER BY COUNT(*) DESC LIMIT 30"""):
        if r["ticker"] not in out:
            out.append(r["ticker"])
    return [t for t in out if "." not in t]


def run_trades(conn, trades: list[dict]) -> None:
    for i, tr in enumerate(trades):
        t, exp, k = tr["ticker"], date.fromisoformat(tr["exp"]), float(tr["k"])
        d0 = date.fromisoformat(tr["d0"])
        s = spot(conn, t, d0 - timedelta(days=1)) or float(tr["prev"] or 0)
        cs = chain(conn, t, exp, s or k)
        if not cs:
            continue
        kk = f"{tr['account']}|{t}|{tr['d0']}|{tr['exp']}|{k}"
        sold = next((c for c in cs if c["type"] == "put" and abs(c["strike"] - k) < 1e-6), None)
        leg(conn, "trades", kk, "sold_put", sold, exp)
        lower = [c for c in cs if c["type"] == "put" and c["strike"] < k - 1e-6]
        for j, c in enumerate(reversed(lower[-2:])):
            leg(conn, "trades", kk, f"long_put_{j + 1}", c, exp)
        if s:
            leg(conn, "trades", kk, "atm_put", nearest(cs, "put", s), exp)
            leg(conn, "trades", kk, "atm_call", nearest(cs, "call", s), exp)
            leg(conn, "trades", kk, "mirror_call", nearest(cs, "call", 2 * s - k), exp)
        if i % 25 == 0:
            progress(conn, f"trades {i}/{len(trades)}")


def fridays_after(d: date, n: int) -> list[date]:
    f = d + timedelta(days=(4 - d.weekday()) % 7 or 7)
    return [f + timedelta(days=7 * i) for i in range(n)]


def run_earnings(conn, tickers: list[str]) -> None:
    ev = rows(conn, """SELECT DISTINCT UPPER(ticker) AS t, report_date AS d FROM earnings_calendar
                       WHERE UPPER(ticker) = ANY(%s) AND report_date BETWEEN %s AND %s ORDER BY d DESC""",
              (tickers, START + timedelta(days=30), TODAY - timedelta(days=3)))
    for i, e in enumerate(ev):
        t, d = e["t"], e["d"]
        s = spot(conn, t, d - timedelta(days=1))
        if not s:
            continue
        for exp in fridays_after(d, 3):  # weeklies first; small names may only list monthlies
            cs = chain(conn, t, exp, s)
            if cs:
                kk = f"{t}|{d}"
                leg(conn, "earnings", kk, "atm_put", nearest(cs, "put", s), exp)
                leg(conn, "earnings", kk, "atm_call", nearest(cs, "call", s), exp)
                conn.execute("INSERT INTO optlab.legs VALUES ('earnings', %s, 'expiry', %s) ON CONFLICT DO NOTHING",
                             (kk, str(exp)))
                conn.commit()
                break
        if i % 20 == 0:
            progress(conn, f"earnings {i}/{len(ev)}")


def third_fridays() -> list[date]:
    out, d = [], date(START.year, START.month, 1)
    while d < TODAY:
        f = d + timedelta(days=(4 - d.weekday()) % 7 + 14)
        if START + timedelta(days=45) <= f < TODAY:
            out.append(f)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


def run_ivrank(conn, tickers: list[str]) -> None:
    for i, t in enumerate(tickers):
        for exp in third_fridays():
            s = spot(conn, t, exp - timedelta(days=30))
            if not s:
                continue
            c = nearest(chain(conn, t, exp, s), "put", s)
            leg(conn, "ivrank", f"{t}|{exp}", "atm30_put", c, exp)
        progress(conn, f"ivrank {i + 1}/{len(tickers)} ({t})")


def progress(conn, msg: str) -> None:
    flush_usage(conn)
    try:
        LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
        LAST_RUN.write_text(json.dumps({"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "ok": True,
                                        "detail": msg}))
    except OSError:
        pass
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def main() -> None:
    conn = connect()
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    conn.commit()
    trades = load_trades()
    uni = universe(conn, trades)
    if "--plan" in sys.argv:
        print(f"trades {len(trades)} · universe {len(uni)}: {' '.join(uni)}")
        return
    for t in uni:
        fetch_underlying(conn, t)
    progress(conn, f"underlying done ({len(uni)})")
    run_trades(conn, trades)
    progress(conn, "trades done")
    run_earnings(conn, uni)
    progress(conn, "earnings done")
    run_ivrank(conn, book_names())  # user 10-14: book only, 1 strike/month (~2 h, not ~20 h)
    import option_derive  # UI tables (Breakdown › Options history, Playbook)
    option_derive.main()
    progress(conn, "all done")


if __name__ == "__main__":
    main()
