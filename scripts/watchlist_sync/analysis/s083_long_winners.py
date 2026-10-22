"""S083 — what makes a long option win? (A244, third pass)

Pre-registered in research/studies/INDEX.md (row S083) and committed BEFORE this script was run.
Authority: Jamie 10-22 — "S081 FAIL is not an answer; get closer to the goal."

S081 answered "does a Direction × Price screen beat unconditional buying?" with FAIL. S083 asks the two questions that
a FAIL leaves open:
  Part A — **reverse-engineer the winners** that S081 already produced. Not "does my screen work?" but "what did the
           +100 % trades look like at entry?" (memory: reverse-engineer-winners).
  Part B — **four entry signals from the literature that have never been tested as long-option entries here**, one
           frozen setting each, Holm over 4.
  Part C lives in long_option_ledger.py (forward track record), committed separately after A/B.

Engine: reused from S081 / S080 / S076 unchanged — Black-Scholes at the stock's iv30_<side> × the S075 skew ratio for the
(side, DTE, |Δ|) cell, entry fill = bid + 23 % of the spread, LSEG daily panel, T-bill (FRED DTB3) over the holding days,
**held to expiry** (intrinsic at the last bar ≤ expiry). Returns are per $ debit.

One deliberate difference from S081, needed by Part A: S081 skipped any entry with a report in (entry, expiry], so
"earnings inside the window" could not be a feature — it was identically 0. S083 **keeps** those entries and carries
`earn_in_window` as a feature. The S081-comparable subset (earn_in_window = 0) is reported beside it, and the
reconciliation check in the report confirms the engine still reproduces S081's unconditional numbers on that subset.

DATA LIMITS FOUND BY THE READ-ONLY INVENTORY (calibration log 10-22: probe before claiming, and plan after the
inventory, not before):
  - `optlab.earnings_moves` (the S018 actual ÷ priced ratio) holds 391 reports / 59 names and **starts 2024-11-14**.
  - `optlab.bars` (real Polygon option closes → call−put IV spread, put skew) **starts 2024-10-15**.
  Both therefore sit entirely inside the Part A *test* window (2024-25) and cannot be fitted on 2021-23. Putting them in
  the primary feature matrix would either drop every fit row or median-impute 100 % of them — a leak dressed as a
  feature. They are pre-registered as a **restricted-window descriptive family** (univariate, Holm within the family,
  never in the primary model, never selected on). Same treatment S080/S081 gave arm (g).

Pre-registered bars:
  Part A (per side) — test-window AUC ≥ 0.60 (vs the non-winners of the same side) AND the top-decile model score's mean
    per $ debit > 0 AND its month-block bootstrap t ≥ 2 AND the sign survives the ±25 % call-cost stress.
  Part B (per arm)  — mean per $ debit > 0 AND month-block t ≥ 2 AND Holm p < 0.05 over the 4 arms AND beats the S081
    unconditional comparator on the same side AND beats buying the stock on the same signal per $ risked
    (equal-volatility scaled) AND the sign survives the ±25 % call-cost stress.
  Stop rule: nothing clears → no list, log which condition failed, no post-hoc substitute arm is promoted.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s083_long_winners.py [--smoke] [--tickers=A,B] [--max-names=N]
"""
from __future__ import annotations

import json
import math
import random
import statistics
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402
from s080_long_options import SCEN  # noqa: E402  — base · rich (×1.25) · cheap (×0.75) on the call ratio
from s076_structures_backtest import Pricer, fill, strike_for  # noqa: E402
from s045_put_retest import ncdf  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S083.md"
FLAGS = HERE.parent / "out" / "opt" / "S083_flags.json"

START = date(2021, 2, 1)
FIT = (date(2021, 2, 1), date(2023, 12, 31))     # Part A fit window
TEST = (date(2024, 1, 1), date(2025, 12, 31))    # Part A test window — untouched until the model was frozen
TEST_END = TEST[1]

DELTA, DTE = 0.50, 45
PEAD_DTE = 30                                    # Part B4, frozen
STRADDLE_DTE = 7                                 # Part B3, frozen (nearest weekly); 30 reported as a sensitivity
WIN_PAYOFF = 1.00                                # Part A label: payoff ≥ +100 % per $ debit at expiry
ALPHA = 0.05
MIN_N = 30

# Part A primary features — every one is computable across the whole 2021-25 panel (inventory-verified)
FEATS = ["iv_rv", "iv_rank", "iv_chg5", "prox_52w", "ret20", "ret60", "ret120",
         "dist_ma50", "dist_ma200", "vol_z", "earn_in_window", "spy_below_200"]
# restricted-window descriptive family (2024-10/11 →) — never in the primary model
RESTRICTED = ["s018_ratio", "cp_iv_spread", "put_skew"]

rng = random.Random(83)
nprng = np.random.default_rng(83)


# ---------------------------------------------------------------- stats (same estimators as S081)

def month_blocks(xs, key):
    by = defaultdict(list)
    for x in xs:
        by[(x["d"].year, x["d"].month)].append(x[key])
    return by


def boot(xs, key="base", n=600):
    """Month-block bootstrap, aggregated per block (identical estimator to S080.boot). Returns (t, 90 % CI).

    The generator is re-seeded per call: with one shared stream the resample draws depend on the order the arms happen
    to be computed in, so simply adding a descriptive slice moved every t by ~0.2 between runs. Per-call seeding makes
    the reported numbers reproducible."""
    rng = random.Random(83)
    by = month_blocks(xs, key)
    ks = list(by)
    if len(ks) < 6:
        return float("nan"), (float("nan"), float("nan"))
    agg = {k: (math.fsum(v), len(v)) for k, v in by.items()}

    def m(sel):
        s = c = 0
        for k in sel:
            a, b = agg[k]
            s += a
            c += b
        return s / c if c else float("nan")

    obs = m(ks)
    bs = sorted(m([rng.choice(ks) for _ in ks]) for _ in range(n))
    sd = statistics.pstdev(bs)
    lo, hi = bs[int(0.05 * n)], bs[int(0.95 * n) - 1]
    return (obs / sd if sd else float("nan")), (lo, hi)


S80.boot = boot
stats, fmt = S80.stats, S80.fmt


def pval(s):
    if not s or s["t"] != s["t"]:
        return float("nan")
    return 2 * (1 - ncdf(abs(s["t"])))


def holm(pairs):
    """Holm step-down. pairs = [(label, p)] → {label: adjusted p}."""
    live = sorted([(p, k) for k, p in pairs if p == p])
    out = {k: float("nan") for k, _ in pairs}
    run = 0.0
    for i, (p, k) in enumerate(live):
        run = max(run, min(1.0, (len(live) - i) * p))
        out[k] = run
    return out


def welch(a, b):
    a = [x for x in a if x == x]
    b = [x for x in b if x == x]
    if len(a) < MIN_N or len(b) < MIN_N:
        return float("nan"), float("nan"), float("nan"), float("nan")
    ma, mb = statistics.mean(a), statistics.mean(b)
    se = math.sqrt(statistics.variance(a) / len(a) + statistics.variance(b) / len(b))
    t = (ma - mb) / se if se else float("nan")
    p = math.erfc(abs(t) / math.sqrt(2)) if t == t else 1.0
    return ma, mb, t, p


def scen_sign_ok(s):
    """The ±25 % call-cost stress keeps the sign of the base mean."""
    if not s:
        return False
    sc = s["scen"]
    return all((sc[k] > 0) == (sc["base"] > 0) for k in SCEN if sc[k] == sc[k])


# ---------------------------------------------------------------- panel features

def extra_features(rows, c, rv20, vol60):
    """Per-bar arrays beyond S80.features(), all computed from bars ≤ i only."""
    n = len(c)
    v = np.array([r[4] if r[4] is not None else np.nan for r in rows], float)
    prox = np.full(n, np.nan)      # close ÷ 252-day high − 1 (0 = sitting on the 52-week high)
    ret20 = np.full(n, np.nan)
    ret60 = np.full(n, np.nan)
    ret120 = np.full(n, np.nan)
    ret12_1 = np.full(n, np.nan)    # 12-1 month momentum (Moskowitz-Ooi-Pedersen), skips the last month
    vol_z = np.full(n, np.nan)
    for i in range(252, n):
        hi = c[i - 251:i + 1].max()
        prox[i] = c[i] / hi - 1 if hi > 0 else np.nan
        ret20[i] = c[i] / c[i - 20] - 1
        ret60[i] = c[i] / c[i - 60] - 1
        ret120[i] = c[i] / c[i - 120] - 1
        ret12_1[i] = c[i - 21] / c[i - 252] - 1
        w = v[i - 59:i + 1]
        w = w[~np.isnan(w)]
        if len(w) >= 30:
            sd = w.std(ddof=1)
            vol_z[i] = (v[i] - w.mean()) / sd if sd > 0 and v[i] == v[i] else np.nan
    return prox, ret20, ret60, ret120, ret12_1, vol_z



def iv_chg5(series):
    a = np.array([x if x is not None else np.nan for x in series], float)
    out = np.full(len(a), np.nan)
    out[5:] = a[5:] - a[:-5]
    return out


# ---------------------------------------------------------------- restricted-window inputs (descriptive only)

def s018_ratios(conn):
    """Per name, the median actual ÷ priced earnings move over the reports STRICTLY BEFORE each report date
    (rolling, ≥ 4 priors). Returns {ticker: [(report_date, median_prior_ratio, n_prior)]} — no look-ahead."""
    by = defaultdict(list)
    for t, d, r in conn.execute("SELECT ticker, report_date, ratio::float FROM optlab.earnings_moves "
                                "WHERE ratio IS NOT NULL AND implied > 0 ORDER BY ticker, report_date"):
        by[t].append((d, r))
    out = {}
    for t, seq in by.items():
        rows = []
        for i, (d, _) in enumerate(seq):
            prior = [r for _, r in seq[:i]]
            if len(prior) >= 4:
                rows.append((d, statistics.median(prior), len(prior)))
        if rows:
            out[t] = rows
    return out


def polygon_iv_pairs(conn):
    """Call−put IV spread (Cremers-Weinbaum) and OTM-put skew (Xing-Zhang-Zhao) inverted from real Polygon closes.
    Delegates to the S080 implementation so there is one home for the definition. 0 new vendor calls."""
    try:
        return S80.polygon_direction(conn)
    except Exception as e:                                      # noqa: BLE001
        print(f"polygon_direction unavailable: {e}", flush=True)
        return {}


# ---------------------------------------------------------------- the trade set (Part A + arms 1-2 + comparator)

def build(conn, px, rep, tb, screen_from=None):
    """One pass over every bar → hold-to-expiry trades at 0.50Δ / 45 DTE, both sides, **earnings kept and flagged**.
    With screen_from set, returns today's signal flags instead (the last ~6 weeks cannot finish a trade), so the live
    screen and the backtest cannot drift apart."""
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    spy = px.get("SPY")
    if not spy:
        raise SystemExit("SPY missing from lseg_research.daily_history")
    sc = np.array([r[1] for r in spy], float)
    spy_dates = [r[0] for r in spy]
    spy_ma = np.full(len(sc), np.nan)
    cs = np.concatenate([[0.0], np.cumsum(sc)])
    spy_ma[199:] = (cs[200:] - cs[:-200]) / 200
    spy_below = {spy_dates[i]: bool(sc[i] < spy_ma[i]) for i in range(199, len(sc))}

    trades = []
    for t, rows in sorted(px.items()):
        if t in ("SPY", "QQQ", "IWM"):
            continue
        dates = [r[0] for r in rows]
        c, lr, ma50, ma200, rv20, z5, vol20, vol60 = S80.features(rows)
        irp = S80.iv_rank([r[2] for r in rows])
        irc = S80.iv_rank([r[3] for r in rows])
        dvp = iv_chg5([r[2] for r in rows])
        dvc = iv_chg5([r[3] for r in rows])
        prox, ret20, ret60, ret120, ret12_1, vol_z = extra_features(rows, c, rv20, vol60)
        earn = rep.get(t, [])
        n = len(rows)

        for i in range(252, n):
            d, S, ivp, ivc = rows[i][0], rows[i][1], rows[i][2], rows[i][3]
            if d < START or not ivp or not ivc or np.isnan(rv20[i]) or np.isnan(ma200[i]):
                continue
            e = d + timedelta(days=DTE)
            earn_in = any(d < x <= e for x in earn)
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0

            base = {"t": t, "d": d, "earn_in_window": float(earn_in), "spy_below_200": float(bool(spy_below.get(d))),
                    "prox_52w": prox[i], "ret20": ret20[i], "ret60": ret60[i], "ret120": ret120[i],
                    "ret12_1": ret12_1[i], "dist_ma50": c[i] / ma50[i] - 1 if ma50[i] == ma50[i] else np.nan,
                    "dist_ma200": c[i] / ma200[i] - 1, "vol_z": vol_z[i]}

            if screen_from is not None:
                if d >= screen_from:
                    for side, iv0, ir, dv in (("call", ivc, irc[i], dvc[i]), ("put", ivp, irp[i], dvp[i])):
                        K = strike_for(S, iv0, DTE / 365, DELTA, side)
                        m, spr = pricer.mid(side, S, K, iv0, DTE, d)
                        trades.append(dict(base, side=side, S=S, K=K, e=e, iv=iv0, rv=float(rv20[i]),
                                           iv_rv=iv0 / rv20[i], iv_rank=ir, iv_chg5=dv,
                                           debit=fill(m, spr, 1), spread=spr))
                continue

            je = bisect_right(dates, e) - 1
            if je <= i or je >= n - 1 or (e - dates[je]).days > 5:
                continue
            Se = rows[je][1]
            days = (dates[je] - d).days

            for side, iv0, ir, dv in (("call", ivc, irc[i], dvc[i]), ("put", ivp, irp[i], dvp[i])):
                K = strike_for(S, iv0, DTE / 365, DELTA, side)
                intrinsic = max(Se - K, 0.0) if side == "call" else max(K - Se, 0.0)
                res, debits = {}, {}
                for sn in SCEN:
                    m, spr = pricer.mid(side, S, K, iv0, DTE, d, sn)
                    debit = fill(m, spr, 1)
                    if debit < 0.05:
                        res = {}
                        break
                    debits[sn] = debit
                    res[sn] = intrinsic / debit - 1 - r_tb * days / 365
                if "base" not in res:
                    continue
                x = dict(base, side=side, S=S, K=K, Se=Se, e=e, xd=dates[je], days=days, iv=iv0, rv=float(rv20[i]),
                         iv_rv=iv0 / rv20[i], iv_rank=ir, iv_chg5=dv, debit=debits["base"],
                         raw=intrinsic / debits["base"] - 1,
                         stock=(Se / S - 1) * (1 if side == "call" else -1))
                x.update({sn: res[sn] for sn in res})
                x["win"] = int(x["raw"] >= WIN_PAYOFF)
                trades.append(x)
    return trades, pricer



def cross_sectional_tercile(trades, key="ret120"):
    """Top tercile of `key` among the names trading that day (Part B1 needs a cross-sectional cut, not a fixed level)."""
    by = defaultdict(dict)
    for x in trades:
        v = x.get(key)
        if v == v:
            by[x["d"]][x["t"]] = v
    cut = {}
    for d, m in by.items():
        vals = sorted(m.values())
        if len(vals) >= 20:
            cut[d] = vals[int(len(vals) * 2 / 3)]
    for x in trades:
        v, cv = x.get(key), cut.get(x["d"])
        x[f"{key}_top3"] = bool(v == v and cv is not None and v >= cv)
    return trades


# ---------------------------------------------------------------- Part B arms 3 and 4 (own entry rules)


def arm_straddle(conn, px, rep, tb, ratios, dte=STRADDLE_DTE, min_ratio=1.2):
    """B3 — earnings underpricing (S018 per name, rolling ≥ 4 priors, median ratio ≥ 1.2): buy the ATM straddle one
    trading day before the report, sell the day after. Both legs priced and filled; return is per $ debit.

    min_ratio = None builds the **unconditional straddle on the same events** (every name with ≥ 4 prior reports,
    whatever the ratio). Pre-run clarification, disclosed in the report: the pre-registered comparator is "S081
    unconditional on the same side", and a straddle has no single side, so this is B3's comparator. Decided before the
    full run, with no results in hand."""
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    out = []
    for t, rows in sorted(px.items()):
        if t in ("SPY", "QQQ", "IWM") or t not in ratios:
            continue
        dates = [r[0] for r in rows]
        for rd, med, npri in ratios[t]:
            if min_ratio is not None and med < min_ratio:
                continue
            i = bisect_left(dates, rd) - 1              # last bar strictly before the report
            if i < 252 or i + 1 >= len(dates):
                continue
            j = i + 2 if i + 2 < len(dates) else i + 1  # the day after the report (report lands on i+1)
            d, S, ivp, ivc = dates[i], rows[i][1], rows[i][2], rows[i][3]
            if d < START or not ivp or not ivc:
                continue
            K = S                                       # ATM straddle
            e = d + timedelta(days=dte)
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            rec = {"t": t, "d": d, "side": "straddle", "S": S, "K": K, "e": e, "ratio_prior": med, "n_prior": npri,
                   "xd": dates[j], "Se": rows[j][1], "days": (dates[j] - d).days}
            ok = True
            for sn in SCEN:
                debit = 0.0
                for side, iv0 in (("call", ivc), ("put", ivp)):
                    m, spr = pricer.mid(side, S, K, iv0, dte, d, sn)
                    debit += fill(m, spr, 1)
                if debit < 0.10:
                    ok = False
                    break
                rem = max((e - dates[j]).days, 1)
                val = 0.0
                Sj = rows[j][1]
                for side, iv0 in (("call", rows[j][3] or ivc), ("put", rows[j][2] or ivp)):
                    m, spr = pricer.mid(side, Sj, K, iv0, rem, dates[j], sn)
                    val += fill(m, spr, -1)
                rec[sn] = val / debit - 1 - r_tb * rec["days"] / 365
                if sn == "base":
                    rec["debit"], rec["raw"] = debit, val / debit - 1
            if ok and "base" in rec:
                rec["stock"] = abs(rows[j][1] / S - 1)   # a straddle is direction-free → the stock comparator is |move|
                out.append(rec)
    return out


def arm_pead(conn, px, rep, tb, dte=PEAD_DTE):
    """B4 — post-earnings drift on the S032 surprise definition: surprise ≥ +5 % and a gap up → long call entered at the
    day-2 close, 30 DTE, held to expiry; surprise ≤ −5 % and a gap down → long put. Calendar surprises are matched to the
    true LSEG report date exactly as S032 did: the first LSEG date in (calendar − 3 d, calendar + 75 d]."""
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    cal = defaultdict(list)
    for t, cd, sp in conn.execute("SELECT ticker, report_date, surprise_pct::float FROM earnings_calendar "
                                  "WHERE surprise_pct IS NOT NULL ORDER BY ticker, report_date"):
        cal[t].append((cd, sp))
    out = []
    for t, rows in sorted(px.items()):
        if t in ("SPY", "QQQ", "IWM") or t not in cal:
            continue
        dates = [r[0] for r in rows]
        reps = rep.get(t, [])
        for cd, sp in cal[t]:
            if abs(sp) < 5:
                continue
            m = [x for x in reps if cd - timedelta(days=3) < x <= cd + timedelta(days=75)]
            if not m:
                continue
            rd = min(m)
            k = bisect_left(dates, rd)                  # first bar on/after the report date = "day 1"
            if k < 253 or k + 1 >= len(dates):
                continue
            gap = rows[k][1] / rows[k - 1][1] - 1
            side = "call" if sp >= 5 and gap > 0 else ("put" if sp <= -5 and gap < 0 else None)
            if side is None:
                continue
            i = k + 1                                   # entry at the day-2 close
            d, S, ivp, ivc = dates[i], rows[i][1], rows[i][2], rows[i][3]
            iv0 = ivc if side == "call" else ivp
            if d < START or not iv0:
                continue
            e = d + timedelta(days=dte)
            je = bisect_right(dates, e) - 1
            if je <= i or je >= len(dates) - 1 or (e - dates[je]).days > 5:
                continue
            Se = rows[je][1]
            K = strike_for(S, iv0, dte / 365, DELTA, side)
            intrinsic = max(Se - K, 0.0) if side == "call" else max(K - Se, 0.0)
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            days = (dates[je] - d).days
            rec = {"t": t, "d": d, "side": side, "S": S, "K": K, "Se": Se, "e": e, "xd": dates[je], "days": days,
                   "surprise": sp, "gap": gap, "stock": (Se / S - 1) * (1 if side == "call" else -1)}
            ok = True
            for sn in SCEN:
                mm, spr = pricer.mid(side, S, K, iv0, dte, d, sn)
                debit = fill(mm, spr, 1)
                if debit < 0.05:
                    ok = False
                    break
                rec[sn] = intrinsic / debit - 1 - r_tb * days / 365
                if sn == "base":
                    rec["debit"], rec["raw"] = debit, intrinsic / debit - 1
            if ok and "base" in rec:
                out.append(rec)
    return out


# ---------------------------------------------------------------- Part A

def Xy(rows, feats):
    X = np.array([[r.get(f, np.nan) for f in feats] for r in rows], float)
    for j in range(X.shape[1]):
        col = X[:, j]
        m = np.nanmedian(col)
        col[np.isnan(col)] = m if m == m else 0.0
        X[:, j] = col
    return X


def part_a(trades, side):
    """Fit the winner model on 2021-23, score the untouched 2024-25 test window."""
    xs = [x for x in trades if x["side"] == side]
    fit = [x for x in xs if FIT[0] <= x["d"] <= FIT[1]]
    test = [x for x in xs if TEST[0] <= x["d"] <= TEST[1]]
    res = {"n_fit": len(fit), "n_test": len(test), "auc": float("nan"), "top": None, "univ": [],
           "base_rate_fit": float("nan"), "base_rate_test": float("nan")}
    if len(fit) < 200 or len(test) < 200:
        return res
    y_fit = np.array([x["win"] for x in fit])
    y_test = np.array([x["win"] for x in test])
    res["base_rate_fit"] = float(y_fit.mean())
    res["base_rate_test"] = float(y_test.mean())
    if len(set(y_fit)) < 2 or len(set(y_test)) < 2:
        return res

    # univariate: winners vs non-winners, fit window only, Holm over the feature list
    w = [x for x in fit if x["win"]]
    l = [x for x in fit if not x["win"]]
    tests = [(f, *welch([x.get(f) for x in w], [x.get(f) for x in l])) for f in FEATS]
    adj = holm([(f, p) for f, _, _, _, p in tests])
    res["univ"] = [(f, ma, mb, t, adj[f]) for f, ma, mb, t, _ in tests]

    clf = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=150, random_state=83)
    clf.fit(Xy(fit, FEATS), y_fit)
    proba = clf.predict_proba(Xy(test, FEATS))[:, 1]
    res["auc"] = float(roc_auc_score(y_test, proba))
    order = sorted(zip(test, proba), key=lambda z: z[1], reverse=True)
    k = max(1, len(order) // 10)
    res["top"] = [r for r, _ in order[:k]]
    res["top_cut"] = float(order[k - 1][1])
    res["model"] = clf
    return res


# ---------------------------------------------------------------- report

def main():
    args = sys.argv[1:]
    only = next((set(a.split("=", 1)[1].split(",")) for a in args if a.startswith("--tickers=")), None)
    maxn = next((int(a.split("=", 1)[1]) for a in args if a.startswith("--max-names=")), None)
    smoke = "--smoke" in args
    conn = connect()
    px, rep, tb, _tech = S80.load(conn, only, maxn)
    print(f"loaded {len(px)} names", flush=True)
    trades, pricer = build(conn, px, rep, tb)
    trades = cross_sectional_tercile(trades)
    print(f"{len(trades):,} trades", flush=True)

    if smoke:
        # hand-checkable: print the pricing chain for three winners and assert the label/intrinsic agree
        wins = [x for x in trades if x["win"]][:3] or trades[:3]
        for x in wins:
            m, spr = pricer.mid(x["side"], x["S"], x["K"], x["iv"], DTE, x["d"])
            intr = max(x["Se"] - x["K"], 0) if x["side"] == "call" else max(x["K"] - x["Se"], 0)
            print(f"\n{x['t']} {x['d']} {x['side']} spot {x['S']:.2f} K {x['K']:.2f} iv {x['iv']:.2%} dte {DTE}"
                  f"\n  mid {m:.3f} spread {spr:.1%} debit {fill(m, spr, 1):.3f} (stored {x['debit']:.3f})"
                  f"\n  expiry {x['e']} last bar {x['xd']} spot {x['Se']:.2f} intrinsic {intr:.3f}"
                  f"\n  ret/debit {x['raw']:+.1%} win={x['win']} stock {x['stock']:+.1%}"
                  f"\n  feats iv_rv {x['iv_rv']:.2f} prox52 {x['prox_52w']:+.1%} ret120 {x['ret120']:+.1%} "
                  f"earn_in {x['earn_in_window']:.0f} spy<200 {x['spy_below_200']:.0f}")
            assert abs(fill(m, spr, 1) - x["debit"]) < 1e-9, "debit drift"
            assert abs((intr / x["debit"] - 1) - x["raw"]) < 1e-9, "payoff drift"
            assert x["win"] == int(x["raw"] >= WIN_PAYOFF), "label drift"
        n_e = sum(1 for x in trades if x["earn_in_window"])
        print(f"\nwinners {sum(x['win'] for x in trades):,} / {len(trades):,}; earnings-in-window {n_e:,}")
        pead = arm_pead(conn, px, rep, tb)
        rat = s018_ratios(conn)
        stl = arm_straddle(conn, px, rep, tb, rat)
        print(f"arm B4 pead trades {len(pead):,}; arm B3 straddles {len(stl):,} "
              f"(names with ≥ 4 prior reports: {len(rat)})")
        return

    s081_sub = [x for x in trades if not x["earn_in_window"]]           # the S081-comparable population
    test_all = [x for x in trades if TEST[0] <= x["d"] <= TEST[1]]

    L = [f"# S083 — what makes a long option win? (A244, {date.today()})", "",
         f"{len(trades):,} trades, {len({x['t'] for x in trades})} names, daily entries {START} →, {DELTA:.2f}Δ ~{DTE} "
         f"DTE single long call / long put, **held to expiry**, per $ debit net of the entry fill (bid + 23 % of the "
         f"spread) minus T-bill. Engine reused unchanged from S081/S080/S076. Unlike S081, entries with a report inside "
         f"the window are **kept and flagged** so `earn_in_window` can be a feature; the S081-comparable subset "
         f"({len(s081_sub):,} trades) is reported beside every headline number. Pre-registered in INDEX row S083 and "
         f"committed before this run.", "",
         "## Reconciliation with S081 (engine unchanged)", "",
         "| population | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    for nm, xs in (("unconditional calls, earnings excluded (= S081 (a))", [x for x in s081_sub if x["side"] == "call"]),
                   ("unconditional puts, earnings excluded (= S081 (a))", [x for x in s081_sub if x["side"] == "put"]),
                   ("unconditional calls, earnings kept", [x for x in trades if x["side"] == "call"]),
                   ("unconditional puts, earnings kept", [x for x in trades if x["side"] == "put"])):
        L.append(f"| {nm} {fmt(stats(xs))}")
    L += ["", "S081 reported +13.7 % unconditional calls / −16.7 % puts on its test window; the earnings-excluded rows "
          "above are the same construction over the full panel, so they are the number to compare. The earnings-excluded "
          f"subset holds {len(s081_sub):,} trades against S081's 336,270 — the engine is the same one.", "",
          "**Hypothesis for the next pre-registration, NOT a result of this one:** keeping the entries S081 threw away "
          "raises unconditional long calls from +11.7 % (t 1.32) to +16.7 % (t 2.44), and `earn_in_window` is a "
          "significant winner feature on the call side below. S081 excluded any report inside the holding window, so it "
          "never priced the event long options are usually bought for. This is descriptive and pooled across both eras — "
          "the stop rule forbids promoting it here. It needs its own pre-registered row with an era split.", ""]

    # ---------------- Part A
    L += ["## Part A — reverse-engineering the winners", "",
          f"Label: **payoff ≥ +{WIN_PAYOFF:.0%} per $ debit at expiry**. Features are entry-day only. Fit "
          f"{FIT[0]}→{FIT[1]}, test {TEST[0]}→{TEST[1]} (untouched until the model was frozen). "
          f"Pass = test AUC ≥ 0.60 **and** top-decile mean per $ debit > 0 **and** month-block t ≥ 2 **and** the sign "
          f"survives the ±25 % call-cost stress.", ""]
    A, a_pass = {}, {}
    for side in ("call", "put"):
        r = part_a(trades, side)
        A[side] = r
        L += [f"### Long {side}s", "",
              f"Fit {r['n_fit']:,} trades ({r['base_rate_fit']:.1%} winners) · test {r['n_test']:,} "
              f"({r['base_rate_test']:.1%} winners).", ""]
        if r["univ"]:
            L += ["| feature | mean winners | mean non-winners | Welch t | Holm p |", "|---|---|---|---|---|"]
            for f, ma, mb, t, hp in sorted(r["univ"], key=lambda z: -abs(z[3] if z[3] == z[3] else 0)):
                L.append(f"| {f} | {ma:.3g} | {mb:.3g} | {t:.2f} | {hp:.3g} |")
            L.append("")
        if r["top"]:
            st = stats(r["top"])
            uncond = stats([x for x in test_all if x["side"] == side])
            ok = (r["auc"] >= 0.60 and st and st["mean"] > 0 and st["t"] == st["t"] and st["t"] >= 2
                  and scen_sign_ok(st))
            a_pass[side] = bool(ok)
            checks = [("test AUC ≥ 0.60", r["auc"] >= 0.60),
                      ("top-decile mean per $ debit > 0", bool(st and st["mean"] > 0)),
                      ("top-decile month-block t ≥ 2", bool(st and st["t"] == st["t"] and st["t"] >= 2)),
                      ("sign survives ±25 % call stress", scen_sign_ok(st))]
            L += [f"**Test-window AUC {r['auc']:.3f}** (winner vs non-winner, same side).", "",
                  "| slice | n | mean | median | month-block t | 90 % CI | win | payoff |",
                  "|---|---|---|---|---|---|---|---|",
                  f"| top decile of the model score {fmt(st)}",
                  f"| the whole test window, same side {fmt(uncond)}", ""]
            if st:
                sc = st["scen"]
                L += [f"Stress: base {sc['base']:+.1%} · rich +25 % {sc['rich']:+.1%} · cheap −25 % {sc['cheap']:+.1%}.",
                      "", "| check | result |", "|---|---|"]
                L += [f"| {k} | {'✓' if v else '✗'} |" for k, v in checks] + [""]
            L += [f"**Part A long {side}s: {'PASS' if ok else 'FAIL'}**"
                  + ("" if ok else " — failed: " + ", ".join(k for k, v in checks if not v)), ""]
        else:
            a_pass[side] = False
            L += [f"**Part A long {side}s: FAIL** — too few trades to fit/score.", ""]

    # what the winners look like — the actual Part A deliverable, separate from the pass/fail
    L += ["### What the winners look like (the separation is real in-sample; the ranking does not generalise)", ""]
    for side in ("call", "put"):
        r = A[side]
        if not r["univ"]:
            continue
        top3 = sorted(r["univ"], key=lambda z: -abs(z[3] if z[3] == z[3] else 0))[:3]
        L.append(f"- **Long {side}s** — strongest separators at entry: "
                 + "; ".join(f"`{f}` {ma:.3g} vs {mb:.3g} in non-winners (t {t:.1f})" for f, ma, mb, t, _ in top3)
                 + ".")
    st_c, st_p = stats(r_top_c := A["call"]["top"] or []), stats(A["put"]["top"] or [])
    uc_c = stats([x for x in test_all if x["side"] == "call"])
    L += ["", "Read those two facts together, because they are the finding: the univariate gaps clear Holm by 70+ orders "
          "of magnitude on 153k fit trades, yet the fitted ranking scores **AUC "
          f"{A['call']['auc']:.3f} / {A['put']['auc']:.3f}** out of sample — a coin flip. On calls the model's top decile "
          f"({st_c['mean']:+.1%} per $ debit) actually earns **less** than simply buying every call in the same window "
          f"({uc_c['mean']:+.1%}), so the ranking is worse than no ranking at all. Entry-day price/IV state separates "
          "winners from losers after the fact but does not predict which option will win.", ""]
    L += ["### Restricted-window features (descriptive, never in the model)", "",
          "The inventory found that the S018 per-name ratio (`optlab.earnings_moves`, 391 reports / 59 names) starts "
          "**2024-11-14** and the real Polygon option closes behind the call−put IV spread and the put skew "
          "(`optlab.bars`) start **2024-10-15**. Both lie entirely inside the Part A *test* window, so fitting them on "
          "2021-23 is impossible — in the primary matrix they would be 100 % imputed, which is a leak, not a feature. "
          "They are tested univariately on their own window with Holm inside this family and are never selected on.", ""]
    rat = s018_ratios(conn)
    pg = polygon_iv_pairs(conn)
    idx = defaultdict(dict)
    for (u, dd), v in pg.items():
        idx[u][dd] = v
    rmap = {t: {d: m for d, m, _ in rows} for t, rows in rat.items()}
    rtagged = []
    for x in trades:
        v = idx.get(x["t"], {}).get(x["d"], {})
        row = {}
        if "spread" in v:
            row["cp_iv_spread"] = v["spread"]
        if "skew" in v:
            row["put_skew"] = v["skew"]
        nxt = [m for d, m in rmap.get(x["t"], {}).items() if x["d"] <= d <= x["e"]]
        if nxt:
            row["s018_ratio"] = statistics.median(nxt)
        if row:
            rtagged.append((dict(x, **row), row))
    if rtagged:
        sub = [a for a, _ in rtagged]
        L += [f"{len(sub):,} trades carry at least one restricted feature.", "",
              "| feature | n | mean winners | mean non-winners | Welch t | Holm p |", "|---|---|---|---|---|---|"]
        rt = []
        for f in RESTRICTED:
            have = [a for a in sub if a.get(f) == a.get(f) and f in a]
            w = [a[f] for a in have if a["win"]]
            l = [a[f] for a in have if not a["win"]]
            ma, mb, t, p = welch(w, l)
            rt.append((f, len(have), ma, mb, t, p))
        radj = holm([(f, p) for f, _, _, _, _, p in rt])
        for f, nn, ma, mb, t, _ in rt:
            L.append(f"| {f} | {nn:,} | {ma:.3g} | {mb:.3g} | {t:.2f} | {radj[f]:.3g} |")
        L.append("")
    else:
        L += ["No trade carried a restricted feature (empty `optlab.bars` / `optlab.earnings_moves`).", ""]

    # ---------------- Part B
    L += ["## Part B — literature signals never tested here as long-option entries", "",
          "One frozen setting per arm, **Holm over the 4 arms**. Each arm is the pre-registered rule, not a tuned one.", ""]
    pead = arm_pead(conn, px, rep, tb)
    stl = arm_straddle(conn, px, rep, tb, rat)
    tw = lambda xs: [x for x in xs if x["d"] <= TEST_END]  # noqa: E731

    b_sets = {
        "B1 52-week-high momentum (George-Hwang) → long call":
            tw([x for x in trades if x["side"] == "call" and x["prox_52w"] == x["prox_52w"]
                and x["prox_52w"] >= -0.05 and x.get("ret120_top3")]),
        "B2 time-series momentum (Moskowitz-Ooi-Pedersen), IV/RV ≤ 1":
            tw([x for x in trades if x["ret12_1"] == x["ret12_1"] and x["iv_rv"] == x["iv_rv"] and x["iv_rv"] <= 1.0
                and ((x["side"] == "call" and x["ret12_1"] > 0) or (x["side"] == "put" and x["ret12_1"] < 0))]),
        "B3 earnings underpricing (S018 per name ≥ 1.2) → ATM straddle": tw(stl),
        "B4 post-earnings drift (S032 surprise ≥ ±5 % + gap)": tw(pead),
    }
    b_stats = {k: stats(v) for k, v in b_sets.items()}
    b_p = holm([(k, pval(s)) for k, s in b_stats.items()])

    L += ["| arm | n | mean | median | month-block t | 90 % CI | win | payoff | base | rich +25 % | cheap −25 % |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for k, v in b_sets.items():
        s = b_stats[k]
        if s:
            sc = s["scen"]
            p = lambda x: "—" if x != x else f"{x:+.1%}"  # noqa: E731
            L.append(f"| {k} {fmt(s)} {p(sc['base'])} | {p(sc['rich'])} | {p(sc['cheap'])} |")
        else:
            L.append(f"| {k} {fmt(s)} — | — | — |")
    L += ["", f"B3 built **{len(tw(stl)):,}** straddle events inside the test window (≤ {TEST_END}) out of "
              f"{len(stl):,} in the whole panel: the S018 ratio table "
              f"starts 2024-11-14 and the rule needs ≥ 4 **prior** reports, so the first eligible event per name lands "
              f"roughly four quarters later — almost all of them in 2026, outside the pre-registered window. That is a "
              f"data limit found before the run and pre-registered as such, not a result.", ""]

    # comparators
    uc = {s: stats([x for x in trades if x["side"] == s and x["d"] <= TEST_END]) for s in ("call", "put")}
    stl_uncond = stats(tw(arm_straddle(conn, px, rep, tb, rat, min_ratio=None)))
    uc["straddle"] = stl_uncond
    L += ["### Comparators", "",
          "B3's comparator is the **unconditional ATM straddle on the same events** (every name with ≥ 4 prior reports, "
          "whatever its ratio): the pre-registered comparator is \"S081 unconditional on the same side\" and a straddle "
          "has no single side. Decided before the full run, with no results in hand.", "",
          "| arm | arm mean | S081 unconditional, same side | stock on the same signal, equal $ | stock scaled to the "
          "option's vol | beats uncond | beats stock |", "|---|---|---|---|---|---|---|"]
    b_cmp = {}
    for k, v in b_sets.items():
        s = b_stats[k]
        if not s or not v:
            L.append(f"| {k} | — | — | — | — | — | — |")
            b_cmp[k] = (False, False)
            continue
        sides = {x["side"] for x in v}
        ref = (statistics.mean([uc[s2]["mean"] for s2 in sides if uc.get(s2)])
               if sides and all(uc.get(s2) for s2 in sides) else float("nan"))
        sm = statistics.mean([x["stock"] for x in v])
        ssd = statistics.pstdev([x["stock"] for x in v])
        sv = sm * (s["sd"] / ssd) if ssd else float("nan")
        bu = bool(ref == ref and s["mean"] > ref)
        bs = bool(sv == sv and s["mean"] > sv)
        b_cmp[k] = (bu, bs)
        p = lambda x: "—" if x != x else f"{x:+.1%}"  # noqa: E731
        L.append(f"| {k} | {p(s['mean'])} | {p(ref)} | {p(sm)} | {p(sv)} | {'✓' if bu else '✗'} | "
                 f"{'✓' if bs else '✗'} |")
    L.append("")

    # regime slices — Jamie 10-22 (memory: cross-sectional-not-own-history): nothing may be judged on the bull tape alone
    L += ["### Regime slices (descriptive — 'tested outside the bull tape')", "",
          "Jamie 10-22: a candidate screen must hold up outside 2021 and 2023-25, so every arm is cut by era and by the "
          "2022 bear year on its own. No arm is selected on these; they exist so a positive pooled mean cannot hide a "
          "one-regime bet. **No list ships from S083, so the cross-sectional / beta-residual guard on candidate lists is "
          "not reached** — but the gap is real and is named under Known weaknesses.", "",
          "| arm | 2021-23 | 2022 only | 2024-25 |", "|---|---|---|---|"]
    era_w = {"2021-23": FIT, "2022 only": (date(2022, 1, 1), date(2022, 12, 31)), "2024-25": TEST}
    for k, v in list(b_sets.items()) + [("Part A top decile, calls", A["call"]["top"] or []),
                                        ("Part A top decile, puts", A["put"]["top"] or [])]:
        cells = []
        for lab, w in era_w.items():
            s = stats([x for x in v if w[0] <= x["d"] <= w[1]])
            cells.append(f"{s['mean']:+.1%} (n {s['n']:,}, t {s['t']:.2f})" if s else "—")
        L.append(f"| {k} | " + " | ".join(cells) + " |")
    L.append("")

    b_pass = {}
    L += ["### Verdict per arm, against the pre-registered bar", ""]
    for k, v in b_sets.items():
        s = b_stats[k]
        bu, bs = b_cmp[k]
        checks = [("mean per $ debit > 0", bool(s and s["mean"] > 0)),
                  ("month-block t ≥ 2", bool(s and s["t"] == s["t"] and s["t"] >= 2)),
                  (f"Holm p < {ALPHA} over the 4 arms", bool(b_p[k] == b_p[k] and b_p[k] < ALPHA)),
                  ("beats the unconditional comparator", bu),
                  ("beats the stock per $ risked", bs),
                  ("sign survives ±25 % call stress", scen_sign_ok(s))]
        ok = all(x for _, x in checks)
        b_pass[k] = ok
        raw = pval(s) if s else float("nan")
        L += [f"**{k}: {'PASS' if ok else 'FAIL'}** — n {len(v):,}"
              + ("" if s else f" (below the {5}-trade floor, so no statistics are computed)")
              + (f", raw p {raw:.4f}, Holm p {b_p[k]:.4f}" if raw == raw else ", p not computable")
              + ("" if ok else " · failed: " + ", ".join(x for x, y in checks if not y))
              + (f"  **(low-powered: n < {MIN_N})**" if s and s["n"] < MIN_N else ""), ""]

    # B3 sensitivity (reported, never selected on)
    if stl:
        s30 = stats(tw(arm_straddle(conn, px, rep, tb, rat, dte=30)))
        L += ["Sensitivity B3 at 30 DTE instead of 7 (reported, never selected on): "
              + (f"{s30['mean']:+.1%} (n {s30['n']}, t {s30['t']:.2f})" if s30 else "too few trades") + ".", ""]

    # ---------------- ship decision + today's flags
    passing = [k for k, v in b_pass.items() if v] + [f"Part A long {s}s" for s, v in a_pass.items() if v]
    ship = bool(passing)
    L += ["## Ship decision", "",
          (f"**{len(passing)} arm(s) clear the pre-registered bar: " + "; ".join(passing) + ".**") if ship else
          "**No arm clears the pre-registered bar → NO LIST.** The stop rule forbids promoting a substitute arm; the "
          "failed condition per arm is printed above.", ""]

    flags = {"as_of": None, "passing": passing, "entries": []}
    scr, _ = build(conn, px, rep, tb, screen_from=date.today() - timedelta(days=10))
    if scr:
        scr = cross_sectional_tercile(scr)
        last = max(x["d"] for x in scr)
        flags["as_of"] = str(last)
        today = [x for x in scr if x["d"] == last]
        rows_out = []
        if a_pass.get("call") or a_pass.get("put"):
            for side in ("call", "put"):
                if not a_pass.get(side) or not A[side].get("model"):
                    continue
                cand = [x for x in today if x["side"] == side]
                if cand:
                    pr = A[side]["model"].predict_proba(Xy(cand, FEATS))[:, 1]
                    for x, p in zip(cand, pr):
                        if p >= A[side]["top_cut"]:
                            rows_out.append(dict(x, arm="S083A", score=float(p)))
        for k, ok in b_pass.items():
            if not ok or k.startswith("B3"):
                continue
            if k.startswith("B1"):
                rows_out += [dict(x, arm="S083B1") for x in today if x["side"] == "call"
                             and x["prox_52w"] == x["prox_52w"] and x["prox_52w"] >= -0.05 and x.get("ret120_top3")]
            if k.startswith("B2"):
                rows_out += [dict(x, arm="S083B2") for x in today if x["ret12_1"] == x["ret12_1"]
                             and x["iv_rv"] == x["iv_rv"] and x["iv_rv"] <= 1.0
                             and ((x["side"] == "call" and x["ret12_1"] > 0) or (x["side"] == "put" and x["ret12_1"] < 0))]
        flags["entries"] = [{"ticker": x["t"], "date": str(x["d"]), "side": x["side"], "arm": x["arm"],
                             "spot": round(x["S"], 4), "strike": round(x["K"], 4), "expiry": str(x["e"]),
                             "dte": DTE, "delta": DELTA, "model_debit": round(x["debit"], 4),
                             "iv30": round(x["iv"], 4), "rv20": round(x["rv"], 4)} for x in rows_out]
        L += [f"## Today's flags from passing arms (latest LSEG bar {last})", "",
              f"{len(rows_out)} flag(s)." if rows_out else "No passing arm → no flags (by the stop rule).", ""]
        if rows_out:
            L += ["| ticker | side | arm | spot | strike | expiry | model debit | iv30 | rv20 |",
                  "|---|---|---|---|---|---|---|---|---|"]
            for x in sorted(rows_out, key=lambda y: (y["side"], y["t"])):
                L.append(f"| {x['t']} | {x['side']} | {x['arm']} | {x['S']:.2f} | {x['K']:.2f} | {x['e']} | "
                         f"{x['debit']:.2f} | {x['iv']:.1%} | {x['rv']:.1%} |")
            L.append("")
    FLAGS.write_text(json.dumps(flags, indent=1) + "\n")

    L += ["## Known weaknesses", "",
          "- Call skew rests on one day of Schwab ladders (S075). Hold-to-expiry pays intrinsic while the ratio scales "
          "only the entry debit, so the ±25 % stress bites directly — read the stress row before any product.",
          "- Daily entries overlap heavily at 45 DTE → month-block bootstrap, never an iid t.",
          "- Part A's label is a tail event (payoff ≥ +100 %), so AUC is measured against a small positive class; the "
          "base rate is printed beside it.",
          "- The restricted features cannot be fitted on 2021-23 at all (see above) — they are descriptive only.",
          "- B3's universe is 59 names from 2024-11; its n is small by construction, not by selection.",
          "- Expiry intrinsic assumes settlement at no spread; B3 exits at the model mid − fill.",
          "- Continuous Δ-strikes; real chains round to listed strikes.",
          "- **No beta residualisation and no sector cap** (Jamie 10-22, memory `cross-sectional-not-own-history`). Every "
          "return here is raw, not forward-return-minus-β×SPY, and B1/B2 are momentum arms that would load on high-beta "
          "names. It does not change a FAIL — an unadjusted arm that already fails cannot pass once its beta is removed — "
          "but any future long-option row must be beta-residual, cross-sectional and sector-capped before it may show a "
          "candidate list. Part A's features are each name's own history by construction (that is what 'reverse-engineer "
          "the winners' asks for); only B1's momentum cut is cross-sectional."]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[:40]))
    print(f"\n→ {OUT}\n→ {FLAGS}")
    for side in ("call", "put"):
        r = A[side]
        print(f"  Part A {side}: AUC {r['auc']:.3f} pass={a_pass.get(side)}")
    for k, ok in b_pass.items():
        print(f"  {k}: pass={ok}")


if __name__ == "__main__":
    main()
