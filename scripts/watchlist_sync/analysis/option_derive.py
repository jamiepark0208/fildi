"""Derived option-history views for the UI (Claude, PM role, user 2026-10-14). Reads optlab.* raw tables (option_history.py),
writes small tables the API serves as-is:

  optlab.earnings_moves  per report: implied move (ATM straddle close the day before ÷ spot) vs realized move
                         (|first close after report ÷ last close before − 1|; spans both before-open and after-close reports)
  optlab.iv30            per name per day: ~30-day ATM implied vol (Black-Scholes on the near-spot monthly put's close),
                         20-day realized vol, IV rank = percentile of today's IV within the past 252 trading days
  optlab.trades          the trader's short puts (S015 trades.csv) + the sold contract, for Breakdown › Options history
  optlab.findings        one row per study (S017–S021): verdict + recommendation card → Live › Portfolio Alerts › Playbook

    .venv/bin/python analysis/option_derive.py      # idempotent; run any time (option_history.py calls it at the end)
"""
from __future__ import annotations

import csv
import json
import math
import sys
from bisect import bisect_left
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect, rows  # noqa: E402

RATE = 0.0425  # 3-month T-bill, roughly flat over the window; IV error from this is < 0.5 vol pt at 30 days

DDL = """
CREATE TABLE IF NOT EXISTS optlab.earnings_moves (ticker text, report_date date, expiry date, spot real, straddle real,
  implied real, realized real, ratio real, PRIMARY KEY (ticker, report_date));
CREATE TABLE IF NOT EXISTS optlab.iv30 (ticker text, date date, iv real, rv20 real, iv_rank real, occ text,
  PRIMARY KEY (ticker, date));
CREATE TABLE IF NOT EXISTS optlab.trades (key text PRIMARY KEY, account text, ticker text, d0 date, expiry date, strike real,
  premium real, qty real, breached boolean, closed_early boolean, occ text);
CREATE TABLE IF NOT EXISTS optlab.findings (study text PRIMARY KEY, title text, verdict text, headline text, card jsonb,
  updated_at timestamptz DEFAULT now())
"""

FINDINGS = [  # placeholders until each study runs; the study script overwrites its row
    ("S017", "Close early or hold?", "running", "Testing 50 % / 75 % take-profit, 2× stop, close-if-ITM vs holding."),
    ("S018", "Earnings: priced-in vs actual move", "running", "Per name: sell through earnings or skip."),
    ("S019", "True IV rank", "running", "Implied-vol rank built from option prices vs today's realized-vol rank."),
    ("S020", "Spreads / strangles / straddles", "running", "Same entries as your puts, each structure compared."),
    ("S021", "Old backtest check", "running", "Were S003's model-priced puts close to real prices?"),
]


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_put(s: float, k: float, t: float, v: float) -> float:
    d1 = (math.log(s / k) + (RATE + v * v / 2) * t) / (v * math.sqrt(t))
    return k * math.exp(-RATE * t) * ncdf(-(d1 - v * math.sqrt(t))) - s * ncdf(-d1)


def put_iv(price: float, s: float, k: float, t: float) -> float | None:
    if price <= max(k * math.exp(-RATE * t) - s, 0) + 1e-4 or t <= 0:
        return None
    lo, hi = 0.01, 6.0
    if bs_put(s, k, t, hi) < price:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if bs_put(s, k, t, mid) < price else (lo, mid)
    return (lo + hi) / 2


def closes(conn, t: str) -> tuple[list[date], list[float]]:
    r = conn.execute("SELECT date, c FROM optlab.underlying WHERE ticker = %s AND c > 0 ORDER BY date", (t,)).fetchall()
    return [x[0] for x in r], [x[1] for x in r]


def earnings_moves(conn) -> int:
    n = 0
    conn.execute("DELETE FROM optlab.earnings_moves")
    legs = rows(conn, """SELECT key, MAX(occ) FILTER (WHERE role = 'atm_put') AS p, MAX(occ) FILTER (WHERE role = 'atm_call') AS c,
                                MAX(occ) FILTER (WHERE role = 'expiry') AS e
                         FROM optlab.legs WHERE study = 'earnings' GROUP BY key""")
    cache: dict[str, tuple[list[date], list[float]]] = {}
    lseg = {(t, d) for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves").fetchall()}
    lseg_names = {t for t, _ in lseg}
    for g in legs:
        if not (g["p"] and g["c"] and g["e"]):
            continue
        t, rd = g["key"].split("|")
        rd = date.fromisoformat(rd)
        if rd.strftime("%m-%d") in ("03-31", "06-30", "09-30", "12-31") or (t in lseg_names and (t, rd) not in lseg):
            continue  # not a real report date: fiscal period end (A98) or a calendar date LSEG contradicts
        ds, cs = cache.setdefault(t, closes(conn, t))
        i = bisect_left(ds, rd)  # ds[i-1] = last close before the report; first close after = ds[j]
        j = i + 1 if i < len(ds) and ds[i] == rd else i
        if i == 0 or j >= len(ds):
            continue
        before, after, d_before = cs[i - 1], cs[j], ds[i - 1]
        px = {o: c for o, c in conn.execute("SELECT occ, c FROM optlab.bars WHERE occ = ANY(%s) AND date = %s",
                                             ([g["p"], g["c"]], d_before)).fetchall()}
        if len(px) < 2:
            continue
        straddle = px[g["p"]] + px[g["c"]]
        implied, realized = straddle / before, abs(after / before - 1)
        conn.execute("""INSERT INTO optlab.earnings_moves VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT (ticker, report_date) DO UPDATE SET expiry = excluded.expiry, spot = excluded.spot,
                        straddle = excluded.straddle, implied = excluded.implied, realized = excluded.realized, ratio = excluded.ratio""",
                     (t, rd, g["e"], before, straddle, implied, realized, realized / implied if implied > 0 else None))
        n += 1
    conn.commit()
    return n


def iv30(conn) -> int:
    n = 0
    names = [r[0] for r in conn.execute("SELECT DISTINCT split_part(key, '|', 1) FROM optlab.legs WHERE study = 'ivrank'").fetchall()]
    for t in names:
        ds, cs = closes(conn, t)
        spot = dict(zip(ds, cs))
        cands: dict[date, tuple[int, float, str]] = {}
        for occ, exp, k in conn.execute("""SELECT l.occ, c.expiry, c.strike FROM optlab.legs l JOIN optlab.contracts c USING (occ)
                                          WHERE l.study = 'ivrank' AND split_part(l.key, '|', 1) = %s""", (t,)).fetchall():
            for d, c in conn.execute("SELECT date, c FROM optlab.bars WHERE occ = %s AND c > 0", (occ,)).fetchall():
                dte, s = (exp - d).days, spot.get(d)
                if not s or not 15 <= dte <= 50 or abs(k / s - 1) > 0.10:
                    continue
                v = put_iv(c, s, k, dte / 365)
                if v and (d not in cands or abs(dte - 30) < abs(cands[d][0] - 30)):
                    cands[d] = (dte, v, occ)
        days = sorted(cands)
        for d in days:
            i = ds.index(d)
            rv = None
            if i >= 20:
                lr = [math.log(cs[x] / cs[x - 1]) for x in range(i - 19, i + 1)]
                m = sum(lr) / 20
                rv = math.sqrt(sum((x - m) ** 2 for x in lr) / 19 * 252)
            past = [cands[x][1] for x in days if d - timedelta(days=365) <= x <= d]
            rank = sum(1 for x in past if x < cands[d][1]) / (len(past) - 1) if len(past) >= 60 else None
            conn.execute("""INSERT INTO optlab.iv30 VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (ticker, date) DO UPDATE SET
                            iv = excluded.iv, rv20 = excluded.rv20, iv_rank = excluded.iv_rank, occ = excluded.occ""",
                         (t, d, cands[d][1], rv, rank, cands[d][2]))
            n += 1
    conn.commit()
    return n


def trades(conn) -> int:
    with open(HERE.parent / "out/mistakes/trades.csv") as fh:
        tr = list(csv.DictReader(fh))
    sold = dict(conn.execute("SELECT key, occ FROM optlab.legs WHERE study = 'trades' AND role = 'sold_put'").fetchall())
    agg: dict[str, dict] = {}  # split fills of one order share a key → qty-weighted premium
    for r in tr:
        key = f"{r['account']}|{r['ticker']}|{r['d0']}|{r['exp']}|{float(r['k'])}"
        a = agg.setdefault(key, {**r, "qty": 0.0, "prem_x_qty": 0.0})
        a["qty"] += float(r["qty"])
        a["prem_x_qty"] += float(r["fill"]) * float(r["qty"])
    with conn.cursor() as cur:
        for key, r in agg.items():
            cur.execute("""INSERT INTO optlab.trades VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (key) DO UPDATE SET premium = excluded.premium, qty = excluded.qty, occ = excluded.occ""",
                        (key, r["account"], r["ticker"], r["d0"], r["exp"], float(r["k"]), r["prem_x_qty"] / r["qty"], r["qty"],
                         r["breach"] == "True", r["closed"] == "True", sold.get(key)))
    conn.commit()
    return len(agg)


def main() -> None:
    conn = connect()
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    for s, title, verdict, head in FINDINGS:
        conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline) VALUES (%s,%s,%s,%s)
                        ON CONFLICT (study) DO NOTHING""", (s, title, verdict, head))
    conn.commit()
    print(f"trades {trades(conn)} · earnings {earnings_moves(conn)} · iv30 {iv30(conn)}")


if __name__ == "__main__":
    main()
