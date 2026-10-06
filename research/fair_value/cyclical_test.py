"""Mid-cycle normalization test for cyclicals (isExtendedCyclical: energy/mining modes, oil|gas|metals|materials|steel|
semiconductor|memory peer groups). Replaces forward EPS with a trailing average of point-in-time FY1 consensus
(split-adjusted panel from bt_load.py) and compares accuracy, extremes and predictive power for cyclical names.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/cyclical_test.py WORKDIR"""
import math, pickle, re, statistics as st, sys
from collections import defaultdict
import numpy as np
P = pickle.load(open(f"{sys.argv[1]}/panel.pkl", "rb"))
CYC = re.compile(r"(energy|oil|gas|mining|metals|materials|steel|semiconductor|memory)", re.I)
cyc = lambda r: r["mode"] in ("energy", "mining") or bool(r["grp"] and CYC.search(r["grp"]))
EXCL = {"speculative_pre_revenue", "pre_revenue_ok", "speculative_ok", "speculative_crypto", "reit"}
P = [r for r in P if r["mode"] not in EXCL and r["e1"] and r["e1"] > 0 and r["px"] > 0]
hist = defaultdict(list)
for r in sorted(P, key=lambda r: r["d"]):
    hist[r["t"]].append((r["d"], r["e1"]))
def norm_e1(r, months):
    xs = [e for d, e in hist[r["t"]] if d <= r["d"] and (r["d"] - d).days <= months * 31]
    return st.mean(xs) if len(xs) >= months * 0.6 else None
by_date = defaultdict(list)
for r in P: by_date[r["d"]].append(r)
def run(variant):
    out = []
    for d, rows in by_date.items():
        pe = [r["px"] / r["e1"] for r in rows if not cyc(r) and 0 < r["px"] / r["e1"] < 150]
        if len(pe) < 10: continue
        mkt = st.median(pe)      # non-cyclical market forward P/E as the yardstick
        for r in rows:
            if not cyc(r): continue
            e = r["e1"]
            if variant != "none":
                months, w = (36, 1.0) if variant == "mean36" else (36, 0.5) if variant == "half36" else (24, 1.0)
                n = norm_e1(r, months)
                if n is None or n <= 0: continue
                e = w * n + (1 - w) * r["e1"]
            out.append((d, math.log(e * mkt / r["px"]), r["rel126"]))
    return out
def ic(pts):
    by = defaultdict(list)
    for d, x, y in pts:
        if y is not None: by[d].append((x, y))
    ics = []
    for v in by.values():
        if len(v) < 8: continue
        a, b = np.array([p[0] for p in v]), np.array([p[1] for p in v])
        ics.append(np.corrcoef(a.argsort().argsort(), b.argsort().argsort())[0, 1])
    return (st.mean(ics), st.mean(ics) / (st.pstdev(ics) / math.sqrt(len(ics) / 6)), len(ics)) if len(ics) > 10 else (float("nan"),) * 3
print("cyclical names (forward P/E at non-cyclical market multiple):")
base = {(d, round(x, 6)) for d, x, _ in run("none")}
for v in ("none", "mean24", "mean36", "half36"):
    pts = run(v)
    xs = [x for _, x, _ in pts]
    i, t, n = ic(pts)
    print(f"  {v:7s} rows {len(pts):4d}  median |log V/P| {st.median(abs(x) for x in xs):.2f}  >3x or <1/3 {sum(abs(x) > math.log(3) for x in xs) / len(xs):.1%}"
          f"  IC rel126 {i:+.3f} (t {t:+.1f}, {n} months)")
