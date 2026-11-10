"""S177 — long calls / long puts / sold call spreads: what was different at entry for winners vs losers? (Jamie 11-09:
"analyze good recs against bad, entry/close conditions, find patterns to fix it; sold-put lows → long calls? highs → sold calls / long puts?")

Trades = S175 cache (S076 run, ~260 names, Monday entries 2021-02→, 30 DTE held to expiry, model-priced with skew + RH fills).
Entry features from lseg_research.daily_history at the entry close: ret5/20/60, z50 (close−MA50)/sd50, RSI14, off 52w high,
above 52w low, ivrv (S076), iv pctile 1y, VIX÷VIX3M, SPY ret20.
Out: per structure, (1) winners (top decile pnl) vs losers (bottom half) feature medians; (2) mean pnl by feature quintile,
both eras (S.SPLIT), month-block t on Q5−Q1; (3) the sold-put LOW conditions on long calls and the mirrored HIGH conditions
on long puts + sold call spreads, vs the same structure on all days.
"""
from __future__ import annotations

import math
import pickle
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

SPLIT = __import__("datetime").date(2024, 1, 1)
CACHE = Path.home() / ".fildi/cache/s175_trades.pkl"
STRUCT = ("long_call", "long_put", "call_spread", "bull_call_spread")
FEATS = ["ret5", "ret20", "ret60", "z50", "rsi", "off_hi", "up_lo", "ivrv", "ivp", "vixr", "spy20"]


def rsi(c, n=14):
    g = [max(c[i] - c[i - 1], 0) for i in range(len(c) - n, len(c))]
    l = [max(c[i - 1] - c[i], 0) for i in range(len(c) - n, len(c))]
    return 100 if sum(l) == 0 else 100 - 100 / (1 + sum(g) / sum(l))


def month_t(xs):
    by = defaultdict(list)
    for d, v in xs:
        by[(d.year, d.month)].append(v)
    m = [st.mean(v) for v in by.values()]
    return st.mean(m) / (st.pstdev(m) / math.sqrt(len(m))) if len(m) > 2 and st.pstdev(m) > 0 else float("nan")


def main():
    T = [x for x in pickle.loads(CACHE.read_bytes()) if x["s"] in STRUCT]
    names = sorted({x["t"] for x in T})
    H = defaultdict(list)
    with connect() as conn:
        for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float8, iv30_call::float8 FROM lseg_research.daily_history
                                           WHERE ticker = ANY(%s) AND date >= '2019-06-01' AND close > 0 ORDER BY ticker, date""", (names + ["SPY"],)):
            H[t].append((d, c, iv))
        vx = {}
        for d, r in conn.execute("""SELECT a.date, a.value / b.value FROM watchlist_sync.macro_daily a JOIN watchlist_sync.macro_daily b
                                    ON b.date = a.date AND b.series = 'vix3m' WHERE a.series = 'vix' AND b.value > 0"""):
            vx[d] = float(r)
        for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M') ORDER BY date"):
            vx.setdefault(("raw", d), {})[i] = c
    for k in [k for k in vx if isinstance(k, tuple)]:
        v = vx.pop(k)
        if "VIX" in v and v.get("VIX3M"):
            vx.setdefault(k[1], v["VIX"] / v["VIX3M"])
    vd = sorted(vx)
    spy = H["SPY"]; sd = [r[0] for r in spy]
    feat = {}

    def f_at(t, d):
        if (t, d) in feat:
            return feat[(t, d)]
        h = H.get(t) or []
        ds = [r[0] for r in h] if h else []
        i = bisect_right(ds, d) - 1
        if i < 260:
            feat[(t, d)] = None; return None
        c = [r[1] for r in h[i - 260:i + 1]]
        ivs = [r[2] for r in h[i - 252:i + 1] if r[2]]
        m50 = st.mean(c[-50:]); s50 = st.pstdev(c[-50:]) or 1
        j = bisect_right(sd, d) - 1; k = bisect_right(vd, d) - 1
        f = {"ret5": c[-1] / c[-6] - 1, "ret20": c[-1] / c[-21] - 1, "ret60": c[-1] / c[-61] - 1, "z50": (c[-1] - m50) / s50,
             "rsi": rsi(c), "off_hi": c[-1] / max(c[-252:]) - 1, "up_lo": c[-1] / min(c[-252:]) - 1,
             "ivp": (sum(v <= ivs[-1] for v in ivs) / len(ivs)) if ivs and h[i][2] else None,
             "vixr": vx[vd[k]] if k >= 0 else None, "spy20": spy[j][1] / spy[j - 20][1] - 1 if j >= 20 else None}
        feat[(t, d)] = f; return f

    _idx = {}
    for t in H:
        _idx[t] = [r[0] for r in H[t]]

    def f_fast(t, d):   # same as f_at with cached date index
        if (t, d) in feat:
            return feat[(t, d)]
        h = H.get(t)
        if not h:
            feat[(t, d)] = None; return None
        i = bisect_right(_idx[t], d) - 1
        if i < 260:
            feat[(t, d)] = None; return None
        return f_at(t, d)

    rows = []
    for x in T:
        f = f_fast(x["t"], x["d"])
        if f:
            rows.append({**x, **f})
    print(f"S177: {len(rows)} trades with features ({len(T)} total)")
    for s in STRUCT:
        R = [r for r in rows if r["s"] == s]
        R.sort(key=lambda r: r["pnl"])
        n = len(R); win, lose = R[-n // 10:], R[:n // 2]
        allm = st.mean(r["pnl"] for r in R)
        print(f"\n== {s}  n {n}  mean {100 * allm:+.1f} %  win {100 * sum(r['pnl'] > 0 for r in R) / n:.0f} %")
        print("  feature    winners  losers |  Q1      Q2      Q3      Q4      Q5   | Q5−Q1 t   eras(Q5−Q1)")
        for k in FEATS:
            V = [r for r in R if r.get(k) is not None]
            if len(V) < 500:
                continue
            V.sort(key=lambda r: r[k])
            q = [V[i * len(V) // 5:(i + 1) * len(V) // 5] for i in range(5)]
            qm = [st.mean(r["pnl"] for r in b) for b in q]
            cut = [q[0][-1][k], q[4][0][k]]
            diff = [(r["d"], r["pnl"]) for r in q[4]] + [(r["d"], -r["pnl"]) for r in q[0]]
            e = [st.mean(r["pnl"] for r in q[4] if (r["d"] < SPLIT) == a) - st.mean(r["pnl"] for r in q[0] if (r["d"] < SPLIT) == a) for a in (True, False)]
            wm = st.median(r[k] for r in win if r.get(k) is not None); lm = st.median(r[k] for r in lose if r.get(k) is not None)
            print(f"  {k:8s} {wm:8.3f} {lm:7.3f} | " + " ".join(f"{100 * v:+6.1f}" for v in qm) +
                  f" | {month_t(diff):5.1f}  {100 * e[0]:+.1f}/{100 * e[1]:+.1f}   (Q1≤{cut[0]:.3f} Q5≥{cut[1]:.3f})")
    # sold-put LOW conditions on calls; mirrored HIGH conditions on puts / sold call spreads
    C = {
        "LOW  dip: ret20 ≤ −15 %": lambda r: r["ret20"] <= -0.15,
        "LOW  z50 ≤ −2": lambda r: r["z50"] <= -2,
        "LOW  RSI ≤ 30": lambda r: r["rsi"] <= 30,
        "LOW  panic VIX÷VIX3M ≥ 1": lambda r: (r["vixr"] or 0) >= 1,
        "LOW  dip ∧ IV cheap (ivrv < 1)": lambda r: r["ret20"] <= -0.10 and r["ivrv"] < 1,
        "HIGH run: ret20 ≥ +15 %": lambda r: r["ret20"] >= 0.15,
        "HIGH z50 ≥ +2": lambda r: r["z50"] >= 2,
        "HIGH RSI ≥ 70": lambda r: r["rsi"] >= 70,
        "HIGH at 52w high (off_hi ≥ −2 %)": lambda r: r["off_hi"] >= -0.02,
        "HIGH run ∧ IV cheap (ivrv < 1)": lambda r: r["ret20"] >= 0.10 and r["ivrv"] < 1,
        "MOM  ret60 ≥ +25 % ∧ ivrv < 1": lambda r: r["ret60"] >= 0.25 and r["ivrv"] < 1,
    }
    print("\n== conditions (mean pnl per $ debit / capital, vs same structure all days; eras <2024 / ≥2024; month-block t of lift)")
    for s in STRUCT:
        R = [r for r in rows if r["s"] == s]
        allm = st.mean(r["pnl"] for r in R)
        for name, fn in C.items():
            c = [r for r in R if fn(r)]
            if len(c) < 100:
                continue
            m = st.mean(r["pnl"] for r in c)
            e = [st.mean([r["pnl"] for r in c if (r["d"] < SPLIT) == a] or [float("nan")]) -
                 st.mean([r["pnl"] for r in R if (r["d"] < SPLIT) == a]) for a in (True, False)]
            print(f"  {s:16s} {name:34s} n {len(c):6d} mean {100 * m:+6.1f} % (all {100 * allm:+5.1f}) lift {100 * (m - allm):+6.1f} · "
                  f"eras {100 * e[0]:+.1f}/{100 * e[1]:+.1f} · t {month_t([(r['d'], r['pnl'] - allm) for r in c]):.1f} · "
                  f"win {100 * sum(r['pnl'] > 0 for r in c) / len(c):.0f} %")


if __name__ == "__main__":
    main()
