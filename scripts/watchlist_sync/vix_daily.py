"""Daily VIX / VIX3M closes from Yahoo (free) → watchlist_sync.macro_daily ('vix', 'vix3m'). Raw response → vendor_raw (rule 4c).

Why (10-29): the sold-put market state ('panic' = VIX ÷ VIX3M ≥ 1) read wrds_research.cboe_daily, which WRDS refreshes about
weekly — on 10-29 its last VIX was 10-23. strategy_engine.band_states now takes the freshest of the two.
Run: scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/vix_daily.py
"""
from __future__ import annotations

import hashlib
import json
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
        conn.commit()
    print(f"vix_daily: {n} rows → macro_daily")


if __name__ == "__main__":
    main()
