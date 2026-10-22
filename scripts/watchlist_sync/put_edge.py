"""Put edge (S059, Claude 10-19): one home for the literature-backed short-put ranking used by the Model List.

Three factors: IV/RV, vol-of-vol and put-tech. Existing calibration is the prior
fixed-four-session, net-of-fill S059 run; its profit advantage was not significant.
A206 corrects holiday dates to first→last NYSE session of the same week. That new
horizon has NOT been backtested or recalibrated; legacy probabilities remain tagged
as unvalidated for this horizon. No new economic performance claim is implied.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime
from pathlib import Path
from statistics import pstdev

import numpy as np
from weekly_put_calendar import HORIZON_VERSION, weekly_sessions

HERE = Path(__file__).resolve().parent
CAL = HERE / "put_edge_calibration.json"   # written by analysis/s059_option_factors.py (holdout only)
MAX_TECH_AGE_DAYS = 10
MIN_QUINTILE = 4   # A196 net-of-fill holdout: Q1–Q3 lose −3…−7 bp/wk after fills, Q4 ≈ 0, Q5 +22 → weekly lane sells Q4–Q5 only
FILL_SHARE = 0.23   # RH fill = bid + 23 % of the spread (state.md) → cost vs mid = (0.5 − 0.23) × spread
# in-session relative spread (ask − bid) / mid of 2–9 DTE, 0.10–0.25Δ puts by premium ÷ strike (option_chain_history 7–12 PT, n 1,508, 10-19)
SPREAD_BY_PREM = [(0.001, 1.12), (0.003, 0.67), (0.006, 0.39), (0.012, 0.25), (0.03, 0.20)]


def fill_cost(prem_over_k: float) -> float:
    """Expected fill cost per $ of strike when selling at bid + 23 % of the spread instead of mid (log-interpolated spread)."""
    xs, ys = [math.log(x) for x, _ in SPREAD_BY_PREM], [y for _, y in SPREAD_BY_PREM]
    rel = float(np.interp(math.log(max(prem_over_k, 1e-5)), xs, ys))
    return (0.5 - FILL_SHARE) * rel * prem_over_k
MIN_WEEKS = 6   # drift check waits for six resolved weeks (~1,400 sim puts) before it can demote


def _rank(x: list[float]) -> np.ndarray:
    x = np.asarray(x, float)
    o = np.argsort(x, kind="mergesort")
    r = np.empty(len(x))
    r[o] = np.arange(len(x))
    return r / max(len(x) - 1, 1)


def calibration_status(cal: dict | None = None) -> dict:
    """A version match identifies regenerated data, not an independent financial approval."""
    source = cal if cal is not None else json.loads(CAL.read_text())
    version = source.get("horizon_version", "legacy-fixed-4-session")
    return {"calibration_horizon": version, "horizon_revalidated": version == HORIZON_VERSION}


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
    calibration = json.loads(CAL.read_text())
    cal = calibration["quintiles"]
    horizon_status = calibration_status(calibration)
    comp = _rank(sum(_rank([r[k] for r in rows]) for k in (1, 2, 3)))
    out = {}
    for r, p in zip(rows, comp):
        q = min(5, int(p * 5) + 1)
        out[r[0]] = {"iv_rv": round(r[1], 2), "vol_of_vol": round(r[2], 4), "put_tech": round(r[3], 3), "pct": round(float(p), 3),
                     "quintile": q, "pnl_bp": cal[str(q)]["pnl_bp"], "breach": cal[str(q)]["breach"], "tech_asof": str(tech_asof),
                     **horizon_status}
    return out


def log_sim(conn, edge: dict[str, dict], now: datetime | None = None) -> int:
    """Log after the first NYSE session's close, settling at this week's last session.
    Exact entry-date close/IV only; horizon is elapsed sessions (normally four).
    Legacy S059 breach calibration is retained but explicitly not revalidated.
    This is a simulation, not an order; forecast_ledger grades close ≥ strike."""
    from statistics import NormalDist
    from forecast_ledger import UPSERT
    import rules as R
    current = (now or datetime.now(R.ET)).astimezone(R.ET)
    today = current.date()
    sessions = weekly_sessions(today)
    # Conservative 16:00 ET check also waits until 16:00 on early-close days.
    if len(sessions) < 2 or today != sessions[0] or current.hour < 16:
        return 0
    expiry, hold = sessions[-1], len(sessions) - 1
    N, n = NormalDist(), 0
    horizon_status = calibration_status()
    for t, e in edge.items():
        r = conn.execute("""SELECT date, close::float8, iv30_put::float8 FROM lseg_research.daily_history
                            WHERE ticker = %s AND date = %s AND close > 0 AND iv30_put > 0""", (t, today)).fetchone()
        if not r or r[0] != today or not all(math.isfinite(x) and x > 0 for x in r[1:]):
            continue
        S, iv = r[1], r[2] / 100
        tt = hold / 252
        K = round(S * math.exp(-iv * math.sqrt(tt)), 2)
        if K <= 0:
            continue
        d2 = (math.log(S / K) - 0.5 * iv * iv * tt) / (iv * math.sqrt(tt))
        meta = json.dumps({"strike": K, "spot": S, "iv": r[2], "quintile": e["quintile"], "study": "S059",
                           "entry_date": str(today), "expiry_date": str(expiry), "hold_sessions": hold,
                           "horizon_version": HORIZON_VERSION, **horizon_status})
        qid = f"simput:{t}:{expiry}"
        for fc, prob in (("put_edge", 1 - e["breach"]), ("market_iv", N.cdf(d2))):
            conn.execute(UPSERT, (qid, f"Will {t} close ≥ {K} on {expiry}? (simulated 1σ weekly put)", "sim_put_otm", t, fc, round(prob, 4),
                                  current, today, expiry, meta))
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


def persist(conn, edge: dict[str, dict], as_of: date | None = None) -> int:
    """watchlist_sync.put_edge_daily (one row per name per day) → GET /api/options/rankings attaches `edge` + `focus` (Options board).
    as_of must match the day `scores()` was computed for: CURRENT_DATE stamped a replay of 10-20 as today (A243 review #4)."""
    conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.put_edge_daily (
      as_of date NOT NULL, ticker text NOT NULL, quintile int NOT NULL, pnl_bp double precision, breach double precision,
      iv_rv double precision, vol_of_vol double precision, put_tech double precision, pct double precision,
      PRIMARY KEY (as_of, ticker))""")
    day = as_of or date.today()
    with conn.cursor() as cur:
        cur.executemany("""INSERT INTO watchlist_sync.put_edge_daily VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                           ON CONFLICT (as_of, ticker) DO UPDATE SET quintile = EXCLUDED.quintile, pnl_bp = EXCLUDED.pnl_bp,
                           breach = EXCLUDED.breach, iv_rv = EXCLUDED.iv_rv, vol_of_vol = EXCLUDED.vol_of_vol,
                           put_tech = EXCLUDED.put_tech, pct = EXCLUDED.pct""",
                        [(day, t, e["quintile"], e["pnl_bp"], e["breach"], e["iv_rv"], e["vol_of_vol"], e["put_tech"], e["pct"]) for t, e in edge.items()])
    return len(edge)


STATUS_DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.put_edge_status (
  as_of date PRIMARY KEY, demoted boolean NOT NULL, reasons jsonb NOT NULL DEFAULT '[]', updated_at timestamptz DEFAULT now())"""


def set_status(conn, warnings: list[str]) -> bool:
    """Enforce the drift check (A196: it only warned). Any DRIFT warning → put edge demoted today: build_plan ranks weekly puts by
    option_score and stops the quintile block; the Options Focus view falls back to top option score. Clears when the check passes."""
    conn.execute(STATUS_DDL)
    demoted = any(w.startswith("DRIFT: put edge") for w in warnings)
    conn.execute("""INSERT INTO watchlist_sync.put_edge_status (as_of, demoted, reasons) VALUES (CURRENT_DATE, %s, %s)
                    ON CONFLICT (as_of) DO UPDATE SET demoted = EXCLUDED.demoted, reasons = EXCLUDED.reasons, updated_at = now()""",
                 (demoted, json.dumps([w for w in warnings if w.startswith("DRIFT: put edge")])))
    return demoted


def is_demoted(conn) -> bool:
    conn.execute(STATUS_DDL)
    r = conn.execute("SELECT demoted FROM watchlist_sync.put_edge_status ORDER BY as_of DESC LIMIT 1").fetchone()
    return bool(r and r[0])
