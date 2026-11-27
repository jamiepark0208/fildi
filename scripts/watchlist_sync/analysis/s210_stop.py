# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_stop.py <book.pkl from a352_score_rank.rebuild_book> [out]
"""S210d pre-registered (11-27): engine weekly 1σ puts with a stop. Trigger: a daily close before expiry ≤ strike × (1 - buf),
buf ∈ {0, 0.02}. Buy back at BS(close, K, iv × m, sessions left) + book fill cost, m ∈ {1.5, 2.0} (vol spikes at the stop).
Pass = mean ≥ naked − 3 bp/wk in both halves AND worst-5 % week better by ≥ 20 %."""
import math, pickle, sys, numpy as np
from bisect import bisect_right, bisect_left
from collections import defaultdict
from datetime import timedelta
sys.path.insert(0, "analysis"); sys.path.insert(0, ".")
from build_plan import connect
import s045_put_retest as S
import put_edge as PE
b = pickle.load(open(sys.argv[1], "rb"))
c = connect(); names = sorted({e["t"] for e in b})
px = defaultdict(lambda: ([], []))
for t, d, cl in c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND date >= '2020-12-01' AND close > 0 ORDER BY ticker, date", (names,)):
    px[t][0].append(d); px[t][1].append(cl)
wk = lambda d: d - timedelta(days=d.weekday())
by = defaultdict(list)
for e in b: by[wk(e["d"])].append(e)
def pnl(e, buf, m):
    if buf is None: return e["pnl"]
    ds, cs = px[e["t"]]; i0 = bisect_right(ds, e["d"]); i1 = bisect_left(ds, e["expiry"])
    prem = e["pnl"] + PE.fill_cost(0) * 0  # book pnl is net; recover premium = pnl + intrinsic at expiry
    prem = e["pnl"] + max(e["strike"] - e["settle"], 0) / e["strike"]
    for j in range(i0, i1):
        if cs[j] <= e["strike"] * (1 - buf):
            left = max(i1 - j, 1) / 252.0
            buy = S.bs_put(cs[j], e["strike"], e["iv"] * m, left) / e["strike"]
            return prem - buy - PE.fill_cost(buy)
    return e["pnl"]
def run(buf=None, m=1.0):
    W, out = [], []
    for w in sorted(by):
        g = by[w]
        if len(g) < 20: continue
        top = sorted(g, key=lambda e: (-e["score"], e["t"]))[: max(1, len(g)//3)]
        W.append(w); out.append(1e4 * sum(pnl(e, buf, m) for e in top) / sum(max(e["dte"], 1) / 7 for e in top))
    return np.array(W), np.array(out)
W, base = run(); h1 = np.array([w.year <= 2023 for w in W]); worst = np.argsort(base)[:20]
def show(lbl, a):
    eq = np.cumsum(a); dd = (eq - np.maximum.accumulate(eq)).min()
    print(f"{lbl:<24} bp/wk {a.mean():+5.0f}  H1 {a[h1].mean():+4.0f} H2 {a[~h1].mean():+4.0f}  worst5% {np.percentile(a,5):+5.0f}  worst {a.min():+5.0f}  maxDD {dd:+6.0f}  20 worst wks {a[worst].mean():+5.0f}")
show("naked (hold to expiry)", base)
for buf in (0.0, 0.02):
    for m in (1.5, 2.0):
        show(f"stop buf {buf:.0%} iv×{m}", run(buf, m)[1])
