"""S042b (A155): does relativePressure (20-day return minus SPY's, known at as_of) predict? Same grain as S042:
lab_outcomes weeks × 252 names, rank IC vs 21d relative return and P(21d return > −5 %), both halves."""
import sys, collections, bisect
import numpy as np
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from build_plan import connect
c = connect()
px = collections.defaultdict(list)
for t, d, cl in c.execute("select ticker, date, close::float8 from prices_historical where date >= '2019-10-01' order by ticker, date"):
    px[t].append((d, cl))
def r20(t, d):
    s = px.get(t)
    if not s: return None
    i = bisect.bisect_right([x[0] for x in s], d) - 1
    return s[i][1] / s[i - 20][1] - 1 if i >= 20 else None
dates = {t: [x[0] for x in s] for t, s in px.items()}
def r20f(t, d):
    s, ds = px.get(t), dates.get(t)
    if not s: return None
    i = bisect.bisect_right(ds, d) - 1
    return s[i][1] / s[i - 20][1] - 1 if i >= 20 else None
rows = c.execute("select ticker, as_of, (outcomes->>'rel_21')::float8, (outcomes->>'ret_21')::float8 from watchlist_sync.lab_outcomes where outcomes->>'rel_21' is not null").fetchall()
byw = collections.defaultdict(list)
spy = {}
for t, d, r, rr in rows:
    if d not in spy: spy[d] = r20f("SPY", d)
    x = r20f(t, d)
    if x is not None and spy[d] is not None: byw[d].append((x - spy[d], r, rr))
rank = lambda a: np.argsort(np.argsort(a)).astype(float)
weeks = sorted(w for w in byw if len(byw[w]) >= 30); half = weeks[len(weeks) // 2]
for sign, lab in ((1, "strength (high = outperformed)"), (-1, "pressure (high = lagged, mean-reversion)")):
    a, b, h = [], [], []
    for w in weeks:
        xs = byw[w]; s = rank([sign * x[0] for x in xs])
        a.append(np.corrcoef(s, rank([x[1] for x in xs]))[0, 1]); b.append(np.corrcoef(s, [float(x[2] > -0.05) for x in xs])[0, 1]); h.append(w < half)
    a, b, h = map(np.array, (a, b, h))
    t = lambda v: v.mean() / (v.std(ddof=1) / np.sqrt(len(v)) * 2)
    print(f"{lab}: weeks {len(a)} · rel21 IC {a.mean():+.3f} t≈{t(a):.1f} halves {a[h].mean():+.3f}/{a[~h].mean():+.3f} · kept IC {b.mean():+.3f} t≈{t(b):.1f} halves {b[h].mean():+.3f}/{b[~h].mean():+.3f}")
