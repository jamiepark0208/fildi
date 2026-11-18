"""Daily VIX / VIX3M closes from Yahoo (free) → watchlist_sync.macro_daily ('vix', 'vix3m'). Raw response → vendor_raw (rule 4c).

Why (10-29): the sold-put market state ('panic' = VIX ÷ VIX3M ≥ 1) read wrds_research.cboe_daily, which WRDS refreshes about
weekly — on 10-29 its last VIX was 10-23. strategy_engine.band_states now takes the freshest of the two.
Run: scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/vix_daily.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

from build_plan import connect

SYMBOLS = {"vix": "^VIX", "vix3m": "^VIX3M"}


def fetch(sym: str) -> dict:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?range=1mo&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def load_hy_oas(conn, backfill: bool = False) -> int:
    """ICE BofA US High Yield OAS (FRED BAMLH0A0HYM2, free, no key) → macro_daily 'hy_oas' (%). Jamie 11-17: the selloff
    started with CoreWeave debt — if stocks bounce while this widens, the bounce is suspect (Today › bottom checklist)."""
    since = "2010-01-01" if backfill else date.fromordinal(date.today().toordinal() - 45).isoformat()
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2&cosd={since}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "curl/8"}), timeout=20) as r:  # FRED stalls browser UAs
            text = r.read().decode()
    except Exception as e:  # FRED down must not fail the VIX load
        print(f"  hy_oas: fetch failed ({e})")
        return 0
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('fred', 'fredgraph.csv', 'BAMLH0A0HYM2', %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha""",
                 (date.today(), json.dumps({"csv": text}), hashlib.sha256(text.encode()).hexdigest()))
    rows = []
    for line in text.strip().splitlines()[1:]:
        d, _, v = line.partition(",")
        if v and v != ".":
            rows.append(("hy_oas", date.fromisoformat(d), float(v), "fred"))
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.macro_daily (series, date, value, source) VALUES (%s,%s,%s,%s)
                           ON CONFLICT (series, date) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source,
                           updated_at = now()""", rows)
    if rows:
        print(f"  hy_oas: {len(rows)} days, last {rows[-1][1]} {rows[-1][2]:.2f}")
    return len(rows)


def main() -> None:
    n = 0
    with connect() as conn:
        for series, sym in SYMBOLS.items():
            raw = fetch(sym)
            text = json.dumps(raw)
            conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                            VALUES ('yahoo', 'chart/1d', %s, %s, %s::jsonb, %s)
                            ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                            payload_sha = EXCLUDED.payload_sha""",
                         (sym, date.today(), text, hashlib.sha256(text.encode()).hexdigest()))
            res = raw["chart"]["result"][0]
            closes = res["indicators"]["quote"][0]["close"]
            today = date.today()
            data = [(series, datetime.fromtimestamp(ts, timezone.utc).date(), float(c), "yahoo")
                    for ts, c in zip(res["timestamp"], closes) if c is not None]
            # today's bar is partial until the close: keep only completed days (B14)
            data = [d for d in data if d[1] < today or datetime.now().hour >= 14]
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO watchlist_sync.macro_daily (series, date, value, source) VALUES (%s,%s,%s,%s)
                                   ON CONFLICT (series, date) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source,
                                   updated_at = now()""", data)
            n += len(data)
            print(f"  {series}: {len(data)} days, last {data[-1][1]} {data[-1][2]:.2f}")
        n += load_hy_oas(conn, backfill="--backfill" in sys.argv)
        conn.commit()
    print(f"vix_daily: {n} rows → macro_daily")


if __name__ == "__main__":
    main()
