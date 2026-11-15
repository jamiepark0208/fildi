#!/usr/bin/env python3
"""S087 — collateral timing for the wheel (Jamie 10-22). Pre-registered: research/studies/INDEX.md row S087.

Idea: after a crash, when technicals say the market is near a low over the next 1/2/4 weeks, post more collateral
(sell more puts, hold less cash); after a big rally, near a high, hold more cash. Same for the call leg of the wheel
(held / assigned stock): near a high, overlay more short calls; near a low, fewer.

Trades: weekly ~1σ puts from the S059 harness (S045 pricing, pnl per $ collateral, net of fills) and mirror ~1σ
short calls on the same names / weeks (pnl per $ of stock, net of fills). Portfolio per week = equal weight.
Signal (technicals only, SPY + VIX, Yahoo 2005 → so the model sees 2008/2011/2015/2018/2020 before any trade):
  (a) walk-forward ridge forecast of SPY's forward max drawdown (puts) / max run-up (calls) over h weeks, trained
      only on weeks whose h-week window closed before the entry;
  (b) rule: −z(SPY 20d return, RSI14, distance to 50d) on an expanding history (crash → +, rally → −).
  Signal > 0 = lower risk than usual → deploy more.
Policies:
  linear     c = clip(base + slope × signal, 0.1, 1.0)
  threshold  c = base + jump if signal ≥ its expanding 90th pct, base − jump if ≤ 10th, else base (extremes only,
             Jamie's "significant crash / rallied aggressively")
puts: c × put pnl + (1 − c) × T-bill; calls: stock + c × short-call pnl. Comparator: constant c = mean(c) on the
same weeks (same average exposure → any gain is timing, not leverage).
Amendment (before reading any result): v1 used LSEG SPY (starts 2018-10) → the model could not predict before
late 2021, and breadth features exist only from 2017; v2 swaps in Yahoo SPY/VIX 2005 → and drops breadth.
Threshold policy + signal-quintile diagnostic added as sensitivity (not in the primary Holm family).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s087_collateral_timing.py
"""
from __future__ import annotations

import json
import math
import random
import sys
import urllib.request
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import put_edge as PE  # noqa: E402
import s059_option_factors as S59  # noqa: E402
import s085_regime_analog as e85  # noqa: E402
from build_plan import connect  # noqa: E402
from s045_put_retest import Z, bs_put  # noqa: E402
from s069_gate_audit import rank  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S087.md"
MKT_CSV = HERE.parent / "out" / "opt" / "yahoo_spy_vix.csv"
HORIZONS = (1, 2, 4)
BASES, SLOPES, JUMPS = (0.5, 0.7, 0.9), (0.1, 0.2, 0.3), (0.2, 0.3)
PRIMARY = ("linear", 0.7, 0.2)
C_MIN, C_MAX = 0.1, 1.0
SPLIT = date(2023, 1, 1)
OOS_FROM = date(2020, 1, 1)
FIRST_WEEK = date(2006, 1, 2)
REFIT_WEEKS = 13
RIDGE = 1.0
rng = random.Random(87)


def bs_call(S, K, v, t):
    return bs_put(S, K, v, t) + S - K


def load_market():
    """Daily SPY adj close + VIX close, Yahoo chart API (free), cached to out/opt (gitignored)."""
    if not MKT_CSV.exists():
        rows = {}
        for sym, key in (("SPY", "spy"), ("%5EVIX", "vix")):
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1=1104537600&period2=4102444800&interval=1d"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            j = json.load(urllib.request.urlopen(req, timeout=30))["chart"]["result"][0]
            q = j["indicators"]["adjclose"][0]["adjclose"] if key == "spy" else j["indicators"]["quote"][0]["close"]
            for ts, v in zip(j["timestamp"], q):
                if v:
                    rows.setdefault(datetime.fromtimestamp(ts, timezone.utc).date(), {})[key] = v
        MKT_CSV.write_text("date,spy,vix\n" + "".join(f"{d},{r.get('spy', '')},{r.get('vix', '')}\n"
                                                      for d, r in sorted(rows.items()) if r.get("spy")))
    ds, spy, vix = [], [], []
    for line in MKT_CSV.read_text().splitlines()[1:]:
        d, s, v = line.split(",")
        ds.append(date.fromisoformat(d))
        spy.append(float(s))
        vix.append(float(v) / 100 if v else float("nan"))
    return ds, np.array(spy), np.array(vix)


def rsi(c, n):
    from quantcore.ta import rsi_last  # one home (Jamie 11-15)
    v = rsi_last(c, n)
    return float("nan") if v is None else v  # no stand-in (B1)


def market_features(mkt, d):
    """SPY + VIX technicals from bars ≤ d."""
    ds, c_all, v_all = mkt
    i = bisect_right(ds, d) - 1
    if i < 260:
        return None
    c, v = c_all[: i + 1], v_all[: i + 1]
    lr = np.diff(np.log(c[-21:]))
    rv20 = lr.std(ddof=1) * math.sqrt(252)
    return {"ret5": c[-1] / c[-6] - 1, "ret20": c[-1] / c[-21] - 1, "ret60": c[-1] / c[-61] - 1,
            "rsi2": rsi(c, 2), "rsi14": rsi(c, 14), "dist50": c[-1] / c[-50:].mean() - 1,
            "dist200": c[-1] / c[-200:].mean() - 1, "dd52": c[-1] / c[-252:].max() - 1,
            "vix": v[-1], "vix_chg5": v[-1] - v[-6], "vix_rv": v[-1] / rv20 if rv20 > 0 else float("nan")}


def forward_path(mkt, d, h):
    ds, c, _ = mkt
    i = bisect_right(ds, d) - 1
    j = i + 5 * h
    if i < 0 or j >= len(c):
        return None
    path = c[i + 1: j + 1]
    return {"dd": path.min() / c[i] - 1, "up": path.max() / c[i] - 1, "end": ds[j]}


def short_calls(px, ev):
    """Mirror ~1σ short call per put event: same name, entry, expiry; strike exp(+Zσ√t) at iv30 call."""
    out = []
    for p in ev:
        rows = px.get(p["t"])
        if not rows:
            continue
        i, j = e85.bar_index(rows, p["d"]), e85.bar_index(rows, p["expiry"])
        if i is None or j is None or j <= i:
            continue
        S, Se = rows[i][1], rows[j][1]
        v = rows[i][4] or rows[i][2]
        if not v or v <= 0:
            continue
        tt = p["hold_sessions"] / 252
        K = S * math.exp(Z * v * math.sqrt(tt))
        prem = bs_call(S, K, v, tt)
        out.append({"d": p["d"], "pnl": (prem - max(Se - K, 0.0)) / S - PE.fill_cost(prem / S),
                    "stock": Se / S - 1})
    return out


def edge_q(ev):
    """Live put-edge quintile within week (S069 definition)."""
    byw = defaultdict(list)
    for x in ev:
        byw[x["d"]].append(x)
    for xs in byw.values():
        ok = [x for x in xs if all(x.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech"))]
        if len(ok) >= 30:
            comp = rank(sum(rank([x[k] for x in ok]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
            for x, p in zip(ok, comp):
                x["edge_q"] = min(5, int(p * 5) + 1)


def zexp(vals, i, min_n=52):
    """z of vals[i] vs vals[:i] (expanding; no look-ahead)."""
    hist = [v for v in vals[:i] if v == v]
    if len(hist) < min_n or vals[i] != vals[i]:
        return float("nan")
    sd = np.std(hist, ddof=1)
    return (vals[i] - np.mean(hist)) / sd if sd > 0 else 0.0


def ridge_signal(weeks, feats, fwd, key, h):
    """Walk-forward ridge: predict fwd[key] at each week from features; train rows = weeks whose h-week window
    ended before the prediction date. Returns {week: z of prediction vs past predictions}; + = lower risk."""
    names = sorted(next(iter(feats.values())))
    X = {w: np.array([feats[w][k] for k in names], float) for w in weeks if w in feats}
    pred, beta, mu, sd, last_fit = {}, None, None, None, None
    for w in weeks:
        if w not in X:
            continue
        if last_fit is None or (w - last_fit).days >= 7 * REFIT_WEEKS:
            tr = [v for v in weeks if v in X and v in fwd[h] and fwd[h][v]["end"] < w and np.all(np.isfinite(X[v]))]
            if len(tr) >= 150:
                A = np.array([X[v] for v in tr])
                y = np.array([fwd[h][v][key] for v in tr])
                mu, sd = A.mean(0), A.std(0, ddof=1)
                sd[sd == 0] = 1
                An = (A - mu) / sd
                beta = np.append(np.linalg.solve(An.T @ An + RIDGE * np.eye(An.shape[1]), An.T @ (y - y.mean())),
                                 y.mean())
                last_fit = w
        if beta is None or not np.all(np.isfinite(X[w])):
            continue
        pred[w] = float(((X[w] - mu) / sd) @ beta[:-1] + beta[-1])
    ws = sorted(pred)
    vals = [pred[w] for w in ws]
    sgn = 1.0 if key == "dd" else -1.0     # puts: smaller predicted drawdown = +; calls: smaller run-up (near a high) = +
    return {w: sgn * z for w, z in ((w, zexp(vals, i, 26)) for i, w in enumerate(ws)) if z == z}


def rule_signal(weeks, feats):
    """−z(ret20, rsi14, dist50) on expanding history: crash → +, rally → −."""
    ws = [w for w in weeks if w in feats]
    cols = {k: [feats[w][k] for w in ws] for k in ("ret20", "rsi14", "dist50")}
    out = {}
    for i, w in enumerate(ws):
        zs = [zexp(cols[k], i) for k in cols]
        if all(z == z for z in zs):
            out[w] = -float(np.mean(zs))
    return out


def threshold_ratio(s, ws, base, jump):
    """Extremes only: expanding 10th / 90th percentile of the signal's own history."""
    allw = sorted(s)
    out = []
    for w in ws:
        hist = [s[v] for v in allw if v < w]
        if len(hist) < 104:
            out.append(base)
            continue
        lo, hi = np.percentile(hist, 10), np.percentile(hist, 90)
        out.append(base + jump if s[w] >= hi else base - jump if s[w] <= lo else base)
    return [min(C_MAX, max(C_MIN, c)) for c in out]


def stats(r, wk_rf):
    r = np.array(r)
    ex = r - np.array(wk_rf)
    eq = np.cumprod(1 + r)
    srt = np.sort(r)
    return {"ann": float(eq[-1] ** (52 / len(r)) - 1), "vol": float(r.std(ddof=1) * math.sqrt(52)),
            "sharpe": float(ex.mean() / ex.std(ddof=1) * math.sqrt(52)) if ex.std() > 0 else float("nan"),
            "mdd": float((eq / np.maximum.accumulate(eq) - 1).min()), "cvar5": float(srt[: max(1, len(r) // 20)].mean())}


def block_t(diff, block=4, n=2000):
    d = np.array(diff)
    if len(d) < 3 * block:
        return float("nan")
    k = math.ceil(len(d) / block)
    starts = range(len(d) - block + 1)
    means = [np.concatenate([d[i: i + block] for i in (rng.choice(starts) for _ in range(k))])[: len(d)].mean()
             for _ in range(n)]
    se = np.std(means, ddof=1)
    return float(d.mean() / se) if se > 0 else float("nan")


def holm(p):
    out, run = {}, 0.0
    for k, name in enumerate(sorted(p, key=p.get)):
        run = max(run, min(1.0, (len(p) - k) * p[name]))
        out[name] = run
    return out


def evaluate(trade, leg, ws, c, wk, rf, split=SPLIT):
    cbar = float(np.mean(c))
    if trade == "put":
        dyn = [ci * wk[leg][w] + (1 - ci) * rf[w] for ci, w in zip(c, ws)]
        con = [cbar * wk[leg][w] + (1 - cbar) * rf[w] for w in ws]
    else:
        dyn = [wk["stock"][w] + ci * wk[leg][w] for ci, w in zip(c, ws)]
        con = [wk["stock"][w] + cbar * wk[leg][w] for w in ws]
    rfw = [rf[w] for w in ws]
    out = {"cbar": cbar, "n": len(ws)}
    for lab, sel in (("all", lambda w: True), ("H1", lambda w: w < split), ("H2", lambda w: w >= split)):
        idx = [i for i, w in enumerate(ws) if sel(w)]
        out[lab] = (stats([dyn[i] for i in idx], [rfw[i] for i in idx]), stats([con[i] for i in idx], [rfw[i] for i in idx]))
    diff = [a - b for a, b in zip(dyn, con)]
    out["diff_bp"], out["t"] = float(np.mean(diff) * 1e4), block_t(diff)
    d_all, c_all = out["all"]
    out["works"] = (out["H1"][0]["sharpe"] > out["H1"][1]["sharpe"] and out["H2"][0]["sharpe"] > out["H2"][1]["sharpe"]
                    and d_all["mdd"] >= c_all["mdd"] - 1e-9 and out["t"] >= 2)
    return out


# ---- v3 amendment (after the v2 quintile table, labelled): market STATE with crash confirmation --------------------
# The v2 linear / threshold signals failed; a state breakdown of the same weeks showed the put premium after a crash
# is earned only once VIX stops rising (S082's lesson: confirmation, not the drop). The states below were read off
# 2020→ name-level weeks, so that sample is IN-SAMPLE for them; the independent test is SPY weekly ~1σ puts / calls
# priced at VIX, 2006-01 → 2019-12 (never seen), then 2020 → as a second look.
STATES = ("crash, VIX cooling", "crash, VIX rising", "drawdown > 10 %, calm", "normal", "rally, RSI > 70",
          "rally, RSI ≤ 70")
# collateral ratio per state (puts) / short-call overlay per state (calls); a few sensitivities, not fitted
PUT_POLICIES = {
    "jamie":      dict(zip(STATES, (1.0, 0.9, 0.9, 0.7, 0.5, 0.4))),
    "mild":       dict(zip(STATES, (0.9, 0.8, 0.8, 0.7, 0.6, 0.5))),
    "crash-only": dict(zip(STATES, (1.0, 1.0, 0.7, 0.7, 0.7, 0.7))),
    "rally-only": dict(zip(STATES, (0.7, 0.7, 0.7, 0.7, 0.4, 0.4))),
}
CALL_POLICIES = {
    "jamie":      dict(zip(STATES, (0.0, 0.3, 0.5, 0.7, 1.0, 0.5))),
    "no-crash":   dict(zip(STATES, (0.0, 0.0, 0.7, 0.7, 0.7, 0.7))),
}


def market_state(f):
    if f["ret20"] < -0.05:
        return STATES[0] if f["vix_chg5"] < 0 else STATES[1]
    if f["ret20"] > 0.05:
        return STATES[4] if f["rsi14"] > 70 else STATES[5]
    return STATES[2] if f["dd52"] < -0.10 else STATES[3]


def spy_weekly(mkt, w):
    """SPY ~1σ weekly put and call entered at the close ≤ w, expiring 5 sessions later, priced at VIX (net of fills)."""
    ds, c, v = mkt
    i = bisect_right(ds, w) - 1
    j = i + 5
    if i < 0 or j >= len(c) or not v[i] == v[i]:
        return None
    S, Se, iv, tt = c[i], c[j], v[i], 5 / 252
    Kp, Kc = S * math.exp(-Z * iv * math.sqrt(tt)), S * math.exp(Z * iv * math.sqrt(tt))
    pp, pc = bs_put(S, Kp, iv, tt), bs_call(S, Kc, iv, tt)
    return {"put": (pp - max(Kp - Se, 0.0)) / Kp - PE.fill_cost(pp / Kp),
            "call": (pc - max(Se - Kc, 0.0)) / S - PE.fill_cost(pc / S), "stock": Se / S - 1}


def state_tests(mkt, feats, wk, rf, tb):
    """State policy vs constant at the same average exposure: names 2020→ (in-sample for the states) and SPY
    2006–2019 (out-of-sample) + SPY 2020→."""
    spy = {w: x for w in feats if (x := spy_weekly(mkt, w))}
    spy_wk = {"put": {w: x["put"] for w, x in spy.items()}, "call": {w: x["call"] for w, x in spy.items()},
              "stock": {w: x["stock"] for w, x in spy.items()}}
    rf_all = {w: (e85.tbill_at(tb, w) or 0.0) / 52 for w in spy}
    by_state = defaultdict(lambda: defaultdict(list))
    for w, x in spy.items():
        if w < OOS_FROM:
            s = market_state(feats[w])
            by_state[s]["put"].append(x["put"])
            by_state[s]["call"].append(x["call"])
    out = {"by_state": {s: {k: (float(np.mean(v)) * 1e4, float(np.percentile(v, 5)) * 1e4, len(v)) for k, v in d.items()}
                        for s, d in by_state.items()}, "cells": []}
    samples = [("SPY 2006–2019 (OOS)", spy_wk, lambda w: w < OOS_FROM, rf_all),
               ("SPY 2020→", spy_wk, lambda w: w >= OOS_FROM, rf_all),
               ("names Q4–Q5 2020→ (in-sample)", {"put": wk["put Q4–Q5"], "call": wk["call"], "stock": wk["stock"]},
                lambda w: w >= OOS_FROM, rf)]
    for lab, src, sel, rfx in samples:
        for trade, pols in (("put", PUT_POLICIES), ("call", CALL_POLICIES)):
            ws = [w for w in sorted(src[trade]) if sel(w) and w in feats and w in rfx and (trade == "put" or w in src["stock"])]
            if len(ws) < 100:
                continue
            for name, pol in pols.items():
                c = [pol[market_state(feats[w])] for w in ws]
                split = date(2013, 1, 1) if lab.startswith("SPY 2006") else SPLIT   # each sample split in its own halves
                r = evaluate(trade, trade, ws, c, {trade: src[trade], "stock": src["stock"]}, rfx, split)
                out["cells"].append({"sample": lab, "trade": trade, "policy": name, **r})
    return out


def main():
    conn = connect()
    px = e85.load_prices(conn)
    mkt = load_market()
    ev = S59.aligned_events(conn)
    edge_q(ev)
    calls = short_calls(px, ev)
    tb = e85.tbill_map(conn)
    print(f"{len(ev)} puts · {len(calls)} calls · market bars {mkt[0][0]} → {mkt[0][-1]}", flush=True)

    weeks = sorted({x["d"] for x in ev})
    allw, w = [], FIRST_WEEK
    while w < weeks[0]:
        allw.append(w)
        w += timedelta(days=7)
    allw += weeks
    w = weeks[-1] + timedelta(days=7)
    while w <= mkt[0][-1]:                      # weeks after the last harness week, so today's signal is current
        allw.append(w)
        w += timedelta(days=7)
    feats = {w: f for w in allw if (f := market_features(mkt, w)) and all(v == v for v in f.values())}
    fwd = {h: {w: f for w in allw if (f := forward_path(mkt, w, h))} for h in HORIZONS}

    port = {"put all": defaultdict(list), "put Q4–Q5": defaultdict(list), "call": defaultdict(list),
            "stock": defaultdict(list)}
    for x in ev:
        port["put all"][x["d"]].append(x["pnl"])
        if x.get("edge_q", 0) >= 4:
            port["put Q4–Q5"][x["d"]].append(x["pnl"])
    for x in calls:
        port["call"][x["d"]].append(x["pnl"])
        port["stock"][x["d"]].append(x["stock"])
    wk = {k: {w: float(np.mean(v)) for w, v in d.items() if len(v) >= 20} for k, d in port.items()}
    rf = {w: (e85.tbill_at(tb, w) or 0.0) / 52 for w in weeks}

    sig = {}
    for h in HORIZONS:
        sig[("model", "put", h)] = ridge_signal(allw, feats, fwd, "dd", h)
        sig[("model", "call", h)] = ridge_signal(allw, feats, fwd, "up", h)
    rule = rule_signal(allw, feats)
    sig[("rule", "put", 1)] = rule
    sig[("rule", "call", 1)] = {w: -v for w, v in rule.items()}   # rally → + → more calls

    # forecast skill: does the signal rank SPY's forward drawdown / run-up at all? (OOS weeks)
    skill = {}
    for (kind, trade, h), s in sig.items():
        for hh in (HORIZONS if kind == "rule" else (h,)):
            ws = [w for w in s if w >= OOS_FROM and w in fwd[hh]]
            y = [fwd[hh][w]["dd" if trade == "put" else "up"] * (1 if trade == "put" else -1) for w in ws]
            if len(ws) > 30:
                skill[(kind, trade, hh)] = (float(np.corrcoef(rank([s[w] for w in ws]), rank(y))[0, 1]), len(ws))

    rows, prim_p, quint = [], {}, []
    for (kind, trade, h), s in sig.items():
        legs = ["put all", "put Q4–Q5"] if trade == "put" else ["call"]
        for leg in legs:
            ws = [w for w in weeks if w in s and w in wk[leg] and w >= OOS_FROM and (trade == "put" or w in wk["stock"])]
            if len(ws) < 100:
                continue
            q = np.array(rank([s[w] for w in ws]))
            for k in range(5):
                sel = [wk[leg][w] for w, qq in zip(ws, q) if k / 5 <= qq < (k + 1) / 5 or (k == 4 and qq == 1)]
                quint.append((kind, trade, h, leg, k + 1, float(np.mean(sel)) * 1e4 if sel else float("nan"),
                              float(np.percentile(sel, 5)) * 1e4 if sel else float("nan"), len(sel)))
            for base in BASES:
                for slope in SLOPES:
                    c = [min(C_MAX, max(C_MIN, base + slope * s[w])) for w in ws]
                    r = {"kind": kind, "trade": trade, "leg": leg, "h": h, "policy": "linear", "base": base, "p": slope,
                         **evaluate(trade, leg, ws, c, wk, rf)}
                    rows.append(r)
                    if ("linear", base, slope) == PRIMARY and leg != "put Q4–Q5":
                        t = r["t"]
                        p = 2 * (1 - 0.5 * (1 + math.erf(abs(t) / math.sqrt(2)))) if t == t else 1.0
                        prim_p[(kind, trade, h)] = p if t > 0 else 1.0
                for jump in JUMPS:
                    c = threshold_ratio(s, ws, base, jump)
                    rows.append({"kind": kind, "trade": trade, "leg": leg, "h": h, "policy": "threshold", "base": base,
                                 "p": jump, **evaluate(trade, leg, ws, c, wk, rf)})
        print(f"{kind} {trade} h{h} done", flush=True)

    today = mkt[0][-1]
    st = state_tests(mkt, feats, wk, rf, tb)
    write(rows, holm(prim_p), sig, market_features(mkt, today), today, skill, quint, st)


def write(rows, hp, sig, ft, today, skill, quint, st):
    L = ["# S087 — collateral timing for the wheel (pre-registered, INDEX S087; v2 amendment in the script header)", "",
         "Weekly ~1σ puts (S059 harness, net of fills) and mirror ~1σ short calls; equal-weight portfolio per week; "
         "OOS 2020-01 →. Signal from SPY + VIX technicals (Yahoo, 2005 →). **dyn** = collateral ratio moved by the "
         "signal; **const** = fixed ratio at the same average exposure. Works = Sharpe up in both halves AND max DD "
         "no worse AND 4-week block-bootstrap t ≥ 2.", "",
         "## Forecast skill (rank corr of signal with SPY's forward drawdown / −run-up, OOS weeks)", ""]
    for k, (r, n) in sorted(skill.items()):
        L.append(f"- {k[0]} {k[1]} {k[2]}w: {r:+.3f} (n {n})")
    L += ["", "## Primary cells (linear, base 0.7, slope 0.2)", "",
          "| signal | trade | leg | h | avg c | dyn ann / Sharpe / maxDD | const ann / Sharpe / maxDD | Sharpe H1 dyn/const | "
          "Sharpe H2 dyn/const | diff bp/wk (t) | Holm p | works |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        if (r["policy"], r["base"], r["p"]) == PRIMARY:
            d, c = r["all"]
            L.append(f"| {r['kind']} | {r['trade']} | {r['leg']} | {r['h']}w | {r['cbar']:.2f} | "
                     f"{d['ann']:+.1%} / {d['sharpe']:.2f} / {d['mdd']:.1%} | {c['ann']:+.1%} / {c['sharpe']:.2f} / {c['mdd']:.1%} | "
                     f"{r['H1'][0]['sharpe']:.2f}/{r['H1'][1]['sharpe']:.2f} | {r['H2'][0]['sharpe']:.2f}/{r['H2'][1]['sharpe']:.2f} | "
                     f"{r['diff_bp']:+.2f} ({r['t']:.1f}) | {hp.get((r['kind'], r['trade'], r['h']), float('nan')):.3f} | "
                     f"{'**yes**' if r['works'] else 'no'} |")
    L += ["", "## Weekly leg pnl by signal quintile (Q5 = signal says safest / deploy most), bp per week", "",
          "| signal | trade | h | leg | Q1 | Q2 | Q3 | Q4 | Q5 | Q1 worst 5 % | Q5 worst 5 % |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    grp = defaultdict(dict)
    for kind, trade, h, leg, k, m, p5, n in quint:
        grp[(kind, trade, h, leg)][k] = (m, p5)
    for key, v in grp.items():
        L.append(f"| {key[0]} | {key[1]} | {key[2]}w | {key[3]} | " + " | ".join(f"{v[k][0]:+.1f}" for k in range(1, 6))
                 + f" | {v[1][1]:+.0f} | {v[5][1]:+.0f} |")
    L += ["", "## Sensitivity grid (every policy × base × slope/jump)", "",
          "| signal | trade | leg | h | policy | base | slope/jump | avg c | dyn Sharpe | const Sharpe | dyn maxDD | const maxDD | dyn CVaR5 | const CVaR5 | diff bp/wk (t) | works |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        d, c = r["all"]
        L.append(f"| {r['kind']} | {r['trade']} | {r['leg']} | {r['h']}w | {r['policy']} | {r['base']} | {r['p']} | {r['cbar']:.2f} | "
                 f"{d['sharpe']:.2f} | {c['sharpe']:.2f} | {d['mdd']:.1%} | {c['mdd']:.1%} | {d['cvar5'] * 1e4:+.0f} | {c['cvar5'] * 1e4:+.0f} | "
                 f"{r['diff_bp']:+.2f} ({r['t']:.1f}) | {'yes' if r['works'] else 'no'} |")
    L += ["", "## v3 state policy (amendment, crash confirmation)", "",
          "SPY weekly ~1σ put / call at VIX by state, 2006–2019 (states never seen on this sample), bp per week:", "",
          "| state | put mean | put worst 5 % | call mean | call worst 5 % | weeks |", "|---|---|---|---|---|---|"]
    for s in STATES:
        d = st["by_state"].get(s)
        if d:
            L.append(f"| {s} | {d['put'][0]:+.1f} | {d['put'][1]:+.0f} | {d['call'][0]:+.1f} | {d['call'][1]:+.0f} | {d['put'][2]} |")
    L += ["", "Policies (ratio per state, order: " + ", ".join(STATES) + "): puts " +
          "; ".join(f"{k} {list(v.values())}" for k, v in PUT_POLICIES.items()) + " · calls " +
          "; ".join(f"{k} {list(v.values())}" for k, v in CALL_POLICIES.items()), "",
          "| sample | trade | policy | avg c | dyn ann / Sharpe / maxDD / CVaR5 | const ann / Sharpe / maxDD / CVaR5 | Sharpe H1 dyn/const | Sharpe H2 dyn/const | diff bp/wk (t) | works |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for r in st["cells"]:
        d, c = r["all"]
        L.append(f"| {r['sample']} | {r['trade']} | {r['policy']} | {r['cbar']:.2f} | "
                 f"{d['ann']:+.1%} / {d['sharpe']:.2f} / {d['mdd']:.1%} / {d['cvar5'] * 1e4:+.0f} | "
                 f"{c['ann']:+.1%} / {c['sharpe']:.2f} / {c['mdd']:.1%} / {c['cvar5'] * 1e4:+.0f} | "
                 f"{r['H1'][0]['sharpe']:.2f}/{r['H1'][1]['sharpe']:.2f} | {r['H2'][0]['sharpe']:.2f}/{r['H2'][1]['sharpe']:.2f} | "
                 f"{r['diff_bp']:+.2f} ({r['t']:.1f}) | {'**yes**' if r['works'] else 'no'} |")
    L += ["", f"## Today ({today})", ""]
    if ft:
        L.append(f"**State: {market_state(ft)}** · " + ", ".join(f"{k} {v:+.3f}" for k, v in ft.items()))
        L.append("State-policy ratios today: puts " + ", ".join(f"{k} {v[market_state(ft)]}" for k, v in PUT_POLICIES.items())
                 + " · calls " + ", ".join(f"{k} {v[market_state(ft)]}" for k, v in CALL_POLICIES.items()))
    for key, s in sig.items():
        if s:
            last = max(s)
            L.append(f"- {key[0]} {key[1]} {key[2]}w: signal {s[last]:+.2f} (as of {last}) → linear ratio "
                     f"{min(C_MAX, max(C_MIN, 0.7 + 0.2 * s[last])):.2f} at base 0.7")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[:60]))


if __name__ == "__main__":
    main()
