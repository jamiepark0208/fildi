#!/usr/bin/env python3
"""A241 P3 — lean public VM tick (no Node / no Anthropic).

Updates prices_historical for watchlist tickers from Yahoo chart API.
Idempotent upsert. Logs to /var/log/fildi-public-tick.log and stamps
app_config last_public_tick when that table exists.

Env: DATABASE_URL (default postgresql:///tradedash?host=/var/run/postgresql)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "psycopg2-binary"], stdout=subprocess.DEVNULL)
    import psycopg2  # type: ignore

DB = os.environ.get(
    "DATABASE_URL",
    "postgresql:///tradedash?host=/var/run/postgresql",
)
LOG = Path(os.environ.get("FILDI_TICK_LOG", "/opt/fildi/logs/public-tick.log"))


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).isoformat()} {msg}"
    print(line)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def yahoo_bars(ticker: str, days: int = 10) -> list[tuple]:
    """Return list of (date, open, high, low, close, volume)."""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
        f"?range={days}d&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "fildi-public-tick/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode())
    res = data["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    out = []
    for i, t in enumerate(ts):
        o, h, l, c, v = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
        if c is None:
            continue
        day = datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat()
        out.append((day, o, h, l, c, int(v or 0)))
    return out


def main() -> int:
    conn = psycopg2.connect(DB)
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT ticker FROM watchlist ORDER BY 1")
    tickers = [r[0] for r in cur.fetchall()]
    if not tickers:
        cur.execute("SELECT DISTINCT ticker FROM prices_historical ORDER BY 1 LIMIT 80")
        tickers = [r[0] for r in cur.fetchall()]
    log(f"tick start n={len(tickers)}")
    ok = fail = rows = 0
    for t in tickers:
        try:
            bars = yahoo_bars(t)
            for day, o, h, l, c, v in bars:
                cur.execute(
                    """
                    INSERT INTO prices_historical (ticker, date, open, high, low, close, volume, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, 'yahoo-public')
                    ON CONFLICT (ticker, date) DO UPDATE SET
                      open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                      close = EXCLUDED.close, volume = EXCLUDED.volume, source = EXCLUDED.source
                    """,
                    (t, day, o, h, l, c, v),
                )
                rows += 1
            ok += 1
        except Exception as e:
            fail += 1
            log(f"FAIL {t}: {e}")
        if (ok + fail) % 25 == 0:
            conn.commit()
    conn.commit()
    # stamp
    try:
        cur.execute(
            """
            INSERT INTO app_config (key, value) VALUES ('last_public_tick', %s)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
            """,
            (datetime.now(timezone.utc).isoformat(),),
        )
        conn.commit()
    except Exception:
        conn.rollback()
    cur.close()
    conn.close()
    log(f"tick done ok={ok} fail={fail} upserts={rows}")
    return 0 if fail < max(3, len(tickers) // 2) else 2


if __name__ == "__main__":
    raise SystemExit(main())
