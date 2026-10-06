#!/usr/bin/env python3
"""Step 8: what makes a put / wheel / covered-call trade good? PCA factor study + walk-forward + scenario analysis (read-only).

Starting point = published factor research (references in the report): Fama-French / Carhart (momentum), Jegadeesh (short-term
reversal), George-Hwang (52-week-high anchoring), Goyal-Saretto (IV − realized vol spread), Carr-Wu / Bollerslev-Tauchen-Zhou
(variance risk premium as a market-regime signal), Ang-Hodrick-Xing-Zhang + Cao-Han (idiosyncratic vol), Frazzini-Pedersen (beta),
Daniel-Moskowitz (momentum crashes after selloffs), Israelov-Nielsen (covered calls = long stock + short vol + short upside),
Kelly-Pruitt-Su (characteristics → a few latent factors, the PCA idea).

Trades: the Step 4 reconstruction (monthly ~0.20Δ 30-day puts on every LSEG name, 2020-03 → now, BS at LSEG 30d ATM IV × haircut).
Outcomes graded four ways, because "good trade" depends on the job the trade does:
  kept      premium kept (P&L ÷ premium)                           — the income job
  ret_ra    return on collateral ÷ implied 1σ                       — risk-adjusted income
  campaign  put → if assigned, hold the stock 63 trading days        — the wheel / ownership job (the user's HOOD question)
  cc_vs_hold  a ~0.20Δ 30-day covered call minus just holding       — when does selling calls cost you upside
Features are point-in-time (data on or before entry). PCA runs separately on stock features (monthly cross-sectional ranks) and on
market-regime features (one row per month). Importance = Fama-MacBeth ICs (Newey-West t), walk-forward out-of-sample IC with
drop-one-group, and scenario tables (market regimes, named episodes, decision rules).

Usage: .venv/bin/python analysis/factor_pca.py [--haircut 0.85] [--delta 0.20] [--exclude HOOD]  → out/step8/factor_pca.md (+ json)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import mean, median, pstdev

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_plan import connect, rows  # noqa: E402
from backtest_puts import RF, build_trades, load, ncdf  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "step8"
HOLD = 63  # trading days the wheel holds assigned stock

STOCK_GROUPS = {
    "vol pricing (IV vs RV, IV rank)": ["iv_rv", "iv_rank_1y"],
    "vol level / risk (IV, idio vol, beta)": ["iv30", "idio_vol", "beta"],
    "short-term trend (1m mom, MA50, RSI, 5d reversal)": ["mom20", "dist_ma50", "rsi14", "rev5"],
    "long-term trend (12-1 mom, MA200)": ["mom_12_1", "dist_ma200"],
    "drawdown from 52w high": ["dd_52w"],
    "analyst revisions (StarMine alpha)": ["combined_alpha_rank"],
    "earnings in window": ["earnings_in_window"],
}
STOCK_F = [f for g in STOCK_GROUPS.values() for f in g]
MKT_F = ["mkt_med_dd", "spy_m20", "spy_dd_52w", "spy_iv", "spy_vrp", "breadth50", "dispersion"]
TARGETS = {"kept": "put premium kept", "camp_kept": "wheel campaign (in premiums)", "own63": "stock vs peers, 3 mo", "cc_kept": "call premium kept"}


def ninv(p: float) -> float:
    lo, hi = -8.0, 8.0
    for _ in range(70):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ncdf(mid) < p else (lo, mid)
    return (lo + hi) / 2


def bs_call(S, K, T, r, s):
    d1 = (math.log(S / K) + (r + s * s / 2) * T) / (s * math.sqrt(T))
    return S * ncdf(d1) - K * math.exp(-r * T) * ncdf(d1 - s * math.sqrt(T))


def call_strike(S, T, r, s, delta):
    d1 = ninv(delta)  # call delta = N(d1)
    return S * math.exp(-(d1 * s * math.sqrt(T)) + (r + s * s / 2) * T)


def logrets(cl, a, b):
    return [math.log(cl[k] / cl[k - 1]) for k in range(max(1, a), b + 1) if cl[k - 1] > 0 and cl[k] > 0]


def enrich(trades, H, extra, haircut, delta):
    """Add the literature features + wheel / covered-call outcomes. Everything indexed at the entry day i (point-in-time)."""
    idx = {t: ([d for d, _, _ in s], [c for _, c, _ in s]) for t, s in H.items()}
    sd, sc = idx["SPY"]
    spy_iv = {d: v for d, _, v in H["SPY"]}
    spy_pos = {d: n for n, d in enumerate(sd)}
    for tr in trades:
        ds, cl = idx[tr["ticker"]]
        i = bisect_left(ds, tr["entry"])
        j = bisect_right(ds, tr["exit"]) - 1
        S = cl[i]
        x = extra.get((tr["ticker"], tr["entry"]), {})
        hi252 = max(cl[max(0, i - 251):i + 1])
        tr["dd_52w"] = S / hi252 - 1                                   # George-Hwang anchor (negative = far below high)
        tr["mom_12_1"] = cl[i - 21] / cl[i - 252] - 1 if i >= 252 else None   # Carhart / Jegadeesh-Titman
        tr["rev5"] = S / cl[i - 5] - 1                                  # Jegadeesh short-term reversal
        tr["dist_ma200"] = S / mean(cl[i - 199:i + 1]) - 1 if i >= 199 else None
        tr["iv_term"] = (x["iv90"] / x["iv30"]) if x.get("iv90") and x.get("iv30") else None   # >1 normal, <1 stressed
        tr["skew"] = (x["iv30"] / x["iv30c"]) if x.get("iv30c") and x.get("iv30") else None    # put IV ÷ call IV
        # beta + idiosyncratic vol vs SPY over the past year (Frazzini-Pedersen, Ang et al.)
        k = bisect_right(sd, tr["entry"]) - 1
        a = [], []
        for n in range(max(1, i - 251), i + 1):
            p = spy_pos.get(ds[n]); q = spy_pos.get(ds[n - 1])
            if p is not None and q is not None and cl[n - 1] > 0 and sc[q] > 0:
                a[0].append(math.log(cl[n] / cl[n - 1])); a[1].append(math.log(sc[p] / sc[q]))
        if len(a[0]) >= 120:
            ys, xs = np.array(a[0]), np.array(a[1])
            b = float(np.cov(xs, ys)[0, 1] / np.var(xs, ddof=1))
            tr["beta"] = b
            tr["idio_vol"] = float(np.std(ys - b * xs, ddof=1) * math.sqrt(252))
        else:
            tr["beta"] = tr["idio_vol"] = None
        # market regime at entry (same for every trade that month)
        tr["spy_dd_52w"] = sc[k] / max(sc[max(0, k - 251):k + 1]) - 1
        v = spy_iv.get(sd[k])
        rv = pstdev(logrets(sc, k - 20, k)) * math.sqrt(252)
        tr["spy_iv"] = v
        tr["spy_vrp"] = (v / 100 - rv) if v else None                   # Carr-Wu / Bollerslev variance risk premium proxy
        sx = extra.get(("SPY", sd[k]), {})
        tr["spy_iv_term"] = (sx["iv90"] / sx["iv30"]) if sx.get("iv90") and sx.get("iv30") else None
        # outcome: wheel campaign (put; if assigned at K, hold HOLD trading days, then mark to market)
        if tr["assigned"]:
            tr["campaign"] = (tr["prem"] + cl[j + HOLD] - tr["K"]) / tr["K"] if j + HOLD < len(cl) else None
        else:
            tr["campaign"] = tr["prem"] / tr["K"]  # cash idle after expiry (conservative)
        # outcome: covered call on 100 shares bought at S vs just holding, same 30-day window
        civ = x.get("iv30c") or x.get("iv30")
        if civ:
            s_ = civ / 100
            T = (ds[j] - tr["entry"]).days / 365
            r = RF.get(tr["entry"].year, 0.03)
            Kc = call_strike(S, T, r, s_, delta)
            prem_c = bs_call(S, Kc, T, r, s_) * haircut
            tr["cc_vs_hold"] = (prem_c - max(0.0, cl[j] - Kc)) / S
            tr["cc_kept"] = (prem_c - max(0.0, cl[j] - Kc)) / prem_c if prem_c > 0 else None
        else:
            tr["cc_vs_hold"] = tr["cc_kept"] = None
    # Outcomes measured in premium units (P&L ÷ premium) or vs peers are volatility-neutral by construction; raw returns are not
    # (an unassigned put returns premium/K, which is just a function of IV, so high-IV names "win" mechanically).
    for tr in trades:
        tr["camp_kept"] = tr["campaign"] * tr["K"] / tr["prem"] if tr["campaign"] is not None and tr["prem"] > 0 else None
        if tr["assigned"]:
            ds, cl = idx[tr["ticker"]]
            j = bisect_right(ds, tr["exit"]) - 1
            tr["post_assign"] = cl[j + HOLD] / tr["K"] - 1 if j + HOLD < len(cl) else None  # did the stock recover above the strike?
        else:
            tr["post_assign"] = None
    by_m = defaultdict(list)
    for tr in trades:
        by_m[tr["entry"]].append(tr)
    for ts in by_m.values():
        g = defaultdict(list)
        for t in ts:
            if t["fwd63"] is not None:
                g[t["peer"] or "_all"].append(t["fwd63"])
        allm = median([t["fwd63"] for t in ts if t["fwd63"] is not None] or [0])
        for t in ts:
            pv = g.get(t["peer"] or "_all") or []
            base = median(pv) if len(pv) >= 4 else allm
            t["own63"] = t["fwd63"] - base if t["fwd63"] is not None else None
        pa = [t["post_assign"] for t in ts if t["post_assign"] is not None]
        for t in ts:
            t["post_assign_rel"] = t["post_assign"] - median(pa) if t["post_assign"] is not None and len(pa) >= 5 else None

        md = median(t["dd_52w"] for t in ts)
        for t in ts:
            t["mkt_med_dd"] = md  # breadth selloff: the median stock's distance from its 52w high (indexes can hide this)
        b = [t["dist_ma50"] for t in ts if t["dist_ma50"] is not None]
        m = [t["mom20"] for t in ts]
        for t in ts:
            t["breadth50"] = sum(v > 0 for v in b) / len(b) if b else None
            t["dispersion"] = pstdev(m) if len(m) > 2 else None
    return trades


# ---------- statistics ----------
def rank_pct(v):
    """Ranks → (−0.5, 0.5); None stays None."""
    idx = [k for k, x in enumerate(v) if x is not None]
    out = [None] * len(v)
    if len(idx) < 2:
        return out
    order = sorted(idx, key=lambda k: v[k])
    n = len(order)
    r = 0
    while r < n:
        s = r
        while s + 1 < n and v[order[s + 1]] == v[order[r]]:
            s += 1
        for q in range(r, s + 1):
            out[order[q]] = ((r + s) / 2 + 0.5) / n - 0.5
        r = s + 1
    return out


def spear(x, y, min_n=20):
    p = [(a, b) for a, b in zip(x, y) if a is not None and b is not None]
    if len(p) < min_n:
        return None
    rx, ry = rank_pct([a for a, _ in p]), rank_pct([b for _, b in p])
    rx, ry = np.array(rx), np.array(ry)
    d = rx.std() * ry.std()
    return float(((rx - rx.mean()) * (ry - ry.mean())).mean() / d) if d > 0 else None


def nw_t(x, lag=3):
    """Newey-West t-stat of a mean (lag 3: campaign / 63d outcomes overlap ~3 monthly entries)."""
    x = np.asarray([v for v in x if v is not None], float)
    n = len(x)
    if n < 6:
        return float("nan")
    e = x - x.mean()
    s = (e @ e) / n
    for l in range(1, lag + 1):
        s += 2 * (1 - l / (lag + 1)) * (e[l:] @ e[:-l]) / n
    return float(x.mean() / math.sqrt(s / n)) if s > 0 else float("nan")


def pca(X, names):
    """X already standardized; returns eigenvalues share + loadings (columns = PCs)."""
    C = np.cov(X, rowvar=False)
    w, V = np.linalg.eigh(C)
    o = np.argsort(w)[::-1]
    w, V = w[o], V[:, o]
    for k in range(V.shape[1]):  # sign: make the largest |loading| positive so PCs are readable
        if V[np.argmax(np.abs(V[:, k])), k] < 0:
            V[:, k] *= -1
    return w / w.sum(), V


def pc_label(v, names, top=3):
    o = np.argsort(-np.abs(v))[:top]
    return ", ".join(f"{'+' if v[k] > 0 else '−'}{names[k]}" for k in o)


def stock_matrix(trades, feats):
    """Monthly cross-sectional ranks (−0.5..0.5), missing → 0 (the month's median)."""
    by_m = defaultdict(list)
    for n, t in enumerate(trades):
        by_m[t["entry"]].append(n)
    X = np.zeros((len(trades), len(feats)))
    for ns in by_m.values():
        for c, f in enumerate(feats):
            r = rank_pct([trades[n][f] for n in ns])
            for n, v in zip(ns, r):
                X[n, c] = 0.0 if v is None else v
    return X


def walk_forward(trades, X, target, years, cols=None):
    """Train pooled OLS on entries before year Y, score year Y → mean monthly OOS Spearman IC across test months."""
    y_all = np.array([np.nan if t[target] is None else t[target] for t in trades])
    yr = np.array([t["entry"].year for t in trades])
    ent = [t["entry"] for t in trades]
    cols = list(range(X.shape[1])) if cols is None else cols
    ics = []
    for Y in years:
        tr = (yr < Y) & ~np.isnan(y_all)
        te = (yr == Y) & ~np.isnan(y_all)
        if tr.sum() < 1000 or te.sum() < 100:
            continue
        # target as monthly cross-sectional rank too (robust to fat tails of kept / campaign)
        yr_rank = np.full(len(trades), np.nan)
        by_m = defaultdict(list)
        for n in np.where(~np.isnan(y_all))[0]:
            by_m[ent[n]].append(n)
        for ns in by_m.values():
            for n, v in zip(ns, rank_pct([y_all[n] for n in ns])):
                yr_rank[n] = v
        tr &= ~np.isnan(yr_rank)  # a month with a single trade has no rank
        A = np.c_[np.ones(tr.sum()), X[tr][:, cols]]
        beta, *_ = np.linalg.lstsq(A, yr_rank[tr], rcond=None)
        pred = np.c_[np.ones(te.sum()), X[te][:, cols]] @ beta
        te_idx = np.where(te)[0]
        bm = defaultdict(list)
        for p, n in zip(pred, te_idx):
            bm[ent[n]].append((p, y_all[n]))
        for v in bm.values():
            ic = spear([a for a, _ in v], [b for _, b in v])
            if ic is not None:
                ics.append(ic)
    return (mean(ics), nw_t(ics, 1), len(ics)) if ics else (None, None, 0)


def summarize(ts):
    def m(k):
        v = [t[k] for t in ts if t.get(k) is not None]
        return mean(v) if v else None
    kept = [t["kept"] for t in ts if t["kept"] is not None]
    ck = [t["cc_kept"] for t in ts if t.get("cc_kept") is not None]
    return {"n": len(ts), "ret": m("ret"), "kept_med": median(kept) if kept else None, "tail": m("tail_ra"),
            "put_loss": sum(k < 0 for k in kept) / len(kept) if kept else None, "call_loss": sum(k < 0 for k in ck) / len(ck) if ck else None,
            "own63": m("own63"), "post_assign": m("post_assign"),
            "assigned": m("assigned"), "campaign": m("campaign"), "cc_vs_hold": m("cc_vs_hold"), "fwd63": m("fwd63"),
}


def fmt(v, pct=True, d=2):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    return f"{100 * v:+.{d}f}%" if pct else f"{v:+.{d}f}"


def srow(name, s):
    return (f"| {name} | {s['n']:,} | {fmt(s['ret'])} | {fmt(s['put_loss'], d=0).lstrip('+')} | {fmt(s['assigned'], d=0).lstrip('+')} | "
            f"{fmt(s['campaign'])} | {fmt(s['post_assign'], d=1)} | {fmt(s['own63'], d=1)} | {fmt(s['cc_vs_hold'])} | {fmt(s['call_loss'], d=0).lstrip('+')} |")


SHEAD = ["| bucket | trades | put ret/mo | put loses money | assigned | wheel campaign (4 mo) | stock vs strike 3 mo after assignment | stock vs peers 3 mo | CC − hold | call loses money |",
         "|---|---|---|---|---|---|---|---|---|---|"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--haircut", type=float, default=0.85)
    ap.add_argument("--delta", type=float, default=0.20)
    ap.add_argument("--exclude", default="", help="comma list of tickers to drop (robustness, e.g. HOOD)")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        H, peer, er, sm = load(conn)
        extra = {(r["ticker"], r["date"]): {"iv30": r["iv30_put"], "iv30c": r["iv30_call"], "iv90": r["iv90_put"]}
                 for r in rows(conn, "SELECT ticker, date, iv30_put, iv30_call, iv90_put FROM lseg_research.daily_history WHERE iv30_put IS NOT NULL")}
    trades = build_trades(H, peer, er, sm, a.haircut, a.delta)
    excl = {s.strip().upper() for s in a.exclude.split(",") if s.strip()}
    trades = [t for t in trades if t["ticker"] not in excl]
    trades = enrich(trades, H, extra, a.haircut, a.delta)
    months = sorted({t["entry"] for t in trades})
    years = sorted({m.year for m in months})
    L = [f"# Step 8: what makes a trade good? PCA factors + scenarios ({date.today()})", "",
         f"{len(trades):,} reconstructed monthly ~{a.delta:.2f}Δ 30-day puts · {len({t['ticker'] for t in trades})} tickers · "
         f"{months[0]} → {months[-1]} ({len(months)} months) · fill haircut {a.haircut}" + (f" · excluded {sorted(excl)}" if excl else ""), "",
         "Not testable with current data: put skew and IV term structure (LSEG ATM call IV = put IV; 90-day IV is ~0% covered), "
         "fundamentals/valuation (no point-in-time history), size (no market-cap history), and the qualitative thesis "
         "(StarMine analyst alpha is used as the closest point-in-time proxy).", ""]

    # ---- 1. stock-level PCA ----
    X = stock_matrix(trades, STOCK_F)
    Xs = (X - X.mean(0)) / np.where(X.std(0) > 0, X.std(0), 1)
    share, V = pca(Xs, STOCK_F)
    npc = int(np.searchsorted(np.cumsum(share), 0.80) + 1)
    P = Xs @ V[:, :npc]
    for k in range(npc):
        for n, t in enumerate(trades):
            t[f"PC{k + 1}"] = float(P[n, k])
    L += ["## 1. Stock-level PCA (what the 16 trade-entry features boil down to)", "",
          f"Features are ranked within each month, so this is about *which names* to pick in a given month. {npc} components explain "
          f"{np.cumsum(share)[npc - 1]:.0%} of the variation.", "",
          "| PC | variance | top loadings | " + " | ".join(f"IC {v}" for v in TARGETS.values()) + " |",
          "|---|---|---|" + "---|" * len(TARGETS)]
    by_m = defaultdict(list)
    for t in trades:
        by_m[t["entry"]].append(t)
    # IV-neutral targets: within each month, the part of the outcome's rank not explained by the IV rank
    # (premium size is mechanical; we want what predicts outcomes *beyond* "sell the higher-IV name")
    for ts in by_m.values():
        riv = rank_pct([t["iv30"] for t in ts])
        for tg in TARGETS:
            ry = rank_pct([t[tg] for t in ts])
            pts = [(a_, b_) for a_, b_ in zip(riv, ry) if a_ is not None and b_ is not None]
            if len(pts) < 10:
                for t in ts:
                    t[tg + "|iv"] = None
                continue
            xa, ya = np.array([p_[0] for p_ in pts]), np.array([p_[1] for p_ in pts])
            sl = float(np.cov(xa, ya)[0, 1] / np.var(xa, ddof=1)) if np.var(xa) > 0 else 0.0
            for t, a_, b_ in zip(ts, riv, ry):
                t[tg + "|iv"] = (b_ - sl * a_) if a_ is not None and b_ is not None else None

    def fm_ic(f, target):
        ics = [spear([t[f] for t in ts], [t[target] for t in ts]) for _, ts in sorted(by_m.items())]
        ics = [i for i in ics if i is not None]
        return (mean(ics), nw_t(ics), sum(i > 0 for i in ics) / len(ics)) if ics else (None, None, None)

    pc_rows = {}
    for k in range(npc):
        cells = []
        for tg in TARGETS:
            ic, t_, _ = fm_ic(f"PC{k + 1}", tg + "|iv")
            pc_rows[(k, tg)] = (ic, t_)
            cells.append(f"{ic:+.3f} (t {t_:+.1f})" if ic is not None else "—")
        L.append(f"| PC{k + 1} | {share[k]:.0%} | {pc_label(V[:, k], STOCK_F)} | " + " | ".join(cells) + " |")
    L += ["", "Full loadings (rows = features, columns = PCs):", "", "| feature | " + " | ".join(f"PC{k + 1}" for k in range(npc)) + " |",
          "|---|" + "---|" * npc]
    for c, f in enumerate(STOCK_F):
        L.append(f"| {f} | " + " | ".join(f"{V[c, k]:+.2f}" for k in range(npc)) + " |")

    # ---- 2. raw factor ICs (Fama-MacBeth, Newey-West) ----
    L += ["", "## 2. Individual factors: monthly rank IC (Fama-MacBeth, Newey-West t, lag 3)", "",
          "IC > 0 → a higher value of the factor means a better outcome. **All ICs hold the IV level fixed** (outcome rank residualized on IV "
          "rank within each month), except the iv30 row itself, which is raw. |t| ≥ 2 is the usual bar; ICs of 0.02–0.05 are what real factors look like.", "",
          "| factor | " + " | ".join(TARGETS.values()) + " |", "|---|" + "---|" * len(TARGETS)]
    fic = {}
    for f in STOCK_F:
        cells = []
        for tg in TARGETS:
            ic, t_, hit = fm_ic(f, tg if f == "iv30" else tg + "|iv")
            fic[(f, tg)] = (ic, t_)
            star = " **" if t_ is not None and abs(t_) >= 2 else ""
            cells.append(f"{star}{ic:+.3f} ({t_:+.1f}){star.strip() and '**'}" if ic is not None else "—")
        L.append(f"| {f} | " + " | ".join(cells) + " |")

    # ---- 2b. assigned only: what predicts the stock recovering above the strike? (the HOOD question) ----
    L += ["", "### 2b. Assigned puts only: which entry factors predicted the stock recovering 3 months after assignment?", "",
          "Target = stock price 63 trading days after assignment ÷ strike, relative to the other assigned names that month. "
          "Months with ≥ 8 assignments only.", "", "| factor | IC | t | months |", "|---|---|---|---|"]
    for f in STOCK_F:
        ics = [spear([t[f] for t in ts if t["post_assign_rel"] is not None], [t["post_assign_rel"] for t in ts if t["post_assign_rel"] is not None], 8)
               for _, ts in sorted(by_m.items())]
        ics = [i for i in ics if i is not None]
        if ics:
            fic[(f, "post_assign")] = (mean(ics), nw_t(ics))
            star = "**" if abs(nw_t(ics)) >= 2 else ""
            L.append(f"| {f} | {star}{mean(ics):+.3f}{star} | {nw_t(ics):+.1f} | {len(ics)} |")

    # ---- 3. walk-forward importance (drop one group) ----
    test_years = [y for y in years if y >= 2022]
    L += ["", f"## 3. Out-of-sample importance (train on earlier years, test {test_years[0]}–{test_years[-1]}; drop one factor group)", "",
          "Full model = all stock features. Δ = how much out-of-sample IC is lost when the group is removed (bigger = more important, "
          "and not replaceable by the other features).", "",
          "| group | " + " | ".join(f"Δ {v}" for v in TARGETS.values()) + " |", "|---|" + "---|" * len(TARGETS)]
    full = {tg: walk_forward(trades, X, tg + "|iv", test_years) for tg in TARGETS}
    L.append("| **full model OOS IC** | " + " | ".join(f"**{full[tg][0]:+.3f}** (t {full[tg][1]:+.1f})" if full[tg][0] is not None else "—" for tg in TARGETS) + " |")
    wf = {}
    for g, fs in STOCK_GROUPS.items():
        keep = [c for c, f in enumerate(STOCK_F) if f not in fs]
        cells = []
        for tg in TARGETS:
            r = walk_forward(trades, X, tg + "|iv", test_years, keep)
            d = (full[tg][0] - r[0]) if r[0] is not None and full[tg][0] is not None else None
            wf[(g, tg)] = d
            cells.append(f"{d:+.3f}" if d is not None else "—")
        L.append(f"| {g} | " + " | ".join(cells) + " |")

    # ---- 4. market-regime PCA + regime tables ----
    mrow = {}
    for m, ts in by_m.items():
        t0 = ts[0]
        if all(t0.get(f) is not None for f in MKT_F):
            mrow[m] = [t0[f] for f in MKT_F]
    mm = sorted(mrow)
    M = np.array([mrow[m] for m in mm])
    Ms = (M - M.mean(0)) / M.std(0)
    mshare, MV = pca(Ms, MKT_F)
    mpc = Ms @ MV[:, :3]
    L += ["", "## 4. Market regime (time series: does *when* you sell matter?)", "",
          f"One row per month ({len(mm)} months). Market PCA: " + "; ".join(
              f"MPC{k + 1} {mshare[k]:.0%} = {pc_label(MV[:, k], MKT_F)}" for k in range(3)) + ".", "",
          "Correlation of the month's average outcome (all names) with each regime variable (Newey-West t on the product of z-scores):", "",
          "| regime variable | " + " | ".join(TARGETS.values()) + " |", "|---|" + "---|" * len(TARGETS)]
    mavg = {tg: np.array([np.nanmean([np.nan if t[tg] is None else t[tg] for t in by_m[m]]) for m in mm]) for tg in TARGETS}
    regime_corr = {}
    for c, f in enumerate(list(MKT_F) + [f"MPC{k + 1}" for k in range(3)]):
        x = Ms[:, c] if c < len(MKT_F) else mpc[:, c - len(MKT_F)]
        cells = []
        for tg in TARGETS:
            y = mavg[tg]
            ok = ~np.isnan(y)
            zx = (x[ok] - x[ok].mean()) / x[ok].std()
            zy = (y[ok] - y[ok].mean()) / y[ok].std()
            r, t_ = float(np.mean(zx * zy)), nw_t(list(zx * zy))
            regime_corr[(f, tg)] = (r, t_)
            cells.append(f"{r:+.2f} (t {t_:+.1f})")
        L.append(f"| {f} | " + " | ".join(cells) + " |")

    def bucket(name, key, edges, labels):
        L.extend(["", f"**{name}**", ""] + SHEAD)
        for lab, (lo, hi) in zip(labels, edges):
            ts = [t for t in trades if t.get(key) is not None and lo <= t[key] < hi]
            if ts:
                L.append(srow(lab, summarize(ts)))

    bucket("Breadth: the median stock's drawdown from its 52-week high at entry", "mkt_med_dd", [(-1, -0.30), (-0.30, -0.20), (-0.20, -0.12), (-0.12, 1)],
           ["deep (> 30%)", "broad selloff (20–30%)", "soft (12–20%)", "healthy (< 12%)"])
    bucket("SPY drawdown from its 52-week high at entry", "spy_dd_52w", [(-1, -0.20), (-0.20, -0.10), (-0.10, -0.05), (-0.05, 1)],
           ["bear (> 20% down)", "correction (10–20%)", "pullback (5–10%)", "near highs (< 5%)"])
    ivs = sorted(t["spy_iv"] for t in trades if t["spy_iv"])
    q = [ivs[int(len(ivs) * p)] for p in (0.33, 0.67)]
    bucket("SPY 30-day implied vol at entry (VIX proxy, terciles)", "spy_iv", [(0, q[0]), (q[0], q[1]), (q[1], 999)],
           [f"calm (< {q[0]:.0f})", f"normal ({q[0]:.0f}–{q[1]:.0f})", f"stressed (> {q[1]:.0f})"])
    bucket("SPY implied − realized vol (variance risk premium)", "spy_vrp", [(-9, 0), (0, 0.04), (0.04, 9)],
           ["negative (realized > implied: panic)", "0–4 pts", "> 4 pts (rich insurance)"])

    # ---- 5. interaction: the HOOD logic (deep stock drawdown × market selloff) ----
    L += ["", "## 5. Your HOOD logic: deep stock drawdown × market selloff", "",
          "Stock 'deep drawdown' = bottom quintile of 52w-high drawdown that month. **Broad selloff = the median stock is ≥ 20% below its 52w high** "
          "(breadth; Feb 2026 qualified at −21% while SPY was only −2.6%).", ""] + SHEAD
    for m_lab, mcond in (("broad selloff", lambda t: t["mkt_med_dd"] <= -0.20), ("market normal", lambda t: t["mkt_med_dd"] > -0.20)):
        for s_lab, lo, hi in (("deep drawdown (Q1)", -0.5, -0.3), ("middle (Q2–Q4)", -0.3, 0.3), ("near high (Q5)", 0.3, 0.6)):
            ts = []
            for mth, xs in by_m.items():
                r = rank_pct([t["dd_52w"] for t in xs])
                ts += [t for t, v in zip(xs, r) if v is not None and lo <= v < hi and mcond(t)]
            if ts:
                L.append(srow(f"{m_lab} · {s_lab}", summarize(ts)))
    # quality filter on top: deep drawdown + analyst support (the 'I like it for x/y/z reasons' part, proxied by StarMine)
    L += ["", "Adding a thesis proxy (StarMine combined alpha in the top half that month — the closest point-in-time stand-in for "
          "'I like this company for reasons'):", ""] + SHEAD
    for m_lab, mcond in (("broad selloff", lambda t: t["mkt_med_dd"] <= -0.20), ("market normal", lambda t: t["mkt_med_dd"] > -0.20)):
        for q_lab, qcond in (("deep dd + alpha top half", lambda v, a_: v < -0.3 and a_ is not None and a_ >= 0),
                             ("deep dd + alpha bottom half", lambda v, a_: v < -0.3 and a_ is not None and a_ < 0)):
            ts = []
            for mth, xs in by_m.items():
                r = rank_pct([t["dd_52w"] for t in xs])
                ra = rank_pct([t["combined_alpha_rank"] for t in xs])
                ts += [t for t, v, a_ in zip(xs, r, ra) if v is not None and qcond(v, a_) and mcond(t)]
            if ts:
                L.append(srow(f"{m_lab} · {q_lab}", summarize(ts)))

    L += ["", "Pullback in a long-term uptrend (HOOD: 20th pct drawdown, 92nd pct 12-month momentum in Feb 2026). Deep dd = bottom 40%; trend = 12-1 momentum:", ""] + SHEAD
    cells = defaultdict(list)
    for mth, xs in by_m.items():
        rd, rm, ra = (rank_pct([t[k] for t in xs]) for k in ("dd_52w", "mom_12_1", "combined_alpha_rank"))
        for t, d_, m_, a_ in zip(xs, rd, rm, ra):
            if d_ is None or m_ is None or d_ >= -0.1:
                continue
            if m_ < -0.1:
                cells["deep dd + 12m downtrend (bottom 40%)"].append(t)
            elif m_ >= 0.1:
                cells["deep dd + 12m uptrend (top 40%)"].append(t)
                if a_ is not None and a_ >= 0:
                    cells["deep dd + uptrend + alpha top half"].append(t)
    for lab, ts in cells.items():
        L.append(srow(f"{lab} ({sum(t['post_assign'] is not None for t in ts)} assigned)", summarize(ts)))

    # ---- 6. covered calls into momentum (the HOOD CC question) ----
    L += ["", "## 6. When do covered calls cost you? (CC − hold by 1-month momentum and 52w position)", "",
          "CC − hold < 0 means the call gave away more upside than it paid. Kept = premium kept on the call.", "",
          "| bucket | trades | CC − hold | median call kept | calls finishing ITM |", "|---|---|---|---|---|"]
    cc_tab = {}
    for lab, cond in (("1m momentum top quintile", lambda r1, r2: r1 >= 0.3), ("1m momentum bottom quintile", lambda r1, r2: r1 < -0.3),
                      ("near 52w high (top quintile)", lambda r1, r2: r2 >= 0.3), ("deep below high (bottom quintile)", lambda r1, r2: r2 < -0.3),
                      ("momentum top AND near high", lambda r1, r2: r1 >= 0.3 and r2 >= 0.3), ("all", lambda r1, r2: True)):
        ts = []
        for mth, xs in by_m.items():
            r1, r2 = rank_pct([t["mom20"] for t in xs]), rank_pct([t["dd_52w"] for t in xs])
            ts += [t for t, a_, b_ in zip(xs, r1, r2) if a_ is not None and b_ is not None and cond(a_, b_) and t["cc_vs_hold"] is not None]
        if ts:
            v = [t["cc_vs_hold"] for t in ts]
            kk = [t["cc_kept"] for t in ts if t["cc_kept"] is not None]
            cc_tab[lab] = mean(v)
            L.append(f"| {lab} | {len(ts):,} | {fmt(mean(v))} | {fmt(median(kk), False)} | {sum(x < 0 for x in kk) / len(kk):.0%} |")
    sel = [(lab, cond) for lab, cond in (("market selloff (SPY ≥10% off high)", lambda t: t["spy_dd_52w"] <= -0.10),
                                          ("market near highs", lambda t: t["spy_dd_52w"] > -0.05))]
    for lab, cond in sel:
        v = [t["cc_vs_hold"] for t in trades if t["cc_vs_hold"] is not None and cond(t)]
        L.append(f"| {lab} | {len(v):,} | {fmt(mean(v))} | — | — |")

    # ---- 7. named episodes ----
    eps = [("Covid crash entry (2020-03, 2020-04)", date(2020, 3, 1), date(2020, 4, 30)), ("2021 bull", date(2021, 1, 1), date(2021, 12, 31)),
           ("2022 bear", date(2022, 1, 1), date(2022, 10, 31)), ("2023–24 bull", date(2023, 1, 1), date(2024, 12, 31)),
           ("2025 tariff shock (Mar–Apr)", date(2025, 3, 1), date(2025, 4, 30)), ("2026 Feb–Mar selloff (your HOOD entries)", date(2026, 2, 1), date(2026, 3, 31)),
           ("2026 Apr → now", date(2026, 4, 1), date(2026, 12, 31))]
    L += ["", "## 7. Named episodes", ""] + SHEAD
    for lab, d0, d1 in eps:
        ts = [t for t in trades if d0 <= t["entry"] <= d1]
        if ts:
            L.append(srow(lab, summarize(ts)))

    # ---- 8. decision-rule scenarios ----
    def rule_rows(title, rules):
        L.extend(["", f"**{title}**", ""] + SHEAD)
        for lab, f in rules:
            ts = []
            for mth, xs in by_m.items():
                rk = {k: rank_pct([t[k] for t in xs]) for k in ("iv_rv", "dd_52w", "combined_alpha_rank", "mom20")}
                for n, t in enumerate(xs):
                    if f(t, {k: v[n] for k, v in rk.items()}):
                        ts.append(t)
            if ts:
                L.append(srow(lab, summarize(ts)))

    L += ["", "## 8. Decision-rule scenarios (what if the Model List had picked trades this way?)"]
    nz = lambda v: v is not None
    rule_rows("Single filters", [
        ("all trades (baseline)", lambda t, r: True),
        ("IV/RV top 40%", lambda t, r: nz(r["iv_rv"]) and r["iv_rv"] >= 0.1),
        ("no earnings in window", lambda t, r: t["earnings_in_window"] == 0),
        ("deep 52w drawdown (bottom 40%)", lambda t, r: nz(r["dd_52w"]) and r["dd_52w"] < -0.1),
        ("StarMine alpha top half", lambda t, r: nz(r["combined_alpha_rank"]) and r["combined_alpha_rank"] >= 0),
        ("market selloff only (SPY ≥ 10% off high)", lambda t, r: t["spy_dd_52w"] <= -0.10),
        ("broad selloff only (median stock ≥ 20% off high)", lambda t, r: t["mkt_med_dd"] <= -0.20),
        ("SPY implied > realized (VRP > 0)", lambda t, r: nz(t["spy_vrp"]) and t["spy_vrp"] > 0),
    ])
    rule_rows("Combinations", [
        ("IV/RV top 40% + no earnings", lambda t, r: nz(r["iv_rv"]) and r["iv_rv"] >= 0.1 and t["earnings_in_window"] == 0),
        ("+ alpha top half", lambda t, r: nz(r["iv_rv"]) and r["iv_rv"] >= 0.1 and t["earnings_in_window"] == 0 and nz(r["combined_alpha_rank"]) and r["combined_alpha_rank"] >= 0),
        ("+ deep drawdown (HOOD-style entry)", lambda t, r: nz(r["iv_rv"]) and r["iv_rv"] >= 0.1 and t["earnings_in_window"] == 0 and nz(r["combined_alpha_rank"]) and r["combined_alpha_rank"] >= 0 and nz(r["dd_52w"]) and r["dd_52w"] < -0.1),
        ("+ deep drawdown + broad selloff", lambda t, r: nz(r["iv_rv"]) and r["iv_rv"] >= 0.1 and t["earnings_in_window"] == 0 and nz(r["combined_alpha_rank"]) and r["combined_alpha_rank"] >= 0 and nz(r["dd_52w"]) and r["dd_52w"] < -0.1 and t["mkt_med_dd"] <= -0.20),
        ("deep drawdown + alpha top + broad selloff (no IV filter)", lambda t, r: nz(r["combined_alpha_rank"]) and r["combined_alpha_rank"] >= 0 and nz(r["dd_52w"]) and r["dd_52w"] < -0.1 and t["mkt_med_dd"] <= -0.20),
        ("deep drawdown + broad selloff (no other filter)", lambda t, r: nz(r["dd_52w"]) and r["dd_52w"] < -0.1 and t["mkt_med_dd"] <= -0.20),
    ])

    # ---- 9. robustness: halves ----
    L += ["", "## 9. Stability: same factor IC in the first half vs the second half (IV held fixed)", "",
          "| factor | campaign 2020–22 | campaign 2023–26 | vs peers 2020–22 | vs peers 2023–26 |", "|---|---|---|---|---|"]
    halves = {}
    for f in STOCK_F:
        cells = []
        for tg in ("camp_kept", "own63"):
            for lo, hi in ((2020, 2022), (2023, 2026)):
                ics = [spear([t[f] for t in ts], [t[tg + "|iv"] for t in ts]) for m, ts in by_m.items() if lo <= m.year <= hi]
                ics = [i for i in ics if i is not None]
                halves[(f, tg, lo)] = mean(ics) if ics else None
                cells.append(f"{mean(ics):+.3f}" if ics else "—")
        L.append(f"| {f} | " + " | ".join(cells) + " |")

    # ---- 10. HOOD Feb–Mar 2026 profile ----
    L += ["", "## 10. Where HOOD's Feb–Apr 2026 entries ranked on each factor (percentile within that month; 100 = highest value)", "",
          "| entry | " + " | ".join(["dd_52w", "iv_rv", "iv_rank_1y", "mom20", "mom_12_1", "combined_alpha_rank", "idio_vol"]) + " | median stock dd | spy_dd_52w | premium kept | campaign |",
          "|---|" + "---|" * 11]
    for mth in sorted(by_m):
        if not (date(2026, 1, 1) <= mth <= date(2026, 5, 31)):
            continue
        xs = by_m[mth]
        h = [n for n, t in enumerate(xs) if t["ticker"] == "HOOD"]
        if not h:
            continue
        n = h[0]
        cells = []
        for f in ["dd_52w", "iv_rv", "iv_rank_1y", "mom20", "mom_12_1", "combined_alpha_rank", "idio_vol"]:
            r = rank_pct([t[f] for t in xs])[n]
            cells.append(f"{100 * (r + 0.5):.0f}" if r is not None else "—")
        t = xs[n]
        L.append(f"| {mth} | " + " | ".join(cells) + f" | {fmt(t['mkt_med_dd'], d=0)} | {fmt(t['spy_dd_52w'], d=1)} | {fmt(t['kept'], False)} | {fmt(t['campaign'])} |")

    (OUT / ("factor_pca" + ("_ex_" + "_".join(sorted(excl)) if excl else "") + ".md")).write_text("\n".join(L) + "\n")
    json.dump({"n": len(trades), "pc_share": [float(s) for s in share[:npc]], "pc_ic": {f"PC{k + 1}|{tg}": v for (k, tg), v in pc_rows.items()},
               "factor_ic": {f"{f}|{tg}": v for (f, tg), v in fic.items()}, "wf_full": full, "wf_drop": {f"{g}|{tg}": v for (g, tg), v in wf.items()},
               "regime_corr": {f"{f}|{tg}": v for (f, tg), v in regime_corr.items()}, "cc": cc_tab},
              open(OUT / ("factor_pca" + ("_ex_" + "_".join(sorted(excl)) if excl else "") + ".json"), "w"), indent=1, default=str)
    print(f"wrote {OUT}/factor_pca*.md  trades={len(trades)} months={len(months)} stock PCs={npc}")


if __name__ == "__main__":
    main()
