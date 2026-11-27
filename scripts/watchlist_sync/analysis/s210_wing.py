# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_wing.py <book.pkl from a352_score_rank.rebuild_book> [out]
"""S210b pre-registered (11-27): engine top-third weekly 1σ puts vs the same put + a bought wing (put spread).
Wing strike = spot·exp(-zw·iv·√t), zw ∈ {1.5, 2.0}; wing vol = iv × skew, skew ∈ {1.10, 1.25} (put skew: wing priced richer);
wing cost = BS + the same fill cost the book charges. Unit: bp of short strike per collateral-week (same as book).
Expected: spread gives up some mean, cuts worst weeks. Pass = worst-5% week and max drawdown better, mean ≥ 70% of naked,
same sign both halves (2021-23 / 2024-26)."""
import math, pickle, sys, numpy as np
from collections import defaultdict
from datetime import timedelta
sys.path.insert(0, "analysis"); sys.path.insert(0, ".")
import s045_put_retest as S
import s059_option_factors as S59
import put_edge as PE
b = pickle.load(open(sys.argv[1], "rb"))
wk = lambda d: d - timedelta(days=d.weekday())
by = defaultdict(list)
for e in b: by[wk(e["d"])].append(e)
def series(zw=None, skew=1.0):
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < 20: continue
        top = sorted(g, key=lambda e: (-e["score"], e["t"]))[: max(1, len(g)//3)]
        num = 0.0
        for e in top:
            p = e["pnl"]
            if zw:
                t = e["hold_sessions"]/252.0
                k2 = e["spot"]*math.exp(-zw*e["iv"]*math.sqrt(t))
                wp = S.bs_put(e["spot"], k2, e["iv"]*skew, t)
                p += (max(k2 - e["settle"], 0.0) - wp)/e["strike"] - PE.fill_cost(wp/e["strike"])
            num += p
        out.append((w, 1e4*num/sum(max(e["dte"],1)/7 for e in top)))
    return out
def stats(lbl, s):
    a = np.array([x[1] for x in s]); eq = np.cumsum(a); dd = (eq - np.maximum.accumulate(eq)).min()
    h1 = np.mean([x[1] for x in s if x[0].year <= 2023]); h2 = np.mean([x[1] for x in s if x[0].year >= 2024])
    print(f"{lbl:<28} bp/wk {a.mean():+5.0f}  H1 {h1:+4.0f} H2 {h2:+4.0f}  worst5% {np.percentile(a,5):+5.0f}  worst {a.min():+5.0f}  maxDD {dd:+6.0f} bp  loss wks {(a<0).mean():.0%}  sharpe {a.mean()/a.std(ddof=1)*math.sqrt(52):.2f}")
    return a
base = stats("naked 1σ put (engine)", series())
for zw in (1.5, 2.0):
    for sk in (1.10, 1.25):
        stats(f"spread wing {zw}σ skew {sk}", series(zw, sk))
