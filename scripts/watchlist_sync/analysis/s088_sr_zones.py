#!/usr/bin/env python3
"""S088 — S/R zone engine → probabilistic strike picker for sold puts / calls (Jamie 10-22). INDEX row S088.

Zones (bars ≤ entry only), from public indicator definitions:
  fractal   Bill Williams: a low with two higher lows each side (high: two lower highs)        — Investopedia
  pivot10   10-bar pivot highs/lows                                                             — TradingView ta.pivothigh/low
  channel   LonesomeTheBlue "Support Resistance Channels": pivot10 levels clustered within 5 % of the 300-bar range,
            strength = 20 × pivots + bars touching; strongest 6                                — TradingView script
  vp        volume profile, 120 bars, 40 rows: POC, value area (70 %) high/low, high-volume nodes — TradingView VP
  wpivot    standard weekly pivots from last week's H/L/C: P, S1 = 2P − H, S2 = P − (H − L), R1, R2
  fib       Fibonacci 38.2 / 50 / 61.8 % retracements of the 60-bar swing                        — Investopedia
  ma        50- and 200-day moving averages
Levels within 0.5 ATR merge into one zone (≤ 1 ATR wide); zone score = number of distinct methods.

Trades: weekly entries, horizons 1/2/4 weeks (5/10/20 sessions), held to expiry. Candidate strikes per name-week:
σ-grid (0.75, 1.0, 1.5 σ of the horizon) + one strike just beyond each zone (0.1 ATR) within 0.3–2.5 σ.
Priced with the S076 pricer (LSEG skew ratios, fill = bid + 23 % of spread). Put pnl per $ collateral (K), call pnl
per $ of stock (covered). Models: HistGradientBoosting P(kept) and pnl, walk-forward by calendar year.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s088_sr_zones.py [--smoke] [--tickers=A,B] [--if-due] [--force-log]
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, fill  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S088.md"
HORIZONS = (1, 2, 4)
SIGMAS = (0.75, 1.0, 1.5)
METHODS = ("fractal", "pivot10", "channel", "vp", "wpivot", "fib", "ma")
FIRST_FIT_YEAR = 2021          # first predicted year; 2019-10 → 2020 only trains
HOLDOUT = date(2023, 1, 1)
TOPN = 20
MIN_SPOT, MIN_CREDIT = 5.0, 0.10      # tradability (10-22: unfiltered picks were $0.50–$4 names with nickel premiums)


def listed_strike(K, S, side):
    """Round to the listed increment (build_plan.py step rule): puts down, calls up."""
    step = 0.5 if S < 25 else 1 if S < 100 else 2.5 if S < 250 else 5 if S < 1000 else 10
    return math.floor(K / step) * step if side == "put" else math.ceil(K / step) * step
# real LSEG seller fill ÷ simulated credit (cached optlab.lseg_opt_daily, 104k put quote-days, ≤ 35 DTE; 10-22 check)
HAIRCUT = {("lo", 0): 1.00, ("lo", 1): 1.02, ("lo", 2): 1.08, ("mid", 0): 0.98, ("mid", 1): 0.95, ("mid", 2): 0.94,
           ("hi", 0): 0.98, ("hi", 1): 0.91, ("hi", 2): 0.89, ("xhi", 0): 0.96, ("xhi", 1): 0.88, ("xhi", 2): 0.83}


def haircut_pnl(r):
    """pnl_wk with the credit scaled to real fills (>2σ capped at 1.0: real is richer, don't take that credit)."""
    ivb = "lo" if r["iv"] < .4 else "mid" if r["iv"] < .6 else "hi" if r["iv"] < .9 else "xhi"
    db = 0 if r["dist_sig"] < .75 else 1 if r["dist_sig"] < 1.25 else 2
    k = HAIRCUT[(ivb, db)] if r["dist_sig"] <= 2 else 1.0
    base = r["K"] if r["side"] == "put" else r["S"]
    return (r["pnl"] - r["credit"] * (1 - k) / base) / r["h"]


# ---------------------------------------------------------------- data

def load(conn, only=None):
    q = ("SELECT ticker, date, high::float, low::float, close::float, volume::float, iv30_put::float, iv30_call::float "
         "FROM lseg_research.daily_history WHERE close > 0 AND high IS NOT NULL ORDER BY ticker, date")
    rows = defaultdict(list)
    for t, d, h, lo, c, v, ivp, ivc in conn.execute(q):
        if only and t not in only:
            continue
        f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
        rows[t].append((d, h, lo, c, v or 0.0, f(ivp), f(ivc)))
    out = {}
    for t, r in rows.items():
        if len(r) < 320 or t in ("SPY", "QQQ", "IWM"):
            continue
        d, h, lo, c, v, ivp, ivc = zip(*r)
        out[t] = {"d": list(d), "h": np.array(h), "l": np.array(lo), "c": np.array(c), "v": np.array(v),
                  "ivp": list(ivp), "ivc": list(ivc)}
    return out


# ---------------------------------------------------------------- zones

def atr(b, i, n=14):
    h, lo, c = b["h"][i - n + 1: i + 1], b["l"][i - n + 1: i + 1], b["c"][i - n: i]
    return float(np.mean(np.maximum(h - lo, np.maximum(abs(h - c), abs(lo - c)))))


def pivots(x, i, left, right, lookback, low):
    """Confirmed pivots (index ≤ i − right) in the last `lookback` bars."""
    out = []
    for k in range(max(left, i - lookback), i - right + 1):
        w = x[k - left: k + right + 1]
        if (low and x[k] == w.min() and (w == x[k]).sum() == 1) or (not low and x[k] == w.max() and (w == x[k]).sum() == 1):
            out.append(float(x[k]))
    return out


def levels(b, i):
    """All raw levels at bar i: [(price, method, weight)] + channels [(lo, hi, strength)]."""
    h, lo, c, v = b["h"], b["l"], b["c"], b["v"]
    L = []
    for p in pivots(lo, i, 2, 2, 250, True) + pivots(h, i, 2, 2, 250, False):
        L.append((p, "fractal", 1.0))
    p10 = pivots(lo, i, 10, 10, 290, True) + pivots(h, i, 10, 10, 290, False)
    for p in p10:
        L.append((p, "pivot10", 1.0))
    # LonesomeTheBlue S/R channels
    rng = h[max(0, i - 299): i + 1].max() - lo[max(0, i - 299): i + 1].min()
    width = 0.05 * rng
    hh, ll = h[max(0, i - 289): i + 1], lo[max(0, i - 289): i + 1]
    chans = []
    for seed in p10:
        lo_, hi_ = seed, seed
        n = 0
        for p in sorted(p10, key=lambda z: abs(z - seed)):
            if max(hi_, p) - min(lo_, p) <= width:
                lo_, hi_ = min(lo_, p), max(hi_, p)
                n += 1
        touch = int(((hh >= lo_) & (ll <= hi_)).sum())
        chans.append((lo_, hi_, 20 * n + touch))
    chans.sort(key=lambda z: -z[2])
    keep = []
    for ch in chans:
        if ch[2] >= 40 and all(ch[1] < k[0] or ch[0] > k[1] for k in keep):
            keep.append(ch)
        if len(keep) == 6:
            break
    for lo_, hi_, s in keep:
        L.append(((lo_ + hi_) / 2, "channel", s / 20))
    # volume profile, 120 bars × 40 rows
    a, z = lo[i - 119: i + 1].min(), h[i - 119: i + 1].max()
    if z > a:
        edges = np.linspace(a, z, 41)
        prof = np.zeros(40)
        for k in range(i - 119, i + 1):
            b0 = min(39, int((lo[k] - a) / (z - a) * 40))
            b1 = min(39, int((h[k] - a) / (z - a) * 40))
            prof[b0: b1 + 1] += v[k] / (b1 - b0 + 1)
        mid = (edges[:-1] + edges[1:]) / 2
        poc = int(prof.argmax())
        L.append((float(mid[poc]), "vp", 2.0))
        lo_i = hi_i = poc
        tot, acc = prof.sum(), prof[poc]
        while tot > 0 and acc < 0.7 * tot:
            up = prof[hi_i + 1] if hi_i < 39 else -1
            dn = prof[lo_i - 1] if lo_i > 0 else -1
            if up >= dn:
                hi_i += 1
                acc += up
            else:
                lo_i -= 1
                acc += dn
        L += [(float(mid[lo_i]), "vp", 1.0), (float(mid[hi_i]), "vp", 1.0)]
        mu = prof.mean()
        for k in range(1, 39):
            if prof[k] > prof[k - 1] and prof[k] > prof[k + 1] and prof[k] > 1.2 * mu and k != poc:
                L.append((float(mid[k]), "vp", 1.0))
    # weekly standard pivots from the previous calendar week
    wk = b["d"][i].isocalendar()[:2]
    k = i
    while k > 0 and b["d"][k].isocalendar()[:2] == wk:
        k -= 1
    pw = b["d"][k].isocalendar()[:2]
    k0 = k
    while k0 > 0 and b["d"][k0 - 1].isocalendar()[:2] == pw:
        k0 -= 1
    H, Lw, C = h[k0: k + 1].max(), lo[k0: k + 1].min(), c[k]
    P = (H + Lw + C) / 3
    for p in (P, 2 * P - H, P - (H - Lw), 2 * P - Lw, P + (H - Lw)):
        L.append((float(p), "wpivot", 1.0))
    # Fibonacci of the 60-bar swing
    sh, sl = h[i - 59: i + 1].max(), lo[i - 59: i + 1].min()
    for r in (0.382, 0.5, 0.618):
        L.append((float(sh - r * (sh - sl)), "fib", 1.0))
    L += [(float(c[i - 49: i + 1].mean()), "ma", 1.0), (float(c[i - 199: i + 1].mean()), "ma", 1.5)]
    return L


def zones(b, i):
    """Merge levels within 0.5 ATR → [{lo, hi, mid, methods, score, weight}] sorted by price."""
    a = atr(b, i)
    L = sorted(x for x in levels(b, i) if x[0] > 0)   # S2 / fib can go negative on crashed names
    out, cur = [], None
    for p, m, w in L:
        if cur and p - cur["hi"] <= 0.5 * a and p - cur["lo"] <= 1.0 * a:   # chain cap: a zone is ≤ 1 ATR wide
            cur["hi"] = p
            cur["methods"].add(m)
            cur["weight"] += w
        else:
            cur = {"lo": p, "hi": p, "methods": {m}, "weight": w}
            out.append(cur)
    for z in out:
        z["mid"] = (z["lo"] + z["hi"]) / 2
        z["score"] = len(z["methods"])
    return out, a


# ---------------------------------------------------------------- candidates

def rsi(c, n=14):
    d = np.diff(c[-(n + 1):])
    up, dn = d[d > 0].sum(), -d[d < 0].sum()
    return 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)


def tech(b, i):
    c = b["c"][: i + 1]
    lr = np.diff(np.log(c[-21:]))
    rv = lr.std(ddof=1) * math.sqrt(252)
    ivs = [x for x in b["ivp"][max(0, i - 251): i + 1] if x]
    iv = b["ivp"][i]
    return {"rsi14": rsi(c), "rsi2": rsi(c, 2), "ret5": c[-1] / c[-6] - 1, "ret20": c[-1] / c[-21] - 1,
            "dist50": c[-1] / c[-50:].mean() - 1, "dist200": c[-1] / c[-200:].mean() - 1,
            "dd60": c[-1] / b["h"][i - 59: i + 1].max() - 1,
            "iv_rv": (iv / rv) if (iv and rv > 0) else float("nan"),
            "iv_rank": (sum(x <= iv for x in ivs) / len(ivs)) if (iv and len(ivs) > 100) else float("nan")}


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


ZONE_FEATS = ("at_zone", "at_score", "at_weight", "guard_n", "guard_methods", "guard_best", "cushion_sig",
              "cushion_score") + tuple(f"m_{m}" for m in METHODS)
BASE_FEATS = ("dist_sig", "p_implied", "h", "iv", "atr_pct", "rsi14", "rsi2", "ret5", "ret20", "dist50", "dist200",
              "dd60", "iv_rv", "iv_rank")


def candidates(b, i, side, pricer, zs, a):
    """All candidate strikes for one name-entry, every horizon. Returns rows with features + realised outcome."""
    S, d = float(b["c"][i]), b["d"][i]
    if S < MIN_SPOT:
        return []
    iv = b["ivp"][i] if side == "put" else b["ivc"][i]
    iv = iv or b["ivp"][i] or b["ivc"][i]
    if not iv or iv <= 0:
        return []
    tf = tech(b, i)
    out = []
    for h in HORIZONS:
        j = i + 5 * h
        realised = j < len(b["c"])
        n_days = (b["d"][j] - d).days if realised else 7 * h
        sig = iv * math.sqrt(5 * h / 252)
        strikes = [(S * math.exp(-m * sig) if side == "put" else S * math.exp(m * sig), None, m) for m in SIGMAS]
        for z in zs:
            if side == "put" and z["hi"] < S:
                K = z["lo"] - 0.1 * a
            elif side == "call" and z["lo"] > S:
                K = z["hi"] + 0.1 * a
            else:
                continue
            if K <= 0.05 * S:
                continue
            ds = abs(math.log(S / K)) / sig
            if 0.3 <= ds <= 2.5:
                strikes.append((K, z, None))
        seen = set()
        for K, z, gm_ in strikes:
            K = listed_strike(K, S, side)
            if K <= 0 or K in seen or (side == "put" and K >= S) or (side == "call" and K <= S):
                continue
            seen.add(K)
            ds = abs(math.log(S / K)) / sig
            mid, spread = pricer.mid(side, S, K, iv, n_days, d)
            credit = fill(mid, spread, -1)
            if credit < MIN_CREDIT:
                continue
            # zones between strike and spot (guards) and beyond the strike (cushion)
            if side == "put":
                guards = [g for g in zs if K < g["lo"] and g["hi"] < S]
                beyond = [g for g in zs if g["hi"] < K]
                cush = max(beyond, key=lambda g: g["hi"]) if beyond else None
            else:
                guards = [g for g in zs if S < g["lo"] and g["hi"] < K]
                beyond = [g for g in zs if g["lo"] > K]
                cush = min(beyond, key=lambda g: g["lo"]) if beyond else None
            gm = set().union(*(g["methods"] for g in guards)) if guards else set()
            p_imp = ncdf((math.log(S / K) - 0.5 * sig * sig) / sig) if side == "put" else ncdf((math.log(K / S) - 0.5 * sig * sig) / sig)
            r = {"side": side, "d": d, "i": i, "h": h, "S": S, "K": K, "credit": credit, "grid_m": gm_, "dist_sig": ds, "p_implied": p_imp,
                 "iv": iv, "atr_pct": a / S, **tf,
                 "at_zone": 1.0 if z else 0.0, "at_score": z["score"] if z else 0.0, "at_weight": z["weight"] if z else 0.0,
                 "guard_n": len(guards), "guard_methods": len(gm), "guard_best": max((g["score"] for g in guards), default=0),
                 "cushion_sig": abs(math.log(K / (cush["hi"] if side == "put" else cush["lo"]))) / sig if cush else 9.0,
                 "cushion_score": cush["score"] if cush else 0.0}
            for m in METHODS:
                r[f"m_{m}"] = 1.0 if (z and m in z["methods"]) else 0.0
            if realised:
                Se = float(b["c"][j])
                if side == "put":
                    r["kept"] = 1.0 if Se > K else 0.0
                    r["pnl"] = (credit - max(K - Se, 0.0)) / K
                else:
                    r["kept"] = 1.0 if Se < K else 0.0
                    r["pnl"] = (credit - max(Se - K, 0.0)) / S
                r["pnl_wk"] = r["pnl"] / h
            out.append(r)
    return out


def entries(b):
    """First bar of each calendar week with ≥ 300 bars of history."""
    out, last = [], None
    for i, d in enumerate(b["d"]):
        wk = d.isocalendar()[:2]
        if wk != last:
            last = wk
            if i >= 300:
                out.append(i)
    return out


# ---------------------------------------------------------------- model + evaluation

def fit_predict(rows, feats, year):
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    tr = [r for r in rows if "pnl" in r and r["d"].year < year and (r["d"] + timedelta(days=7 * r["h"] + 3)).year <= year
          and r["d"] < date(year, 1, 1) - timedelta(days=7 * r["h"])]
    te = [r for r in rows if r["d"].year == year]
    if len(tr) < 2000 or not te:
        return
    X = np.array([[r[f] for f in feats] for r in tr], float)
    Xt = np.array([[r[f] for f in feats] for r in te], float)
    clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, random_state=88)
    clf.fit(X, [r["kept"] for r in tr])
    reg = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, random_state=88)
    reg.fit(X, [r["pnl_wk"] for r in tr])
    return clf.predict_proba(Xt)[:, 1], reg.predict(Xt), te


def week_t(per_week):
    v = np.array([x for x in per_week if x == x])
    return float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))) if len(v) > 5 and v.std() > 0 else float("nan")


def main():
    args = sys.argv[1:]
    only = next((set(a.split("=", 1)[1].upper().split(",")) for a in args if a.startswith("--tickers=")), None)
    if "--smoke" in args and not only:
        only = {"CAVA", "SHOP", "TMO", "MU", "CRWV"}
    conn = connect()
    if "--if-due" in args:          # daily.py: the whole run is weekly (≈ the ledger cadence)
        last = conn.execute("SELECT max(made_on) FROM watchlist_sync.forecast_ledger WHERE forecaster LIKE 'S088:%%'").fetchone()[0]
        if last and (date.today() - last).days < LOG_EVERY:
            print(f"S088: not due (last log {last})")
            return
    bars = load(conn, only)
    pricer = Pricer(conn)
    rows, today_rows = [], []
    for n, (t, b) in enumerate(sorted(bars.items())):
        es = entries(b)
        last_i = len(b["c"]) - 1
        for i in es + ([last_i] if last_i not in es else []):
            zs, a = zones(b, i)
            for side in ("put", "call"):
                for r in candidates(b, i, side, pricer, zs, a):
                    r["t"] = t
                    (today_rows if i == last_i else rows).append(r)
        if n % 25 == 0:
            print(f"{n}/{len(bars)} {t} rows {len(rows)}", flush=True)
    print(f"rows {len(rows)} · today {len(today_rows)}", flush=True)
    if "--smoke" in args:
        smoke(rows, today_rows, bars)
        return
    run(rows, today_rows)


def smoke(rows, today_rows, bars):
    """Hand-check: one put and one call candidate with zone detail."""
    for side in ("put", "call"):
        r = next(x for x in rows if x["side"] == side and x["at_zone"] and "pnl" in x)
        print({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
    b = bars[sorted(bars)[0]]
    zs, a = zones(b, len(b["c"]) - 1)
    print(sorted(bars)[0], "spot", b["c"][-1], "atr", round(a, 2))
    for z in zs:
        print(f"  {z['lo']:.2f}–{z['hi']:.2f} score {z['score']} {sorted(z['methods'])}")


def run(rows, today_rows):
    years = sorted({r["d"].year for r in rows})
    res = {}
    for side in ("put", "call"):
        side_rows = [r for r in rows if r["side"] == side]
        for lab, feats in (("zones", BASE_FEATS + ZONE_FEATS), ("no-zones", BASE_FEATS)):
            for y in years:
                if y < FIRST_FIT_YEAR:
                    continue
                o = fit_predict(side_rows, feats, y)
                if not o:
                    continue
                p, e, te = o
                for r, pp, ee in zip(te, p, e):
                    r[f"p_{lab}"], r[f"e_{lab}"] = float(pp), float(ee)
                print(f"{side} {lab} {y} fitted ({len(te)} rows)", flush=True)
        res[side] = side_rows
    if "--vs-ml" in sys.argv[1:]:
        vs_model_list(res["put"])
        return
    # today's model: fit on everything realised, predict today's candidates
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    feats = BASE_FEATS + ZONE_FEATS
    for side in ("put", "call"):
        tr = [r for r in rows if r["side"] == side and "pnl" in r]
        te = [r for r in today_rows if r["side"] == side]
        if not te:
            continue
        X = np.array([[r[f] for f in feats] for r in tr], float)
        clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, random_state=88).fit(X, [r["kept"] for r in tr])
        reg = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, random_state=88).fit(X, [r["pnl_wk"] for r in tr])
        Xt = np.array([[r[f] for f in feats] for r in te], float)
        for r, pp, ee in zip(te, clf.predict_proba(Xt)[:, 1], reg.predict(Xt)):
            r["p_zones"], r["e_zones"] = float(pp), float(ee)
    write(res, today_rows)
    log_ledger(today_rows, force='--force-log' in sys.argv[1:])


def put_delta(r):
    sig = r["iv"] * math.sqrt(5 * r["h"] / 252)
    return ncdf(-(math.log(r["S"] / r["K"]) + 0.5 * sig * sig) / sig)


def vs_model_list(rows, n_top=10):
    """Before/after for the Model List switch (holdout 2023 →, same rows): current put rule (strike nearest |Δ| 0.15,
    |Δ| ≤ 0.20, credit ≥ MIN_WEEKLY_INCOME_PCT/wk) vs S088 (top-10 P(kept) ≥ 90 % by predicted pnl), plus the hybrid
    (current eligible names, S088 strike) that isolates strike choice from name choice."""
    from rules import MIN_WEEKLY_INCOME_PCT, PUT_DELTA, PUT_TARGET_ABS_DELTA
    lo, hi = abs(PUT_DELTA[1]), abs(PUT_DELTA[0])
    L = ["# S088 vs current Model List put rule (holdout 2023 →, walk-forward)", "",
         f"Current = per name-week the candidate strike nearest |Δ| {PUT_TARGET_ABS_DELTA}, |Δ| {lo}–{hi}, credit ≥ "
         f"{MIN_WEEKLY_INCOME_PCT} %/wk of strike. Name ranking (fit score) has no history → 'all eligible' and 'top {n_top} "
         "by credit' bracket it. pnl = bp per collateral-week.", "",
         "| horizon | arm | n | bp/wk | real-fill bp/wk | kept | worst 5 % | Sharpe | max DD | avg |Δ| | week t | vs current all (t) | by year |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for h in HORIZONS:
        hs = [r for r in rows if r["h"] == h and "pnl" in r and r["d"] >= HOLDOUT and "e_zones" in r]
        for r in hs:
            r["dlt"] = put_delta(r)
        cur = {}
        for r in hs:
            if lo <= r["dlt"] <= hi and r["credit"] / r["K"] / h >= MIN_WEEKLY_INCOME_PCT / 100:
                k = (r["t"], r["d"])
                if k not in cur or abs(r["dlt"] - PUT_TARGET_ABS_DELTA) < abs(cur[k]["dlt"] - PUT_TARGET_ABS_DELTA):
                    cur[k] = r
        elig = {k for k in cur}
        byw = defaultdict(list)
        for r in cur.values():
            byw[r["d"]].append(r)
        cur_top = [r for v in byw.values() for r in sorted(v, key=lambda z: -z["credit"] / z["K"])[:n_top]]
        s088, hyb = {}, {}
        for r in hs:
            if r["p_zones"] < 0.90:
                continue
            k = (r["t"], r["d"])
            if k not in s088 or r["e_zones"] > s088[k]["e_zones"]:
                s088[k] = r
            if k in elig and (k not in hyb or r["e_zones"] > hyb[k]["e_zones"]):
                hyb[k] = r
        # live policy: S088 strike only among strikes the live checks pass (Δ band, income floor), else the current strike
        live = dict(cur)
        for r in hs:
            k = (r["t"], r["d"])
            if (k in elig and r["p_zones"] >= 0.90 and lo <= r["dlt"] <= hi
                    and r["credit"] / r["K"] / h >= MIN_WEEKLY_INCOME_PCT / 100
                    and (live[k] is cur[k] or r["e_zones"] > live[k]["e_zones"])):
                live[k] = r
        # same-risk comparator: current-eligible names, plain strike nearest the hybrid's average |Δ| (no model)
        hyb_d = float(np.mean([r["dlt"] for r in hyb.values()])) if hyb else PUT_TARGET_ABS_DELTA
        far = {}
        for r in hs:
            k = (r["t"], r["d"])
            if k in elig and (k not in far or abs(r["dlt"] - hyb_d) < abs(far[k]["dlt"] - hyb_d)):
                far[k] = r

        def top(d):
            bw = defaultdict(list)
            for r in d.values():
                bw[r["d"]].append(r)
            return [r for v in bw.values() for r in sorted(v, key=lambda z: -z["e_zones"])[:n_top]]
        base = summ(list(cur.values()))
        for name, rs in (("current rule, all eligible", list(cur.values())), (f"current rule, top {n_top} by credit", cur_top),
                         (f"S088 top {n_top}, P ≥ 90 %", top(s088)), (f"hybrid: current-eligible names, S088 strike, top {n_top}", top(hyb)),
                         ("hybrid, all eligible names", list(hyb.values())),
                         ("LIVE POLICY: S088 strike within Δ band + income floor, else current", list(live.values())),
                         (f"same names, plain strike nearest |Δ| {hyb_d:.2f} (same-risk comparator)", list(far.values()))):
            s = summ(rs)
            if not s:
                continue
            v = paired_t(s, base) if s is not base and rs is not None and name != "current rule, all eligible" else (float("nan"), 0)
            L.append(f"| {h}w | {name} | {s['n']} | {s['bp']:+.1f} | {s['bp_hc']:+.1f} | {s['kept']:.1%} | {s['worst5']:+.0f} | "
                     f"{s['sharpe']:.2f} | {s['mdd']:.1%} | {np.mean([r['dlt'] for r in rs]):.2f} | {s['t']:.1f} | {v[0]:+.1f} | "
                     + " ".join(f"{y % 100}:{x:+.0f}" for y, x in s["years"].items()) + " |")
    p = OUT.with_name("S088-vs-ML.md")
    p.write_text("\n".join(L) + "\n")
    print("\n".join(L))


LOG_EVERY = 7       # days; the backtest enters weekly


def log_ledger(today_rows, force=False):
    """Forward paper record (graded at expiry by forecast_ledger._r_structure): top-10 P(kept) ≥ 90 % picks per side ×
    horizon (forecaster S088:<side>:<h>w) + the 1σ strike on every name as the baseline (S088:<side>:<h>w:1σ).
    The model refits on every run, so each week's picks use every graded week before it."""
    import json as _json
    from datetime import datetime
    from forecast_ledger import UPSERT
    conn = connect()
    today = max(r["d"] for r in today_rows)
    last = conn.execute("SELECT max(made_on) FROM watchlist_sync.forecast_ledger WHERE forecaster LIKE 'S088:%%'").fetchone()[0]
    if not force and last and (today - last).days < LOG_EVERY:
        print(f"ledger: next S088 log {last + timedelta(days=LOG_EVERY)}")
        return
    n = 0
    for side in ("put", "call"):
        for h in HORIZONS:
            cand = [r for r in today_rows if r["side"] == side and r["h"] == h and "e_zones" in r]
            best = {}
            for r in cand:
                if r["p_zones"] >= 0.90 and (r["t"] not in best or r["e_zones"] > best[r["t"]]["e_zones"]):
                    best[r["t"]] = r
            arms = [(f"S088:{side}:{h}w", sorted(best.values(), key=lambda z: -z["e_zones"])[:10], "p_zones"),
                    (f"S088:{side}:{h}w:1σ", [r for r in cand if r["grid_m"] == 1.0], "p_implied")]
            exp = today + timedelta(days=7 * h)
            exp += timedelta(days=(4 - exp.weekday()) % 7)
            for fc, rs, pk in arms:
                for r in rs:
                    sid = f"short_{side}"
                    qid = f"{fc}:{r['t']}:{exp}:{today}"
                    meta = _json.dumps({"structure": sid, "credit": round(r["credit"], 4), "spot": round(r["S"], 4),
                                        "legs": [{"side": side, "strike": r["K"], "qty": -1, "expiry": str(exp)}],
                                        "from": str(today), "stock": False, "study": "S088", "h": h,
                                        "p_implied": round(r["p_implied"], 4), "exit_rule": "hold to expiry"})
                    conn.execute(UPSERT, (qid, f"Will the short {side} on {r['t']} K {r['K']} (exp {exp}) make money?",
                                          "sim_structure", r["t"], fc, round(min(1, max(0, r[pk])), 4), datetime.now(),
                                          today, exp, meta))
                    n += 1
    conn.commit()
    print(f"ledger: {n} S088 rows logged for {today}")


def pick(rows, key, holdout_only=True, pmin=0.0):
    """Per (name, week, horizon): the candidate with the best predicted pnl (optionally only strikes whose model
    P(kept) ≥ pmin); then the top-N names per week/horizon."""
    best = {}
    pk = key.replace("e_", "p_")
    for r in rows:
        if (key not in r or "pnl" not in r or (holdout_only is True and r["d"] < HOLDOUT)
                or (holdout_only == "pre" and r["d"] >= HOLDOUT) or r.get(pk, 1) < pmin):
            continue
        k = (r["t"], r["d"], r["h"])
        if k not in best or r[key] > best[k][key]:
            best[k] = r
    byw = defaultdict(list)
    for r in best.values():
        byw[(r["d"], r["h"])].append(r)
    return [r for v in byw.values() for r in sorted(v, key=lambda z: -z[key])[:TOPN]]


def fixed(rows, m, holdout_only=True):
    """σ-grid strike m on every name-week (no zone strikes), top-N by nothing → all names."""
    return [r for r in rows if "pnl" in r and r["grid_m"] == m
            and (not holdout_only or r["d"] >= HOLDOUT)]


def summ(rs):
    if not rs:
        return None
    by = defaultdict(list)
    for r in rs:
        by[r["d"]].append(r["pnl_wk"])
    wk = [float(np.mean(v)) for v in by.values()]
    pnl = np.array([r["pnl_wk"] for r in rs])
    hc = np.array([haircut_pnl(r) for r in rs])
    w = np.array(wk)
    eq = np.cumprod(1 + w / max(1, rs[0]["h"]))
    yr = defaultdict(list)
    for r in rs:
        yr[r["d"].year].append(r["pnl_wk"])
    return {"n": len(rs), "bp": float(pnl.mean() * 1e4), "kept": float(np.mean([r["kept"] for r in rs])),
            "worst5": float(np.percentile(pnl, 5) * 1e4), "t": week_t(wk), "wk": dict((d, float(np.mean(v))) for d, v in by.items()),
            "bp_hc": float(hc.mean() * 1e4), "sharpe": float(w.mean() / w.std(ddof=1) * math.sqrt(52)) if w.std() > 0 else float("nan"),
            "mdd": float((eq / np.maximum.accumulate(eq) - 1).min()), "names": len({r["t"] for r in rs}),
            "iv": float(np.mean([r["iv"] for r in rs])), "dist": float(np.mean([r["dist_sig"] for r in rs])),
            "years": {y: float(np.mean(v) * 1e4) for y, v in sorted(yr.items())}}


def paired_t(a, b):
    ks = sorted(set(a["wk"]) & set(b["wk"]))
    return week_t([a["wk"][k] - b["wk"][k] for k in ks]), len(ks)


def brier(rs, key):
    v = [(r[key] - r["kept"]) ** 2 for r in rs if key in r and "kept" in r]
    return float(np.mean(v)) if v else float("nan")


def write(res, today_rows):
    L = ["# S088 — S/R zones → probabilistic strike picker (pre-registered, INDEX S088)", "",
         "Holdout = 2023-01 →, walk-forward (fit on prior years only). pnl = bp per collateral-week (puts) / per $ "
         "stock-week (calls), net of fills, LSEG skew. Picks = top 20 names per week per horizon by predicted pnl.", ""]
    for side in ("put", "call"):
        rs = res[side]
        ho = [r for r in rs if r["d"] >= HOLDOUT]
        # best fixed σ chosen on pre-holdout years
        pre = {m: summ(fixed(rs, m, False) and [r for r in fixed(rs, m, False) if r["d"] < HOLDOUT]) for m in SIGMAS}
        m_best = max(SIGMAS, key=lambda m: pre[m]["bp"] if pre[m] else -1e9)
        L += [f"## Sold {side}s", "", "| horizon | arm | n | bp/wk | bp/wk real-fill haircut | kept | worst 5 % | Sharpe (wk) | max DD | names | avg IV | avg dist σ | week t | vs 1σ (t) | vs best fixed σ (t) | by year bp/wk |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for h in HORIZONS:
            hs = [r for r in rs if r["h"] == h]
            one = summ(fixed(hs, 1.0))
            bf = summ(fixed(hs, m_best))
            arms = [("1σ, all names", one), (f"best fixed {m_best}σ (pre-2023 pick)", bf),
                    ("model, no zones", summ(pick(hs, "e_no-zones"))), ("model + zones", summ(pick(hs, "e_zones"))),
                    ("model + zones, P(kept) ≥ 90 %", summ(pick(hs, "e_zones", pmin=0.90))),
                    ("model + zones, P(kept) ≥ 95 %", summ(pick(hs, "e_zones", pmin=0.95))),
                    ("spot ≥ $20: model + zones, P ≥ 90 %", summ(pick([r for r in hs if r["S"] >= 20], "e_zones", pmin=0.90))),
                    ("spot ≥ $20: 1σ", summ([r for r in fixed(hs, 1.0) if r["S"] >= 20]))]
            arms += [
                    ("2021–22 walk-forward: model + zones, P ≥ 90 %", summ(pick(hs, "e_zones", "pre", pmin=0.90))),
                    ("2021–22: 1σ, all names", summ([r for r in hs if "pnl" in r and r["grid_m"] == 1.0
                                                    and date(2021, 1, 1) <= r["d"] < HOLDOUT])),
                    ("zone strikes only, all", summ([r for r in hs if r["at_zone"] and "pnl" in r and r["d"] >= HOLDOUT])),
                    ("zone strikes, score ≥ 3", summ([r for r in hs if r["at_score"] >= 3 and "pnl" in r and r["d"] >= HOLDOUT]))]
            for name, s in arms:
                if not s:
                    continue
                v1 = paired_t(s, one) if one and s is not one else (float("nan"), 0)
                vb = paired_t(s, bf) if bf and s is not bf else (float("nan"), 0)
                L.append(f"| {h}w | {name} | {s['n']} | {s['bp']:+.1f} | {s['bp_hc']:+.1f} | {s['kept']:.1%} | {s['worst5']:+.0f} | "
                         f"{s['sharpe']:.2f} | {s['mdd']:.1%} | {s['names']} | {s['iv']:.0%} | {s['dist']:.2f} | {s['t']:.1f} | "
                         f"{v1[0]:+.1f} | {vb[0]:+.1f} | " + " ".join(f"{y % 100}:{v:+.0f}" for y, v in s["years"].items()) + " |")
        L += ["", f"Calibration (holdout Brier, lower = better): implied {brier(ho, 'p_implied'):.4f} · model no-zones "
              f"{brier(ho, 'p_no-zones'):.4f} · model + zones {brier(ho, 'p_zones'):.4f}", ""]
        # which zone methods hold best at the same distance (holdout, zone strikes, kept − implied)
        L += ["| zone method at strike | n | kept | implied | kept − implied |", "|---|---|---|---|---|"]
        for m in METHODS:
            z = [r for r in ho if r[f"m_{m}"] and "kept" in r]
            if len(z) > 100:
                k, p = np.mean([r["kept"] for r in z]), np.mean([r["p_implied"] for r in z])
                L.append(f"| {m} | {len(z)} | {k:.1%} | {p:.1%} | {k - p:+.1%} |")
        sg = [r for r in ho if not r["at_zone"] and "kept" in r]
        if sg:
            L.append(f"| (σ-grid, no zone) | {len(sg)} | {np.mean([r['kept'] for r in sg]):.1%} | "
                     f"{np.mean([r['p_implied'] for r in sg]):.1%} | {np.mean([r['kept'] - r['p_implied'] for r in sg]):+.1%} |")
        L.append("")
    # today
    L += ["## Today — best strike per name (model + zones, P(kept) ≥ 90 %), top 10 per side × horizon", ""]
    for side in ("put", "call"):
        for h in HORIZONS:
            best = {}
            for r in today_rows:
                if r["side"] == side and r["h"] == h and "e_zones" in r and r["p_zones"] >= 0.90:
                    if r["t"] not in best or r["e_zones"] > best[r["t"]]["e_zones"]:
                        best[r["t"]] = r
            top = sorted(best.values(), key=lambda z: -z["e_zones"])[:10]
            L += [f"### Sell {side}s, {h} week{'s' if h > 1 else ''}", "",
                  "| ticker | spot | strike | dist σ | zone at strike | P(kept) model | P implied | credit | exp. pnl bp/wk |",
                  "|---|---|---|---|---|---|---|---|---|"]
            for r in top:
                zt = f"score {int(r['at_score'])}" + "".join(f" {m}" for m in METHODS if r[f"m_{m}"]) if r["at_zone"] else "σ-grid"
                L.append(f"| {r['t']} | {r['S']:.2f} | {r['K']:.2f} | {r['dist_sig']:.2f} | {zt} | {r['p_zones']:.0%} | "
                         f"{r['p_implied']:.0%} | {r['credit']:.2f} | {r['e_zones'] * 1e4:+.0f} |")
            L.append("")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[:80]))


if __name__ == "__main__":
    main()
