# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_gate.py <book.pkl from a352_score_rank.rebuild_book> [out]
"""S210c pre-registered (11-27): S208 flags as a gate. Top-third weekly picks; flags within the week's picks:
top tercile ret5, top tercile sue (None = no flag), bottom tercile iv. Variants: A all picks · B skip 2+ flags ·
C skip 2+ and refill from the next-ranked clean names (same count). Pass = mean bp/wk up in BOTH halves, worst-5% not worse."""
import math, pickle, sys, numpy as np
from collections import defaultdict
from datetime import timedelta
b = pickle.load(open(sys.argv[1], "rb"))
wk = lambda d: d - timedelta(days=d.weekday())
by = defaultdict(list)
for e in b: by[wk(e["d"])].append(e)
def flags(picks):
    def terc(key, hi):
        v = [p[key] for p in picks if p.get(key) is not None]
        if len(v) < 3: return lambda p: False
        cut = np.percentile(v, 200/3 if hi else 100/3)
        return (lambda p: p.get(key) is not None and p[key] >= cut) if hi else (lambda p: p.get(key) is not None and p[key] <= cut)
    f = [terc("ret5", True), terc("sue", True), terc("iv", False)]
    return {id(p): sum(fn(p) for fn in f) for p in picks}
def bp(xs): return 1e4*sum(e["pnl"] for e in xs)/sum(max(e["dte"],1)/7 for e in xs) if xs else 0.0
out = defaultdict(list); W = []
for w in sorted(by):
    g = by[w]
    if len(g) < 20: continue
    r = sorted(g, key=lambda e: (-e["score"], e["t"])); n = max(1, len(g)//3); top = r[:n]
    fl = flags(top); clean = [p for p in top if fl[id(p)] < 2]
    rest = [p for p in r[n:] if p not in top]
    fr = flags(top + rest)  # refill: next-ranked names that would be clean
    refill = clean + [p for p in rest if fr[id(p)] < 2][: n - len(clean)]
    W.append(w); out["A all"].append(bp(top)); out["B skip 2+"].append(bp(clean)); out["C skip+refill"].append(bp(refill))
    out["flag2 only"].append(bp([p for p in top if fl[id(p)] >= 2]) if len(clean) < n else np.nan)
W = np.array(W); h1 = np.array([w.year <= 2023 for w in W])
base = np.array(out["A all"]); worst = np.argsort(base)[:20]
for k, v in out.items():
    a = np.array(v, float); m = ~np.isnan(a)
    print(f"{k:<14} bp/wk {np.nanmean(a):+5.0f}  H1 {np.nanmean(a[h1&m]):+4.0f} H2 {np.nanmean(a[~h1&m]):+4.0f}  worst5% {np.nanpercentile(a,5):+5.0f}  "
          f"worst {np.nanmin(a):+5.0f}  loss wks {(a[m]<0).mean():.0%}  in base's 20 worst wks {np.nanmean(a[worst]):+5.0f}  n {m.sum()}")
d = np.array(out["B skip 2+"]) - base
print(f"paired B−A: {d.mean():+.1f} bp/wk t {d.mean()/(d.std(ddof=1)/math.sqrt(len(d))):+.2f}  H1 t {d[h1].mean()/(d[h1].std(ddof=1)/math.sqrt(h1.sum())):+.2f}  H2 t {d[~h1].mean()/(d[~h1].std(ddof=1)/math.sqrt((~h1).sum())):+.2f}")
