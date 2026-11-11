"""S188 — option momentum (a name's own past-52-week put record) on REAL LSEG put quotes (Claude 11-10; S187 lead).

Registered BEFORE this run (factor-catalogue-2026-11-10.md § 6):
  DOWN regime cell: past put pnl → coefficient > 0 on real put return; past breach rate → coefficient < 0. Both after controls.
  UP cell: no registered sign (S187 train up cell ≈ 0).
Feature   from S059 simulated weekly puts whose EXPIRY < the real trade's entry date, last 365 days, ≥ 20 weeks (causal).
Outcome   S109 real LSEG weekly puts (3–9 DTE, fill bid + 23 % of spread, held to expiry), r = pnl ÷ strike per week; breach.
Model     pooled OLS, week fixed effects (week-demeaned), regressors = within-week ranks of feature, OTM %, income, 52w drawdown;
          SE clustered by week. Cell needs ≥ 30 weeks, else "can't answer at this n".
Regime    rule 12 causal label (as S187): up = SPY > 200d MA and 63d return ≥ 0; down otherwise.
Independence caveat: same stocks and calendar as the S187 sim (different pricing source), so this is a robustness check, not fresh
data. Fresh data = forward weeks from 2026-11-10.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s188_option_momentum_real.py
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s059_option_factors as F  # noqa: E402
import s109_real_quote_rule as R  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S188.md"


def wk_rank(vals):
    a = np.asarray(vals, float)
    return (a.argsort().argsort() / max(1, len(a) - 1)) if len(a) > 1 else np.zeros(len(a))


def ols_cluster(rows, feat, target):
    by = defaultdict(list)
    for r in rows:
        if r.get(feat) is not None:
            by[r["wk"]].append(r)
    Xs, ys, gs = [], [], []
    for w, g in by.items():
        if len(g) < 2:
            continue
        X = np.c_[wk_rank([r[feat] for r in g]), wk_rank([r["otm"] for r in g]), wk_rank([r["inc"] for r in g]),
                  wk_rank([r["dd52"] for r in g])]
        y = np.array([float(r[target]) for r in g])
        Xs.append(X - X.mean(0)); ys.append(y - y.mean()); gs += [w] * len(g)
    if len({*gs}) < 30:
        return {"weeks": len({*gs}), "n": len(gs)}
    X, y, gs = np.vstack(Xs), np.concatenate(ys), np.array(gs)
    XtX_inv = np.linalg.pinv(X.T @ X)
    b = XtX_inv @ X.T @ y
    e = y - X @ b
    meat = np.zeros((X.shape[1],) * 2)
    for w in np.unique(gs):
        m = gs == w
        s = X[m].T @ e[m]
        meat += np.outer(s, s)
    se = np.sqrt(np.diag(XtX_inv @ meat @ XtX_inv))
    return {"weeks": len(np.unique(gs)), "n": len(y), "b": float(b[0]), "t": float(b[0] / se[0])}


def main():
    with connect() as conn:
        ev = F.aligned_events(conn)
        q, px = R.load(conn)
        spy = [(d, c) for d, c in conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close > 0 ORDER BY date")]
    real = R.trades(q, px)
    sd = [d for d, _ in spy]
    sc = np.array([c for _, c in spy])

    def regime(d):
        i = bisect_left(sd, d)
        if i >= len(sd) or sd[i] != d:
            i -= 1
        if i < 200:
            return None
        return "up" if sc[i] > sc[i - 199:i + 1].mean() and sc[i] / sc[i - 63] - 1 >= 0 else "down"

    hist = defaultdict(list)
    for e in ev:
        hist[e["t"]].append((e["expiry"], e["pnl"], e["breach"]))
    for t in hist:
        hist[t].sort()
    rows = []
    for r in real:
        hs = hist.get(r["t"], [])
        k1, k2 = bisect_left(hs, (r["d"] - timedelta(days=365),)), bisect_left(hs, (r["d"],))
        past = hs[k1:k2]
        if len(past) < 20:
            continue
        iso = r["d"].isocalendar()
        rows.append({**r, "wk": iso[0] * 100 + iso[1], "regime": regime(r["d"]), "brch": 0.0 if r["kept"] else 1.0,
                     "opt_mom_52w": float(np.mean([p for _, p, _ in past])),
                     "breach_rate_52w": float(np.mean([x for _, _, x in past]))})
    L = ["# S188 — option momentum on real LSEG weekly puts", "",
         f"{len(real)} real puts; {len(rows)} with ≥ 20 past sim weeks. Coef = effect of moving from the week's lowest to highest "
         "rank, in return per $ strike per week (bp shown); t clustered by week.", "",
         "| cell | feature | target | registered | weeks | trades | coef | t | verdict |", "|---|---|---|---|---|---|---|---|---|"]
    reg = {("down", "opt_mom_52w", "r"): +1, ("down", "breach_rate_52w", "r"): -1}
    for cell in ("down", "up", "all"):
        sub = [x for x in rows if cell == "all" or x["regime"] == cell]
        for f in ("opt_mom_52w", "breach_rate_52w"):
            for tg in ("r", "brch"):
                o = ols_cluster(sub, f, tg)
                want = reg.get((cell, f, tg), 0)
                if "b" not in o:
                    L.append(f"| {cell} | {f} | {tg} | {want:+d} | {o['weeks']} | {o['n']} | — | — | can't answer at this n |")
                    continue
                v = ("PASS" if np.sign(o["b"]) == want and abs(o["t"]) >= 2 else "fail") if want else "exploratory"
                unit = 1e4 if tg == "r" else 100
                L.append(f"| {cell} | {f} | {tg} | {want:+d} | {o['weeks']} | {o['n']} | {o['b'] * unit:+.1f}{' bp' if tg == 'r' else ' pp'} | {o['t']:+.1f} | {v} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
