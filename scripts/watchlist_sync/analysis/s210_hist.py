# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_hist.py <book.pkl from a352_score_rank.rebuild_book> [out]
import pickle, sys, numpy as np
from collections import defaultdict
from datetime import timedelta
b = pickle.load(open(sys.argv[1], "rb"))
wk = lambda d: d - timedelta(days=d.weekday())
by = defaultdict(list)
for e in b: by[wk(e["d"])].append(e)
W, E, OTM, PREM, DEL = [], [], [], [], []
for w in sorted(by):
    g = by[w]
    if len(g) < 20: continue
    g = sorted(g, key=lambda e: (-e["score"], e["t"]))[: max(1, len(g)//3)]
    W.append(w); E.append(1e4*sum(e["pnl"] for e in g)/sum(max(e["dte"],1)/7 for e in g))
    OTM.append(np.median([e["otm"] for e in g])); PREM.append(np.median([e["weekly"] for e in g])); DEL.append(np.median([e["delta"] for e in g]))
E = np.array(E); print(f"weeks {len(E)} {W[0]}→{W[-1]} mean {E.mean():+.0f} bp/wk median {np.median(E):+.0f} loss weeks {(E<0).mean():.0%}")
print(f"book pick: median OTM {np.median(OTM):.1%}, weekly prem {np.median(PREM):.2f}% of spot, delta {np.median(DEL):.2f}")
r8 = np.convolve(E, np.ones(8)/8, "valid")
print(f"8-wk rolling mean: p5 {np.percentile(r8,5):+.0f} p1 {np.percentile(r8,1):+.0f} min {r8.min():+.0f}; share ≤ -104: {(r8<=-104).mean():.1%}")
lw = np.convolve((E<0).astype(float), np.ones(7), "valid"); print(f"7-wk windows with ≥6 losing weeks: {(lw>=6).mean():.1%}")
worst = np.argsort(r8)[:6]; print("worst 8-wk windows start:", [(str(W[i]), round(r8[i])) for i in worst])
pickle.dump(dict(W=W, E=E), open(sys.argv[2], "wb"))
