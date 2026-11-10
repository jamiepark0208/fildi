"""S183 — meta-labeling on the proven put edge (López de Prado AFML ch. 3: primary picks side, secondary says skip/size).

Primary (proven, S003/S004): sell the monthly 30-DTE 0.20Δ put on names in the month's top half by IV/RV20.
Secondary: classifier on 'tail_ra' (loss > 1σ of the premium-risk scale), features known at entry only.
Walk-forward: refit each calendar year on trades whose EXIT is before Jan 1 of that year (no label overlap), first test 2022.
Policies vs primary, per month: skip the predicted-worst fifth; size ∝ (1 − p)/mean (same total collateral).
Pre-registered pass: skip-fifth lifts month-mean ret_ra over primary with t ≥ 2 AND positive in both halves
(2022-23 / 2024→); also report tail-rate cut. Fails → meta-label not worth building.
"""
import math, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import backtest_puts as B
from build_plan import connect
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression

F = ["iv_rv", "iv30", "iv_rank_1y", "mom20", "mom_vs_spy", "dist_ma50", "rsi14", "oversold_self", "fk_proxy",
     "earnings_in_window", "spy_m20"]

with connect() as conn:
    H, peer, er, sm = B.load(conn)
trades = [t for t in B.build_trades(H, peer, er, sm, 0.85, 0.20) if t.get("iv_rv")]
by_m = defaultdict(list)
for t in trades:
    by_m[str(t["entry"])[:7]].append(t)
prim = []
for m, g in by_m.items():
    med = np.median([t["iv_rv"] for t in g])
    prim += [dict(t, month=m) for t in g if t["iv_rv"] >= med]
X = np.array([[np.nan if t.get(f) is None else float(t[f]) for f in F] for t in prim])
LAB = sys.argv[sys.argv.index("--label") + 1] if "--label" in sys.argv else "tail"
y = np.array([int(bool(t["tail_ra"])) if LAB == "tail" else int(t["ret"] < 0) for t in prim]); r = np.array([t["ret_ra"] for t in prim])
mon = np.array([t["month"] for t in prim]); ex = np.array([str(t["exit"]) for t in prim])
print(f"primary: {len(prim)} trades · {len(set(mon))} months · tail rate {y.mean():.3f} · mean ret_ra {r.mean():+.3f}")

out = {k: defaultdict(list) for k in ("gbm", "logit")}
for yr in range(2022, 2027):
    tr = ex < f"{yr}-01-01"; te = np.array([m.startswith(str(yr)) for m in mon])
    if te.sum() == 0:
        continue
    Xtr = X[tr]; med = np.nanmedian(Xtr, 0)
    fill = lambda A: np.where(np.isnan(A), med, A)
    mu, sd = fill(Xtr).mean(0), fill(Xtr).std(0) + 1e-9
    models = {"gbm": HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=200),
              "logit": LogisticRegression(C=0.3, max_iter=1000)}
    for name, mdl in models.items():
        mdl.fit((fill(Xtr) - mu) / sd, y[tr])
        p = mdl.predict_proba((fill(X[te]) - mu) / sd)[:, 1]
        for m in sorted(set(mon[te])):
            k = mon[te] == m; pm, rm, ym = p[k], r[te][k], y[te][k]
            if len(rm) < 10:
                continue
            keep = pm <= np.quantile(pm, 0.8); w = (1 - pm) / (1 - pm).mean()
            o = out[name]
            o["month"].append(m); o["prim"].append(rm.mean()); o["skip"].append(rm[keep].mean())
            o["size"].append((w * rm).mean()); o["tail_p"].append(ym.mean()); o["tail_s"].append(ym[keep].mean())
            o["auc"].append(((pm[ym == 1][:, None] > pm[ym == 0][None, :]).mean()) if 0 < ym.sum() < len(ym) else np.nan)

tt = lambda d: d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))
for name, o in out.items():
    P, S, Z = (np.array(o[k]) for k in ("prim", "skip", "size")); M = np.array(o["month"])
    h1 = M < "2024-01"
    print(f"\n{name}: {len(P)} test months · AUC {np.nanmean(o['auc']):.3f} · tail rate {np.mean(o['tail_p']):.3f} → kept {np.mean(o['tail_s']):.3f}")
    for lab, A in (("skip worst 1/5", S), ("size ∝ 1−p", Z)):
        d = A - P
        print(f"  {lab:15s} {A.mean():+.4f} vs primary {P.mean():+.4f} · Δ {d.mean():+.4f} t {tt(d):+.2f} · "
              f"2022-23 Δ {d[h1].mean():+.4f} · 2024→ Δ {d[~h1].mean():+.4f}")
