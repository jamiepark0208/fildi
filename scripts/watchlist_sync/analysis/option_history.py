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
import polygon_gate  # noqa: E402
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
ALTER TABLE optlab.chains_fetched ADD COLUMN IF NOT EXISTS lo real, ADD COLUMN IF NOT EXISTS hi real;
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
        polygon_gate.wait()  # shared 5/min budget across processes
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
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):  # resets, sleep/wake drops, truncated JSON
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
    # Incremental (10-20): the fetched marker used to stop every later fetch → optlab.underlying (and iv30 / IV rank built on
    # it) froze at each name's first fetch (all ≤ 10-14). Now: append from the day after the last stored bar.
    last = conn.execute("SELECT MAX(date) FROM optlab.underlying WHERE ticker = %s", (t,)).fetchone()[0]
    if last is not None and last >= TODAY - timedelta(days=1):
        return
    frm = last + timedelta(days=1) if last else START
    d = get(f"/v2/aggs/ticker/{t}/range/1/day/{frm}/{TODAY}?adjusted=false&sort=asc&limit=50000")
    res = d.get("results") or []
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO optlab.underlying VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                        [(t, day(r["t"]), r.get("o"), r.get("h"), r.get("l"),
                          r.get("c"), r.get("v")) for r in res])
        cur.execute("INSERT INTO optlab.underlying_fetched (ticker, n) VALUES (%s, %s) ON CONFLICT (ticker) DO UPDATE SET "
                    "n = optlab.underlying_fetched.n + EXCLUDED.n, fetched_at = now()", (t, len(res)))
    conn.commit()


def chain(conn, t: str, exp: date, ref: float | None = None) -> list[dict]:
    """Listed contracts for (t, exp), one call; only strikes within ±30 % of `ref` (spot when the study enters) are stored.
    Re-fetches when a later study's ref needs strikes outside the stored window (±20 % of ref not covered) and keeps the
    union (A110); rows from before lo/hi existed use the stored min/max strike as their window."""
    have = conn.execute("""SELECT COALESCE(f.lo, MIN(c.strike)), COALESCE(f.hi, MAX(c.strike)), f.fetched_at::date FROM optlab.chains_fetched f
                           LEFT JOIN optlab.contracts c ON c.underlying = f.underlying AND c.expiry = f.expiry
                           WHERE f.underlying = %s AND f.expiry = %s GROUP BY f.lo, f.hi, f.fetched_at""", (t, exp)).fetchone()
    covered = have is not None and (not ref or (have[0] is not None and have[0] <= ref * 0.8 and have[1] >= ref * 1.2))
    if covered and exp >= TODAY and have[2] < TODAY - timedelta(days=7):   # 10-21: live chains list new strikes → weekly refresh
        covered = False
    if not covered:
        res, path = [], f"/v3/reference/options/contracts?underlying_ticker={t}&expiration_date={exp}&expired=true&limit=1000"
        if exp >= TODAY:
            path = path.replace("&expired=true", "")
        while path:   # 10-21: follow pages (limit 1000 truncated big chains silently)
            d = get(path)
            res += d.get("results") or []
            nxt = d.get("next_url")
            path = nxt[len(API):] if nxt and d.get("results") else None
        lo, hi = (ref * 0.7, ref * 1.3) if ref else (None, None)
        with conn.cursor() as cur:
            cur.executemany("INSERT INTO optlab.contracts VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(r["ticker"], t, exp, r["contract_type"], float(r["strike_price"])) for r in res
                             if not ref or abs(float(r["strike_price"]) / ref - 1) <= 0.30])
            cur.execute("""INSERT INTO optlab.chains_fetched (underlying, expiry, n, lo, hi) VALUES (%s,%s,%s,%s,%s)
                           ON CONFLICT (underlying, expiry) DO UPDATE SET n = excluded.n, fetched_at = now(),
                           lo = LEAST(COALESCE(optlab.chains_fetched.lo, excluded.lo), excluded.lo),
                           hi = GREATEST(COALESCE(optlab.chains_fetched.hi, excluded.hi), excluded.hi)""", (t, exp, len(res), lo, hi))
        conn.commit()
    return rows(conn, "SELECT occ, type, strike FROM optlab.contracts WHERE underlying = %s AND expiry = %s ORDER BY strike",
                (t, exp))


def fetch_bars(conn, occ: str, exp: date) -> None:
    # Incremental (10-21, as fetch_underlying): a contract first fetched before it expired kept its marker forever → the
    # ivrank monthlies (and optlab.iv30 / IV rank) froze at 10-14. Done = fetched after expiry or already today.
    f = conn.execute("SELECT fetched_at::date FROM optlab.bars_fetched WHERE occ = %s", (occ,)).fetchone()
    if f and (f[0] > exp or f[0] >= TODAY):
        return
    last = conn.execute("SELECT MAX(date) FROM optlab.bars WHERE occ = %s", (occ,)).fetchone()[0] if f else None
    lo = last + timedelta(days=1) if last else max(START, exp - timedelta(days=120))
    d = get(f"/v2/aggs/ticker/{occ}/range/1/day/{lo}/{min(exp, TODAY)}?adjusted=false&sort=asc&limit=50000")
    res = d.get("results") or []
    with conn.cursor() as cur:
        cur.executemany("INSERT INTO optlab.bars (occ, date, h, c, v) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                        [(occ, day(r["t"]), r.get("h"), r.get("c"), r.get("v")) for r in res])
        cur.execute("INSERT INTO optlab.bars_fetched (occ, n) VALUES (%s,%s) ON CONFLICT (occ) DO UPDATE SET "
                    "n = optlab.bars_fetched.n + EXCLUDED.n, fetched_at = now()", (occ, len(res)))
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
    # Report dates: LSEG first (true announcement dates); earnings_calendar only for names LSEG lacks, minus fiscal period ends
    # that the earnings backfill stores as report dates (A114) — POET: LSEG 08-13 vs calendar 08-19 / 06-30.
    ev = rows(conn, """SELECT ticker AS t, report_date AS d FROM lseg_research.earnings_moves
                       WHERE ticker = ANY(%(t)s) AND report_date BETWEEN %(a)s AND %(b)s
                       UNION
                       SELECT UPPER(ticker), report_date FROM earnings_calendar c
                       WHERE UPPER(ticker) = ANY(%(t)s) AND report_date BETWEEN %(a)s AND %(b)s
                         AND to_char(report_date, 'MM-DD') NOT IN ('03-31', '06-30', '09-30', '12-31')
                         AND NOT EXISTS (SELECT 1 FROM lseg_research.earnings_moves m WHERE m.ticker = UPPER(c.ticker))
                       ORDER BY d DESC""",
              {"t": tickers, "a": START + timedelta(days=30), "b": TODAY - timedelta(days=3)})
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
    while d < TODAY + timedelta(days=60):
        f = d + timedelta(days=(4 - d.weekday()) % 7 + 14)
        if START + timedelta(days=45) <= f < TODAY + timedelta(days=60):  # incl. the next 2 monthlies → IV "today"
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
    import fcntl
    lock = open("/tmp/fildi-logs/option-history.lock", "w")
    try:  # nightly LaunchAgent + manual runs never overlap
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another option_history run holds the lock; exiting")
        return
    try:  # keep the Mac awake while this runs (10-21: jobs ran in seconds-long dark wakes); ends with this process
        import subprocess
        subprocess.Popen(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())], start_new_session=True)
    except OSError:
        pass
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
    import scoreboard  # promised vs live for adopted scores (Settings › Research)
    scoreboard.main()
    import strategy_lib  # Track Record › Strategies backtests (A176)
    strategy_lib.main(write=True)
    progress(conn, "all done")


if __name__ == "__main__":
    main()
