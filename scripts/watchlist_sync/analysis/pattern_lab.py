"""Pattern lab — do technical / options context features raise the odds that a name is near a swing low or high? (Jamie 10-29)

Question (Jamie's claim, not a return forecast): "find the lows and highs of a period using momentum, support/resistance,
liquidity zones, volume, options skew". Each feature is graded on that claim — how much it lifts the chance that today is
near the period's low (or high) — as a probability table with its base rate, not a pass/fail on returns.

Data: lseg_research.daily_history (565 names, 2016-09 →, OHLCV + 30-d put/call IV), SPY context from the same table.
Labels (use the future, features never do):
  near_low  = "good low": from today's close the next 10 days never trade > 0.5 ATR lower AND rally ≥ 1 ATR higher
  near_high = "good high": mirror (never > 0.5 ATR higher AND fall ≥ 1 ATR) — future only, anchored on the close
  dd10 / up10 = further drop / rise over the next 10 days, in ATR (how far it still goes once the signal fires)
Features (all ≤ t): momentum (RSI, stochastic, MACD hist, ROC, RSI divergence), support/resistance (prior pivot levels,
touches, 20-d / 52-w range, MA distance), liquidity zones (60-d volume profile: distance to the heaviest volume node below /
above, inside a high-volume node), volume (z-score, climax bars, close location), volatility (ATR pct, Bollinger %b),
options (put−call IV skew, skew z / change, IV ÷ RV, IV rank), market (SPY RSI, SPY vs MA50).
Method:
  1. Lift tables per feature (fit years 2016–2024 split in two halves): P(label | quintile) ÷ base rate, month-clustered SE.
     Tier: strong ≥ 1.5× / useful ≥ 1.25× / weak ≥ 1.1× in the extreme quintile, same direction both halves; else none.
  2. Confluence: count of "low-side" conditions firing → lift and forward path.
  3. Model: HistGradientBoosting on all features, fit 2016–2022, check 2023–24, refit ≤ 2024, holdout 2025 → once.
     AUC, top-decile lift, calibration, permutation importance; forward path of the top decile vs base and vs RSI < 30 alone.
Run: cd scripts/watchlist_sync && .venv/bin/python analysis/pattern_lab.py [--tickers A,B] [--rebuild]
     .venv/bin/python analysis/pattern_lab.py --s151 [--tickers A,B] [--rebuild] [--smoke-only]
Out: out/opt/pattern-lab-packet.md + out/opt/pattern_lab_*.csv; --s151 → out/opt/S151.md
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from build_plan import connect, rows  # noqa: E402

OUT = HERE / "out" / "opt"
CACHE = Path.home() / ".fildi" / "cache" / "pattern_lab_panel.pkl"
W = 10            # swing window each side (21-day period)
TOL = 0.25        # within 0.25 ATR of the period extreme
FIT_END, VAL_END = pd.Timestamp("2022-12-31"), pd.Timestamp("2024-12-31")
HALF = pd.Timestamp("2020-12-31")
# S151 (A328): forward-only turning points at 4 horizons; phase-2 fit window 2016–2021 only
S151_K_ATR = 1.0
S151_TOL = 0.25
S151_HORIZONS = {"intra": 1, "week": 5, "month": 21, "quarter": 63}
S151_FIT_END = pd.Timestamp("2021-12-31")
S151_P3_FIT_END = FIT_END
S151_P3_VAL_END = VAL_END
S151_P3_HALF = pd.Timestamp("2023-12-31")
S151_P3_HOLD_START = pd.Timestamp("2025-01-01")
S151_CLOSE_TOL = 0.5
S151_GEOMETRY_FEATS = {"close_loc", "prior_day_low", "prior_day_high", "bb_pctb", "stoch14", "pos20"}
S151_SMOKE_TICKERS = "AAPL,MSFT,NVDA,AMZN,GOOGL,META,JPM,XOM,UNH,WMT".split(",")
S151_CACHE = Path.home() / ".fildi" / "cache" / "pattern_lab_s151_panel.pkl"
S151_HORIZON_LABEL = {"intra": "next_day", "week": "week", "month": "month", "quarter": "quarter"}


def load(tickers: list[str] | None) -> pd.DataFrame:
    q = """SELECT ticker, date, open o, high h, low l, close c, volume v, iv30_put, iv30_call
           FROM lseg_research.daily_history WHERE close > 0 AND high >= low"""
    with connect() as c:
        df = pd.DataFrame(rows(c, q + (" AND ticker = ANY(%s)" if tickers else "") + " ORDER BY ticker, date",
                               (tickers + ["SPY"],) if tickers else None))
    df["date"] = pd.to_datetime(df["date"])
    for k in ("o", "h", "l", "c", "v", "iv30_put", "iv30_call"):
        df[k] = pd.to_numeric(df[k], errors="coerce")
    return df


def rsi(c: pd.Series, n: int = 14) -> pd.Series:
    from quantcore.ta import rsi_frame  # one home (Jamie 11-15): TradingView ta.rsi
    return rsi_frame(c, n)


def vol_profile(g: pd.DataFrame, look: int = 60, bins: int = 24) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per day: distance (ATR) to the heaviest-volume price bin below / above the close over the last `look` days, and
    whether the close sits inside a top-3 volume bin (a liquidity zone). Typical price × volume, past days only."""
    tp = ((g.h + g.l + g.c) / 3).to_numpy(); v = g.v.fillna(0).to_numpy(); c = g.c.to_numpy(); atr = g.atr.to_numpy()
    n = len(g); below = np.full(n, np.nan); above = np.full(n, np.nan); inside = np.full(n, np.nan)
    for i in range(look, n):
        p, w = tp[i - look:i], v[i - look:i]
        lo, hi = p.min(), p.max()
        if hi <= lo or w.sum() <= 0 or not atr[i] > 0:
            continue
        hist, edges = np.histogram(p, bins=bins, range=(lo, hi), weights=w)
        mid = (edges[:-1] + edges[1:]) / 2
        top = np.argsort(hist)[-3:]
        b = mid < c[i]; a = mid > c[i]
        if b.any():
            below[i] = (c[i] - mid[b][np.argmax(hist[b])]) / atr[i]
        if a.any():
            above[i] = (mid[a][np.argmax(hist[a])] - c[i]) / atr[i]
        k = min(max(np.searchsorted(edges, c[i]) - 1, 0), bins - 1)
        inside[i] = float(k in top)
    return below, above, inside


def pivots(g: pd.DataFrame, k: int = 5, look: int = 120) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Support / resistance from confirmed pivots (a low lower than k bars each side, known k bars later): distance in ATR
    to the nearest pivot low below the close and pivot high above it within `look` days, and touches of that level."""
    l, h, c, atr = (g[x].to_numpy() for x in ("l", "h", "c", "atr"))
    n = len(g)
    pl = np.array([i for i in range(k, n - k) if l[i] == l[i - k:i + k + 1].min()])
    ph = np.array([i for i in range(k, n - k) if h[i] == h[i - k:i + k + 1].max()])
    sup = np.full(n, np.nan); res = np.full(n, np.nan); st = np.full(n, np.nan); rt = np.full(n, np.nan)
    for i in range(n):
        if not atr[i] > 0:
            continue
        for arr, src, out, touch, side in ((pl, l, sup, st, -1), (ph, h, res, rt, 1)):
            if not len(arr):
                continue
            j = arr[(arr + k <= i) & (arr >= i - look)]
            if not len(j):
                continue
            lv = src[j]
            cand = lv[lv <= c[i]] if side < 0 else lv[lv >= c[i]]
            if not len(cand):
                continue
            lvl = cand.max() if side < 0 else cand.min()
            out[i] = abs(c[i] - lvl) / atr[i]
            touch[i] = float((np.abs(lv - lvl) <= 0.5 * atr[i]).sum())
    return sup, res, st, rt


def features(g: pd.DataFrame) -> pd.DataFrame:
    g = g.sort_values("date").reset_index(drop=True).copy()
    pc = g.c.shift()
    from quantcore.ta import atr as _atr  # one home (Jamie 11-15)
    g["atr"] = _atr(g.h.to_numpy(float), g.l.to_numpy(float), g.c.to_numpy(float), 14)
    a = g.atr
    # labels (future only — a backward window would match "near a 20-d low" features by construction)
    fl = g.l.shift(-1)[::-1].rolling(W, min_periods=W).min()[::-1]   # lowest low t+1 … t+W
    fh = g.h.shift(-1)[::-1].rolling(W, min_periods=W).max()[::-1]
    ok = fl.notna() & fh.notna()
    # good low: from today's close, the next 10 days never trade > 0.5 ATR lower AND rally ≥ 1 ATR higher (mirror = good
    # high). Anchored on the close, not today's low/high: a low-anchored label made "closed near the high" win by construction.
    g["near_low"] = ((fl >= g.c - 2 * TOL * a) & (fh >= g.c + a)).astype(float).where(ok)
    g["near_high"] = ((fh <= g.c + 2 * TOL * a) & (fl <= g.c - a)).astype(float).where(ok)
    g["dd10"] = (g.c - fl) / a
    g["up10"] = (fh - g.c) / a
    g["ret10"] = g.c.shift(-W) / g.c - 1
    # momentum
    g["rsi14"] = rsi(g.c)
    g["rsi_chg5"] = g.rsi14 - g.rsi14.shift(5)
    ll, hh = g.l.rolling(14).min(), g.h.rolling(14).max()
    g["stoch14"] = (g.c - ll) / (hh - ll).replace(0, np.nan)
    macd = g.c.ewm(span=12, adjust=False).mean() - g.c.ewm(span=26, adjust=False).mean()
    hist = macd - macd.ewm(span=9, adjust=False).mean()
    g["macd_hist_atr"] = hist / a
    g["macd_hist_slope3"] = (hist - hist.shift(3)) / a
    g["roc5_atr"] = (g.c - g.c.shift(5)) / a
    g["roc20_atr"] = (g.c - g.c.shift(20)) / a
    # divergence: lower 10-d low than the prior 10-d low but higher RSI at the low (bullish); mirror for highs
    l10, l10p = g.l.rolling(10).min(), g.l.shift(10).rolling(10).min()
    r10, r10p = g.rsi14.rolling(10).min(), g.rsi14.shift(10).rolling(10).min()
    g["bull_div"] = ((l10 < l10p) & (r10 > r10p) & (g.l <= l10 + 0.25 * a)).astype(float)
    h10, h10p = g.h.rolling(10).max(), g.h.shift(10).rolling(10).max()
    q10, q10p = g.rsi14.rolling(10).max(), g.rsi14.shift(10).rolling(10).max()
    g["bear_div"] = ((h10 > h10p) & (q10 < q10p) & (g.h >= h10 - 0.25 * a)).astype(float)
    # range / trend position
    g["pos20"] = (g.c - g.l.rolling(20).min()) / (g.h.rolling(20).max() - g.l.rolling(20).min()).replace(0, np.nan)
    g["dist_52w_low"] = (g.c - g.l.rolling(252, min_periods=120).min()) / a
    g["dist_52w_high"] = (g.h.rolling(252, min_periods=120).max() - g.c) / a
    for n in (20, 50, 200):
        g[f"dist_ma{n}"] = (g.c - g.c.rolling(n, min_periods=int(n * 0.8)).mean()) / a
    # volume
    lv = np.log(g.v.replace(0, np.nan))
    g["vol_z20"] = (lv - lv.rolling(20).mean()) / lv.rolling(20).std()
    g["close_loc"] = (g.c - g.l) / (g.h - g.l).replace(0, np.nan)
    g["down_climax"] = ((g.vol_z20 > 2) & (g.c < pc)).astype(float)
    g["up_climax"] = ((g.vol_z20 > 2) & (g.c > pc)).astype(float)
    g["gap_atr"] = (g.o - pc) / a
    # volatility
    g["atr_pct252"] = (a / g.c).rolling(252, min_periods=120).rank(pct=True)
    m20, s20 = g.c.rolling(20).mean(), g.c.rolling(20).std()
    g["bb_pctb"] = (g.c - (m20 - 2 * s20)) / (4 * s20).replace(0, np.nan)
    # options
    iv = (g.iv30_put + g.iv30_call) / 2
    sk = g.iv30_put - g.iv30_call
    g["skew"] = sk
    g["skew_z60"] = (sk - sk.rolling(60, min_periods=40).mean()) / sk.rolling(60, min_periods=40).std()
    g["skew_chg5"] = sk - sk.shift(5)
    rv20 = np.log(g.c / pc).rolling(20).std() * np.sqrt(252) * 100
    g["iv_rv"] = iv / rv20.replace(0, np.nan)
    g["iv_rank252"] = iv.rolling(252, min_periods=120).rank(pct=True)
    g["iv_chg5"] = iv - iv.shift(5)
    # support / resistance + liquidity zones
    sup, res, st, rt = pivots(g)
    g["sup_dist"], g["res_dist"], g["sup_touches"], g["res_touches"] = sup, res, st, rt
    below, above, inside = vol_profile(g)
    g["hvn_below_dist"], g["hvn_above_dist"], g["in_hvn"] = below, above, inside
    g["rsi2"] = rsi(g.c, 2)
    g["z5_close"] = (g.c - g.c.rolling(5).mean()) / g.c.rolling(5).std().replace(0, np.nan)
    g["ret_15"] = g.c / g.c.shift(15) - 1
    g["ret_20"] = g.c / g.c.shift(20) - 1
    g["ret_30"] = g.c / g.c.shift(30) - 1
    g["dd_20"] = (g.c - g.h.rolling(20).max()) / g.c
    g["prior_day_low"] = (g.c - g.l.shift(1)) / a
    g["prior_day_high"] = (g.h.shift(1) - g.c) / a
    return g


def s151_horizon_labels(g: pd.DataFrame) -> pd.DataFrame:
    """Forward-only good low/high per horizon (A328 phase 1). Anchored on today's low/high + close rally/fall."""
    a = g.atr
    iv = (g.iv30_put.fillna(0) + g.iv30_call.fillna(0)) / 2 / 100.0
    for name, h in S151_HORIZONS.items():
        fl = g.l.shift(-1)[::-1].rolling(h, min_periods=h).min()[::-1]
        fh = g.h.shift(-1)[::-1].rolling(h, min_periods=h).max()[::-1]
        fc = g.c.shift(-h)
        ok = fl.notna() & fh.notna() & fc.notna() & (a > 0)
        g[f"good_low_{name}"] = ((fl >= g.l - S151_TOL * a) & (fh >= g.c + S151_K_ATR * a)).astype(float).where(ok)
        g[f"good_high_{name}"] = ((fh <= g.h + S151_TOL * a) & (fl <= g.c - S151_K_ATR * a)).astype(float).where(ok)
        g[f"good_low_close_{name}"] = ((fl >= g.c - S151_CLOSE_TOL * a) & (fh >= g.c + S151_K_ATR * a)).astype(float).where(ok)
        g[f"good_high_close_{name}"] = ((fh <= g.c + S151_CLOSE_TOL * a) & (fl <= g.c - S151_K_ATR * a)).astype(float).where(ok)
        g[f"mae_low_{name}"] = ((g.c - fl) / a).where(ok)
        g[f"mfe_low_{name}"] = ((fh - g.c) / a).where(ok)
        g[f"ret_h_{name}"] = (fc / g.c - 1).where(ok)
        sig = iv * np.sqrt(h / 252.0)
        floor = g.c * (1 - sig)
        min_close = g.c.shift(-1)[::-1].rolling(h, min_periods=h).min()[::-1]
        g[f"sell_put_ok_{name}"] = (min_close >= floor).astype(float).where(ok)
        be_call = g.c * (1 + 0.5 * sig)
        g[f"long_call_ok_{name}"] = (fc >= be_call).astype(float).where(ok)
    return g


def s151_features(g: pd.DataFrame) -> pd.DataFrame:
    g = features(g)
    return s151_horizon_labels(g)


FEATS = ["rsi14", "rsi_chg5", "stoch14", "macd_hist_atr", "macd_hist_slope3", "roc5_atr", "roc20_atr", "bull_div", "bear_div",
         "pos20", "dist_52w_low", "dist_52w_high", "dist_ma20", "dist_ma50", "dist_ma200", "vol_z20", "close_loc", "down_climax",
         "up_climax", "gap_atr", "atr_pct252", "bb_pctb", "skew", "skew_z60", "skew_chg5", "iv_rv", "iv_rank252", "iv_chg5",
         "sup_dist", "res_dist", "sup_touches", "res_touches", "hvn_below_dist", "hvn_above_dist", "in_hvn",
         "spy_rsi14", "spy_dist_ma50"]
BINARY = {"bull_div", "bear_div", "down_climax", "up_climax", "in_hvn"}
FEATS_S151 = FEATS + ["rsi2", "z5_close", "ret_15", "ret_20", "ret_30", "dd_20", "prior_day_low", "prior_day_high"]


def panel(tickers: list[str] | None, rebuild: bool) -> pd.DataFrame:
    if CACHE.exists() and not rebuild and not tickers:
        return pd.read_pickle(CACHE)
    raw = load(tickers)
    parts = []
    names = sorted(raw.ticker.unique())
    for i, (t, g) in enumerate(raw.groupby("ticker")):
        if len(g) < 300:
            continue
        parts.append(features(g))
        if i % 50 == 0:
            print(f"  features {i + 1}/{len(names)} {t}", flush=True)
    p = pd.concat(parts, ignore_index=True)
    spy = p[p.ticker == "SPY"][["date", "rsi14", "dist_ma50"]].rename(columns={"rsi14": "spy_rsi14", "dist_ma50": "spy_dist_ma50"})
    p = p[p.ticker != "SPY"].merge(spy, on="date", how="left")
    if not tickers:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        p.to_pickle(CACHE)
    return p


def lift_table(p: pd.DataFrame, label: str) -> pd.DataFrame:
    """Quintiles (edges from the fit years) → P(label) ÷ base per half, SE across months (date clusters)."""
    fit = p[(p.date <= VAL_END) & p[label].notna()]
    out = []
    for f in FEATS:
        d = fit[[f, label, "date"]].dropna()
        if len(d) < 5000:
            continue
        if f in BINARY:
            d["b"] = d[f].astype(int)
            labels = [0, 1]
        else:
            edges = np.unique(np.nanquantile(d[f], [0, .2, .4, .6, .8, 1]))
            if len(edges) < 4:
                continue
            d["b"] = np.clip(np.searchsorted(edges, d[f], side="right") - 1, 0, len(edges) - 2)
            labels = list(range(len(edges) - 1))
        for half, h in (("H1", d[d.date <= HALF]), ("H2", d[d.date > HALF])):
            base = h[label].mean()
            m = h.assign(mo=h.date.dt.to_period("M")).groupby(["b", "mo"])[label].agg(["mean", "size"]).reset_index()
            for b in labels:
                mb = m[m.b == b]
                if mb["size"].sum() < 200:
                    continue
                rate = np.average(mb["mean"], weights=mb["size"])
                se = mb["mean"].std(ddof=1) / np.sqrt(len(mb)) if len(mb) > 3 else np.nan
                out.append({"feature": f, "label": label, "half": half, "bucket": b, "n": int(mb["size"].sum()),
                            "rate": rate, "base": base, "lift": rate / base, "se": se,
                            "lo": float(h.loc[h.b == b, f].min()), "hi": float(h.loc[h.b == b, f].max())})
    return pd.DataFrame(out)


def tier(lt: pd.DataFrame) -> pd.DataFrame:
    """Best extreme bucket per feature × label; tier only when the same bucket lifts in both halves."""
    res = []
    for (f, lab), g in lt.groupby(["feature", "label"]):
        piv = g.pivot_table(index="bucket", columns="half", values="lift")
        if not {"H1", "H2"} <= set(piv.columns):
            continue
        piv = piv.dropna(subset=["H1", "H2"])
        if piv.empty:
            continue
        piv["min"] = piv[["H1", "H2"]].min(axis=1)
        b = piv["min"].idxmax()
        lo = min(piv.loc[b, "H1"], piv.loc[b, "H2"])
        t = "strong" if lo >= 1.5 else "useful" if lo >= 1.25 else "weak" if lo >= 1.1 else "none"
        row = g[(g.bucket == b)]
        rng = f"{row['lo'].min():.2f}…{row['hi'].max():.2f}"
        h1 = row[row.half == "H1"].iloc[0]; h2 = row[row.half == "H2"].iloc[0]
        res.append({"feature": f, "label": lab, "bucket": int(b), "range": rng, "lift_H1": h1.lift, "lift_H2": h2.lift,
                    "rate_H1": h1.rate, "rate_H2": h2.rate, "base_H1": h1.base, "base_H2": h2.base,
                    "z_H1": (h1.rate - h1.base) / h1.se if h1.se else np.nan, "z_H2": (h2.rate - h2.base) / h2.se if h2.se else np.nan,
                    "n": int(row.n.sum()), "tier": t})
    if not res:
        return pd.DataFrame(columns=["feature", "label", "bucket", "range", "lift_H1", "lift_H2", "tier", "n"])
    return pd.DataFrame(res).sort_values(["label", "lift_H1"], ascending=[True, False])


def model(p: pd.DataFrame, label: str) -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.inspection import permutation_importance
    from sklearn.metrics import roc_auc_score
    d = p[p[label].notna()].copy()
    fit, val, hold = d.date <= FIT_END, (d.date > FIT_END) & (d.date <= VAL_END), d.date > VAL_END
    feats = [f for f in FEATS if d.loc[fit, f].nunique() > 1]
    X = d[feats].astype(float); y = d[label].astype(int)
    kw = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=500, l2_regularization=1.0, random_state=0)
    m = HistGradientBoostingClassifier(**kw).fit(X[fit], y[fit])
    pv = m.predict_proba(X[val])[:, 1]
    out = {"label": label, "auc_val": roc_auc_score(y[val], pv)}
    q = pd.qcut(pv, 10, labels=False, duplicates="drop")
    out["top_decile_lift_val"] = y[val][q == q.max()].mean() / y[val].mean()
    sub = np.random.default_rng(0).choice(np.flatnonzero(val.to_numpy()), min(60000, int(val.sum())), replace=False)
    pi = permutation_importance(m, X.iloc[sub], y.iloc[sub], scoring="roc_auc", n_repeats=3, random_state=0)
    out["importance"] = sorted(zip(feats, pi.importances_mean), key=lambda z: -z[1])[:12]
    m2 = HistGradientBoostingClassifier(**kw).fit(X[fit | val], y[fit | val])
    ph = m2.predict_proba(X[hold])[:, 1]
    out["auc_hold"] = roc_auc_score(y[hold], ph)
    qh = pd.qcut(ph, 10, labels=False, duplicates="drop")
    dh = d[hold].assign(score=ph, dec=qh)
    out["hold_deciles"] = dh.groupby("dec").agg(rate=(label, "mean"), dd10=("dd10", "median"), up10=("up10", "median"),
                                                ret10=("ret10", "median"), n=(label, "size")).reset_index()
    out["hold_base"] = dh[label].mean()
    out["hold_base_path"] = dh[["dd10", "up10", "ret10"]].median().to_dict()
    rs = dh[dh.rsi14 < 30] if label == "near_low" else dh[dh.rsi14 > 70]
    out["hold_rsi_alone"] = {"rate": rs[label].mean(), "n": len(rs), **rs[["dd10", "up10", "ret10"]].median().to_dict()}
    return out


def confluence(p: pd.DataFrame) -> pd.DataFrame:
    """Count of classic 'low-side' conditions and the hit rate / forward path at each count (fit years + holdout)."""
    c = ((p.rsi14 < 30).astype(int) + (p.bb_pctb < 0).astype(int) + (p.bull_div == 1).astype(int)
         + (p.sup_dist < 0.5).astype(int) + (p.hvn_below_dist < 0.5).astype(int) + (p.down_climax == 1).astype(int)
         + (p.skew_z60 > 1.5).astype(int) + (p.close_loc > 0.6).astype(int))
    d = p.assign(k=c.clip(upper=5), per=np.where(p.date > VAL_END, "hold", "fit"))
    return d[d.near_low.notna()].groupby(["per", "k"]).agg(n=("near_low", "size"), near_low=("near_low", "mean"),
                                                          dd10=("dd10", "median"), up10=("up10", "median"),
                                                          ret10=("ret10", "median")).reset_index()


def s151_panel(tickers: list[str] | None, rebuild: bool) -> pd.DataFrame:
    cache = S151_CACHE if not tickers else None
    if cache and cache.exists() and not rebuild and not tickers:
        p = pd.read_pickle(cache)
        with connect() as c:  # A330: nightly readers need today's bars — stale cache froze scores at 11-02
            db_max = rows(c, "SELECT max(date) d FROM lseg_research.daily_history WHERE close > 0", None)[0]["d"]
        if "good_low_close_week" in p.columns and p.date.max() >= pd.Timestamp(db_max):
            return p
        rebuild = True
    raw = load(tickers)
    parts = []
    for t, g in raw.groupby("ticker"):
        if t == "SPY" or len(g) < 300:
            continue
        parts.append(s151_features(g))
    p = pd.concat(parts, ignore_index=True)
    spy_raw = raw[raw.ticker == "SPY"]
    if len(spy_raw):
        spy_f = s151_features(spy_raw.sort_values("date"))
        spy_cols = spy_f[["date", "rsi14", "dist_ma50", "ret_20"]].rename(
            columns={"rsi14": "spy_rsi14", "dist_ma50": "spy_dist_ma50", "ret_20": "spy_ret_20"})
        p = p.merge(spy_cols, on="date", how="left")
        p["rel_ret_20"] = p.ret_20 - p.spy_ret_20
    if cache and not tickers:
        cache.parent.mkdir(parents=True, exist_ok=True)
        p.to_pickle(cache)
    return p


def s151_phase1_summary(p: pd.DataFrame) -> pd.DataFrame:
    """Base rates and path medians per horizon × label side (all dates with valid label)."""
    rows = []
    for name in S151_HORIZONS:
        for side, col in (("low", f"good_low_{name}"), ("high", f"good_high_{name}")):
            d = p[p[col].notna()]
            if d.empty:
                continue
            base = d[col].mean()
            rows.append({"horizon": name, "side": side, "n": len(d), "base_rate": base,
                         "mae_med": d[f"mae_low_{name}"].median() if side == "low" else np.nan,
                         "mfe_med": d[f"mfe_low_{name}"].median() if side == "low" else np.nan,
                         "ret_h_med": d[f"ret_h_{name}"].median(),
                         "sell_put_ok": d[f"sell_put_ok_{name}"].mean() if side == "low" else np.nan,
                         "long_call_ok": d[f"long_call_ok_{name}"].mean() if side == "low" else np.nan})
    return pd.DataFrame(rows)


def _cohen_d(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 30 or len(b) < 30:
        return np.nan
    va, vb = a.var(ddof=1), b.var(ddof=1)
    pooled = np.sqrt(((len(a) - 1) * va + (len(b) - 1) * vb) / (len(a) + len(b) - 2))
    return (a.mean() - b.mean()) / pooled if pooled > 0 else np.nan


def s151_phase2_separation(p: pd.DataFrame) -> pd.DataFrame:
    """Hypothesis generation on fit window 2016–2021: true turning days vs dd×ret-matched controls."""
    fit = p[(p.date >= pd.Timestamp("2016-01-01")) & (p.date <= S151_FIT_END)].copy()
    fit["dd_q"] = pd.qcut(fit.dd_20.rank(method="first"), 5, labels=False, duplicates="drop")
    fit["ret_q"] = pd.qcut(fit.ret_20.rank(method="first"), 5, labels=False, duplicates="drop")
    fit["match_cell"] = fit.dd_q.astype(str) + "_" + fit.ret_q.astype(str)
    out = []
    snap_feats = [f for f in FEATS_S151 if f not in ("dd_20", "ret_20", "ret_15", "ret_30")]
    for name in S151_HORIZONS:
        for side, col in (("low", f"good_low_{name}"), ("high", f"good_high_{name}")):
            d = fit[fit[col].notna() & fit.match_cell.notna()].copy()
            if len(d) < 500:
                continue
            pos = d[d[col] == 1]
            neg_pool = d[d[col] == 0]
            if len(pos) < 40:
                continue
            neg_idx = []
            for cell in pos.match_cell.unique():
                pool = neg_pool[neg_pool.match_cell == cell]
                if pool.empty:
                    continue
                take = min(len(pool), max(3, len(pos[pos.match_cell == cell]) * 3))
                neg_idx.extend(pool.sample(n=take, random_state=0).index.tolist())
            neg = d.loc[neg_idx] if neg_idx else neg_pool.sample(n=min(len(neg_pool), len(pos) * 5), random_state=0)
            for f in snap_feats:
                if d[f].notna().sum() < 500:
                    continue
                pv, nv = pos[f].to_numpy(float), neg[f].to_numpy(float)
                dval = _cohen_d(pv, nv)
                if side == "low" and f in ("rsi14", "rsi2", "stoch14", "bb_pctb", "z5_close"):
                    thr = np.nanquantile(pv, 0.25)
                    direction = "low"
                elif side == "high" and f in ("rsi14", "rsi2", "stoch14", "bb_pctb", "z5_close"):
                    thr = np.nanquantile(pv, 0.75)
                    direction = "high"
                else:
                    thr = np.nanmedian(pv)
                    direction = "med_pos" if dval > 0 else "med_neg"
                out.append({"horizon": name, "side": side, "feature": f, "cohen_d": dval,
                              "pos_n": len(pos), "neg_n": len(neg), "pos_med": np.nanmedian(pv),
                              "neg_med": np.nanmedian(nv), "pos_thr_hint": thr, "direction": direction})
    df = pd.DataFrame(out)
    if df.empty:
        return df
    df["abs_d"] = df.cohen_d.abs()
    return df.sort_values(["horizon", "side", "abs_d"], ascending=[True, True, False])


def s151_lift_table(
    p: pd.DataFrame,
    label: str,
    feats: list[str] | None = None,
    *,
    fit_start: pd.Timestamp | None = None,
    fit_end: pd.Timestamp | None = None,
    check_end: pd.Timestamp | None = None,
    half: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Quintile edges from fit window; lift on check split H1/H2 (month-clustered SE)."""
    feats = feats or FEATS_S151
    fit_start = fit_start or pd.Timestamp("2016-01-01")
    fit_end = fit_end or S151_P3_FIT_END
    check_end = check_end or S151_P3_VAL_END
    half = half or S151_P3_HALF
    fit = p[(p.date >= fit_start) & (p.date <= fit_end) & p[label].notna()]
    check = p[(p.date > fit_end) & (p.date <= check_end) & p[label].notna()]
    out = []
    for f in feats:
        d_fit = fit[[f, label, "date"]].dropna()
        if len(d_fit) < 5000:
            continue
        if f in BINARY:
            edges = None
        else:
            edges = np.unique(np.nanquantile(d_fit[f], [0, 0.2, 0.4, 0.6, 0.8, 1.0]))
            if len(edges) < 4:
                continue
        for half_name, h in (("H1", check[check.date <= half]), ("H2", check[check.date > half])):
            d = h[[f, label, "date"]].dropna()
            if len(d) < 2000:
                continue
            if f in BINARY:
                d = d.assign(b=d[f].astype(int))
                labels = [0, 1]
            else:
                d = d.assign(b=np.clip(np.searchsorted(edges, d[f], side="right") - 1, 0, len(edges) - 2))
                labels = list(range(len(edges) - 1))
            base = d[label].mean()
            m = d.assign(mo=d.date.dt.to_period("M")).groupby(["b", "mo"])[label].agg(["mean", "size"]).reset_index()
            for b in labels:
                mb = m[m.b == b]
                if mb["size"].sum() < 150:
                    continue
                rate = np.average(mb["mean"], weights=mb["size"])
                se = mb["mean"].std(ddof=1) / np.sqrt(len(mb)) if len(mb) > 3 else np.nan
                out.append({"feature": f, "label": label, "half": half_name, "bucket": b, "n": int(mb["size"].sum()),
                            "rate": rate, "base": base, "lift": rate / base if base > 0 else np.nan, "se": se,
                            "lo": float(d.loc[d.b == b, f].min()), "hi": float(d.loc[d.b == b, f].max())})
    return pd.DataFrame(out)


def s151_tier_with_geometry(lt: pd.DataFrame, lt_close: pd.DataFrame | None) -> pd.DataFrame:
    if lt.empty:
        return pd.DataFrame()
    tr = tier(lt)
    if lt_close is None or lt_close.empty:
        tr["geometry_ok"] = True
        return tr
    tr2 = tier(lt_close).rename(columns={"lift_H1": "lift_close_H1", "lift_H2": "lift_close_H2", "tier": "tier_close"})
    tr = tr.merge(tr2[["feature", "tier_close", "lift_close_H1", "lift_close_H2"]], on="feature", how="left")
    geom = tr.feature.isin(S151_GEOMETRY_FEATS)
    ok = ~geom | (
        tr.tier_close.notna() & (tr.tier_close != "none")
        & (tr.lift_close_H1 > 1) & (tr.lift_close_H2 > 1)
        & (np.sign(tr.lift_H1 - 1) == np.sign(tr.lift_close_H1 - 1))
    )
    tr.loc[geom & ~ok, "tier"] = "none"
    tr["geometry_ok"] = ok
    return tr


def _month_cluster_t(d: pd.DataFrame, mask: pd.Series, label: str) -> float:
    sub = d.assign(hit=d[label].astype(float), sel=mask.astype(int))
    mo = sub.groupby(sub.date.dt.to_period("M")).apply(
        lambda g: g.loc[g.sel == 1, "hit"].mean() - g["hit"].mean() if g.sel.sum() >= 20 else np.nan, include_groups=False)
    mo = mo.dropna()
    if len(mo) < 4:
        return np.nan
    return float(mo.mean() / (mo.std(ddof=1) / np.sqrt(len(mo))))


def _bh_adjust(pvals: list[float]) -> list[float]:
    p = np.array([x if np.isfinite(x) else 1.0 for x in pvals], dtype=float)
    n = len(p)
    order = np.argsort(p)
    adj = np.empty(n)
    prev = 1.0
    for rank, i in enumerate(order[::-1], start=1):
        val = min(prev, p[i] * n / (n - rank + 1))
        adj[i] = val
        prev = val
    return adj.tolist()


def s151_pair_grid(p: pd.DataFrame, label: str, top_feats: list[str], side: str) -> pd.DataFrame:
    """All pairs among top_feats; month-block t on check window; BH across pairs."""
    check = p[(p.date > S151_P3_FIT_END) & (p.date <= S151_P3_VAL_END) & p[label].notna()].copy()
    fit = p[(p.date >= pd.Timestamp("2016-01-01")) & (p.date <= S151_P3_FIT_END) & p[label].notna()]
    rows = []
    edges = {}
    for f in top_feats:
        if f in BINARY:
            edges[f] = None
            continue
        d = fit[[f]].dropna()
        if len(d) < 1000:
            continue
        edges[f] = np.unique(np.nanquantile(d[f], [0, 0.2, 0.4, 0.6, 0.8, 1.0]))
    low_side = side == "low"

    def ext_mask(frame: pd.DataFrame, f: str) -> pd.Series:
        if f not in edges or edges[f] is None:
            return frame[f].astype(int) == 1
        b = np.clip(np.searchsorted(edges[f], frame[f], side="right") - 1, 0, len(edges[f]) - 2)
        return b == (0 if low_side else len(edges[f]) - 2)

    for i, f1 in enumerate(top_feats):
        for f2 in top_feats[i + 1:]:
            d = check.dropna(subset=[f1, f2, label])
            if len(d) < 3000:
                continue
            m = ext_mask(d, f1) & ext_mask(d, f2)
            if m.sum() < 200:
                continue
            h1 = d[d.date <= S151_P3_HALF]
            h2 = d[d.date > S151_P3_HALF]
            lifts = []
            for h in (h1, h2):
                base = h[label].mean()
                mh = ext_mask(h, f1) & ext_mask(h, f2)
                rate = h.loc[mh, label].mean()
                lifts.append(rate / base if base > 0 else np.nan)
            if not all(np.isfinite(x) and x > 1 for x in lifts):
                continue
            t = _month_cluster_t(d, ext_mask(d, f1) & ext_mask(d, f2), label)
            rows.append({"f1": f1, "f2": f2, "label": label, "n": int((ext_mask(d, f1) & ext_mask(d, f2)).sum()),
                         "lift_H1": lifts[0], "lift_H2": lifts[1], "t_check": t})
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    from scipy import stats
    pvals = [2 * stats.t.sf(abs(t), df=8) if np.isfinite(t) else 1.0 for t in df.t_check]
    df["p_raw"] = pvals
    df["p_bh"] = _bh_adjust(pvals)
    df["pass_bh"] = df.p_bh < 0.05
    return df.sort_values("t_check", ascending=False)


def s151_model_horizon(p: pd.DataFrame, label: str) -> dict:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    d = p[p[label].notna()].copy()
    fit = d.date <= S151_P3_FIT_END
    val = (d.date > S151_P3_FIT_END) & (d.date <= S151_P3_VAL_END)
    hold = d.date >= S151_P3_HOLD_START
    feats = [f for f in FEATS_S151 if d.loc[fit, f].nunique() > 1]
    X = d[feats].astype(float)
    y = d[label].astype(int)
    kw = dict(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=800, l2_regularization=1.0, random_state=0)
    m = HistGradientBoostingClassifier(**kw).fit(X[fit], y[fit])
    pv = m.predict_proba(X[val])[:, 1]
    out = {"label": label, "auc_val": roc_auc_score(y[val], pv) if val.sum() > 100 else np.nan}
    q = pd.qcut(pv, 10, labels=False, duplicates="drop")
    out["top_decile_lift_val"] = y[val][q == q.max()].mean() / y[val].mean()
    m2 = HistGradientBoostingClassifier(**kw).fit(X[fit | val], y[fit | val])
    if hold.sum() < 500:
        out["auc_hold"] = np.nan
        out["hold_top_decile_lift"] = np.nan
    else:
        ph = m2.predict_proba(X[hold])[:, 1]
        out["auc_hold"] = roc_auc_score(y[hold], ph)
        qh = pd.qcut(ph, 10, labels=False, duplicates="drop")
        out["hold_top_decile_lift"] = y[hold][qh == qh.max()].mean() / y[hold].mean()
    return out


def s151_confluence(p: pd.DataFrame, label: str, side: str) -> pd.DataFrame:
    d = p[p[label].notna()].copy()
    if side == "low":
        c = ((d.rsi14 < 35).astype(int) + (d.rsi2 < 35).astype(int) + (d.bb_pctb < 0.2).astype(int)
             + (d.close_loc > 0.55).astype(int) + (d.sup_dist < 0.75).astype(int) + (d.down_climax == 1).astype(int))
    else:
        c = ((d.rsi14 > 65).astype(int) + (d.rsi2 > 65).astype(int) + (d.bb_pctb > 0.8).astype(int)
             + (d.close_loc < 0.45).astype(int) + (d.res_dist < 0.75).astype(int) + (d.up_climax == 1).astype(int))
    d = d.assign(k=c.clip(upper=5), per=np.where(d.date >= S151_P3_HOLD_START, "hold",
                                                  np.where(d.date > S151_P3_FIT_END, "check", "fit")))
    return d.groupby(["per", "k"]).agg(n=(label, "size"), rate=(label, "mean")).reset_index()


def s151_bars5m_panel(daily: pd.DataFrame) -> pd.DataFrame:
    """Rest-of-session good low/high from ~09:35 ET; features lagged from prior close (2024-10→)."""
    try:
        import psycopg
    except ImportError:
        return pd.DataFrame()
    snap = daily.sort_values(["ticker", "date"]).copy()
    snap["feat_date"] = snap.date
    feat_cols = [f for f in FEATS_S151 if f in snap.columns]
    lag = snap.groupby("ticker")[feat_cols + ["atr", "date"]].shift(1)
    lag["ticker"] = snap.ticker.values
    lag["date"] = snap.date.values
    with connect() as conn:
        uni = set(snap.ticker.unique())
        tickers = [t for (t,) in conn.execute(
            "SELECT DISTINCT ticker FROM optlab.bars_5m"
        ).fetchall() if t in uni]
    rows = []
    for tk in tickers:
        g = lag[lag.ticker == tk].dropna(subset=["atr"])
        if g.empty:
            continue
        with connect() as conn:
            raw = pd.read_sql(
                "SELECT ts, o, h, l, c FROM optlab.bars_5m WHERE ticker=%s ORDER BY ts", conn, params=(tk,))
        if raw.empty:
            continue
        raw["ts"] = pd.to_datetime(raw.ts, utc=True).dt.tz_convert("America/New_York")
        m = raw.ts.dt.hour * 60 + raw.ts.dt.minute
        raw = raw[(m >= 570) & (m < 960)].copy()
        raw["d"] = pd.to_datetime(raw.ts.dt.date)
        by_day = {d: sub for d, sub in raw.groupby("d")}
        for _, row in g.iterrows():
            d = row.date
            if d < pd.Timestamp("2024-10-01"):
                continue
            bars = by_day.get(d)
            if bars is None or len(bars) < 8:
                continue
            early = bars[bars.ts.dt.hour * 60 + bars.ts.dt.minute <= 575]
            rest = bars[bars.ts.dt.hour * 60 + bars.ts.dt.minute > 575]
            if early.empty or rest.empty:
                continue
            sig_l, sig_c = float(early.l.min()), float(early.c.iloc[-1])
            fl, fh = float(rest.l.min()), float(rest.h.max())
            a = float(row.atr)
            if not a > 0:
                continue
            ok = True
            good_low = float((fl >= sig_l - S151_TOL * a) and (fh >= sig_c + S151_K_ATR * a))
            good_high = float((fh <= early.h.max() + S151_TOL * a) and (fl <= sig_c - S151_K_ATR * a))
            good_low_close = float((fl >= sig_c - S151_CLOSE_TOL * a) and (fh >= sig_c + S151_K_ATR * a))
            rec = {f: row[f] for f in feat_cols if f in row.index}
            rec.update({"ticker": tk, "date": d, "good_low_rest": good_low, "good_high_rest": good_high,
                          "good_low_rest_close": good_low_close, "atr": a})
            rows.append(rec)
    return pd.DataFrame(rows)


def s151_phase3(p: pd.DataFrame, p2: pd.DataFrame) -> dict:
    """Prospective lifts, pairs (BH), model, confluence; dual geometry labels."""
    out: dict = {"tiers": [], "pairs": [], "models": [], "confluence": [], "bars5m_tiers": None}
    for name in S151_HORIZONS:
        for side in ("low", "high"):
            lab = f"good_{side}_{name}"
            lab_close = f"good_{side}_close_{name}"
            lt = s151_lift_table(p, lab)
            lt_c = s151_lift_table(p, lab_close)
            tr = s151_tier_with_geometry(lt, lt_c)
            tr = tr.assign(horizon=name, side=side, label_geom=lab)
            out["tiers"].append(tr)
            top = p2[(p2.horizon == name) & (p2.side == side)].head(15).feature.tolist()
            if len(top) >= 2:
                pg = s151_pair_grid(p, lab, top, side)
                if not pg.empty:
                    pg = pg.assign(horizon=name, side=side)
                    out["pairs"].append(pg)
            out["models"].append({**s151_model_horizon(p, lab), "horizon": name, "side": side})
            out["confluence"].append(s151_confluence(p, lab, side).assign(horizon=name, side=side))
    out["tiers_df"] = pd.concat(out["tiers"], ignore_index=True) if out["tiers"] else pd.DataFrame()
    out["pairs_df"] = pd.concat(out["pairs"], ignore_index=True) if out["pairs"] else pd.DataFrame()
    out["conf_df"] = pd.concat(out["confluence"], ignore_index=True) if out["confluence"] else pd.DataFrame()
    b5 = s151_bars5m_panel(p)
    if not b5.empty:
        lt = s151_lift_table(
            b5, "good_low_rest", [f for f in FEATS_S151 if f in b5.columns],
            fit_start=pd.Timestamp("2024-10-01"), fit_end=pd.Timestamp("2025-06-30"),
            check_end=pd.Timestamp("2026-06-30"), half=pd.Timestamp("2025-12-31"),
        )
        lt_c = s151_lift_table(
            b5, "good_low_rest_close", [f for f in FEATS_S151 if f in b5.columns],
            fit_start=pd.Timestamp("2024-10-01"), fit_end=pd.Timestamp("2025-06-30"),
            check_end=pd.Timestamp("2026-06-30"), half=pd.Timestamp("2025-12-31"),
        )
        if not lt.empty:
            tr = s151_tier_with_geometry(lt, lt_c)
            tr = tr.assign(block="bars_5m_rest_day", side="low")
            out["bars5m_tiers"] = tr
        out["bars5m_n"] = len(b5)
        out["bars5m_base"] = b5.good_low_rest.mean()
    return out


def s151_hand_check_row(p: pd.DataFrame, ticker: str = "AAPL", horizon: str = "week") -> dict:
    """One explicit label row for manual verification in the packet."""
    col = f"good_low_{horizon}"
    g = p[p.ticker == ticker].sort_values("date").reset_index(drop=True)
    pos = g[g[col] == 1]
    if pos.empty:
        return {"error": "no positive label"}
    row = pos.iloc[len(pos) // 2]
    gi = int(pos.index[len(pos) // 2])
    h = S151_HORIZONS[horizon]
    fwd = g.iloc[gi + 1: gi + 1 + h]
    fl, fh = fwd.l.min(), fwd.h.max()
    chk = bool(fl >= row.l - S151_TOL * row.atr and fh >= row.c + S151_K_ATR * row.atr)
    return {"ticker": ticker, "date": str(row.date.date()), "horizon": horizon, "h_sessions": h,
            "low_t": float(row.l), "close_t": float(row.c), "atr": float(row.atr),
            "fwd_min_low": float(fl), "fwd_max_high": float(fh),
            "tol_floor": float(row.l - S151_TOL * row.atr), "rally_bar": float(row.c + S151_K_ATR * row.atr),
            "label": int(row[col]), "manual_ok": chk}


def run_s151(tickers: list[str] | None, rebuild: bool) -> None:
    p = s151_panel(tickers, rebuild)
    tag = "smoke" if tickers else "full"
    print(f"S151 panel {len(p):,} rows · {p.ticker.nunique()} names · {p.date.min().date()} → {p.date.max().date()}")
    OUT.mkdir(parents=True, exist_ok=True)
    p1 = s151_phase1_summary(p)
    p1.to_csv(OUT / f"s151_phase1_{tag}.csv", index=False)
    fit_p = p[p.date <= S151_FIT_END]
    p2 = s151_phase2_separation(fit_p)
    p2.to_csv(OUT / f"s151_phase2_{tag}.csv", index=False)
    hand = s151_hand_check_row(p)
    p3 = s151_phase3(p, p2)
    if not p3["tiers_df"].empty:
        p3["tiers_df"].to_csv(OUT / f"s151_phase3_tiers_{tag}.csv", index=False)
    if not p3["pairs_df"].empty:
        p3["pairs_df"].to_csv(OUT / f"s151_phase3_pairs_{tag}.csv", index=False)
    if not p3["conf_df"].empty:
        p3["conf_df"].to_csv(OUT / f"s151_phase3_confluence_{tag}.csv", index=False)
    hz_note = ", ".join(f"{S151_HORIZON_LABEL.get(k, k)}={v}d" for k, v in S151_HORIZONS.items())
    lines = [
        "# S151 — turning points by horizon (A328)",
        "",
        f"Panel: **{p.ticker.nunique()}** names · **{len(p):,}** day-rows · {p.date.min().date()} → {p.date.max().date()}",
        "Labels: forward-only good low/high (0.25 ATR hold on day low/high, 1 ATR rally/fall from close); "
        f"close-anchored control (hold 0.5 ATR from close). Horizons: {hz_note} (`intra` = **next session**, not rest-of-day).",
        f"Phase 2 fit window: 2016-01-01 → {S151_FIT_END.date()} (hypothesis generation only).",
        f"Phase 3: quintiles fit ≤ {S151_P3_FIT_END.date()}, check {S151_P3_HALF.date()} halves on 2023–24, holdout ≥ {S151_P3_HOLD_START.date()} once.",
        "",
        "## Phase 1 — label base rates",
        "",
        p1.round(4).to_string(index=False),
        "",
        "## Hand-checked label (good low, week, mid-sample)",
        "",
        "```json",
        __import__("json").dumps(hand, indent=2),
        "```",
        "",
        "## Phase 2 — top feature separation (|Cohen d|, fit 2016–2021)",
        "",
    ]
    if p2.empty:
        lines.append("_No phase-2 rows (insufficient events)._")
    else:
        top = p2.groupby(["horizon", "side"]).head(8)
        lines.append(top.round(3).to_string(index=False))
    lines += ["", "## Phase 3 — prospective lifts (check 2023–24, geometry filter on range features)", ""]
    tr = p3["tiers_df"]
    if tr.empty:
        lines.append("_No tier rows._")
    else:
        show = tr[tr.tier != "none"].sort_values(["horizon", "side", "lift_H1"], ascending=[True, True, False])
        cols = ["horizon", "side", "feature", "range", "lift_H1", "lift_H2", "tier", "geometry_ok", "n"]
        cols = [c for c in cols if c in show.columns]
        if show.empty:
            lines.append("_No feature reached useful/strong tier after geometry filter._")
        else:
            lines.append(show.groupby(["horizon", "side"]).head(6)[cols].round(3).to_string(index=False))
    lines += ["", "### Phase 3 — top 2-factor pairs (BH q<0.05, same-sign lift both halves)", ""]
    pg = p3["pairs_df"]
    if pg.empty:
        lines.append("_No passing pairs._")
    else:
        hit = pg[pg.pass_bh].sort_values("t_check", ascending=False).groupby(["horizon", "side"]).head(3)
        if hit.empty:
            lines.append("_No pairs survived BH at q<0.05._")
        else:
            lines.append(hit[["horizon", "side", "f1", "f2", "lift_H1", "lift_H2", "t_check", "p_bh", "n"]].round(3).to_string(index=False))
    lines += ["", "### Phase 3 — HistGradientBoosting (fit ≤2022, AUC check, holdout once)", ""]
    for m in p3["models"]:
        av = m.get("auc_val", float("nan"))
        tv = m.get("top_decile_lift_val", float("nan"))
        ah = m.get("auc_hold", float("nan"))
        th = m.get("hold_top_decile_lift", float("nan"))
        lines.append(
            f"- {m['horizon']} {m['side']}: AUC check **{av:.3f}** · top-decile lift check **{tv:.2f}×** · "
            f"holdout AUC **{ah:.3f}** · holdout top-decile **{th:.2f}×**"
        )
    lines += ["", "### Phase 3 — bars_5m rest-of-session block (2024-10→, signal ~09:35, features lagged 1d)", ""]
    b5t = p3.get("bars5m_tiers")
    if b5t is None or (isinstance(b5t, pd.DataFrame) and b5t.empty):
        lines.append("_bars_5m panel empty (DATABASE_URL or no overlap)._")
    else:
        lines.append(f"Rows **{p3.get('bars5m_n', 0):,}** · rest-day good-low base **{p3.get('bars5m_base', float('nan')):.1%}**")
        bshow = b5t[b5t.tier != "none"] if isinstance(b5t, pd.DataFrame) else pd.DataFrame()
        if bshow.empty:
            lines.append("_No useful tiers on rest-of-day labels._")
        else:
            lines.append(bshow.head(8)[["feature", "range", "lift_H1", "lift_H2", "tier", "n"]].round(3).to_string(index=False))
    lines += [
        "",
        "## Notes",
        "- Survivorship: static LSEG universe; no vendor calls on daily panel.",
        "- Range features (close_loc, etc.) count only if lift holds on **low-anchored and close-anchored** labels.",
        "- Phase 4 (trades / execution grid) not run.",
        "- Verdict: Claude.",
    ]
    (OUT / "S151.md").write_text("\n".join(lines) + "\n")
    print((OUT / "S151.md").read_text()[:5000])


def main() -> None:
    if "--s151" in sys.argv:
        tick = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--tickers=")), None)
        if "--smoke-only" in sys.argv and not tick:
            tickers = S151_SMOKE_TICKERS
        else:
            tickers = tick.split(",") if tick else None
        run_s151(tickers, "--rebuild" in sys.argv)
        return
    tick = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--tickers=")), None)
    tickers = tick.split(",") if tick else None
    p = panel(tickers, "--rebuild" in sys.argv)
    print(f"panel {len(p):,} rows · {p.ticker.nunique()} names · {p.date.min().date()} → {p.date.max().date()}")
    OUT.mkdir(parents=True, exist_ok=True)
    lt = pd.concat([lift_table(p, "near_low"), lift_table(p, "near_high")])
    tr = tier(lt)
    tag = "smoke" if tickers else "full"
    lt.to_csv(OUT / f"pattern_lab_lifts_{tag}.csv", index=False); tr.to_csv(OUT / f"pattern_lab_tiers_{tag}.csv", index=False)
    pd.set_option("display.width", 220); pd.set_option("display.max_rows", 200)
    print(tr[["label", "feature", "range", "lift_H1", "lift_H2", "rate_H1", "base_H1", "z_H1", "z_H2", "n", "tier"]].round(2).to_string(index=False))
    cf = confluence(p)
    print(cf.round(3).to_string(index=False))
    cf.to_csv(OUT / f"pattern_lab_confluence_{tag}.csv", index=False)
    if not tickers or "--model" in sys.argv:
        for lab in ("near_low", "near_high"):
            r = model(p, lab)
            print(f"\n{lab}: AUC val {r['auc_val']:.3f} · top-decile lift val {r['top_decile_lift_val']:.2f} · AUC holdout {r['auc_hold']:.3f}")
            print("  importance", [(f, round(v, 4)) for f, v in r["importance"]])
            print(r["hold_deciles"].round(3).to_string(index=False))
            print("  base", round(r["hold_base"], 3), {k: round(v, 3) for k, v in r["hold_base_path"].items()},
                  " RSI-alone", {k: round(v, 3) if isinstance(v, float) else v for k, v in r["hold_rsi_alone"].items()})
            r["hold_deciles"].to_csv(OUT / f"pattern_lab_model_{lab}_{tag}.csv", index=False)


if __name__ == "__main__":
    main()
