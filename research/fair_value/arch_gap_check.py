import sys, numpy as np
sys.path.insert(0, "/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync"); sys.path.insert(0, "/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync/dcf")
import engine as E
from build_plan import connect
T = sys.argv[1].split() if len(sys.argv) > 1 else "AAOI AAPL AEP AMZN BABA BB CAVA CELH CRWV FSLY GEV GOOGL HOOD INTC MP MRVL MSFT NET NFLX NOW NVDA PLTR RDDT RKLB SHOP SMCI SNOW TSLA TTD".split()
br = E.BaseRates(); c = connect(); out = []
for t in T:
    try:
        x = E.inputs(c, t)
        if E.unvalued(x) or not x["price"]: continue
        b = float(np.median(E.simulate(x, br, n=1500, seed=0)["vps"])); r = E.simulate(x, br, n=1500, seed=0, fixed={"arch": True})
        a = float(np.median(r["vps"]))
    except Exception as e:
        continue
    out.append((t, r["arch"], b / x["price"] - 1, a / x["price"] - 1))
    if len(T) < 60: print(f"{t:5} {r['arch']:10} base {b/x['price']-1:+.0%} → arch {a/x['price']-1:+.0%}", flush=True)
for lab, f in (("all", lambda o: True), ("changed", lambda o: o[1] != "base")):
    o = [q for q in out if f(q)]
    if not o: continue
    b = np.array([q[2] for q in o]); a = np.array([q[3] for q in o])
    print(f"{lab:8} n {len(o)}  mean|gap| {np.mean(np.abs(b)):.1%} → {np.mean(np.abs(a)):.1%}  median|gap| {np.median(np.abs(b)):.1%} → {np.median(np.abs(a)):.1%}  median signed {np.median(b):+.1%} → {np.median(a):+.1%}  within25 {np.sum(np.abs(b)<.25)} → {np.sum(np.abs(a)<.25)}  closer {np.sum(np.abs(a)<np.abs(b))}/{len(o)}")
from collections import Counter; print(Counter(q[1] for q in out))
