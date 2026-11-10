#!/usr/bin/env python3
"""S185 / A390 — per-name 30-DTE skew history from LSE OPRA greeks (2025-10 →).

LSE `/v3/export?data=greeks&timeframe=1d` returns, per contract and day, the near-close
quote-MID IV / delta / spot (expired contracts included). One call covers a contract's life,
so per name × monthly expiry we fetch a 6-contract ladder (puts z −1.5/−0.75/0, calls 0/+0.75/+1.5
in σ√T units at the anchor date) and read the smile in delta each day.

  .venv/bin/python analysis/s185_skew_history.py --strikes          # /v3/pairs only (works while rows are exhausted)
  .venv/bin/python analysis/s185_skew_history.py --fetch [--names 150] [--limit N]
  .venv/bin/python analysis/s185_skew_history.py --build            # → skew_daily

Never run beside another LSE job (opra_backfill waits on ~/.fildi/locks/lse.lock).
"""
from __future__ import annotations

import argparse
import csv
import io
import math
import os
import pickle
import sys
import time
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import lse_client as L  # noqa: E402

LOCK = Path.home() / ".fildi/locks/lse.lock"
FIRST_EXP, LAST_EXP = date(2025, 11, 1), date(2026, 12, 31)
LEAD, TAIL = 52, 12            # fetch E−52 … E−12 (skew read at DTE 14–50)
Z_PUT, Z_CALL = (-1.5, -0.75, 0.0), (0.0, 0.75, 1.5)

DDL = """
CREATE TABLE IF NOT EXISTS lse_option_greeks_daily (
  occ text, ticker text, side text, strike numeric, expiry date, date date,
  iv real, delta real, option_price real, price_source text, underlying_price real, rate real,
  fetched_at timestamptz DEFAULT now(), PRIMARY KEY (occ, date));
CREATE TABLE IF NOT EXISTS lse_option_greeks_fetch (
  occ text PRIMARY KEY, ticker text, expiry date, status int, n int, fetched_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS skew_daily (
  ticker text, date date, expiry date, dte int, spot real,
  iv_atm real, iv_atm_c real, iv_atm_p real, iv_p25 real, iv_c25 real,
  cw real, rr25 real, smirk real, n_contracts int, source text DEFAULT 'lse_greeks',
  PRIMARY KEY (ticker, date));
"""


def third_fridays() -> list[date]:
    out, d = [], date(FIRST_EXP.year, FIRST_EXP.month, 1)
    while d <= LAST_EXP:
        f = d + timedelta(days=(4 - d.weekday()) % 7 + 14)
        if FIRST_EXP <= f <= LAST_EXP:
            out.append(f)
        d = date(d.year + (d.month // 12), d.month % 12 + 1, 1)
    return out


def universe(conn, n: int) -> list[str]:
    names = sorted({x["t"] for x in pickle.load(open(Path.home() / ".fildi/cache/s175_trades.pkl", "rb")) if x["s"] == "long_call"})
    r = conn.execute(
        """SELECT ticker, percentile_cont(0.5) WITHIN GROUP (ORDER BY close * volume)
           FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date >= current_date - 365 AND volume > 0
           GROUP BY 1""", (names,)).fetchall()
    return [t for t, _ in sorted(r, key=lambda x: -(x[1] or 0))[:n]]


def anchor(conn, t: str, d: date) -> tuple[float, float] | None:
    r = conn.execute(
        """SELECT close, coalesce(nullif(iv30_call, 0), nullif(iv30_put, 0)) FROM lseg_research.daily_history
           WHERE ticker = %s AND date <= %s AND close > 0 ORDER BY date DESC LIMIT 1""", (t, d)).fetchone()
    if not r:
        return None
    s, iv = float(r[0]), r[1]
    iv = float(iv) / (100.0 if iv and iv > 3 else 1.0) if iv else 0.45
    return s, min(max(iv, 0.10), 2.0)


def ladder(s0: float, sig: float, listed: list[float]) -> list[tuple[str, float]]:
    rt = sig * math.sqrt(LEAD / 365.0)
    snap = lambda k: min(listed, key=lambda x: abs(x - k))  # noqa: E731
    out = [("put", snap(s0 * math.exp(z * rt))) for z in Z_PUT] + [("call", snap(s0 * math.exp(z * rt))) for z in Z_CALL]
    return list(dict.fromkeys(out))


def plan(conn, names: list[str], strikes_only: bool) -> list[tuple[str, str, str, float, date]]:
    jobs, today = [], date.today()
    for t in names:
        for e in third_fridays():
            if e - timedelta(days=LEAD) > today:
                continue
            try:
                listed = L.list_put_strikes(conn, t, e)   # cached in vendor_raw after the first call
            except Exception as ex:  # noqa: BLE001 — one slow listing (AAPL ~3k pairs) must not kill the run
                print(f"  pairs {t} {e}: {type(ex).__name__}", flush=True)
                conn.rollback()
                continue
            if strikes_only or not listed:
                continue
            a = anchor(conn, t, e - timedelta(days=LEAD))
            if not a:
                continue
            for side, k in ladder(a[0], a[1], listed):
                jobs.append((L.occ_symbol(t, e, k, side), t, side, k, e))
    return jobs


def parse(text: str) -> list[dict]:
    rows = list(csv.DictReader(io.StringIO(text)))
    out = []
    for r in rows:
        try:
            iv = float(r.get("iv") or "nan")
        except ValueError:
            continue
        if not (0.01 < iv < 5.0):
            continue
        f = lambda k: float(r[k]) if r.get(k) not in (None, "") else None  # noqa: E731
        out.append({"date": date.fromisoformat(r["time"][:10]), "iv": iv, "delta": f("delta"), "px": f("option_price"),
                    "src": r.get("price_source"), "spot": f("underlying_price"), "rate": f("rate")})
    return out


def fetch(conn, jobs, limit: int) -> None:
    done = {r[0] for r in conn.execute("SELECT occ FROM lse_option_greeks_fetch WHERE status IN (200, 404)")}
    todo = [j for j in jobs if j[0] not in done][: limit or None]
    print(f"fetch: {len(jobs)} planned, {len(done)} done, {len(todo)} to go (~{len(todo)/60:.0f} min)", flush=True)
    t0, nrow = time.time(), 0
    for i, (occ, t, side, k, e) in enumerate(todo):
        st, text = L.export_options_csv(conn, occ, date_from=e - timedelta(days=LEAD), date_to=e - timedelta(days=TAIL),
                                        timeframe="1d", data="greeks")
        if st == 429 and "rows-exhausted" in text:
            print("rows exhausted — stop; rerun after 00:00 UTC", flush=True)
            break
        rows = parse(text) if st == 200 else []
        for r in rows:
            conn.execute(
                """INSERT INTO lse_option_greeks_daily (occ, ticker, side, strike, expiry, date, iv, delta, option_price,
                   price_source, underlying_price, rate) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (occ, date) DO UPDATE SET iv = EXCLUDED.iv, delta = EXCLUDED.delta,
                   option_price = EXCLUDED.option_price, underlying_price = EXCLUDED.underlying_price, fetched_at = now()""",
                (occ, t, side, k, e, r["date"], r["iv"], r["delta"], r["px"], r["src"], r["spot"], r["rate"]))
        code = 200 if st == 200 else (404 if st in (400, 404) or "unknown" in text[:200] else st)
        conn.execute("""INSERT INTO lse_option_greeks_fetch (occ, ticker, expiry, status, n) VALUES (%s,%s,%s,%s,%s)
                        ON CONFLICT (occ) DO UPDATE SET status = EXCLUDED.status, n = EXCLUDED.n, fetched_at = now()""",
                     (occ, t, e, code, len(rows)))
        conn.commit()
        nrow += len(rows)
        LOCK.touch()
        if i % 200 == 0:
            print(f"  {i}/{len(todo)} {occ} st={st} rows={nrow} {time.time()-t0:.0f}s", flush=True)


def interp(pts: list[tuple[float, float]], x: float) -> float | None:
    pts = sorted(pts)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1 and x1 > x0:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    near = [y for xx, y in pts if abs(xx - x) <= 0.03]
    return near[0] if near else None


def build(conn) -> None:
    rows = conn.execute(
        """SELECT ticker, date, expiry, side, abs(delta), iv, underlying_price FROM lse_option_greeks_daily
           WHERE delta IS NOT NULL AND (expiry - date) BETWEEN 14 AND 50 AND coalesce(option_price, 0) >= 0.05""").fetchall()
    by: dict[tuple, dict] = {}
    for t, d, e, side, ad, iv, spot in rows:
        g = by.setdefault((t, d), {}).setdefault(e, {"put": [], "call": [], "spot": spot})
        g[side].append((float(ad), float(iv)))
    out = []
    for (t, d), exps in by.items():
        e = min(exps, key=lambda x: abs((x - d).days - 30))
        g = exps[e]
        p25, c25 = interp(g["put"], 0.25), interp(g["call"], 0.25)
        pa, ca = interp(g["put"], 0.50), interp(g["call"], 0.50)
        if pa is None and ca is None:
            continue
        atm = (pa + ca) / 2 if pa is not None and ca is not None else (pa if pa is not None else ca)
        out.append((t, d, e, (e - d).days, g["spot"], atm, ca, pa, p25, c25,
                    None if pa is None or ca is None else ca - pa,
                    None if p25 is None or c25 is None else c25 - p25,
                    None if p25 is None else p25 - atm, len(g["put"]) + len(g["call"])))
    conn.execute("DELETE FROM skew_daily WHERE source = 'lse_greeks'")
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO skew_daily (ticker, date, expiry, dte, spot, iv_atm, iv_atm_c, iv_atm_p, iv_p25, iv_c25,
                           cw, rr25, smirk, n_contracts) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", out)
    conn.commit()
    full = sum(1 for r in out if r[11] is not None and r[12] is not None)
    print(f"build: {len(out)} name-days ({len({r[0] for r in out})} names), {full} with rr25+smirk "
          f"({100*full/max(len(out),1):.0f} %)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strikes", action="store_true")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--names", type=int, default=150)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    conn = L.connect()
    conn.execute(DDL)
    conn.commit()
    if a.strikes or a.fetch:
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        LOCK.write_text(str(os.getpid()))
        try:
            names = universe(conn, a.names)
            print(f"universe {len(names)}: {names[:8]} …", flush=True)
            jobs = plan(conn, names, strikes_only=a.strikes)
            if a.fetch:
                fetch(conn, jobs, a.limit)
        finally:
            LOCK.unlink(missing_ok=True)
    if a.build:
        build(conn)


if __name__ == "__main__":
    main()
