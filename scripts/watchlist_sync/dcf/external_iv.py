"""Outside intrinsic-value estimates next to Fildi fair value (A283; Jamie 10-27: "display them next to our estimate").
One home: watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail).
  starmine   LSEG StarMine intrinsic value = LSEG close ÷ price_to_intrinsic (signals_daily, already fetched daily; no call)
  fmp_dcf    FMP /stable/discounted-cash-flow (unlevered) + levered-discounted-cash-flow. Large caps only on our plan
             (TTD/IONQ return "Premium"); budget 220/day shared → at most --max calls a run, watchlist first, refreshed
             when older than 7 days; a Premium refusal is stored and retried after 30 days.
Raw FMP responses go to vendor_raw; calls are metered in api_usage (source fmp).
Usage: .venv/bin/python dcf/external_iv.py [--max 60] [TICKERS...]"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.external_intrinsic (
  ticker text NOT NULL, as_of date NOT NULL, source text NOT NULL, value double precision, price double precision,
  detail jsonb, PRIMARY KEY (ticker, as_of, source))"""
FMP = "https://financialmodelingprep.com/stable"


def _meter(conn, n: int) -> None:
    if n > 0:
        conn.execute("""INSERT INTO api_usage (source, date, calls_made) VALUES ('fmp', (now() AT TIME ZONE 'America/Los_Angeles')::date, %s)
                        ON CONFLICT (source, date) DO UPDATE SET calls_made = api_usage.calls_made + EXCLUDED.calls_made, updated_at = now()""", (n,))


def starmine(conn) -> int:
    n = conn.execute("""INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail)
        SELECT DISTINCT ON (ticker) ticker, as_of, 'starmine', price_close / price_to_intrinsic, price_close,
               jsonb_build_object('price_to_intrinsic', price_to_intrinsic)
        FROM lseg_research.signals_daily WHERE price_to_intrinsic > 0 AND price_close > 0 AND as_of >= CURRENT_DATE - 10
        ORDER BY ticker, as_of DESC
        ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail""").rowcount
    return n


def _key() -> str | None:
    if not os.environ.get("FMP_API_KEY"):  # daily.py runs without the API server's env → read the repo .env.local
        env = Path(__file__).resolve().parents[3] / ".env.local"
        for line in env.read_text().splitlines() if env.exists() else []:
            if line.startswith("FMP_API_KEY="):
                os.environ["FMP_API_KEY"] = line.split("=", 1)[1].strip().strip('"')
    return os.environ.get("FMP_API_KEY")


def _fmp(conn, path: str, t: str) -> tuple[dict | None, str | None]:
    key = _key()
    try:
        raw = urllib.request.urlopen(f"{FMP}/{path}?symbol={t}&apikey={key}", timeout=30).read().decode()
    except urllib.error.HTTPError as e:  # 402 = symbol not on our plan (small/mid caps)
        raw = f"Premium HTTP {e.code}" if e.code in (401, 402, 403) else f"HTTP {e.code}"
        if not raw.startswith("Premium"):
            return None, raw
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha) VALUES ('fmp', %s, %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                 (path, t, date.today(), json.dumps({"text": raw[:20000]}), hashlib.sha256(raw.encode()).hexdigest()))
    if raw.lstrip().startswith("Premium") or "not available under your current subscription" in raw:
        return None, "premium"
    try:
        d = json.loads(raw)
    except ValueError:
        return None, "bad_json"
    return (d[0], None) if isinstance(d, list) and d else (None, "empty")


def fmp(conn, tickers: list[str], max_calls: int) -> int:
    calls = done = 0
    for t in tickers:
        last = rows(conn, """SELECT as_of, detail FROM watchlist_sync.external_intrinsic WHERE ticker = %s AND source = 'fmp_dcf'
                             ORDER BY as_of DESC LIMIT 1""", (t,))
        if last:
            age = (date.today() - last[0]["as_of"]).days
            if age < 7 or ((last[0]["detail"] or {}).get("unavailable") and age < 30):
                continue
        if calls + 2 > max_calls:
            break
        u, err = _fmp(conn, "discounted-cash-flow", t)
        calls += 1
        lev = None
        if u:
            lv, _ = _fmp(conn, "levered-discounted-cash-flow", t)
            calls += 1
            lev = (lv or {}).get("dcf")
        conn.execute("""INSERT INTO watchlist_sync.external_intrinsic (ticker, as_of, source, value, price, detail) VALUES (%s, %s, 'fmp_dcf', %s, %s, %s)
                        ON CONFLICT (ticker, as_of, source) DO UPDATE SET value = EXCLUDED.value, price = EXCLUDED.price, detail = EXCLUDED.detail""",
                     (t, date.today(), (u or {}).get("dcf"), (u or {}).get("Stock Price"),
                      json.dumps({"levered_dcf": lev, "fmp_date": (u or {}).get("date")} if u else {"unavailable": err})))
        conn.commit()
        done += 1
    _meter(conn, calls)
    conn.commit()
    print(f"fmp_dcf: {done} tickers, {calls} calls")
    return calls


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    max_calls = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 60
    if "--max" in sys.argv:
        args = [a for a in args if a != str(max_calls)]
    with connect() as conn:
        conn.execute(DDL)
        print("starmine rows:", starmine(conn))
        conn.commit()
        if "--probe-calls" in sys.argv:  # meter the hand probes made while building this (10-27: 5 calls)
            _meter(conn, int(args.pop(0))); conn.commit()
        tickers = [a.upper() for a in args] or [r["t"] for r in rows(conn, """
            SELECT t FROM (SELECT DISTINCT UPPER(ticker) t, 0 pri FROM watchlist
                           UNION SELECT f.ticker, 1 FROM ticker_fundamentals f JOIN fair_value_snapshots s ON s.ticker = f.ticker
                           AND s.as_of = (SELECT max(as_of) FROM fair_value_snapshots) WHERE s.price * f.shares_outstanding > 1e11) x
            GROUP BY t ORDER BY MIN(pri), t""")]
        fmp(conn, tickers, max_calls)


if __name__ == "__main__":
    main()
