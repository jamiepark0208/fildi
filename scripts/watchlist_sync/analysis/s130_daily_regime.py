"""S130 — Daily regime detectors (the 8 TradingView scripts Jamie sent + classic regime literature), 1993 → 2026.

Why (Jamie 10-28: "double check you did the right test"): S126 tested the Live tab on 5-min bars to the same-day
close. The detectors themselves are built for 1H / 4H / Daily bars (StrixEDGE: "Recommended 1H, 4H, Daily") and
claim the *state* persists. Jamie sells 1–2-week puts, so the regime that matters is days, not minutes.

Decision at the close of day t; nothing after t is used. Tickers SPY QQQ IWM DIA (Yahoo daily since 1993, VIX 1990).
Indicators (implemented from the published descriptions / open code):
  StrixEDGE  ADX14>25 · RSI range-shift (bull zone 40–80 / bear 20–60 over 20 d) · KAMA21 slope ÷ ATR · ATR14/ATR50
  LuciTech   KAMA slope normalised by adaptive ATR → strong/weak bull/bear, consolidation, chop
  QuantAlgo  volatility-adaptive filter slope (|slope| histogram, 10 / 30 % thresholds) — KAMA-slope proxy
  forexobro  ADX trend/range thresholds 25/20 · BB-width percentile · ATR percentile > 80 = volatile (no-trade)
  KK         efficiency ratio · choppiness 38.2/61.8 · BB-inside-KC squeeze · HH/HL structure
  JOAT       range filter direction + run length · impulse (ZLEMA vs SMMA34 hi/lo) · EMA 20/50/200 alignment ·
             chandelier exit (22, 3 ATR)
  Classic    close > 200 d SMA (Faber 2007) · 12-1 m time-series momentum (Moskowitz et al. 2012) · VIX level ·
             VIX/VIX3M term (inverted = stress) · VIX − 20 d realised vol (variance premium; Bollerslev et al. 2009) ·
             credit HYG/IEF 50 d trend · breadth proxy RSP/SPY 50 d trend · CBOE SKEW
Outcomes: 5 / 10-day forward return and sign; put breach = close(t+h) < K, K = S·exp(−σ√(h/252)), σ = VIX/100
(≈ a 0.16Δ put; VIX for every ticker, so compare labels within a ticker); worst close drawdown over h.
Grading: non-overlapping samples (every h-th day), halves 1993–2009 / 2010–2026, label vs complement.
Pass = same sign both halves, |t| ≥ 2 in each, and adds over "close > 200 d" (the free baseline).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S130.md"
SPLIT = pd.Timestamp("2010-01-01")


def load(src: str) -> dict[str, pd.DataFrame]:
    raw = json.loads(Path(src).read_text())
    out = {}
    for t, q in raw.items():
        d = pd.DataFrame(q)
        d["date"] = pd.to_datetime(d["date"], utc=True).dt.tz_convert("America/New_York").dt.normalize().dt.tz_localize(None)
        d = d.dropna(subset=["close"]).drop_duplicates("date").set_index("date").sort_index()
        out[t] = d[["open", "high", "low", "close", "volume"]].astype(float)
    return out


def rma(x: pd.Series, n: int) -> pd.Series:
    return x.ewm(alpha=1 / n, adjust=False).mean()


def kama(c: pd.Series, n=10, fast=2, slow=30) -> pd.Series:
    er = (c - c.shift(n)).abs() / c.diff().abs().rolling(n).sum()
    sc = (er * (2 / (fast + 1) - 2 / (slow + 1)) + 2 / (slow + 1)) ** 2
    k = np.full(len(c), np.nan); v = c.values; s = sc.values
    for i in range(len(c)):
        if np.isnan(s[i]): continue
        k[i] = v[i] if np.isnan(k[i - 1]) else k[i - 1] + s[i] * (v[i] - k[i - 1])
    return pd.Series(k, c.index)


def features(d: pd.DataFrame, vix: pd.Series, ext: dict[str, pd.Series]) -> pd.DataFrame:
    h, l, c = d.high, d.low, d.close
    pc = c.shift()
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    atr14, atr50 = rma(tr, 14), rma(tr, 50)
    up, dn = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), d.index)
    mdm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), d.index)
    pdi, mdi = 100 * rma(pdm, 14) / atr14, 100 * rma(mdm, 14) / atr14
    adx = rma(100 * (pdi - mdi).abs() / (pdi + mdi), 14)
    gain, loss = rma(c.diff().clip(lower=0), 14), rma(-c.diff().clip(upper=0), 14)
    rsi = 100 - 100 / (1 + gain / loss)
    k21 = kama(c, 21)
    kslope = (k21 - k21.shift(5)) / (atr14 * 5)          # KAMA slope in ATRs per day
    er20 = (c - c.shift(20)).abs() / c.diff().abs().rolling(20).sum()
    chop = 100 * np.log10(tr.rolling(14).sum() / (h.rolling(14).max() - l.rolling(14).min())) / np.log10(14)
    sma20, sd20 = c.rolling(20).mean(), c.rolling(20).std()
    bbw = 4 * sd20 / sma20
    ema = lambda x, n: x.ewm(span=n, adjust=False).mean()
    kc_w = 2 * 1.5 * ema(tr, 20) / ema(c, 20)
    # JOAT range filter (smoothrng/rngfilt)
    avr = ema((c - pc).abs(), 50); smr = ema(avr, 99) * 3.0
    f = np.full(len(c), np.nan); cv, rv = c.values, smr.values
    for i in range(len(c)):
        if np.isnan(rv[i]): continue
        p = f[i - 1] if i and not np.isnan(f[i - 1]) else cv[i]
        f[i] = max(p, cv[i] - rv[i]) if cv[i] > p else min(p, cv[i] + rv[i])
    rf = pd.Series(f, d.index); rfdir = np.sign(rf.diff()).replace(0, np.nan).ffill()
    smma = lambda x, n: x.ewm(alpha=1 / n, adjust=False).mean()
    hi34, lo34 = smma(h, 34), smma(l, 34)
    e1 = ema((h + l + c) / 3, 34); zl = e1 + (e1 - ema(e1, 34))
    impulse = np.where(zl > hi34, 1, np.where(zl < lo34, -1, 0))
    chand_long = h.rolling(22).max() - 3 * rma(tr, 22)
    sma200 = c.rolling(200).mean()
    rv20 = np.log(c).diff().rolling(20).std() * np.sqrt(252) * 100
    F = pd.DataFrame(index=d.index)
    F["c"] = c
    F["adx"] = adx; F["di"] = np.sign(pdi - mdi)
    F["rsi_bull"] = (rsi.rolling(20).min() >= 40).astype(int) - (rsi.rolling(20).max() <= 60).astype(int)
    F["kslope"] = kslope
    F["atr_ratio"] = atr14 / atr50
    F["er20"] = er20; F["chop"] = chop
    F["bbw_pct"] = bbw.rolling(252).rank(pct=True)
    F["atr_pct"] = (atr14 / c).rolling(252).rank(pct=True)
    F["sqz"] = (bbw < kc_w).astype(int)
    F["struct"] = np.sign((h.rolling(20).max() > h.shift(20).rolling(20).max()).astype(int)
                          + (l.rolling(20).min() > l.shift(20).rolling(20).min()).astype(int) - 1)
    F["rf_dir"] = rfdir
    F["impulse"] = impulse
    F["ema_align"] = np.sign(c - ema(c, 20)) + np.sign(ema(c, 20) - ema(c, 50)) + np.sign(ema(c, 50) - ema(c, 200))
    F["chandelier"] = np.sign(c - chand_long)
    F["above200"] = np.sign(c - sma200)
    F["tsmom"] = np.sign(c.shift(21) / c.shift(252) - 1)
    F["ret5"] = c / c.shift(5) - 1
    F["vix"] = vix.reindex(d.index).ffill()
    F["vrp"] = F.vix - rv20
    for k, s in ext.items():
        F[k] = s.reindex(d.index).ffill()
    # StrixEDGE matrix (all four agree = strong)
    tr_up = (F.adx > 25) & (F.rsi_bull == 1) & (F.kslope > 0.05) & (F.atr_ratio < 1.1)
    tr_dn = (F.adx > 25) & (F.rsi_bull == -1) & (F.kslope < -0.05)
    rng = (F.adx < 20) & (F.kslope.abs() <= 0.05)
    volc = (F.atr_ratio >= 1.3) & ~tr_up & ~tr_dn
    F["strix"] = np.select([tr_up, tr_dn, volc, rng], ["strong up", "strong down", "volatile chop", "range"], "weak/other")
    # LuciTech AMRI (slope vs adaptive ATR; vol = ATR percentile)
    hv = F.atr_pct > 0.7
    F["luci"] = np.select([(F.kslope > .1) & ~hv, (F.kslope > .1) & hv, (F.kslope < -.1) & ~hv, (F.kslope < -.1) & hv, hv],
                          ["strong bull", "weak bull", "strong bear", "weak bear", "volatile chop"], "consolidation")
    # forexobroker priority: volatile > trending > ranging
    F["fxob"] = np.select([F.atr_pct > .8, F.adx > 25, F.adx < 20], ["volatile", "trending", "ranging"], "neutral")
    # KK composite (weights 30/25/20/15; + = trending)
    F["kk"] = .3 * (F.er20 - .3) / .2 + .25 * (50 - F.chop) / 12 - .2 * F.sqz + .15 * F.struct.abs()
    return F


def outcomes(F: pd.DataFrame, h: int) -> pd.DataFrame:
    c = F.c
    fwd = c.shift(-h) / c - 1
    sig = F.vix / 100 * np.sqrt(h / 252)
    K = c * np.exp(-sig)
    minc = pd.concat([c.shift(-i) for i in range(1, h + 1)], axis=1).min(axis=1)
    return pd.DataFrame({"fwd": fwd, "up": (fwd > 0).astype(float).where(fwd.notna()),
                         "breach": (c.shift(-h) < K).astype(float).where(fwd.notna()),
                         "dd": (minc / c - 1)})


def tstat(a: pd.Series, b: pd.Series) -> float:
    if len(a) < 10 or len(b) < 10: return np.nan
    return (a.mean() - b.mean()) / np.sqrt(a.var() / len(a) + b.var() / len(b))


def main() -> int:
    src = sys.argv[1]
    D = load(src)
    vix = D["^VIX"].close
    with psycopg.connect(os.environ["DATABASE_URL"]) as cn:
        cb = pd.read_sql("select date, index, close from wrds_research.cboe_daily", cn)
    cb["date"] = pd.to_datetime(cb.date)
    cbp = cb.pivot_table(index="date", columns="index", values="close")
    ext = {"vix_term": cbp["VIX"] / cbp["VIX3M"], "skew": cbp["SKEW"], "vvix": cbp["VVIX"]}
    if "HYG" in D and "IEF" in D:
        r = (D["HYG"].close / D["IEF"].close).dropna(); ext["credit"] = np.sign(r / r.rolling(50).mean() - 1)
    if "RSP" in D:
        r = (D["RSP"].close / D["SPY"].close).dropna(); ext["breadth"] = np.sign(r / r.rolling(50).mean() - 1)
    rows = []
    for tk in ["SPY", "QQQ", "IWM", "DIA"]:
        F = features(D[tk], vix, ext)
        for h in (5, 10):
            O = outcomes(F, h)
            X = F.join(O).iloc[252::h].dropna(subset=["fwd", "vix"]).copy()  # non-overlapping
            X["tk"], X["h"] = tk, h
            rows.append(X)
    A = pd.concat(rows)
    A["half"] = np.where(A.index < SPLIT, "H1", "H2")
    L = ["# S130 — Daily regime detectors vs 1–2-week direction and put breaches", "",
         f"{len(A):,} non-overlapping ticker-windows (SPY/QQQ/IWM/DIA, h = 5 and 10 trading days), "
         f"{A.index.min():%Y-%m} → {A.index.max():%Y-%m}; H1 < 2010 ≤ H2.", "",
         "Base rates: " + "; ".join(f"h{h} up {100 * A[A.h == h].up.mean():.0f} %, breach {100 * A[A.h == h].breach.mean():.1f} %" for h in (5, 10)), ""]

    # ---- 1. binary / sign labels: P(up), breach, mean fwd — label on vs off
    tests = {
        "close > 200d (baseline)": A.above200 > 0,
        "12-1m momentum up": A.tsmom > 0,
        "ADX>25 & +DI": (A.adx > 25) & (A.di > 0),
        "ADX>25 & −DI": (A.adx > 25) & (A.di < 0),
        "RSI bull zone (20d min ≥ 40)": A.rsi_bull == 1,
        "RSI bear zone (20d max ≤ 60)": A.rsi_bull == -1,
        "KAMA slope > +0.1 ATR/d": A.kslope > .1,
        "KAMA slope < −0.1 ATR/d": A.kslope < -.1,
        "range filter up (JOAT)": A.rf_dir > 0,
        "impulse up (JOAT)": A.impulse > 0,
        "impulse down (JOAT)": A.impulse < 0,
        "EMA 20/50/200 all up": A.ema_align == 3,
        "EMA 20/50/200 all down": A.ema_align == -3,
        "chandelier long": A.chandelier > 0,
        "HH+HL structure": A.struct > 0,
        "LL+LH structure": A.struct < 0,
        "squeeze (BB in KC)": A.sqz == 1,
        "ATR pct > 80 (volatile)": A.atr_pct > .8,
        "ATR14/ATR50 ≥ 1.3": A.atr_ratio >= 1.3,
        "CHOP > 61.8": A.chop > 61.8,
        "ER20 > 0.4": A.er20 > .4,
        "VIX ≥ 25": A.vix >= 25,
        "VIX term inverted (VIX/VIX3M > 1)": A.vix_term > 1,
        "VIX − RV20 < 0 (no variance premium)": A.vrp < 0,
        "credit HYG/IEF below 50d": A.credit < 0,
        "breadth RSP/SPY below 50d": A.breadth < 0,
        "5-day drop ≤ −3 %": A.ret5 <= -.03,
    }
    L += ["## 1. Each label: on vs off (P(up), put breach, mean fwd), h = 5 and 10", "",
          "| label | h | % of time | P(up) on/off | t H1 | t H2 | breach on/off | t H1 | t H2 | fwd on/off % |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    res = []
    for name, m in tests.items():
        for h in (5, 10):
            x = A[A.h == h]; mm = m[A.h == h].fillna(False)
            if mm.sum() < 30: continue
            on, off = x[mm], x[~mm]
            tu = [tstat(on[on.half == s].up, off[off.half == s].up) for s in ("H1", "H2")]
            tb = [tstat(on[on.half == s].breach, off[off.half == s].breach) for s in ("H1", "H2")]
            L.append(f"| {name} | {h} | {100 * mm.mean():.0f} | {100 * on.up.mean():.0f}/{100 * off.up.mean():.0f} | {tu[0]:+.1f} | {tu[1]:+.1f} | "
                     f"{100 * on.breach.mean():.1f}/{100 * off.breach.mean():.1f} | {tb[0]:+.1f} | {tb[1]:+.1f} | {100 * on.fwd.mean():+.2f}/{100 * off.fwd.mean():+.2f} |")
            res.append((name, h, tu, tb))
    L += ["", "Pass (same sign, |t| ≥ 2 both halves): direction → " +
          (", ".join(f"{n} h{h}" for n, h, tu, tb in res if np.sign(tu[0]) == np.sign(tu[1]) and min(abs(tu[0]), abs(tu[1])) >= 2) or "none") +
          "; breach → " + (", ".join(f"{n} h{h}" for n, h, tu, tb in res if np.sign(tb[0]) == np.sign(tb[1]) and min(abs(tb[0]), abs(tb[1])) >= 2) or "none"), ""]

    # ---- 2. the composite classifiers as published
    for col in ("strix", "luci", "fxob"):
        L += [f"## 2. {col} classes (h = 10)", "", "| class | half | n | P(up) | breach | mean fwd % | worst-10 % drawdown |", "|---|---|---|---|---|---|---|"]
        x = A[A.h == 10]
        for k in sorted(x[col].unique()):
            for s in ("H1", "H2"):
                g = x[(x[col] == k) & (x.half == s)]
                if len(g) < 15: continue
                L.append(f"| {k} | {s} | {len(g)} | {100 * g.up.mean():.0f} % | {100 * g.breach.mean():.1f} % | {100 * g.fwd.mean():+.2f} | {100 * g.dd.quantile(.1):.1f} % |")
        L.append("")

    # ---- 3. learned composite: logistic on H1 → H2 (direction and breach), AUC + calibration by fifth
    cols = ["above200", "tsmom", "adx", "di", "rsi_bull", "kslope", "atr_ratio", "er20", "chop", "bbw_pct", "atr_pct", "sqz",
            "struct", "rf_dir", "impulse", "ema_align", "chandelier", "ret5", "vix", "vrp"]
    opt = [c for c in ("vix_term", "credit", "breadth", "skew") if A[c].notna().mean() > .5]
    for tgt in ("up", "breach"):
        for h in (5, 10):
            x = A[A.h == h].dropna(subset=cols + [tgt]).copy()
            tr, te = x[x.half == "H1"], x[x.half == "H2"]
            mu, sd = tr[cols].mean(), tr[cols].std().replace(0, 1)
            Xtr, Xte = ((tr[cols] - mu) / sd).values, ((te[cols] - mu) / sd).values
            w = fit_logit(Xtr, tr[tgt].values)
            pte = 1 / (1 + np.exp(-(np.c_[np.ones(len(Xte)), Xte] @ w)))
            auc = auc_score(te[tgt].values, pte)
            te = te.assign(p=pte, q=pd.qcut(pte, 5, labels=False, duplicates="drop"))
            L += [f"## 3. Logistic {tgt} h{h}: fit 1993–2009, test 2010–26 → AUC {auc:.3f} (0.5 = coin flip), n test {len(te)}", "",
                  "| fifth | predicted | actual | mean fwd % |", "|---|---|---|---|"]
            for k, g in te.groupby("q"):
                L.append(f"| {k + 1} | {100 * g.p.mean():.0f} % | {100 * g[tgt].mean():.0f} % | {100 * g.fwd.mean():+.2f} |")
            top = sorted(zip(cols, w[1:]), key=lambda z: -abs(z[1]))[:6]
            L += ["", "Largest weights: " + ", ".join(f"{k} {v:+.2f}" for k, v in top), ""]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


def fit_logit(X, y, l2=1.0, it=300):
    Xb = np.c_[np.ones(len(X)), X]; w = np.zeros(Xb.shape[1])
    for _ in range(it):
        p = 1 / (1 + np.exp(-(Xb @ w)))
        g = Xb.T @ (p - y) + l2 * np.r_[0, w[1:]]
        H = Xb.T @ (Xb * (p * (1 - p))[:, None]) + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        w -= np.linalg.solve(H, g)
    return w


def auc_score(y, p):
    o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


if __name__ == "__main__":
    sys.exit(main())
