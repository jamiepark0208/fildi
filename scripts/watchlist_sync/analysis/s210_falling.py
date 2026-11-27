# S210 (11-27) — run from scripts/watchlist_sync: .venv/bin/python analysis/s210_falling.py <book.pkl from a352_score_rank.rebuild_book> [out]
"""S210 pre-registered (11-27): engine weekly puts by market state at entry; new 'falling' overlay.
falling = band_engine state in {normal, rally, sector_drop} AND SPY 21d ret <= -3% AND SPY < 50d SMA (curve not inverted).
Expected sign: falling weeks < other non-panic weeks. n = weeks. Halves 2021-23 / 2024-26."""
import pickle, sys, numpy as np
from collections import defaultdict
from datetime import timedelta
sys.path.insert(0, "analysis"); sys.path.insert(0, ".")
from build_plan import connect
import s101_band_regime as R
import band_engine as BE
b = pickle.load(open(sys.argv[1], "rb"))
c = connect(); spy, vix = R.spy_and_vix(c); si = {d: i for i, d in enumerate(spy["d"])}
wk = lambda d: d - timedelta(days=d.weekday())
by = defaultdict(list)
for e in b: by[wk(e["d"])].append(e)
rows = []
for w in sorted(by):
    g = by[w]
    if len(g) < 20: continue
    d0 = min(e["d"] for e in g); i = si.get(d0)
    if i is None or i < 252: continue
    m = R.rets(spy["c"], spy["h"], i)
    vr = vix["VIX"].get(d0, np.nan) / vix["VIX3M"].get(d0, np.nan) if d0 in vix["VIX"] and d0 in vix["VIX3M"] else 0.0
    st = BE.market_state({"vix_ratio": vr, "spy_3m": m["3m"], "spy_dd52": m["dd52"], "spy_6m": m["6m"]})
    below50 = spy["c"][i] < spy["c"][i-49:i+1].mean()
    fall = st not in ("panic", "sharp_drop", "bear_grind") and m["1m"] <= -0.03 and below50
    top = sorted(g, key=lambda e: (-e["score"], e["t"]))[: max(1, len(g)//3)]
    bp = 1e4*sum(e["pnl"] for e in top)/sum(max(e["dte"],1)/7 for e in top)
    # farther-OTM variant inside the same week: the 1/3 of book picks with largest OTM (what a wider strike earns)
    far = sorted(g, key=lambda e: -e["otm"])[: max(1, len(g)//3)]
    bpf = 1e4*sum(e["pnl"] for e in far)/sum(max(e["dte"],1)/7 for e in far)
    rows.append((w, st, fall, bp, bpf, m["1m"]))
def show(lbl, xs):
    a = np.array([x[3] for x in xs]); f = np.array([x[4] for x in xs])
    if len(a) == 0: print(f"{lbl:<26} n 0"); return
    t = a.mean()/(a.std(ddof=1)/np.sqrt(len(a))) if len(a) > 2 else np.nan
    h1 = [x[3] for x in xs if x[0].year <= 2023]; h2 = [x[3] for x in xs if x[0].year >= 2024]
    print(f"{lbl:<26} n {len(a):>3}  bp/wk {a.mean():+6.0f} (t {t:+.1f})  loss wks {(a<0).mean():.0%}  worst {a.min():+.0f}  "
          f"H1 {np.mean(h1) if h1 else np.nan:+.0f} (n{len(h1)}) H2 {np.mean(h2) if h2 else np.nan:+.0f} (n{len(h2)})  far-OTM third {f.mean():+.0f}")
show("all", rows)
for s in ("panic", "sharp_drop", "bear_grind", "sector_drop", "normal", "rally"):
    show(s, [x for x in rows if x[1] == s])
show("falling (new)", [x for x in rows if x[2]])
show("non-panic, not falling", [x for x in rows if not x[2] and x[1] != "panic"])
print("last book weeks:", [(str(x[0]), x[1], x[2]) for x in rows[-3:]])
