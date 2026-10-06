#!/usr/bin/env python3
"""Scorecard lab: forward outcomes + candidate features for every (ticker, as_of) replayed in watchlist_sync.lab_tech.

Computed once, stored in watchlist_sync.lab_outcomes, so re-tests (new weights, new components) never re-read raw history.
Everything in `features` is point-in-time (data on or before as_of); everything in `outcomes` is strictly after as_of.

outcomes (strategy-neutral; each scorecard is judged on the claim it makes):
  ret_{5,21,63,126}      forward return            rel_{5,21,63,126}  minus the peer-group median that date (universe if < 4 peers)
  mae_21 / mfe_21        worst low / best high over the next 21 trading days vs entry close
  rv_fwd_21              realized vol over the next 21 trading days (annualized, %)
  vrp_real               entry 30d ATM IV − rv_fwd_21 (pts): > 0 = options were rich (the options scorecard's claim)
features (Step 8 candidates, literature set): dd_52w, mom_12_1, dist_ma200, rev5, beta, idio_vol, iv30, iv_rv, iv_rank_1y,
  earnings_21 (report within 21 trading days), alpha (StarMine combined alpha rank, point-in-time), and market context
  mkt_med_dd (median stock's 52w drawdown that date), spy_dd_52w, spy_vrp (SPY IV − SPY 20d RV).

Usage: .venv/bin/python analysis/lab_outcomes.py   (idempotent; recomputes all rows)
"""
from __future__ import annotations

import json
import math
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from pathlib import Path
from statistics import median, pstdev

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.lab_outcomes (
  ticker text NOT NULL, as_of date NOT NULL, outcomes jsonb NOT NULL, features jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ticker, as_of))"""
H = (5, 21, 63, 126)


def rv(cl, a, b):
    lr = [math.log(cl[k] / cl[k - 1]) for k in range(max(1, a), b + 1) if cl[k - 1] > 0 and cl[k] > 0]
    return pstdev(lr) * math.sqrt(252) * 100 if len(lr) >= 10 else None


def main() -> None:
    with connect() as conn:
        conn.execute(DDL)
        keys = rows(conn, "SELECT DISTINCT ticker, as_of, inputs->>'peerGroupId' peer FROM watchlist_sync.lab_tech")
        S = defaultdict(lambda: {"d": [], "c": [], "h": [], "l": [], "iv": []})
        for r in rows(conn, """SELECT ticker, date, close::float8 c, high::float8 h, low::float8 l, iv30_put::float8 iv
                               FROM lseg_research.daily_history WHERE close IS NOT NULL ORDER BY ticker, date"""):
            s = S[r["ticker"]]
            s["d"].append(r["date"]); s["c"].append(r["c"]); s["h"].append(r["h"] or r["c"]); s["l"].append(r["l"] or r["c"]); s["iv"].append(r["iv"])
        er = defaultdict(list)
        for r in rows(conn, "SELECT ticker, report_date d FROM lseg_research.earnings_moves UNION SELECT ticker, event_date FROM lseg_research.events WHERE event_type = 'EarningsReleases'"):
            er[r["ticker"]].append(r["d"])
        for t in er:
            er[t].sort()
        sm = defaultdict(list)
        for r in rows(conn, "SELECT ticker, obs_date, value::float8 v FROM lseg_research.starmine_history WHERE metric = 'combined_alpha_rank' ORDER BY obs_date"):
            sm[r["ticker"]].append((r["obs_date"], r["v"]))
    spy = S["SPY"]
    spos = {d: i for i, d in enumerate(spy["d"])}
    recs = []
    for k in keys:
        t, a = k["ticker"], k["as_of"]
        s = S.get(t)
        if not s:
            continue
        i = bisect_right(s["d"], a) - 1
        if i < 252:
            continue
        cl, hi, lo, ivs = s["c"], s["h"], s["l"], s["iv"]
        c0 = cl[i]
        o = {}
        for h in H:
            o[f"ret_{h}"] = cl[i + h] / c0 - 1 if i + h < len(cl) else None
        if i + 21 < len(cl):
            o["mae_21"] = min(lo[i + 1:i + 22]) / c0 - 1
            o["mfe_21"] = max(hi[i + 1:i + 22]) / c0 - 1
            o["rv_fwd_21"] = rv(cl, i + 1, i + 21)
            o["vrp_real"] = (ivs[i] - o["rv_fwd_21"]) if ivs[i] and o["rv_fwd_21"] else None
        f = {}
        f["dd_52w"] = c0 / max(cl[i - 251:i + 1]) - 1
        f["mom_12_1"] = cl[i - 21] / cl[i - 252] - 1
        f["dist_ma200"] = c0 / (sum(cl[i - 199:i + 1]) / 200) - 1
        f["rev5"] = c0 / cl[i - 5] - 1
        rv20 = rv(cl, i - 19, i)
        f["iv30"] = ivs[i]
        f["iv_rv"] = ivs[i] / rv20 if ivs[i] and rv20 else None
        hist = [x for x in ivs[max(0, i - 252):i] if x]
        f["iv_rank_1y"] = (sum(x <= ivs[i] for x in hist) / len(hist)) if ivs[i] and len(hist) >= 60 else None
        # beta / idio vol vs SPY, 1 year
        xs, ys = [], []
        for n in range(i - 250, i + 1):
            p, q = spos.get(s["d"][n]), spos.get(s["d"][n - 1])
            if p is not None and q is not None and cl[n - 1] > 0 and spy["c"][q] > 0:
                ys.append(math.log(cl[n] / cl[n - 1])); xs.append(math.log(spy["c"][p] / spy["c"][q]))
        if len(xs) >= 120:
            X, Y = np.array(xs), np.array(ys)
            b = float(np.cov(X, Y)[0, 1] / np.var(X, ddof=1))
            f["beta"], f["idio_vol"] = b, float(np.std(Y - b * X, ddof=1) * math.sqrt(252))
        j = bisect_right(s["d"], a)
        nxt = next((d for d in er.get(t, []) if d > a), None)
        f["earnings_21"] = 1.0 if nxt and j + 21 < len(s["d"]) and nxt <= s["d"][min(len(s["d"]) - 1, i + 21)] else 0.0
        al = [v for d, v in sm.get(t, []) if d <= a]
        f["alpha"] = al[-1] if al else None
        k_ = bisect_right(spy["d"], a) - 1
        f["spy_dd_52w"] = spy["c"][k_] / max(spy["c"][max(0, k_ - 251):k_ + 1]) - 1
        srv = rv(spy["c"], k_ - 19, k_)
        f["spy_vrp"] = (spy["iv"][k_] - srv) if spy["iv"][k_] and srv else None
        recs.append({"t": t, "a": a, "peer": k["peer"], "o": o, "f": f})
    # peer-relative outcomes + market breadth, per date
    by = defaultdict(list)
    for r in recs:
        by[r["a"]].append(r)
    for a, rs in by.items():
        md = median(r["f"]["dd_52w"] for r in rs)
        for h in H:
            g = defaultdict(list)
            allv = [r["o"][f"ret_{h}"] for r in rs if r["o"].get(f"ret_{h}") is not None]
            for r in rs:
                if r["o"].get(f"ret_{h}") is not None:
                    g[r["peer"]].append(r["o"][f"ret_{h}"])
            um = median(allv) if allv else None
            for r in rs:
                v = r["o"].get(f"ret_{h}")
                pv = g.get(r["peer"]) or []
                base = median(pv) if r["peer"] and len(pv) >= 4 else um
                r["o"][f"rel_{h}"] = v - base if v is not None and base is not None else None
        for r in rs:
            r["f"]["mkt_med_dd"] = md
    with connect() as conn:
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.lab_outcomes (ticker, as_of, outcomes, features) VALUES (%s, %s, %s, %s)
                               ON CONFLICT (ticker, as_of) DO UPDATE SET outcomes = EXCLUDED.outcomes, features = EXCLUDED.features, computed_at = now()""",
                            [(r["t"], r["a"], json.dumps(r["o"]), json.dumps(r["f"])) for r in recs])
        conn.commit()
    print(f"lab_outcomes: {len(recs)} rows · {len(by)} dates")


if __name__ == "__main__":
    main()
