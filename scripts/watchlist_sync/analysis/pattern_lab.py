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
Out: out/opt/pattern-lab-packet.md + out/opt/pattern_lab_*.csv
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
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


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
    tr = np.maximum(g.h - g.l, np.maximum((g.h - pc).abs(), (g.l - pc).abs()))
    g["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
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
    return g


FEATS = ["rsi14", "rsi_chg5", "stoch14", "macd_hist_atr", "macd_hist_slope3", "roc5_atr", "roc20_atr", "bull_div", "bear_div",
         "pos20", "dist_52w_low", "dist_52w_high", "dist_ma20", "dist_ma50", "dist_ma200", "vol_z20", "close_loc", "down_climax",
         "up_climax", "gap_atr", "atr_pct252", "bb_pctb", "skew", "skew_z60", "skew_chg5", "iv_rv", "iv_rank252", "iv_chg5",
         "sup_dist", "res_dist", "sup_touches", "res_touches", "hvn_below_dist", "hvn_above_dist", "in_hvn",
         "spy_rsi14", "spy_dist_ma50"]
BINARY = {"bull_div", "bear_div", "down_climax", "up_climax", "in_hvn"}


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


def main() -> None:
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
