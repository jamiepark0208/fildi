"""S033 (A137/A138): does a HAR realized-vol forecast beat trailing RV20 as the IV/RV input for short puts?

S003 grain (backtest_puts.build_trades: monthly 30-DTE puts since 2020-03, IV from lseg daily_history). HAR on close-only
data: log RV next 21d ~ log|r_t| + log RV5 + log RV22, pooled OLS refit each entry month on rows whose 21-day target
ended before that month (no look-ahead). Feature iv_har = IV / forecast vs iv_rv = IV / RV20.
Pre-registered pass (studies INDEX S033): put ret_ra rank IC up ≥ 0.02, month-cluster CI > 0, both halves.
"""
import math, random, sys
from bisect import bisect_left
from collections import defaultdict
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import backtest_puts as B
from build_plan import connect

with connect() as conn:
    H, peer, er, sm = B.load(conn)
trades = B.build_trades(H, peer, er, sm, 0.85, 0.20)
rows = []  # (target_end_date, ticker, x, y)
feat_at = {}
for t, series in H.items():
    ds = [d for d, _, _ in series]; cl = np.array([c for _, c, _ in series], float)
    lr = np.diff(np.log(cl)); lr = np.concatenate([[np.nan], lr])
    for i in range(23, len(cl)):
        rd = abs(lr[i]) * math.sqrt(252) + 1e-4
        r5 = np.std(lr[i - 4:i + 1], ddof=1) * math.sqrt(252) + 1e-4
        r22 = np.std(lr[i - 21:i + 1], ddof=1) * math.sqrt(252) + 1e-4
        x = (1.0, math.log(rd), math.log(r5), math.log(r22))
        feat_at[(t, ds[i])] = x
        if i + 21 < len(cl) and i % 5 == 0:
            y = math.log(np.std(lr[i + 1:i + 22], ddof=1) * math.sqrt(252) + 1e-4)
            rows.append((ds[i + 21], x, y))
rows.sort(key=lambda r: r[0])
ends = [r[0] for r in rows]
X = np.array([r[1] for r in rows]); Y = np.array([r[2] for r in rows])
coef = {}
for e in sorted({tr["entry"] for tr in trades}):
    k = bisect_left(ends, e)
    if k > 2000:
        coef[e] = np.linalg.lstsq(X[:k], Y[:k], rcond=None)[0]
for tr in trades:
    x = feat_at.get((tr["ticker"], tr["entry"])); b = coef.get(tr["entry"])
    tr["iv_har"] = (tr["iv"] / 100) / math.exp(float(np.dot(b, x))) if x is not None and b is not None else None
trades = [tr for tr in trades if tr["iv_har"] is not None and tr["iv_rv"] is not None]

def monthly(f, target, partial):
    by = defaultdict(list)
    for tr in trades: by[tr["entry"]].append(tr)
    out = {}
    for e, ts in by.items():
        xs, ys = [t[f] for t in ts], [t[target] for t in ts]
        if partial:
            ivs = [t["iv30"] for t in ts]; xs, ys = B.resid_rank(xs, ivs), B.resid_rank(ys, ivs)
        ic, n = B.spearman(xs, ys)
        if ic is not None and n >= 20: out[e] = ic
    return out

print(f"S033: {len(trades)} puts, {len({t['entry'] for t in trades})} months, {len({t['ticker'] for t in trades})} names")
rnd = random.Random(7)
for target in ("ret_ra", "kept"):
    for partial in (False, True):
        a, b = monthly("iv_rv", target, partial), monthly("iv_har", target, partial)
        ms = sorted(set(a) & set(b)); d = np.array([b[m] - a[m] for m in ms]); h = len(ms) // 2
        boots = [np.mean([d[rnd.randrange(len(d))] for _ in d]) for _ in range(2000)]
        lo, hi = np.percentile(boots, [2.5, 97.5])
        tag = f"{target}{' | IV fixed' if partial else ''}"
        print(f"{tag:18s} IC rv20 {np.mean([a[m] for m in ms]):+.3f} · HAR {np.mean([b[m] for m in ms]):+.3f} · Δ {d.mean():+.3f} "
              f"CI [{lo:+.3f}, {hi:+.3f}] · halves Δ {d[:h].mean():+.3f}/{d[h:].mean():+.3f}")
