#!/usr/bin/env python3
"""Sector / theme ETF closes for the band engine's per-name market state (A277, Jamie 10-26: "SPY is not specific enough —
each sector should have a benchmark ETF, like SOXX").

One table, `watchlist_sync.sector_etf_daily(ticker, date, close)`, split- and dividend-consistent per ETF:
  LSEG daily_history where it has the ETF (the 14 broad ones, 2018 →)
  else CRSP dsf (retx-chained, 2017-11 → 2024-12; research/wrds/sync_crsp.py) stitched to Polygon adjusted daily aggs
  (2024-10 →, incremental, raw response kept in vendor_raw, rule 4c) at their first shared day.
A name's sector = the ETF its daily returns tracked best over the prior year (band_engine), so theme ETFs (rare earths,
data centers, crypto miners …) pick up names a GICS sector would miss.

    .venv/bin/python sector_etfs.py            # daily.py: refresh (≤ 1 Polygon call per ETF per day, 5/min gate)
    .venv/bin/python sector_etfs.py board      # every ETF: 1m / 3m / off high, crashed ones first
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "analysis"))

from build_plan import connect  # noqa: E402

BROAD = {"XLK": "tech", "XLF": "financials", "XLE": "energy", "XLV": "health care", "XLY": "consumer discretionary",
         "XLI": "industrials", "XLC": "communications", "XLP": "staples", "XLU": "utilities", "XLB": "materials",
         "XLRE": "real estate", "SMH": "semiconductors", "QQQ": "Nasdaq 100", "IWM": "small caps"}
THEMES = {"SOXX": "semiconductors", "IGV": "software", "SKYY": "cloud", "CIBR": "cybersecurity", "FDN": "internet",
          "ARKK": "speculative growth", "BOTZ": "robotics / AI", "SRVR": "data centers / towers", "DTCR": "data centers",
          "GRID": "power grid", "NLR": "nuclear", "URA": "uranium", "REMX": "rare earths", "LIT": "lithium / batteries",
          "COPX": "copper miners", "XME": "metals & mining", "GDX": "gold miners", "TAN": "solar", "ICLN": "clean energy",
          "XOP": "oil & gas E&P", "XBI": "biotech", "IBB": "large biotech", "KRE": "regional banks", "KBE": "banks",
          "IAI": "brokers / exchanges", "BLOK": "blockchain", "BITO": "bitcoin", "WGMI": "bitcoin miners",
          "ITA": "aerospace & defense", "UFO": "space", "IYT": "transports", "JETS": "airlines", "XHB": "homebuilders",
          "XRT": "retail", "PAVE": "infrastructure"}
ETFS = {**BROAD, **THEMES}
DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.sector_etf_daily (
  ticker text NOT NULL, date date NOT NULL, close double precision NOT NULL, source text NOT NULL, PRIMARY KEY (ticker, date))"""


def _polygon(conn, t: str, frm: date) -> list[tuple[date, float]]:
    import option_history as O
    end = date.today()
    path = f"/v2/aggs/ticker/{t}/range/1/day/{frm}/{end}?adjusted=true&sort=asc&limit=50000"
    d = O.get(path)
    if d:
        payload = json.dumps(d)
        conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                        VALUES ('polygon', 'aggs/day', %s, %s, %s::jsonb, %s)
                        ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                        payload_sha = EXCLUDED.payload_sha""",
                     (f"{t}:{frm}", end, payload, hashlib.sha256(payload.encode()).hexdigest()))
    O.flush_usage(conn)
    return [(O.day(r["t"]), float(r["c"])) for r in d.get("results") or [] if r.get("c")]


def _crsp(conn, t: str) -> list[tuple[date, float]]:
    """retx-chained index (split-safe, ex-dividend like a close); the permno with the latest data (old SMH HOLDRS etc. dropped)."""
    rs = conn.execute("""WITH p AS (SELECT permno FROM wrds_research.crsp_dsf WHERE ticker = %s GROUP BY 1 ORDER BY MAX(date) DESC LIMIT 1)
                         SELECT date, retx::float8 FROM wrds_research.crsp_dsf WHERE ticker = %s AND permno = (SELECT permno FROM p)
                         AND retx IS NOT NULL ORDER BY date""", (t, t)).fetchall()
    out, lvl = [], 100.0
    for d, r in rs:
        lvl *= 1 + r
        out.append((d, lvl))
    return out


def refresh():
    with connect() as conn:
        conn.execute(DDL)
        have = dict(conn.execute("SELECT ticker, MAX(date) FROM watchlist_sync.sector_etf_daily GROUP BY 1").fetchall())
        lseg = dict(conn.execute("SELECT ticker, MIN(date) FROM lseg_research.daily_history WHERE ticker = ANY(%s) GROUP BY 1",
                                 (list(ETFS),)).fetchall())
        n = 0
        for t in ETFS:
            if t in lseg and lseg[t] <= date(2019, 1, 1):
                rows = conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker = %s AND close > 0 "
                                    "AND date > COALESCE(%s, '1900-01-01'::date)", (t, have.get(t))).fetchall()
                src = "lseg"
            elif have.get(t) and have[t] >= date.today() - timedelta(days=1):
                continue
            elif have.get(t):   # incremental: Polygon from the last stored day, scaled to the stored level
                pol = _polygon(conn, t, have[t])
                last = conn.execute("SELECT close FROM watchlist_sync.sector_etf_daily WHERE ticker = %s AND date = %s",
                                    (t, have[t])).fetchone()[0]
                base = next((c for d, c in pol if d == have[t]), None)
                rows = [(d, c * last / base) for d, c in pol if base and d > have[t]]
                src = "polygon"
            else:               # first build: CRSP history + Polygon, stitched at the first shared day
                cr, pol = _crsp(conn, t), _polygon(conn, t, date.today() - timedelta(days=729))
                pd_ = dict(pol)
                join = next((d for d, _ in cr if d in pd_), None)
                if cr and join:
                    k = dict(cr)[join] / pd_[join]
                    rows = [(d, c) for d, c in cr] + [(d, c * k) for d, c in pol if d > join]
                    src = "crsp+polygon"
                else:
                    rows, src = (pol, "polygon") if pol else (cr, "crsp")
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO watchlist_sync.sector_etf_daily VALUES (%s,%s,%s,%s) ON CONFLICT (ticker, date) "
                                "DO UPDATE SET close = EXCLUDED.close, source = EXCLUDED.source", [(t, d, c, src) for d, c in rows])
            conn.commit()
            n += len(rows)
        print(f"sector ETFs: {len(ETFS)} ETFs, {n:,} new rows → watchlist_sync.sector_etf_daily")


def board():
    """Every ETF by drawdown; under each one in sector drop, the names that track it (best return correlation over the
    trailing year among all 49) with today's engine put. Themes are for finding names; the band comes from the broad ETF."""
    import band_engine as BE
    with connect() as conn:
        recs = [r for (r,) in conn.execute("""SELECT payload FROM watchlist_sync.put_recs_daily
                                              WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_recs_daily)""")]
        names = [r["ticker"] for r in recs if r["ticker"] not in ETFS]
        px = BE._closes(conn, list(ETFS) + names, date.today() - timedelta(days=400))
    end = max(max(px[e]) for e in ETFS if px.get(e))
    for r in recs:
        r["sector"] = BE._best_etf(px, r["ticker"], sorted(d for d in px.get(r["ticker"], {}) if d > end - timedelta(days=365)),
                                   list(ETFS)) if px.get(r["ticker"]) else None
    out = []
    for e in ETFS:
        ds = sorted(px.get(e, {}))
        if len(ds) < 252:
            continue
        c = px[e]
        dd = BE._etf_dd(px, e, ds[-1])
        out.append((dd, e, c[ds[-1]] / c[ds[-22]] - 1, c[ds[-1]] / c[ds[-64]] - 1, ds[-1]))
    for dd, e, m1, m3, d in sorted(out):
        flag = "SECTOR DROP" if dd <= BE.SECTOR_DD else ""
        print(f"{e:5s} {ETFS[e]:24s} 1m {m1:+6.1%} 3m {m3:+6.1%} off high {dd:+6.1%} {d} {flag}")
        if flag:   # the names that track this ETF, with today's engine put (income %/wk · pass or first gate)
            for r in sorted((r for r in recs if r.get("sector") == e), key=lambda r: -(r.get("income_wk_pct") or 0)):
                pick = (f"{r['strike']:g}p {r['expiry']} {-r['delta']:.2f}Δ {r['income_wk_pct']:.2f}%/wk "
                        f"{'PASS' if r.get('rank') and not r.get('gates') else (r.get('gates') or ['—'])[0]}") if r.get("strike") else "no pick"
                print(f"        {r['ticker']:6s} {pick}")


if __name__ == "__main__":
    {"refresh": refresh, "board": board}[sys.argv[1] if len(sys.argv) > 1 else "refresh"]()
