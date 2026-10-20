"""Put edge (S059, Claude 10-19): one home for the literature-backed short-put ranking used by the Model List.

Three factors, each passing on 79k simulated weekly puts (S045 harness) and together beating the live put tech score on the
2024-07 → holdout (+8.5 bp/wk top quintile, t 2.4; breach −1.2 pp):
  iv_rv       LSEG IV30 put ÷ 20-day realized vol             Goyal & Saretto 2009 (t +12)
  vol_of_vol  σ of daily Δln(IV30 put), 60 days              Cao, Vasquez, Xiao & Zhan (t +5.0 after IV controls)
  put_tech    trendContext − volumeConfirm (lab_tech v2)       S045 / A167 (t +6.1)
Composite = rank of the summed within-universe ranks (same as the study) → quintile → simulated pnl/breach from
put_edge_calibration.json (holdout only). Same definitions as analysis/lab_outcomes.py and s059_option_factors.py.
"""
from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path
from statistics import pstdev

import numpy as np

HERE = Path(__file__).resolve().parent
CAL = HERE / "put_edge_calibration.json"   # written by analysis/s059_option_factors.py (holdout only)
MAX_TECH_AGE_DAYS = 10
MIN_WEEKS = 6   # drift check waits for six resolved weeks (~1,400 sim puts) before it can demote


def _rank(x: list[float]) -> np.ndarray:
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort")
    r = np.empty(len(x))
    r[o] = np.arange(len(x))
    return r / max(len(x) - 1, 1)


def scores(conn, as_of: date | None = None) -> dict[str, dict]:
    """{ticker: {iv_rv, vol_of_vol, put_tech, pct, quintile, pnl_bp, breach}} for every name with all three factors.
    as_of = point-in-time replay (verification); default today."""
    today = as_of or date.today()
    hist: dict[str, list] = {}
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float8, iv30_put::float8 FROM lseg_research.daily_history
                                       WHERE date BETWEEN %s::date - 120 AND %s AND close > 0 ORDER BY ticker, date""", (today, today)).fetchall():
        hist.setdefault(t, []).append((d, c, iv))
    tech_asof = conn.execute("SELECT MAX(as_of) FROM watchlist_sync.lab_tech WHERE as_of <= %s", (today,)).fetchone()[0]
    tech = {}
    if tech_asof and (today - tech_asof).days <= MAX_TECH_AGE_DAYS:
        for t, v2 in conn.execute("SELECT ticker, v2 FROM watchlist_sync.lab_tech WHERE as_of = %s", (tech_asof,)).fetchall():
            comps = (v2 or {}).get("comps") or {}
            if comps.get("trendContext") is not None and comps.get("volumeConfirm") is not None:
                tech[t] = comps["trendContext"] - comps["volumeConfirm"]
    import re
    etfs = set(re.findall(r'"([A-Z.]+)"', (HERE.parents[1] / "lib/db/src/etf-exclusions.ts").read_text()))
    rows = []
    for t, b in hist.items():
        if t in etfs:
            continue
        while b and not b[-1][2]:   # today's OHLC bar can land before its IV: score as of the latest bar with IV
            b = b[:-1]
        if t not in tech or len(b) < 61 or (today - b[-1][0]).days > 7:
            continue
        cl = [x[1] for x in b]
        lr = [math.log(cl[k] / cl[k - 1]) for k in range(len(cl) - 20, len(cl))]
        rv20 = pstdev(lr) * math.sqrt(252) * 100
        ivs = [x[2] for x in b[-61:] if x[2]]
        if not b[-1][2] or not rv20 or len(ivs) < 40:
            continue
        if not 0.3 <= b[-1][2] / rv20 <= 5:   # outside this = a data error (10-19: NVDY income ETF read 9.6×), not premium
            continue
        rows.append((t, b[-1][2] / rv20, float(np.std(np.diff(np.log(ivs)))), tech[t]))
    if len(rows) < 30:
        return {}
    cal = json.loads(CAL.read_text())["quintiles"]
    comp = _rank(sum(_rank([r[k] for r in rows]) for k in (1, 2, 3)))
    out = {}
    for r, p in zip(rows, comp):
        q = min(5, int(p * 5) + 1)
        out[r[0]] = {"iv_rv": round(r[1], 2), "vol_of_vol": round(r[2], 4), "put_tech": round(r[3], 3), "pct": round(float(p), 3),
                     "quintile": q, "pnl_bp": cal[str(q)]["pnl_bp"], "breach": cal[str(q)]["breach"], "tech_asof": str(tech_asof)}
    return out


def log_sim(conn, edge: dict[str, dict]) -> int:
    """Weekly simulated puts for every scored name (Jamie 10-19: "simulate similar trades" — ~236 graded/week instead of ~6 live).
    Monday (first session of the week) only, same trade as the S045/S059 simulator: K = S·exp(−IV·√(5/252)), expiry Friday.
    Forecasters on 'stays OTM': put_edge (1 − quintile breach, holdout-calibrated) vs market (BS N(d2) at the same IV).
    Resolved by forecast_ledger (qtype sim_put_otm → close ≥ strike), so put_edge is graded by Brier every week."""
    from datetime import datetime
    from statistics import NormalDist
    from forecast_ledger import UPSERT
    import rules as R
    today = date.today()
    if today.weekday() != 0 and not (today.weekday() == 1 and not R.is_trading_day(today - timedelta(days=1))):
        return 0
    fri = today + timedelta(days=4 - today.weekday())
    N, n = NormalDist(), 0
    for t, e in edge.items():
        r = conn.execute("""SELECT close::float8, iv30_put::float8 FROM lseg_research.daily_history WHERE ticker = %s AND iv30_put > 0
                            ORDER BY date DESC LIMIT 1""", (t,)).fetchone()
        if not r:
            continue
        S, iv = r[0], r[1] / 100
        tt = 5 / 252
        K = round(S * math.exp(-iv * math.sqrt(tt)), 2)
        d2 = (math.log(S / K) - 0.5 * iv * iv * tt) / (iv * math.sqrt(tt))
        meta = json.dumps({"strike": K, "spot": S, "iv": r[1], "quintile": e["quintile"], "study": "S059"})
        qid = f"simput:{t}:{fri}"
        for fc, prob in (("put_edge", 1 - e["breach"]), ("market_iv", N.cdf(d2))):
            conn.execute(UPSERT, (qid, f"Will {t} close ≥ {K} on {fri}? (simulated 1σ weekly put)", "sim_put_otm", t, fc, round(prob, 4),
                                  datetime.now(), today, fri, meta))
            n += 1
    return n


def drift(conn) -> list[str]:
    """Auto-demotion check: live resolved simulated puts vs the backtest. Weeks are one correlated draw each (10-19 replay: one crash
    week breached 40 % of names and alone tripped a pooled check), so it needs ≥ MIN_WEEKS resolved weeks and judges week by week."""
    rows = conn.execute("""SELECT resolves_on, (meta->>'quintile')::int q, outcome FROM watchlist_sync.forecast_ledger
                           WHERE qtype = 'sim_put_otm' AND forecaster = 'put_edge' AND outcome IS NOT NULL""").fetchall()
    wk: dict = {}
    for d, q, y in rows:
        wk.setdefault(d, {}).setdefault(q, []).append(0 if y else 1)
    weeks = [w for w in wk.values() if len(w.get(5, [])) >= 10 and len(w.get(1, [])) >= 10]
    if len(weeks) < MIN_WEEKS:
        return []
    worse = sum(1 for w in weeks if sum(w[5]) / len(w[5]) >= sum(w[1]) / len(w[1]))
    out = []
    if worse / len(weeks) > 0.6:
        out.append(f"DRIFT: put edge Q5 breached ≥ Q1 in {worse}/{len(weeks)} live weeks → demote put_edge (rank by option_score)")
    b = conn.execute("""SELECT forecaster, AVG(POWER(prob - outcome::int, 2)) FROM watchlist_sync.forecast_ledger
                        WHERE qtype = 'sim_put_otm' AND outcome IS NOT NULL GROUP BY 1""").fetchall()
    bb = dict(b)
    if bb.get("put_edge") and bb.get("market_iv") and bb["put_edge"] > 1.05 * bb["market_iv"]:
        out.append(f"DRIFT: put edge Brier {bb['put_edge']:.4f} worse than market IV {bb['market_iv']:.4f} on live simulated puts")
    return out


def persist(conn, edge: dict[str, dict]) -> int:
    """watchlist_sync.put_edge_daily (one row per name per day) → GET /api/options/rankings attaches `edge` + `focus` (Options board)."""
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_edge_daily (
      as_of date NOT NULL, ticker text NOT NULL, quintile int NOT NULL, pnl_bp double precision, breach double precision,
      iv_rv double precision, vol_of_vol double precision, put_tech double precision, pct double precision,
      PRIMARY KEY (as_of, ticker))""")
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.put_edge_daily VALUES (CURRENT_DATE, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT (as_of, ticker) DO UPDATE SET quintile = EXCLUDED.quintile, pnl_bp = EXCLUDED.pnl_bp,
                           breach = EXCLUDED.breach, iv_rv = EXCLUDED.iv_rv, vol_of_vol = EXCLUDED.vol_of_vol,
                           put_tech = EXCLUDED.put_tech, pct = EXCLUDED.pct""",
                        [(t, e["quintile"], e["pnl_bp"], e["breach"], e["iv_rv"], e["vol_of_vol"], e["put_tech"], e["pct"]) for t, e in edge.items()])
    return len(edge)
