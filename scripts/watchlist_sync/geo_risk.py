#!/usr/bin/env python3
"""Geopolitical Risk index (Key Themes › Geopolitics; Jamie 10-28: "you forgot geopolitical tension").

Caldara & Iacoviello (Federal Reserve Board) daily GPR: share of articles in 10 major newspapers about geopolitical
tension, 1985 → yesterday, free (matteoiacoviello.com/gpr.htm). GPRD = total, GPRD_ACT = acts (wars, attacks),
GPRD_THREAT = threats. 1985–2019 average = 100. Raw file → vendor_raw (rule 4c); series → watchlist_sync.macro_daily
(series, date, value): gprd, gprd_act, gprd_threat, gprd_ma30.
Oil (how geopolitics reaches inflation and margins): FRED keyless CSV DCOILWTICO / DCOILBRENTEU → series wti, brent.

    .venv/bin/python geo_risk.py        # daily.py (one ~1 MB download)
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))
from build_plan import connect  # noqa: E402

URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls"
COLS = {"GPRD": "gprd", "GPRD_ACT": "gprd_act", "GPRD_THREAT": "gprd_threat", "GPRD_MA30": "gprd_ma30"}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.macro_daily (
  series text NOT NULL, date date NOT NULL, value double precision, source text, updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (series, date))"""


FRED = {"wti": "DCOILWTICO", "brent": "DCOILBRENTEU"}


def fred(conn, start: str) -> int:
    n = 0
    for name, sid in FRED.items():
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd={start}"
        with urllib.request.urlopen(url, timeout=60) as r:
            text = r.read().decode()
        conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                        VALUES ('fred', %s, %s, %s, %s::jsonb, %s)
                        ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                        payload_sha = EXCLUDED.payload_sha""",
                     (sid, start, date.today(), json.dumps({"csv": text}), hashlib.sha256(text.encode()).hexdigest()))
        data = []
        for line in text.splitlines()[1:]:
            d, _, v = line.partition(",")
            if v and v != ".":
                data.append((name, d, float(v), "fred"))
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.macro_daily (series, date, value, source) VALUES (%s,%s,%s,%s)
                               ON CONFLICT (series, date) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""", data)
        n += len(data)
    return n


def _has_calamine() -> bool:
    try:
        import python_calamine  # noqa: F401
        return True
    except ImportError:
        return False


def main() -> None:
    with urllib.request.urlopen(URL, timeout=60) as r:
        blob = r.read()
    df = pd.read_excel(io.BytesIO(blob), engine="calamine") if _has_calamine() else pd.read_excel(io.BytesIO(blob))
    conn = connect()
    conn.execute(DDL)
    last = df.tail(400)
    payload = json.dumps({"url": URL, "rows": json.loads(last.to_json(orient="records", date_format="iso"))})
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('gpr', 'data_gpr_daily_recent', 'last400', %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha""",
                 (date.today(), payload, hashlib.sha256(blob).hexdigest()))
    n0 = conn.execute("SELECT count(*) FROM watchlist_sync.macro_daily WHERE series = 'gprd'").fetchone()[0]
    rows = df if n0 < 1000 else df.tail(60)   # first run: full history (1985 →), then the recent tail
    with conn.cursor() as cur:
        for src, name in COLS.items():
            data = [(name, d.date(), float(v), "gpr") for d, v in zip(pd.to_datetime(rows["date"]), rows[src]) if pd.notna(v)]
            cur.executemany("""INSERT INTO watchlist_sync.macro_daily (series, date, value, source) VALUES (%s,%s,%s,%s)
                               ON CONFLICT (series, date) DO UPDATE SET value = EXCLUDED.value, updated_at = now()""", data)
    n_wti = conn.execute("SELECT count(*) FROM watchlist_sync.macro_daily WHERE series = 'wti'").fetchone()[0]
    n_oil = fred(conn, "2000-01-01" if n_wti < 5000 else str(date.today().replace(year=date.today().year - 1)))
    conn.commit()
    t = df.iloc[-1]
    print(f"geo risk: {len(rows)} days; last {pd.to_datetime(t['date']).date()} GPR {t['GPRD']:.0f} (30 d avg {t['GPRD_MA30']:.0f}; 1985–2019 = 100); oil rows {n_oil}")


if __name__ == "__main__":
    main()
