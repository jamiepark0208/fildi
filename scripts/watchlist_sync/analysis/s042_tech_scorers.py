import sys, numpy as np, collections
sys.path.insert(0, ".")
from build_plan import connect
W6 = dict(oversoldDepth=.25, reversalSignal=.20, volatilityState=.22, trendContext=.18, optionsFlow=.10, volumeConfirm=.05)
W8 = dict(oversoldDepth=.20, reversalSignal=.17, volatilityState=.14, trendContext=.14, optionsFlow=.08, volumeConfirm=.07)
WT = dict(trendContext=1.0)
def score(c, w):
    num = den = 0.0
    for k, v in w.items():
        if c.get(k) is not None: num += c[k] * v; den += v
    return num / den if den else None
conn = connect()
rows = conn.execute("""select t.as_of, t.ticker, t.v2->'comps', o.outcomes->>'rel_21', o.outcomes->>'ret_21'
  from watchlist_sync.lab_tech t join watchlist_sync.lab_outcomes o using (ticker, as_of)
  where o.outcomes->>'rel_21' is not null""").fetchall()
byw = collections.defaultdict(list)
for d, t, c, r, rr in rows: byw[d].append((c, float(r), float(rr)))
def rank(a): return np.argsort(np.argsort(a)).astype(float)
res = {}
weeks = sorted(byw)
half = weeks[len(weeks)//2]
for name, w in (("6comp", W6), ("8comp-shared6", W8), ("trend-only", WT)):
    ics = {"rel21": [], "kept": []}; whs = []
    for d in weeks:
        xs = [(score(c, w), r, rr) for c, r, rr in byw[d]]
        xs = [x for x in xs if x[0] is not None]
        if len(xs) < 30: continue
        s = rank([x[0] for x in xs])
        ics["rel21"].append(np.corrcoef(s, rank([x[1] for x in xs]))[0, 1])
        ics["kept"].append(np.corrcoef(s, [float(x[2] > -0.05) for x in xs])[0, 1])
        whs.append(d < half)
    whs = np.array(whs)
    out = []
    for k, v in ics.items():
        v = np.array(v); m = v.mean(); t = m / (v.std(ddof=1) / np.sqrt(len(v)) * np.sqrt(4))  # ~4-wk overlap (21d fwd, weekly) → inflate SE ×2
        out.append(f"{k} IC {m:+.3f} t≈{t:.1f} halves {v[whs].mean():+.3f}/{v[~whs].mean():+.3f}")
    print(f"{name:14s} weeks {len(whs)} · " + " · ".join(out))
