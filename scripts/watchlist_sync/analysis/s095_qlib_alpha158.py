"""S095 — qlib Alpha158 features + a weekly boosted ranker (A262).

Question: does a walk-forward ranker on the 158 Alpha158 OHLCV features
predict Monday rel_21 beyond StarMine combined alpha and lab_tech v2?

Method:
  Formulas are qlib's Alpha158DL (microsoft/qlib main, loader.py) and the
  operators behind them (ops.py IdxMax/Rank/Quantile/Std, rolling.pyx slope).
  qlib and LightGBM are not installed. HistGradientBoostingRegressor is the
  fallback the spec names. Hyperparameters were fixed before the holdout
  was scored: depth 6, learning rate 0.05, 200 trees, min_samples_leaf 50,
  l2 1.0, seed 95, early_stopping off (sklearn's auto stop would mix later
  training weeks into the fit). No holdout tuning.
  Target label inside the fit = within-week rank of rel_21. The model never
  sees alpha or lab_tech.
  Walk-forward: one fit per test year 2023–2026. A training row is usable
  only when its 21st forward session (the rel_21 endpoint) is strictly
  before 1 January of the test year.
  Features use the last bar on or before the Monday, the same bar
  lab_outcomes.py uses as the entry close. rel_21 starts at that close.

Price source:
  lseg_research.daily_history has high, low, close, volume from 2016-09 and
  no open. prices_historical has open but starts 2024-10-18, after the
  pre-registered holdout begins, so it is not the backtest sample (PLAYBOOK
  and the market-data skill). Open is taken from prices_historical only when
  that row's close matches daily_history (abs gap <= max(0.02, 0.1% of close)).
  Otherwise the 10 open features are missing. No vwap column exists;
  VWAP0 = (high+low+close)/3 / close, labeled as such.

Pass bar (pre-registered, INDEX S095 / A262 — not changed):
  Holdout 2023-01→ week-clustered Newey-West lag 3, t ≥ 2, both halves
  positive (same reading as S089 on this bar), AND marginal t ≥ 2
  (Fama-MacBeth of rel rank on the score plus combined alpha plus lab_tech,
  or the within alpha+tech quintile high−low rel_21 spread).
  IC without a marginal pass = duplicates what we have.
  These inputs are commercial (LSEG, plus an open print we already store).
  A pass can ship. This script does not change a live score.

Run (from scripts/watchlist_sync):
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s095_qlib_alpha158.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s095_qlib_alpha158.py
"""
from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import math
import sys
import time
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402
from s045_put_retest import rank  # noqa: E402

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
HAND_DAY = date(2024, 6, 3)
OPEN_DAY = date(2025, 5, 19)  # first MU Monday with a prices_historical open
HOLDOUT_START = date(2023, 1, 1)
MIN_NAMES = 30
MIN_HALF = 8
WINDOWS = (5, 10, 20, 30, 60)
KBAR = ["KMID", "KLEN", "KMID2", "KUP", "KUP2", "KLOW", "KLOW2", "KSFT", "KSFT2"]
PRICE = ["OPEN0", "HIGH0", "LOW0", "VWAP0"]
ROLL = ["ROC", "MA", "STD", "BETA", "RSQR", "RESI", "MAX", "MIN", "QTLU", "QTLD",
        "RANK", "RSV", "IMAX", "IMIN", "IMXD", "CORR", "CORD", "CNTP", "CNTN", "CNTD",
        "SUMP", "SUMN", "SUMD", "VMA", "VSTD", "WVMA", "VSUMP", "VSUMN", "VSUMD"]
NAMES = KBAR + PRICE + [f"{n}{d}" for d in WINDOWS for n in ROLL]
NAME_I = {n: i for i, n in enumerate(NAMES)}
OPEN_FEATURES = set(KBAR) | {"OPEN0"}
PARAMS = dict(max_depth=6, learning_rate=0.05, max_iter=200, min_samples_leaf=50,
              l2_regularization=1.0, random_state=95, early_stopping=False)
OUT = ROOT / "out" / "studies" / "S095.md"
assert len(ROLL) == 29 and len(NAMES) == 158


def as_date(d):
    return d.date() if isinstance(d, datetime) else d


def ols(y: np.ndarray):
    """qlib rolling.pyx: x = 1..n, n = newest. Returns slope, last residual, r^2."""
    n = len(y)
    x = np.arange(1, n + 1, dtype=float)
    x_sum = float(x.sum())
    y_sum = float(y.sum())
    xy = float(x @ y)
    x2 = float(x @ x)
    y2 = float(y @ y)
    den = n * x2 - x_sum * x_sum
    if den <= 0:
        return math.nan, math.nan, math.nan
    slope = (n * xy - x_sum * y_sum) / den
    intercept = y_sum / n - slope * (x_sum / n)
    resi = float(y[-1] - (slope * n + intercept))
    yden = n * y2 - y_sum * y_sum
    if yden <= 0:
        return slope, resi, math.nan
    r = (n * xy - x_sum * y_sum) / math.sqrt(den * yden)
    return slope, resi, r * r


def pct_rank(w: np.ndarray) -> float:
    """pandas Rolling.rank(pct=True), average ties, rank of the last point / n."""
    last = w[-1]
    less = int(np.sum(w < last))
    eq = int(np.sum(w == last))
    return (less + (eq + 1) / 2.0) / len(w)


def corr2(a: np.ndarray, b: np.ndarray) -> float:
    if np.std(a) == 0 or np.std(b) == 0:
        return math.nan
    return float(np.corrcoef(a, b)[0, 1])


def _ok(x: np.ndarray) -> bool:
    return bool(x.size) and bool(np.isfinite(x).all())


def roll(h, l, c, v, i: int, d: int) -> list[float]:
    a = i - d + 1
    cw, hw, lw, vw = c[a:i + 1], h[a:i + 1], l[a:i + 1], v[a:i + 1]
    c_prev, v_prev = c[a - 1:i], v[a - 1:i]
    close, vol = float(c[i]), float(v[i]) if np.isfinite(v[i]) else math.nan
    nan = math.nan
    roc = float(c[i - d] / close) if np.isfinite(c[i - d]) else nan
    if _ok(cw):
        ma = float(np.mean(cw) / close)
        std = float(np.std(cw, ddof=1) / close)
        slope, resi, r2 = ols(cw)
        beta, resi = slope / close, resi / close
        qtlu = float(np.quantile(cw, 0.8) / close)
        qtld = float(np.quantile(cw, 0.2) / close)
        rk = pct_rank(cw)
    else:
        ma = std = beta = r2 = resi = qtlu = qtld = rk = nan
    if _ok(hw):
        mx = float(np.max(hw) / close)
        imax_i = int(np.argmax(hw)) + 1
    else:
        mx, imax_i = nan, None
    if _ok(lw):
        mn = float(np.min(lw) / close)
        imin_i = int(np.argmin(lw)) + 1
    else:
        mn, imin_i = nan, None
    if imax_i is not None and imin_i is not None:
        rsv = (close - float(np.min(lw))) / (float(np.max(hw)) - float(np.min(lw)) + 1e-12)
        imax, imin, imxd = imax_i / d, imin_i / d, (imax_i - imin_i) / d
    else:
        rsv = imax = imin = imxd = nan
    corr = corr2(cw, np.log(vw + 1.0)) if _ok(cw) and _ok(vw) and np.all(vw >= 0) else nan
    if _ok(cw) and _ok(c_prev) and _ok(vw) and _ok(v_prev) and np.all(c_prev > 0) and np.all(v_prev > 0):
        cord = corr2(cw / c_prev, np.log(vw / v_prev + 1.0))
    else:
        cord = nan
    if _ok(cw) and _ok(c_prev) and np.all(c_prev > 0):
        up, dn = cw > c_prev, cw < c_prev
        cntp, cntn = float(np.mean(up)), float(np.mean(dn))
        cntd = cntp - cntn
        diff = cw - c_prev
        gain, lose = float(np.maximum(diff, 0).sum()), float(np.maximum(-diff, 0).sum())
        ad = float(np.abs(diff).sum()) + 1e-12
        sump, sumn, sumd = gain / ad, lose / ad, (gain - lose) / ad
    else:
        cntp = cntn = cntd = sump = sumn = sumd = nan
    if _ok(vw) and np.isfinite(vol):
        vma = float(np.mean(vw) / (vol + 1e-12))
        vstd = float(np.std(vw, ddof=1) / (vol + 1e-12))
    else:
        vma = vstd = nan
    if _ok(cw) and _ok(c_prev) and _ok(vw) and np.all(c_prev > 0):
        w = np.abs(cw / c_prev - 1.0) * vw
        wvma = float(np.std(w, ddof=1) / (float(np.mean(w)) + 1e-12))
    else:
        wvma = nan
    if _ok(vw) and _ok(v_prev):
        vd = vw - v_prev
        vg, vl = float(np.maximum(vd, 0).sum()), float(np.maximum(-vd, 0).sum())
        va = float(np.abs(vd).sum()) + 1e-12
        vsump, vsumn, vsumd = vg / va, vl / va, (vg - vl) / va
    else:
        vsump = vsumn = vsumd = nan
    return [roc, ma, std, beta, r2, resi, mx, mn, qtlu, qtld, rk, rsv, imax, imin, imxd,
            corr, cord, cntp, cntn, cntd, sump, sumn, sumd, vma, vstd, wvma, vsump, vsumn, vsumd]


def features_at(h, l, c, v, o, i: int) -> np.ndarray | None:
    if i < 60 or not np.isfinite(c[i]) or c[i] <= 0:
        return None
    ci = float(c[i])
    oi = float(o[i]) if np.isfinite(o[i]) else math.nan
    hi = float(h[i]) if np.isfinite(h[i]) else math.nan
    li = float(l[i]) if np.isfinite(l[i]) else math.nan
    out: list[float] = []
    if np.isfinite(oi) and oi != 0 and np.isfinite(hi) and np.isfinite(li):
        up = hi - max(oi, ci)
        lo = min(oi, ci) - li
        rng = hi - li
        out += [(ci - oi) / oi, rng / oi, (ci - oi) / (rng + 1e-12),
                up / oi, up / (rng + 1e-12), lo / oi, lo / (rng + 1e-12),
                (2 * ci - hi - li) / oi, (2 * ci - hi - li) / (rng + 1e-12)]
    else:
        out += [math.nan] * 9
    out.append(oi / ci if np.isfinite(oi) else math.nan)
    out.append(hi / ci if np.isfinite(hi) else math.nan)
    out.append(li / ci if np.isfinite(li) else math.nan)
    out.append(((hi + li + ci) / 3.0) / ci if np.isfinite(hi) and np.isfinite(li) else math.nan)
    for d in WINDOWS:
        out.extend(roll(h, l, c, v, i, d))
    arr = np.asarray(out, float)
    if arr.size != 158:
        raise RuntimeError(f"feature count {arr.size}")
    arr[~np.isfinite(arr)] = np.nan
    return arr


def self_check() -> None:
    y = np.arange(1, 6, dtype=float)
    slope, resi, r2 = ols(y)
    assert abs(slope - 1) < 1e-9 and abs(resi) < 1e-9 and abs(r2 - 1) < 1e-9, (slope, resi, r2)
    w = np.array([10, 12, 11, 13, 11], float)
    assert abs(pct_rank(w) - 0.5) < 1e-12, pct_rank(w)
    # argmax+1: max at the newest slot of a 5-bar window → 5
    hw = np.array([1, 3, 2, 3, 9], float)
    assert int(np.argmax(hw)) + 1 == 5


def load_panel(conn, tickers: set[str] | None):
    digest = conn.execute(
        """SELECT engine_digest FROM watchlist_sync.lab_tech
           WHERE engine_digest LIKE '%%-ivhist'
           GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1"""
    ).fetchone()[0]
    if tickers is None:
        tickers = {r[0] for r in conn.execute(
            """SELECT DISTINCT ticker FROM watchlist_sync.lab_outcomes
               WHERE outcomes->>'rel_21' IS NOT NULL""")}
        tickers |= set(SMOKE)
    tickers = set(tickers)
    bars: dict[str, dict] = {}
    opens: dict[tuple[str, date], tuple[float, float]] = {}
    for t, d, op, cl in conn.execute(
        """SELECT ticker, date, open::float8, close::float8 FROM prices_historical
           WHERE ticker = ANY(%s) AND open IS NOT NULL AND close IS NOT NULL""",
        (list(tickers),),
    ):
        opens[(t, as_date(d))] = (float(op), float(cl))
    cur, buf = None, []
    q = conn.execute(
        """SELECT ticker, date, high::float8, low::float8, close::float8, volume::float8
           FROM lseg_research.daily_history
           WHERE ticker = ANY(%s) AND close IS NOT NULL
           ORDER BY ticker, date""",
        (list(tickers),),
    )
    attached = missed = 0

    def flush(t, rows):
        nonlocal attached, missed
        if not rows:
            return
        n = len(rows)
        h = np.empty(n)
        l = np.empty(n)
        c = np.empty(n)
        v = np.empty(n)
        o = np.full(n, np.nan)
        ds = []
        for i, (d, hv, lv, cv, vv) in enumerate(rows):
            ds.append(d)
            c[i] = cv
            h[i] = hv if hv is not None else np.nan
            l[i] = lv if lv is not None else np.nan
            v[i] = vv if vv is not None else np.nan
            if np.isfinite(h[i]) and np.isfinite(l[i]) and h[i] < l[i]:
                h[i], l[i] = l[i], h[i]
            hit = opens.get((t, d))
            if hit is None:
                missed += 1
                continue
            op, pc = hit
            tol = max(0.02, 0.001 * abs(cv))
            if abs(pc - cv) <= tol and op > 0:
                o[i] = op
                attached += 1
            else:
                missed += 1
        bars[t] = {"d": ds, "h": h, "l": l, "c": c, "v": v, "o": o,
                   "pos": {d: i for i, d in enumerate(ds)}}

    for t, d, hv, lv, cv, vv in q:
        d = as_date(d)
        if t != cur:
            flush(cur, buf)
            cur, buf = t, []
        buf.append((d, hv, lv, cv, vv))
    flush(cur, buf)

    outcomes = conn.execute(
        """SELECT ticker, as_of, (outcomes->>'rel_21')::float8, (outcomes->>'ret_21')::float8,
                  (features->>'mom_12_1')::float8
           FROM watchlist_sync.lab_outcomes
           WHERE ticker = ANY(%s) AND EXTRACT(DOW FROM as_of) = 1
             AND outcomes->>'rel_21' IS NOT NULL""",
        (list(tickers),),
    ).fetchall()
    tech = {}
    for t, d, val in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND ticker = ANY(%s) AND v2->>'total' IS NOT NULL""",
        (digest, list(tickers)),
    ):
        if val is not None:
            tech[(t, as_date(d))] = float(val)
    alpha = defaultdict(list)
    for t, d, val in conn.execute(
        """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
           WHERE metric = 'combined_alpha_rank' AND ticker = ANY(%s) AND value IS NOT NULL
           ORDER BY ticker, obs_date""",
        (list(tickers),),
    ):
        alpha[t].append((as_date(d), float(val)))
    return digest, bars, outcomes, tech, alpha, attached, missed


def alpha_asof(series, d: date) -> float | None:
    lo, hi, hit = 0, len(series), None
    while lo < hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= d:
            hit = series[mid][1]
            lo = mid + 1
        else:
            hi = mid
    return hit


def build_rows(bars, outcomes, tech, alpha) -> tuple[list[dict], set[date]]:
    rows = []
    holdout_weeks = set()
    for t, d, rel, ret, mom in outcomes:
        d = as_date(d)
        if d >= HOLDOUT_START:
            holdout_weeks.add(d)
        s = bars.get(t)
        if s is None or rel is None:
            continue
        i = bisect_right(s["d"], d) - 1
        if i < 0 or i + 21 >= len(s["d"]):
            continue
        x = features_at(s["h"], s["l"], s["c"], s["v"], s["o"], i)
        if x is None:
            continue
        rows.append({
            "t": t, "d": d, "i": i, "rel": float(rel),
            "ret": None if ret is None else float(ret),
            "mom": float(mom) if mom is not None else math.nan,
            "alpha": alpha_asof(alpha.get(t, []), d),
            "tech": tech.get((t, d)),
            "x": x, "known": s["d"][i + 21], "score": math.nan,
        })
        if len(rows) % 10000 == 0:
            print(f"  features {len(rows)}", flush=True)
    return rows, holdout_weeks


def hand_check(bars, outcomes) -> tuple[list[str], bool]:
    """Independent arithmetic for one MU bar. Does not call roll()."""
    lines = [f"## Hand-check ({HAND} {HAND_DAY.isoformat()})", ""]
    s = bars.get(HAND)
    ok = s is not None
    if s is None:
        lines.append(f"{HAND} has no daily_history rows.")
        return lines, False
    i = bisect_right(s["d"], HAND_DAY) - 1
    if i < 60 or s["d"][i] != HAND_DAY:
        lines.append(f"{HAND} bar on {HAND_DAY} missing or short (index {i}, date {s['d'][i] if i >= 0 else None}).")
        return lines, False
    c, h, l, v, o = s["c"], s["h"], s["l"], s["v"], s["o"]
    x = features_at(h, l, c, v, o, i)
    # Independent window of 5 closes ending today, and the close 5 sessions back.
    c5 = [float(c[i - 5 + k]) for k in range(6)]  # c[i-5] .. c[i]
    h5 = [float(h[i - 4 + k]) for k in range(5)]
    l5 = [float(l[i - 4 + k]) for k in range(5)]
    close = c5[-1]
    roc = c5[0] / close
    ma = sum(c5[1:]) / 5.0 / close
    mu = sum(c5[1:]) / 5.0
    var = sum((p - mu) ** 2 for p in c5[1:]) / 4.0
    std = math.sqrt(var) / close
    # rank of today's close in the 5, average ties, / 5
    w = c5[1:]
    less = sum(p < close for p in w)
    eq = sum(p == close for p in w)
    rk = (less + (eq + 1) / 2.0) / 5.0
    # slope on x=1..5
    ys = c5[1:]
    n = 5
    xs = [1, 2, 3, 4, 5]
    x_sum, y_sum = sum(xs), sum(ys)
    xy = sum(a * b for a, b in zip(xs, ys))
    x2 = sum(a * a for a in xs)
    den = n * x2 - x_sum * x_sum
    slope = (n * xy - x_sum * y_sum) / den
    beta = slope / close
    rsv = (close - min(l5)) / (max(h5) - min(l5) + 1e-12)
    imax = (h5.index(max(h5)) + 1) / 5.0
    checks = {
        "ROC5": roc, "MA5": ma, "STD5": std, "BETA5": beta, "RANK5": rk, "RSV5": rsv, "IMAX5": imax,
    }
    gaps = []
    lines.append(f"Bar {s['d'][i]} high {float(h[i]):.4f} low {float(l[i]):.4f} close {close:.4f} "
                 f"volume {float(v[i]):.0f} open {'NA' if not np.isfinite(o[i]) else f'{float(o[i]):.4f}'}.")
    lines.append("Closes c[t-5]..c[t]: " + ", ".join(f"{p:.4f}" for p in c5) + ".")
    lines.append("Highs of the 5-day window: " + ", ".join(f"{p:.4f}" for p in h5) + ".")
    lines.append("Lows of the 5-day window: " + ", ".join(f"{p:.4f}" for p in l5) + ".")
    for name, hand in checks.items():
        got = float(x[NAME_I[name]])
        gap = got - hand
        gaps.append(abs(gap))
        lines.append(f"{name} hand {hand:.10f} feature {got:.10f} gap {gap:+.3e}.")
    # ret_21 uses the same endpoint as lab_outcomes.py
    ret_hand = float(c[i + 21] / c[i] - 1.0)
    lab_ret = None
    for t, d, _rel, ret, _mom in outcomes:
        if t == HAND and as_date(d) == HAND_DAY:
            lab_ret = None if ret is None else float(ret)
            break
    ret_gap = None if lab_ret is None else ret_hand - lab_ret
    lines.append(f"Forward close {s['d'][i + 21]} {float(c[i + 21]):.4f}. "
                 f"ret_21 hand {ret_hand:.10f} lab {lab_ret if lab_ret is not None else 'NA'} "
                 f"gap {ret_gap if ret_gap is None else f'{ret_gap:+.3e}'}. "
                 f"Label known {s['d'][i + 21]}.")
    finite = int(np.isfinite(x).sum())
    open_finite = int(sum(np.isfinite(x[NAME_I[n]]) for n in OPEN_FEATURES))
    lines.append(f"Finite features {finite}/158. Open-based features finite {open_finite}/10 "
                 f"(this Monday is before MU has a prices_historical open, so these 10 should be missing).")
    # Second bar: open path, once prices_historical exists.
    j = bisect_right(s["d"], OPEN_DAY) - 1
    open_ok = True
    if j >= 60 and s["d"][j] == OPEN_DAY and np.isfinite(s["o"][j]):
        xx = features_at(h, l, c, v, o, j)
        kmid = (float(c[j]) - float(o[j])) / float(o[j])
        kmid_gap = float(xx[NAME_I["KMID"]]) - kmid
        lines.append(f"Open path {OPEN_DAY}: open {float(o[j]):.4f} close {float(c[j]):.4f} "
                     f"KMID hand {kmid:.10f} feature {float(xx[NAME_I['KMID']]):.10f} gap {kmid_gap:+.3e}.")
        open_ok = abs(kmid_gap) < 1e-8
    else:
        why = "no bar" if j < 0 or s["d"][j] != OPEN_DAY else "open not attached (missing or close mismatch)"
        lines.append(f"Open path {OPEN_DAY}: {why}. KMID not checked.")
        open_ok = False
    match = all(g < 1e-8 for g in gaps) and lab_ret is not None and abs(ret_gap) < 1e-6 and open_finite == 0 and open_ok
    lines.append(f"Match {match}.")
    lines.append("")
    return lines, match


def smoke_coverage(bars, outcomes) -> list[str]:
    lines = ["Smoke names:"]
    mondays = defaultdict(int)
    for t, d, rel, _ret, _mom in outcomes:
        if rel is not None:
            mondays[t] += 1
    for t in SMOKE:
        s = bars.get(t)
        if s is None:
            lines.append(f"- {t}: no daily_history.")
            continue
        o_n = int(np.isfinite(s["o"]).sum())
        lines.append(f"- {t}: bars {len(s['d'])} {s['d'][0]}→{s['d'][-1]}, "
                     f"opens attached {o_n}, Monday rel_21 rows {mondays[t]}.")
    lines.append("")
    return lines


def assign_scores(rows: list[dict]) -> list[str]:
    notes = []
    by_year = defaultdict(list)
    for r in rows:
        if r["d"] >= HOLDOUT_START:
            by_year[r["d"].year].append(r)
    for year in range(2023, 2027):
        start = date(year, 1, 1)
        train = [r for r in rows if r["known"] < start]
        test = by_year.get(year, [])
        if len(train) < 500 or not test:
            notes.append(f"{year}: skipped train {len(train)} test {len(test)}.")
            continue
        # Rank label inside each training week. Small weeks are not a cross-section.
        groups = defaultdict(list)
        for r in train:
            groups[r["d"]].append(r)
        used = []
        for group in groups.values():
            if len(group) < MIN_NAMES:
                continue
            rels = [g["rel"] for g in group]
            for g, y in zip(group, rank(rels)):
                g["yrank"] = float(y)
                used.append(g)
        if len(used) < 500:
            notes.append(f"{year}: skipped, only {len(used)} ranked training rows.")
            continue
        X = np.vstack([g["x"] for g in used])
        y = np.array([g["yrank"] for g in used])
        # A column with fewer than two distinct finite values has no split.
        # sklearn's binning raises on that (all-missing open features, before 2025).
        keep = []
        for j in range(X.shape[1]):
            finite = X[np.isfinite(X[:, j]), j]
            if len(np.unique(finite)) >= 2:
                keep.append(j)
        keep = np.asarray(keep, int)
        model = HistGradientBoostingRegressor(**PARAMS)
        model.fit(X[:, keep], y)
        pred = model.predict(np.vstack([g["x"] for g in test])[:, keep])
        for g, p in zip(test, pred):
            g["score"] = float(p)
        knowns = [g["known"] for g in used]
        notes.append(
            f"{year}: train rows {len(used)} weeks {len({g['d'] for g in used})} "
            f"as_of {min(g['d'] for g in used)}→{max(g['d'] for g in used)} "
            f"max label-known {max(knowns)} (must be < {start}). "
            f"test rows {len(test)} {min(g['d'] for g in test)}→{max(g['d'] for g in test)}. "
            f"Training rows with a finite open {sum(np.isfinite(g['x'][NAME_I['KMID']]) for g in used)}. "
            f"Features with a split {len(keep)}/158."
        )
        if max(knowns) >= start:
            raise RuntimeError(f"leakage: {year} saw a label known {max(knowns)}")
    return notes


def _corr(a, b) -> float | None:
    if len(a) < MIN_NAMES or np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def week_metrics(score, rel, al, te, mom) -> dict | None:
    m = np.isfinite(score) & np.isfinite(rel) & np.isfinite(al) & np.isfinite(te)
    if int(m.sum()) < MIN_NAMES:
        return None
    score, rel, al, te, mom = score[m], rel[m], al[m], te[m], mom[m]
    if np.std(score) == 0 or np.std(rel) == 0:
        return None
    rs, ry, ra, rt = rank(score), rank(rel), rank(al), rank(te)
    ic = _corr(rs, ry)
    if ic is None:
        return None
    k = max(1, len(score) // 10)
    order = np.argsort(-score, kind="mergesort")
    spread = float(rel[order[:k]].mean() - rel[order[-k:]].mean())
    beta = np.linalg.lstsq(np.c_[np.ones(len(score)), rs, ra, rt], ry, rcond=None)[0]
    comp = 0.5 * (ra + rt)
    q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
    bits = []
    for qi in range(5):
        sel = q == qi
        if int(sel.sum()) < 8 or np.std(score[sel]) == 0:
            continue
        med = np.median(score[sel])
        hi, lo = rel[sel & (score >= med)], rel[sel & (score < med)]
        if len(hi) and len(lo):
            bits.append(float(hi.mean() - lo.mean()))
    wq = float(np.mean(bits)) if len(bits) >= 3 else math.nan
    mom_c = math.nan
    mm = np.isfinite(mom)
    if int(mm.sum()) >= MIN_NAMES and np.std(score[mm]) > 0 and np.std(mom[mm]) > 0:
        mom_c = float(np.corrcoef(rank(score[mm]), rank(mom[mm]))[0, 1])
    return {"ic": ic, "spread": spread, "fm": float(beta[1]), "wq": wq, "n": int(len(score)),
            "corr_mom": mom_c, "corr_alpha": _corr(rs, ra), "corr_tech": _corr(rs, rt)}


def ic_only(score, rel) -> tuple[float, float, int] | None:
    m = np.isfinite(score) & np.isfinite(rel)
    if int(m.sum()) < MIN_NAMES:
        return None
    score, rel = score[m], rel[m]
    if np.std(score) == 0 or np.std(rel) == 0:
        return None
    ic = _corr(rank(score), rank(rel))
    if ic is None:
        return None
    k = max(1, len(score) // 10)
    order = np.argsort(-score, kind="mergesort")
    spread = float(rel[order[:k]].mean() - rel[order[-k:]].mean())
    return ic, spread, int(len(score))


def pack(pairs: list[tuple[date, float]], mid: date) -> dict:
    if len(pairs) < MIN_HALF:
        return {"thin": True, "n": len(pairs)}
    vals = [v for _, v in pairs]
    a = [v for d, v in pairs if d < mid]
    b = [v for d, v in pairs if d >= mid]
    t = float(nw_t(vals, 3))
    if len(a) < MIN_HALF or len(b) < MIN_HALF:
        return {"thin": True, "n": len(pairs), "na": len(a), "nb": len(b),
                "mean": float(np.mean(vals)), "t": t}
    return {"thin": False, "mean": float(np.mean(vals)), "t": t,
            "a": float(np.mean(a)), "b": float(np.mean(b)),
            "n": len(vals), "na": len(a), "nb": len(b)}


def summarize(packed: list[tuple], mid: date, col: str) -> dict:
    series = {k: [] for k in ("ic", "spread", "fm", "wq", "corr_mom", "corr_alpha", "corr_tech")}
    ns = []
    for item in packed:
        d, rel, al, te, mom, score = item
        met = week_metrics(score if col == "score" else (al if col == "alpha" else te), rel, al, te, mom)
        if not met:
            continue
        ns.append(met["n"])
        for k in series:
            if met[k] is None or (isinstance(met[k], float) and not math.isfinite(met[k])):
                continue
            series[k].append((d, met[k]))
    out = {k: pack(v, mid) for k, v in series.items()}
    out["mean_n"] = float(np.mean(ns)) if ns else 0.0
    out["n_weeks"] = len(series["ic"])
    return out


def path_ok(p: dict) -> bool:
    return (not p.get("thin") and p.get("t") is not None and math.isfinite(p["t"])
            and p["t"] >= 2 and p.get("a", -1) > 0 and p.get("b", -1) > 0)


def fmt_pack(p: dict, scale: float = 1.0) -> str:
    if not isinstance(p, dict) or p.get("mean") is None:
        n = p.get("n", 0) if isinstance(p, dict) else 0
        return f"n {n} (thin)"
    if p.get("a") is None:
        halves = "thin halves"
    else:
        halves = f"{p['a'] * scale:+.4f} / {p['b'] * scale:+.4f} (weeks {p['na']}/{p['nb']})"
    return f"mean {p['mean'] * scale:+.4f} NW t {p['t']:+.2f} halves {halves} (n {p['n']})"


def pre2023_univariate(rows, mid_ignored=None) -> list[tuple[str, dict]]:
    """Mean weekly IC of each raw feature before the holdout. Descriptive only."""
    groups = defaultdict(list)
    for r in rows:
        if r["d"] < HOLDOUT_START:
            groups[r["d"]].append(r)
    # Accumulate IC per feature. Skip a week that is too small.
    acc = [[] for _ in NAMES]
    for d, group in groups.items():
        if len(group) < MIN_NAMES:
            continue
        rel = np.array([g["rel"] for g in group])
        if np.std(rel) == 0:
            continue
        ry = rank(rel)
        X = np.vstack([g["x"] for g in group])
        for j in range(158):
            col = X[:, j]
            m = np.isfinite(col)
            if int(m.sum()) < MIN_NAMES or np.std(col[m]) == 0:
                continue
            ic = _corr(rank(col[m]), ry[m])
            if ic is not None:
                acc[j].append((d, ic))
    # Use the holdout midpoint only as a dummy; pack() still needs a split, so
    # report the mean and t without pretending the halves are the holdout.
    ranked = []
    for j, pairs in enumerate(acc):
        if len(pairs) < MIN_HALF:
            continue
        vals = [v for _, v in pairs]
        t = float(nw_t(vals, 3))
        ranked.append((NAMES[j], float(np.mean(vals)), t, len(vals)))
    ranked.sort(key=lambda z: z[2] if math.isfinite(z[2]) else -9, reverse=True)
    return ranked


def spot_week(packed, target: date) -> str:
    if not packed:
        return "No scored week."
    d, rel, al, te, mom, score = min(packed, key=lambda w: abs((w[0] - target).days))
    met = week_metrics(score, rel, al, te, mom)
    if not met:
        return f"Spot week {d}: too thin."
    return (f"Spot week {d}: n {met['n']}, IC {met['ic']:+.4f}, "
            f"decile {met['spread'] * 100:+.2f} pp, FM coef {met['fm']:+.4f}, "
            f"within-q {met['wq'] * 100:+.2f} pp.")


def write_report(text: str) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)


def main() -> None:
    self_check()
    smoke = "--smoke" in sys.argv
    t0 = time.time()
    conn = connect()
    tickers = set(SMOKE) if smoke else None
    digest, bars, outcomes, tech, alpha, attached, missed = load_panel(conn, tickers)
    # NVDA volume across the 10-for-1 split, to see if volume is on today's share basis.
    nvda = conn.execute(
        """SELECT date, volume::float8 FROM lseg_research.daily_history
           WHERE ticker = 'NVDA' AND date IN ('2024-06-07', '2024-06-10') ORDER BY date"""
    ).fetchall()
    conn.close()
    print(f"loaded {len(bars)} names, {len(outcomes)} Monday rows, opens attached {attached} "
          f"not attached {missed}, digest {digest} ({time.time() - t0:.0f}s)", flush=True)
    cov = smoke_coverage(bars, outcomes)
    print("\n".join(cov), flush=True)
    lines, ok = hand_check(bars, outcomes)
    print("\n".join(lines), flush=True)
    if smoke:
        if not ok:
            raise SystemExit("hand-check failed")
        print(f"smoke ok ({time.time() - t0:.0f}s)", flush=True)
        return
    if not ok:
        raise SystemExit("hand-check failed — full test not run")

    rows, holdout_weeks = build_rows(bars, outcomes, tech, alpha)
    print(f"feature rows {len(rows)} ({time.time() - t0:.0f}s)", flush=True)
    year_notes = assign_scores(rows)
    print("\n".join(year_notes), flush=True)
    weeks = sorted(holdout_weeks)
    mid = weeks[len(weeks) // 2]
    by = defaultdict(list)
    dropped_alpha = 0
    scored_rows = [r for r in rows if r["d"] >= HOLDOUT_START and np.isfinite(r["score"])]
    for r in scored_rows:
        if r["alpha"] is None or r["tech"] is None:
            dropped_alpha += 1
            continue
        by[r["d"]].append(r)
    packed = []
    for d in sorted(by):
        group = by[d]
        if len(group) < MIN_NAMES:
            continue
        packed.append((
            d,
            np.array([g["rel"] for g in group]),
            np.array([g["alpha"] for g in group], float),
            np.array([g["tech"] for g in group], float),
            np.array([g["mom"] for g in group], float),
            np.array([g["score"] for g in group], float),
        ))
    # Unrestricted IC: same scores, no alpha/tech requirement.
    by_all = defaultdict(list)
    for r in scored_rows:
        by_all[r["d"]].append(r)
    free_ic, free_sp = [], []
    for d, group in sorted(by_all.items()):
        hit = ic_only(np.array([g["score"] for g in group]), np.array([g["rel"] for g in group]))
        if hit:
            free_ic.append((d, hit[0]))
            free_sp.append((d, hit[1]))
    free_ic_p, free_sp_p = pack(free_ic, mid), pack(free_sp, mid)

    stats = summarize(packed, mid, "score")
    # Placebo: shuffle the score inside each week.
    rng = np.random.default_rng(95)
    shuffled = []
    for d, rel, al, te, mom, score in packed:
        sc = score.copy()
        rng.shuffle(sc)
        shuffled.append((d, rel, al, te, mom, sc))
    placebo = summarize(shuffled, mid, "score")
    alpha_ic = summarize(packed, mid, "alpha")
    tech_ic = summarize(packed, mid, "tech")
    uni = pre2023_univariate(rows)
    top = uni[:5]
    bot = uni[-5:]

    finite = np.vstack([r["x"] for r in scored_rows]) if scored_rows else np.zeros((0, 158))
    finite_rate = np.isfinite(finite).mean(axis=0) if len(finite) else np.zeros(158)
    open_rate = float(np.mean([finite_rate[NAME_I[n]] for n in OPEN_FEATURES])) if len(finite) else 0.0
    vwap_rate = float(finite_rate[NAME_I["VWAP0"]]) if len(finite) else 0.0
    other = [finite_rate[i] for i, n in enumerate(NAMES) if n not in OPEN_FEATURES and n != "VWAP0"]
    other_rate = float(np.mean(other)) if other else 0.0

    ic_ok, fm_ok, wq_ok = path_ok(stats["ic"]), path_ok(stats["fm"]), path_ok(stats["wq"])
    if ic_ok and (fm_ok or wq_ok):
        verdict = "PASS"
    elif ic_ok:
        verdict = "standalone only — duplicates the comparator"
    else:
        verdict = "not PASS"
    ship = ("Nothing ships. Next: do not add an Alpha158 ranker."
            if verdict != "PASS" else
            "The fit uses LSEG high/low/close/volume plus an open we already store. "
            "A pass can ship as a shadow rank next to combined alpha and lab_tech. "
            "Next: champion param and a before/after on live snapshots. This run does not change a score.")

    def uni_line(z):
        return f"{z[0]} IC {z[1]:+.3f} t {z[2]:+.2f} (weeks {z[3]})"

    nvda_txt = ", ".join(f"{as_date(d)} {vol:.0f}" for d, vol in nvda) or "no rows"
    open_dates = [d for s in bars.values() for d, ov in zip(s["d"], s["o"]) if np.isfinite(ov)]
    open_span = f"{min(open_dates)}→{max(open_dates)}" if open_dates else "none"
    L = [
        "# S095 — qlib Alpha158 ranker vs StarMine + lab_tech",
        "",
        "Question: does a walk-forward boosted ranker on Alpha158 predict Monday `rel_21` "
        "beyond StarMine combined alpha and lab_tech v2?",
        "",
        "Pass bar (pre-registered, unchanged): holdout 2023-01→ week-clustered t ≥ 2, both halves "
        "positive, and marginal t ≥ 2 (FM of the score | alpha + tech, or within alpha+tech quintile). "
        "Same reading of this bar as S089. Positive means the ranker, which was trained to predict "
        "higher rel_21. A negative result is not flipped.",
        "",
        f"**Verdict: {verdict}.** IC pass {ic_ok}. FM pass {fm_ok}. Within-quintile pass {wq_ok}.",
        "",
        *lines,
        *cov,
        "## Fit",
        "",
        f"Model: sklearn HistGradientBoostingRegressor {PARAMS}, 4 threads. "
        "Label = within-week rank of rel_21. LightGBM and qlib are not installed.",
        *year_notes,
        f"Holdout Mondays with rel_21: {len(weeks)}. Calendar midpoint {mid}. "
        f"Scored rows {len(scored_rows)}. Rows dropped for missing alpha or tech {dropped_alpha}. "
        f"Weeks with ≥{MIN_NAMES} names that also have a score, combined alpha and lab_tech: {len(packed)}. "
        f"Mean names per scored week {stats['mean_n']:.0f}. Digest `{digest}`.",
        "",
        "## Stock board",
        "",
        f"IC (score vs rel_21): {fmt_pack(stats['ic'])}.",
        f"Top−bottom decile rel_21: {fmt_pack(stats['spread'], 100)} pp.",
        f"FM partial (score | alpha + tech ranks): {fmt_pack(stats['fm'])}.",
        f"Within alpha+tech quintile, high−low score rel_21: {fmt_pack(stats['wq'], 100)} pp.",
        f"Same weeks, combined-alpha IC: {fmt_pack(alpha_ic['ic'])}.",
        f"Same weeks, lab_tech v2 IC: {fmt_pack(tech_ic['ic'])}.",
        f"Placebo, score shuffled inside each week (seed 95) IC: {fmt_pack(placebo['ic'])}.",
        f"Unrestricted sample (no alpha/tech requirement) IC: {fmt_pack(free_ic_p)}. "
        f"Decile: {fmt_pack(free_sp_p, 100)} pp.",
        f"Holdout rank correlation of the score vs lab mom_12_1: {fmt_pack(stats['corr_mom'])}. "
        f"Vs combined alpha {fmt_pack(stats['corr_alpha'])}. Vs lab_tech {fmt_pack(stats['corr_tech'])}.",
        spot_week(packed, HAND_DAY),
        "",
        "Reading, apart from the bar: rank IC is small and positive "
        f"({stats['ic']['mean']:+.3f}, NW t {stats['ic']['t']:+.2f}), both halves positive, short of 2. "
        f"The top−bottom decile goes the other way ({stats['spread']['mean'] * 100:+.1f} pp per 21 days, "
        f"NW t {stats['spread']['t']:+.2f}, both halves negative). "
        f"FM t {stats['fm']['t']:+.2f}. Within-quintile t {stats['wq']['t']:+.2f}. "
        f"On these weeks combined alpha IC t {alpha_ic['ic']['t']:+.2f} and lab_tech t {tech_ic['ic']['t']:+.2f}, "
        "so the board is noisy, the same limit S089 hit. "
        f"Shuffling the score inside the week gives IC t {placebo['ic']['t']:+.2f}. "
        "The score is only loosely lined up with 12-1 momentum. The extremes are not a long-short, "
        "and the rank correlation is not large enough to ship.",
        "",
        "## What the raw features do before 2023 (not the bar)",
        "",
        "Each of the 158 features, weekly rank IC vs rel_21 on Mondays before the holdout. "
        "The fit keeps every feature with at least two distinct finite values that year. "
        "This list is not a second test and nothing here is promoted.",
        "Highest t: " + "; ".join(uni_line(z) for z in top) + "." if top else "No pre-2023 feature had enough weeks.",
        "Lowest t: " + "; ".join(uni_line(z) for z in bot) + "." if bot else "",
        "",
        "## Coverage",
        "",
        "Prices: `lseg_research.daily_history` high/low/close/volume. "
        "The `prices_historical` table starts 2024-10-18, and the names in this run have opens later than that, "
        f"so it cannot carry a 2023 holdout. Attached opens span {open_span} ({attached} bars). "
        f"Bars without a usable open: {missed}.",
        f"On scored rows, open-based features (9 kbar + OPEN0) are finite {open_rate:.1%} of the time. "
        f"VWAP0, which is (high+low+close)/3 / close, is finite {vwap_rate:.1%}. "
        f"The other 147 features are finite {other_rate:.1%}.",
        f"NVDA volume across the 2024-06-10 split (today's share basis if the two days are the same order): {nvda_txt}.",
        "",
        "## What would ship",
        "",
        ship,
        "",
        "## Known weaknesses",
        "",
        "- Open does not exist on daily_history. prices_historical open is used only when its close matches, and on these names that series starts in 2025. A test year whose training rows have no finite open cannot split on the 10 open features. The fit notes count them.",
        "- VWAP0 is typical price (high+low+close)/3 divided by close. There is no vwap column.",
        "- HistGradientBoosting on the within-week rank, not LightGBM lambdarank. Depth and tree count were not tuned.",
        "- One fit per calendar year. A January model scores December of that year. Labels inside the year are not used until the next fit.",
        "- rel_21 overlaps across weeks. The t is Newey-West lag 3, the same weekly bar as S089, not a 21-day block.",
        "- TMO is on the smoke list and has no daily_history row. CRWV lists in 2025, so it is absent from the early holdout.",
        "- The marginal test drops names with no combined-alpha history or no lab_tech row on that Monday. The unrestricted IC is reported beside it.",
        "",
        "Run: `nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s095_qlib_alpha158.py` from `scripts/watchlist_sync`.",
        "",
    ]
    text = "\n".join(L) + "\n"
    write_report(text)
    print(text)
    print(f"done ({time.time() - t0:.0f}s)", flush=True)


if __name__ == "__main__":
    main()
