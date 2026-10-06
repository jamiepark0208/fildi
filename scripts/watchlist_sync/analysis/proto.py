#!/usr/bin/env python3
"""Gate 1 prototype (PLAN_next_session.md): market-regime labels, Stock score, Trade confidence %, decision ladder. Read-only
except the lab table watchlist_sync.lab_labels; nothing live is touched.

Everything below was pre-registered in PLAN_next_session.md §3 before the first run:
  labels     trend (SPY vs 200d + 50d slope) · breadth (median stock vs 52w high, selloff ≤ −20%) · vol (SPY 30d IV, calm < 15,
             stressed > 25) · VRP (SPY IV − 20d RV pts, rich > 4, panic < 0). A label changes only after 5 consecutive days.
  tests      H1 put loss rate by VRP regime · H2 put P&L by trend · H3 IV/RV within each VRP regime · H4 long-term trend vs peers in
             broad selloffs vs normal · H5 covered calls on top-quintile 20d relative strength. Months are the sample unit.
  stock      equal-weight percentile of 12-1 momentum, distance from 200d, StarMine alpha (fundamentals: no point-in-time history)
  confidence logistic (numpy, L2) per trade type, fit entries 2020-03 → 2023-12, tested 2024-01 →; baseline = train success rate per delta
  ladder     2024 → , ~0.20Δ puts, top 20 a month by PREMIUM (0.7 IV/RV pct + 0.3 IV-rank pct).
             L0 = today's rules (SPY 20d < −5% pause) · L1 = L0 + skip months labelled VRP panic or trend down ·
             L2 = L1 + drop picks below the training 20th percentile of confidence. Skipped months earn 0 (cash).

Usage: .venv/bin/python analysis/proto.py [--rebuild]   → out/proto/gate1.md (trades cached in out/proto/trades.pkl)
"""
from __future__ import annotations

import argparse
import json
import math
import pickle
import sys
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from statistics import mean, median, pstdev

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect, rows  # noqa: E402
from backtest_puts import build_trades, load  # noqa: E402
from factor_pca import enrich, nw_t, spear  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "proto"
VERSION = "regime-0.2"   # 0.1 used VIX-style VRP cut-offs (rich > 4, panic < 0); LSEG ATM IV sits ~2–3 pts under VIX, so
                          # "panic" fired in half of all months. 0.2: rich / panic = top / bottom fifth of 2020–23 SPY IV − RV (training years only)
DELTAS = (0.15, 0.20, 0.30)
SPLIT = date(2024, 1, 1)
CONFIRM = 5
TOP_N = 20


# ---------------- regime labels ----------------
def raw_labels(H):
    sd = [d for d, _, _ in H["SPY"]]
    sc = [c for _, c, _ in H["SPY"]]
    siv = [v for _, _, v in H["SPY"]]
    # breadth: median stock's distance from its own 52-week high, per date
    dd = defaultdict(list)
    for t, s in H.items():
        if t == "SPY":
            continue
        cl = [c for _, c, _ in s]
        for k in range(251, len(s)):
            dd[s[k][0]].append(cl[k] / max(cl[k - 251:k + 1]) - 1)
    vrp_train = []
    for k in range(260, len(sd)):
        if sd[k] < SPLIT and siv[k] is not None:
            lr = [math.log(sc[n] / sc[n - 1]) for n in range(k - 19, k + 1)]
            vrp_train.append(siv[k] - pstdev(lr) * math.sqrt(252) * 100)
    lo_c, hi_c = float(np.quantile(vrp_train, 0.2)), float(np.quantile(vrp_train, 0.8))
    out = []
    for k in range(260, len(sd)):
        ma200 = mean(sc[k - 199:k + 1])
        slope = mean(sc[k - 49:k + 1]) / mean(sc[k - 69:k - 19]) - 1
        lr = [math.log(sc[n] / sc[n - 1]) for n in range(k - 19, k + 1)]
        rv = pstdev(lr) * math.sqrt(252) * 100
        iv = siv[k]
        med = median(dd[sd[k]]) if len(dd[sd[k]]) >= 30 else None
        out.append({
            "date": sd[k],
            "trend": "up" if sc[k] > ma200 and slope > 0 else "down" if sc[k] < ma200 and slope < 0 else "sideways",
            "breadth": None if med is None else ("selloff" if med <= -0.20 else "normal"),
            "vol": None if iv is None else ("calm" if iv < 15 else "stressed" if iv > 25 else "normal"),
            "vrp": None if iv is None else ("rich" if iv - rv > hi_c else "panic" if iv - rv < lo_c else "normal"),
            "raw": {"spy": sc[k], "ma200": round(ma200, 2), "slope50": round(slope, 4), "iv": iv, "rv20": round(rv, 2),
                    "med_dd": None if med is None else round(med, 4), "vrp_cuts": [round(lo_c, 2), round(hi_c, 2)]},
        })
    return out


def confirm(seq):
    """A label switches only after CONFIRM consecutive days of the new raw value."""
    for key in ("trend", "breadth", "vol", "vrp"):
        cur, cand, run = None, None, 0
        for r in seq:
            v = r[key]
            if cur is None:
                cur = v
            elif v != cur:
                run = run + 1 if v == cand else 1
                cand = v
                if run >= CONFIRM:
                    cur, run = v, 0
            else:
                run = 0
            r[key + "_raw"], r[key] = v, cur
    return seq


def timeline(L):
    """Episodes per label family: start → end, state."""
    out = {}
    for key in ("trend", "breadth", "vol", "vrp"):
        eps = []
        for r in L:
            if not eps or eps[-1][2] != r[key]:
                eps.append([r["date"], r["date"], r[key]])
            else:
                eps[-1][1] = r["date"]
        out[key] = eps
    return out


# ---------------- trades ----------------
def get_trades(rebuild):
    OUT.mkdir(parents=True, exist_ok=True)
    pk = OUT / "trades.pkl"
    with connect() as conn:
        H, peer, er, sm = load(conn)
        if pk.exists() and not rebuild:
            return H, pickle.loads(pk.read_bytes())
        extra = {(r["ticker"], r["date"]): {"iv30": r["iv30_put"], "iv30c": r["iv30_call"], "iv90": r["iv90_put"]}
                 for r in rows(conn, "SELECT ticker, date, iv30_put, iv30_call, iv90_put FROM lseg_research.daily_history WHERE iv30_put IS NOT NULL")}
    T = []
    for dl in DELTAS:
        ts = enrich(build_trades(H, peer, er, sm, 0.85, dl), H, extra, 0.85, dl)
        for t in ts:
            t["delta"] = dl
        T += ts
        print(f"  trades Δ{dl}: {len(ts):,}")
    pk.write_bytes(pickle.dumps(T))
    return H, T


def pct_ranks(vals):
    idx = sorted((v, k) for k, v in enumerate(vals) if v is not None)
    out = [None] * len(vals)
    n = len(idx)
    for r, (_, k) in enumerate(idx):
        out[k] = (r + 0.5) / n
    return out


def cross_section(T, lab_by_date):
    """Per (delta, month): stock score, PREMIUM, 20d RS quintile; regime labels at entry."""
    dates = sorted(lab_by_date)
    g = defaultdict(list)
    for t in T:
        g[(t["delta"], t["entry"])].append(t)
    for ts in g.values():
        parts = [pct_ranks([t.get(f) for t in ts]) for f in ("mom_12_1", "dist_ma200", "combined_alpha_rank")]
        raw = [mean(p for p in ps if p is not None) if any(p is not None for p in ps) else None for ps in zip(*parts)]
        for t, s, a, b, c in zip(ts, pct_ranks(raw), *parts):
            t["stock"] = None if s is None else 100 * s
            t["p_trend"], t["p_ma200"], t["p_alpha"] = a, b, c
        ivr, rk = pct_ranks([t["iv_rv"] for t in ts]), pct_ranks([t["iv_rank_1y"] for t in ts])
        for t, a, b in zip(ts, ivr, rk):
            t["premium"] = None if a is None else 0.7 * a + 0.3 * (b if b is not None else 0.5)
        rs = pct_ranks([t["mom_vs_spy"] for t in ts])
        for t, q in zip(ts, rs):
            t["rs_top"] = None if q is None else q >= 0.8
    for t in T:
        k = bisect_right(dates, t["entry"]) - 1
        lab = lab_by_date[dates[k]] if k >= 0 else {}
        for key in ("trend", "breadth", "vol", "vrp"):
            t["L_" + key] = lab.get(key)
        t["win"] = t["ret"] > 0
        t["cc_win"] = None if t.get("cc_kept") is None else t["cc_kept"] > 0
    return T


# ---------------- month-clustered helpers ----------------
def by_month(ts, fn):
    m = defaultdict(list)
    for t in ts:
        v = fn(t)
        if v is not None:
            m[t["entry"]].append(v)
    return {k: mean(v) for k, v in m.items() if v}


def welch(a, b):
    if len(a) < 3 or len(b) < 3:
        return None
    va, vb = np.var(a, ddof=1) / len(a), np.var(b, ddof=1) / len(b)
    return (mean(a) - mean(b)) / math.sqrt(va + vb) if va + vb > 0 else None


def f(v, d=1, pct=True):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "–"
    return f"{100 * v:.{d}f}%" if pct else f"{v:+.{d}f}"


def halves(months):
    ms = sorted(months)
    return ms[:len(ms) // 2], ms[len(ms) // 2:]


def ic_series(ts, x, y):
    g = defaultdict(list)
    for t in ts:
        if t.get(x) is not None and t.get(y) is not None:
            g[t["entry"]].append((t[x], t[y]))
    return {m: spear([a for a, _ in v], [b for _, b in v]) for m, v in g.items() if len(v) >= 20}


def ic_line(s, months=None):
    v = [x for m, x in s.items() if x is not None and (months is None or m in months)]
    return (mean(v), nw_t(v), len(v)) if len(v) >= 6 else (None, None, len(v))


# ---------------- tests ----------------
def tests(T):
    P = [t for t in T if t["delta"] == 0.20]
    L = ["## 2. Regime tests (5 pre-registered; sample = months; trials = 5)", ""]
    # H1 / H2: monthly put loss rate and mean return by label
    for h, key, order in (("H1", "L_vrp", ["rich", "normal", "panic"]), ("H2", "L_trend", ["up", "sideways", "down"])):
        loss = by_month(P, lambda t: 0.0 if t["win"] else 1.0)
        ret = by_month(P, lambda t: t["ret"])
        lab = {t["entry"]: t[key] for t in P}
        L += [f"**{h}: 0.20Δ puts by {key[2:]}**", "", "| state | months | loss rate | mean return / collateral | worst month |", "|---|---|---|---|---|"]
        grp = {}
        for s in order:
            ms = [m for m in loss if lab.get(m) == s]
            grp[s] = ms
            L.append(f"| {s} | {len(ms)} | {f(mean([loss[m] for m in ms])) if ms else '–'} | {f(mean([ret[m] for m in ms]), 2) if ms else '–'} | "
                     f"{f(min(ret[m] for m in ms), 2) if ms else '–'} |")
        a, b = grp[order[0]], grp[order[-1]]
        tl = welch([loss[m] for m in b], [loss[m] for m in a])
        L += ["", f"{order[-1]} vs {order[0]}: loss-rate t = {f(tl, 2, False)} (Welch, months). Halves (loss rate {order[0]} / {order[-1]}): " +
              " · ".join(f"{f(mean([loss[m] for m in a if m in hv])) if any(m in hv for m in a) else '–'} / "
                         f"{f(mean([loss[m] for m in b if m in hv])) if any(m in hv for m in b) else '–'}" for hv in map(set, halves(loss))), ""]
    # H3: IV/RV vs premium kept (vol-neutral target) within each VRP regime
    L += ["**H3: does IV/RV still rank 0.20Δ puts inside each VRP regime?** (monthly IC vs premium kept)", "",
          "| VRP | months | IC | t |", "|---|---|---|---|"]
    s = ic_series(P, "iv_rv", "kept")
    lab = {t["entry"]: t["L_vrp"] for t in P}
    for st in ("rich", "normal", "panic"):
        ic, tt, n = ic_line(s, {m for m in s if lab.get(m) == st})
        L.append(f"| {st} | {n} | {f(ic, 3, False)} | {f(tt, 1, False)} |")
    ic, tt, n = ic_line(s)
    L += [f"| all | {n} | {f(ic, 3, False)} | {f(tt, 1, False)} |", ""]
    # H4: long-term trend vs peers, selloff vs normal breadth
    L += ["**H4: long-term trend (stock score trend part) vs 63-day return vs peers, by breadth**", "", "| breadth | months | IC | t |", "|---|---|---|---|"]
    s = ic_series(P, "p_trend", "own63")
    lab = {t["entry"]: t["L_breadth"] for t in P}
    for st in ("normal", "selloff"):
        ic, tt, n = ic_line(s, {m for m in s if lab.get(m) == st})
        L.append(f"| {st} | {n} | {f(ic, 3, False)} | {f(tt, 1, False)} |")
    # H5: covered calls into top-quintile 20d relative strength
    C = [t for t in P if t["cc_win"] is not None and t["rs_top"] is not None]
    top = by_month([t for t in C if t["rs_top"]], lambda t: 1.0 if t["cc_win"] else 0.0)
    rest = by_month([t for t in C if not t["rs_top"]], lambda t: 1.0 if t["cc_win"] else 0.0)
    ms = sorted(set(top) & set(rest))
    d = [top[m] - rest[m] for m in ms]
    L += ["", "**H5: covered calls (0.20Δ) on top-fifth 20-day strength vs the rest**", "",
          f"call kept money: top fifth {f(mean(top[m] for m in ms))} vs rest {f(mean(rest[m] for m in ms))}; "
          f"monthly difference {f(mean(d), 1)} (t {f(nw_t(d), 1, False)}, {len(ms)} months); halves "
          + " / ".join(f(mean([x for m, x in zip(ms, d) if m in hv]), 1) for hv in map(set, halves(ms))), ""]
    return L


# ---------------- stock score ----------------
def stock_check(T):
    P = [t for t in T if t["delta"] == 0.20]
    L = ["## 3. Stock score (trend + revisions; fundamentals not testable yet)", "",
         "Monthly IC vs 63-day return vs peers (`own63`):", "", "| score | IC | t | months | 2020–23 | 2024–26 |", "|---|---|---|---|---|---|"]
    for name, x in (("Stock score", "stock"), ("12-1 momentum", "p_trend"), ("vs 200-day", "p_ma200"), ("StarMine alpha", "p_alpha")):
        s = ic_series(P, x, "own63")
        a = ic_line(s); b = ic_line(s, {m for m in s if m < SPLIT}); c = ic_line(s, {m for m in s if m >= SPLIT})
        L.append(f"| {name} | {f(a[0], 3, False)} | {f(a[1], 1, False)} | {a[2]} | {f(b[0], 3, False)} | {f(c[0], 3, False)} |")
    return L + [""]


# ---------------- confidence ----------------
FEATS = ["delta", "iv_rv", "iv_rank_1y", "stock", "earnings_in_window",
         "L_trend=down", "L_trend=sideways", "L_vrp=rich", "L_vrp=panic", "L_breadth=selloff", "L_vol=stressed"]


def xrow(t, med):
    v = []
    for k in FEATS:
        if "=" in k:
            a, b = k.split("=")
            v.append(1.0 if t.get(a) == b else 0.0)
        else:
            x = t.get(k)
            v.append(med[k] if x is None else float(min(x, 5.0) if k == "iv_rv" else x))
    return v


def fit_logit(X, y, lam=1.0, it=50):
    X1 = np.hstack([np.ones((len(X), 1)), X])
    w = np.zeros(X1.shape[1])
    R = lam * np.eye(X1.shape[1]); R[0, 0] = 0
    for _ in range(it):
        p = 1 / (1 + np.exp(-X1 @ w))
        g = X1.T @ (p - y) + R @ w
        Hs = (X1 * (p * (1 - p))[:, None]).T @ X1 + R
        step = np.linalg.solve(Hs, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def predict(w, X):
    return 1 / (1 + np.exp(-(np.hstack([np.ones((len(X), 1)), X]) @ w)))


def confidence(T, kind):
    yk = "win" if kind == "put" else "cc_win"
    D = [t for t in T if t[yk] is not None]
    tr = [t for t in D if t["entry"] < SPLIT]
    te = [t for t in D if t["entry"] >= SPLIT]
    med = {k: median([t[k] for t in tr if t.get(k) is not None]) for k in FEATS if "=" not in k}
    Xtr = np.array([xrow(t, med) for t in tr]); Xte = np.array([xrow(t, med) for t in te])
    mu, sd = Xtr.mean(0), np.where(Xtr.std(0) > 0, Xtr.std(0), 1)
    w = fit_logit((Xtr - mu) / sd, np.array([float(t[yk]) for t in tr]))
    ptr, pte = predict(w, (Xtr - mu) / sd), predict(w, (Xte - mu) / sd)
    for t, p in zip(tr, ptr):
        t["conf_" + kind] = float(p)
    for t, p in zip(te, pte):
        t["conf_" + kind] = float(p)
    base = {dl: mean(float(t[yk]) for t in tr if t["delta"] == dl) for dl in DELTAS}
    y = np.array([float(t[yk]) for t in te])
    b0 = np.array([base[t["delta"]] for t in te])
    bm, bb = float(np.mean((pte - y) ** 2)), float(np.mean((b0 - y) ** 2))
    L = [f"### {kind.title()}s ({'put P&L > 0' if kind == 'put' else 'covered call beats holding'})", "",
         f"Train {len(tr):,} trades (to 2023-12) · test {len(te):,} (2024-01 →). Training success rate by delta: "
         + ", ".join(f"Δ{dl} {f(base[dl])}" for dl in DELTAS), "",
         f"Brier: model {bm:.4f} vs baseline {bb:.4f} → skill **{f(1 - bm / bb, 1)}** (> 0 = better than the strike alone)", ""]
    # month-clustered skill: per-month Brier improvement
    mo = defaultdict(lambda: [0.0, 0.0, 0])
    for t, p, b, yy in zip(te, pte, b0, y):
        m = mo[t["entry"]]; m[0] += (p - yy) ** 2; m[1] += (b - yy) ** 2; m[2] += 1
    imp = [(v[1] - v[0]) / v[2] for _, v in sorted(mo.items())]
    hv = halves(sorted(mo))
    L += [f"Monthly Brier improvement: positive in {sum(x > 0 for x in imp)}/{len(imp)} months, t {f(nw_t(imp), 1, False)}; halves "
          + " / ".join(f"{sum(x > 0 for m, x in zip(sorted(mo), imp) if m in set(h))}/{len(h)}" for h in hv), "",
          "Reliability on 2024–26 (fifths of predicted confidence):", "", "| fifth | predicted | actual | n | gap |", "|---|---|---|---|---|"]
    order = np.argsort(pte)
    worst = 0.0
    for q, idx in enumerate(np.array_split(order, 5)):
        pm, am = float(pte[idx].mean()), float(y[idx].mean())
        worst = max(worst, abs(pm - am))
        L.append(f"| {q + 1} | {f(pm)} | {f(am)} | {len(idx):,} | {100 * (am - pm):+.1f} |")
    L += ["", f"Largest gap {100 * worst:.1f} pts (stop rule: > 10). By test half: " + " · ".join(
        f"{h[0]:%Y-%m}→{h[-1]:%Y-%m} predicted {f(float(np.mean([p for t, p in zip(te, pte) if t['entry'] in set(h)])))} "
        f"actual {f(float(np.mean([yy for t, yy in zip(te, y) if t['entry'] in set(h)])))}" for h in hv), "",
          "Weights (standardized): " + ", ".join(f"{k} {w[i + 1]:+.2f}" for i, k in enumerate(FEATS)), ""]
    cut = float(np.quantile([p for t, p in zip(tr, ptr) if t["delta"] == 0.20], 0.20))
    return L, cut, 1 - bm / bb, worst


# ---------------- decision ladder ----------------
def ladder(T, cut):
    P = [t for t in T if t["delta"] == 0.20 and t["entry"] >= SPLIT and t["premium"] is not None]
    months = sorted({t["entry"] for t in P})
    bym = defaultdict(list)
    for t in P:
        bym[t["entry"]].append(t)
    rungs = {
        "L0 today (PREMIUM top 20, SPY pause)": lambda m, ts: ts if (ts[0]["spy_m20"] or 0) >= -0.05 else [],
        "L1 + regime dial (skip panic / downtrend months)": lambda m, ts: [] if ((ts[0]["spy_m20"] or 0) < -0.05 or ts[0]["L_vrp"] == "panic"
                                                                              or ts[0]["L_trend"] == "down") else ts,
    }
    rungs["L2 + confidence (drop bottom-fifth)"] = lambda m, ts: [t for t in rungs["L1 + regime dial (skip panic / downtrend months)"](m, ts)
                                                                  if t["conf_put"] >= cut]
    L = ["## 5. Decision ladder (2024-01 → , 0.20Δ puts, top 20 a month by PREMIUM, equal weight; skipped month = 0)", "",
         "| rung | months traded | trades | mean monthly return | loss rate | tail rate (< −5%) | worst month | mean/sd | halves (mean monthly) |",
         "|---|---|---|---|---|---|---|---|---|"]
    res = {}
    for name, fn in rungs.items():
        mret, picks = [], []
        for m in months:
            ts = sorted(fn(m, bym[m]), key=lambda t: -t["premium"])[:TOP_N]
            picks += ts
            mret.append(mean(t["ret"] for t in ts) if ts else 0.0)
        hv = halves(months)
        hm = [mean([r for m, r in zip(months, mret) if m in set(h)]) for h in hv]
        sd = pstdev(mret)
        res[name] = (mean(mret), sum(1 for t in picks if t["ret"] < -0.05) / max(1, len(picks)), hm)
        L.append(f"| {name} | {sum(1 for m in months if any(True for _ in fn(m, bym[m])))}/{len(months)} | {len(picks)} | {f(mean(mret), 2)} | "
                 f"{f(sum(1 for t in picks if t['ret'] <= 0) / max(1, len(picks)))} | {f(res[name][1])} | {f(min(mret), 2)} | "
                 f"{mean(mret) / sd if sd else 0:.2f} | {' / '.join(f(x, 2) for x in hm)} |")
    return L + [""], res


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rebuild", action="store_true", help="rebuild the trade cache")
    a = ap.parse_args()
    H, T = get_trades(a.rebuild)
    labels = confirm(raw_labels(H))
    with connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.lab_labels (date date PRIMARY KEY, version text NOT NULL, trend text,
                        breadth text, vol text, vrp text, raw jsonb, computed_at timestamptz NOT NULL DEFAULT now())""")
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO watchlist_sync.lab_labels (date, version, trend, breadth, vol, vrp, raw) VALUES (%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (date) DO UPDATE SET version = EXCLUDED.version, trend = EXCLUDED.trend, breadth = EXCLUDED.breadth,
                               vol = EXCLUDED.vol, vrp = EXCLUDED.vrp, raw = EXCLUDED.raw, computed_at = now()""",
                            [(r["date"], VERSION, r["trend"], r["breadth"], r["vol"], r["vrp"],
                              json.dumps({**r["raw"], **{k + "_raw": r[k + "_raw"] for k in ("trend", "breadth", "vol", "vrp")}})) for r in labels])
        conn.commit()
    lab_by_date = {r["date"]: r for r in labels}
    T = cross_section(T, lab_by_date)
    yrs = (labels[-1]["date"] - labels[0]["date"]).days / 365.25
    tl = timeline(labels)
    L = [f"# Gate 1: regime labels, Stock score, Trade confidence % ({date.today()}, {VERSION})", "",
         f"{len(T):,} reconstructed 30-day trades ({', '.join(f'Δ{d}' for d in DELTAS)}; puts + covered calls) · "
         f"{len({t['ticker'] for t in T})} tickers · entries {min(t['entry'] for t in T)} → {max(t['entry'] for t in T)}. "
         "Black-Scholes at LSEG IV × 0.85 fill. Read-only; labels stored in `watchlist_sync.lab_labels`.", "",
         "## 1. Regime timeline", "", f"{labels[0]['date']} → {labels[-1]['date']} ({yrs:.1f} years). Flips per year: "
         + ", ".join(f"{k} {(len(v) - 1) / yrs:.1f}" for k, v in tl.items()) + ".", ""]
    for k in ("trend", "breadth", "vrp", "vol"):
        eps = [e for e in tl[k] if (e[1] - e[0]).days >= 10 or e[2] != Counter(r[k] for r in labels).most_common(1)[0][0]]
        L.append(f"**{k}**: " + " · ".join(f"{e[0]:%y-%m-%d}→{e[1]:%y-%m-%d} {e[2]}" for e in eps if e[2] is not None))
        L.append("")
    L += tests(T)
    L += stock_check(T)
    L += ["## 4. Trade confidence %", ""]
    lp, cut, skill_p, gap_p = confidence(T, "put")
    lc, _, skill_c, gap_c = confidence(T, "call")
    L += lp + lc
    ll, res = ladder(T, cut)
    L += ll
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "gate1.md").write_text("\n".join(L) + "\n")
    (OUT / "gate1.json").write_text(json.dumps({"put_skill": skill_p, "put_gap": gap_p, "call_skill": skill_c, "call_gap": gap_c,
                                                "ladder": res, "cut": cut}, default=str, indent=1))
    print(f"gate1: puts skill {skill_p:+.3f} gap {gap_p:.3f} · calls skill {skill_c:+.3f} gap {gap_c:.3f}")
    for k, v in res.items():
        print(f"  {k:<52} mean {100 * v[0]:+.2f}%/mo  tail {100 * v[1]:.1f}%  halves {' / '.join(f'{100 * x:+.2f}' for x in v[2])}")
    print("→ out/proto/gate1.md")


if __name__ == "__main__":
    main()
