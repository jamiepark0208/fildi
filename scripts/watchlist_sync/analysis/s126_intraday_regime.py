"""S126 — Live-tab regime call: what can an intraday checkpoint actually tell a put seller? (Jamie 10-28)

Theory (TradingView regime detectors: StrixEDGE, LuciTech AMRI, QuantAlgo Turbo, forexobroker, KK multi-metric, JOAT):
they classify the *state* (trend / range / volatile chop / compression) to pick a strategy; none claims to call
direction. Our Live tab called bullish/bearish into the close → 40-day grade = no edge; S124/S055 say intraday
direction doesn't persist on SPY. So test both:
  A. direction to the close — current composite vs naive momentum / VWAP / efficiency-gated momentum
  B. state — efficiency ratio (ER, KK 30 %), choppiness (CHOP, KK 25 %), session range vs 20-day ATR
     (forexobroker ATR percentile, S052 'volatile days stay volatile'), daily trend context (JOAT MTF)
     graded on what the label promises: rest-of-day range, worst drop from the checkpoint (put risk),
     continuation.
Data: optlab.bars_5m SPY/QQQ RTH 2024-10 → 2026-10. Thresholds set on the first half, graded on both halves.
"""
from __future__ import annotations

import os
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S126.md"
CPS = [30, 45, 60, 90, 120, 150, 180, 210, 270, 330]  # Live tab checkpoints (15 = OR baseline, no call)
FLAT = 0.001  # 0.1 % — same band the Live grader uses


def load(tk: str) -> pd.DataFrame:
    with psycopg.connect(os.environ["DATABASE_URL"]) as c:
        df = pd.read_sql("select ts, o, h, l, c, v from optlab.bars_5m where ticker=%s order by ts", c, params=(tk,))
    df["ts"] = pd.to_datetime(df["ts"], utc=True).dt.tz_convert("America/New_York")
    t = df["ts"].dt.hour * 60 + df["ts"].dt.minute
    df = df[(t >= 570) & (t < 960)].copy()  # 09:30 ≤ bar start < 16:00
    df["d"] = df["ts"].dt.date
    df["m"] = (df["ts"].dt.hour * 60 + df["ts"].dt.minute) - 570
    return df


def composite(b: pd.DataFrame, ph: float | None, pl: float | None) -> int:
    """Port of intraday-regime.ts computeSymbolSignal → +1 bullish / −1 bearish / 0."""
    o, a = b.iloc[:3], b.iloc[3:]
    orh, orl, last = o.h.max(), o.l.min(), b.c.iloc[-1]
    bull = bear = 0.0
    if len(a):
        up, dn = max(orh, a.h.max()) > orh, min(orl, a.l.min()) < orl
        if up and last > orh: bull += 35
        elif up: bear += 35
        elif dn and last < orl: bear += 35
        elif dn: bull += 35
    vw = (b.c * b.v).sum() / b.v.sum() if b.v.sum() > 0 else b.c.mean()
    sep = (last - vw) / vw * 100
    if sep > 0.3: bull += 30 * min(1, sep)
    elif sep < -0.3: bear += 30 * min(1, -sep)
    first = b.o.iloc[0]
    upd = last >= first
    ext = b.h.max() if upd else b.l.min()
    drive = (ext - first) if upd else (first - ext)
    pb = (abs(ext - last) / drive * 100) if drive > 0 else 0
    if len(a):
        tw = 20 * (1 - pb / 50) if pb <= 50 else 0
        fw = 20 * ((pb - 50) / 50) if pb > 50 else 0
        if upd: bull += tw; bear += fw
        else: bear += tw; bull += fw
    swept = False
    if pl is not None and last > pl:
        i = np.where(b.l.values < pl)[0]
        if len(i) and (b.c.values[i[0]:i[0] + 7] > pl).any(): bull += 15; swept = True
    if not swept and ph is not None and last < ph:
        i = np.where(b.h.values > ph)[0]
        if len(i) and (b.c.values[i[0]:i[0] + 7] < ph).any(): bear += 15
    return 1 if bull > bear else -1 if bear > bull else 0


def rows(tk: str) -> pd.DataFrame:
    df = load(tk)
    days = [g for _, g in df.groupby("d") if len(g) >= 70]
    daily = pd.DataFrame({"d": [g.d.iloc[0] for g in days], "o": [g.o.iloc[0] for g in days],
                          "h": [g.h.max() for g in days], "l": [g.l.min() for g in days], "c": [g.c.iloc[-1] for g in days]})
    pc = daily.c.shift(1)
    tr = pd.concat([daily.h - daily.l, (daily.h - pc).abs(), (daily.l - pc).abs()], axis=1).max(axis=1)
    daily["atr20"] = (tr / pc).rolling(20).mean().shift(1)  # fraction of price, known before the open
    daily["sma20"] = daily.c.rolling(20).mean().shift(1)
    daily["er10d"] = ((daily.c - daily.c.shift(10)).abs() / daily.c.diff().abs().rolling(10).sum()).shift(1)
    daily["ret5d"] = (daily.c / daily.c.shift(5) - 1).shift(1)
    out = []
    for k, g in enumerate(days):
        dd = daily.iloc[k]
        if k < 21 or not np.isfinite(dd.atr20):
            continue
        prev = days[k - 1]
        ph, pl, pclose = prev.h.max(), prev.l.min(), prev.c.iloc[-1]
        g = g.reset_index(drop=True)
        close = g.c.iloc[-1]
        for m in CPS:
            b, r = g[g.m < m], g[g.m >= m]
            if len(b) < 4 or len(r) < 2:
                continue
            p, op = b.c.iloc[-1], g.o.iloc[0]
            dc = b.c.diff().abs().sum()
            er = abs(p - op) / (dc + abs(b.c.iloc[0] - op)) if dc > 0 else 0
            trs = np.maximum(b.h - b.l, np.maximum((b.h - b.c.shift()).abs(), (b.l - b.c.shift()).abs())).fillna(b.h - b.l)
            hh, ll = b.h.max(), b.l.min()
            chop = 100 * np.log10(trs.sum() / (hh - ll)) / np.log10(len(b)) if hh > ll else 100
            vw = (b.c * b.v).sum() / b.v.sum() if b.v.sum() > 0 else b.c.mean()
            out.append(dict(
                tk=tk, d=dd.d, m=m, p=p,
                gap=op / pclose - 1, ret=p / op - 1, sep=p / vw - 1, er=er, chop=chop,
                rng=(hh - ll) / op / dd.atr20,  # session range so far ÷ normal daily range
                trend_d=np.sign(pclose - dd.sma20), er10d=dd.er10d, ret5d=dd.ret5d,
                comp=composite(b, ph, pl),
                fwd=close / p - 1,
                rest_rng=(r.h.max() - r.l.min()) / p / dd.atr20,
                rest_dd=min(r.l.min() / p - 1, 0) / dd.atr20,  # worst drop after t, in ATRs
                rest_up=max(r.h.max() / p - 1, 0) / dd.atr20,
            ))
    return pd.DataFrame(out)


def acc(sig: pd.Series, fwd: pd.Series) -> tuple[float, int]:
    k = (sig != 0) & (fwd.abs() >= FLAT)
    n = int(k.sum())
    return (float((np.sign(fwd[k]) == sig[k]).mean()) if n else float("nan")), n


def main() -> int:
    R = pd.concat([rows("SPY"), rows("QQQ")], ignore_index=True)
    dates = sorted(R.d.unique())
    split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    tr = R[R.half == "H1"]
    L = [f"# S126 — Live-tab regime call backtest", "",
         f"SPY+QQQ 5-min RTH, {len(dates)} sessions {dates[0]} → {dates[-1]}; H1 < {split} ≤ H2. Checkpoints {CPS} min after the open.", ""]

    # ---- A. direction to the close
    sigs = {
        "current composite (Live tab)": R.comp,
        "momentum: sign(open→now)": np.sign(R.ret),
        "VWAP side": np.sign(R.sep),
        "momentum, ER ≥ H1 p70": np.where(R.er >= tr.er.quantile(.7), np.sign(R.ret), 0),
        "fade: −sign(open→now)": -np.sign(R.ret),
        "daily trend (close vs 20d)": R.trend_d,
    }
    L += ["## A. Direction to the close (accuracy on moves ≥ 0.1 %)", "",
          "| signal | all | H1 | H2 | n | by checkpoint (all) |", "|---|---|---|---|---|---|"]
    for name, s in sigs.items():
        s = pd.Series(np.asarray(s), index=R.index)
        a, n = acc(s, R.fwd)
        h = [acc(s[R.half == x], R.fwd[R.half == x])[0] for x in ("H1", "H2")]
        bym = " ".join(f"{m}:{acc(s[R.m == m], R.fwd[R.m == m])[0]:.0%}" for m in CPS)
        L.append(f"| {name} | {a:.1%} | {h[0]:.1%} | {h[1]:.1%} | {n:,} | {bym} |")
    up = (R.fwd[R.fwd.abs() >= FLAT] > 0).mean()
    L += ["", f"Base rate 'always bullish': {up:.1%}.", ""]

    # ---- B. state labels, thresholds from H1
    q = lambda col, x: float(tr[col].quantile(x))
    er_hi, chop_hi, rng_hi, rng_lo = q("er", .7), q("chop", .6), q("rng", .8), q("rng", .3)
    def state(r):
        if r.rng >= rng_hi and r.er < er_hi: return "volatile chop"
        if r.er >= er_hi: return "trend"
        if r.rng <= rng_lo: return "quiet / compression"
        return "range"
    R["state"] = R.apply(state, axis=1)
    R["cont"] = np.sign(R.fwd) == np.sign(R.ret)
    L += ["## B. State labels (thresholds = H1 quantiles: ER ≥ %.2f trend; range-so-far ≥ %.2f ATR & ER < trend → volatile; ≤ %.2f ATR quiet)" % (er_hi, rng_hi, rng_lo), "",
          "Rest-of-day range and worst drop are in units of the 20-day average daily range (ATR).", "",
          "| state | half | n | rest range | worst drop (median / p90) | ≥ 0.5 ATR drop | continues |", "|---|---|---|---|---|---|---|"]
    for st in ["trend", "range", "quiet / compression", "volatile chop"]:
        for h in ("H1", "H2"):
            x = R[(R.state == st) & (R.half == h)]
            if not len(x): continue
            L.append(f"| {st} | {h} | {len(x):,} | {x.rest_rng.median():.2f} | {x.rest_dd.median():.2f} / {x.rest_dd.quantile(.1):.2f} | "
                     f"{(x.rest_dd <= -.5).mean():.0%} | {x.cont[x.fwd.abs() >= FLAT].mean():.0%} |")

    # ---- C. what predicts rest-of-day risk (rank IC, by half)
    L += ["", "## C. Rank correlation with rest-of-day range / worst drop (Spearman, per half)", "",
          "| feature | range H1 | range H2 | drop H1 | drop H2 |", "|---|---|---|---|---|"]
    for f in ["rng", "er", "chop", "gap", "ret", "sep", "er10d", "ret5d"]:
        c = []
        for tgt in ("rest_rng", "rest_dd"):
            for h in ("H1", "H2"):
                x = R[R.half == h]
                c.append(x[f].abs().corr(x[tgt], method="spearman") if f in ("gap", "ret", "sep") else x[f].corr(x[tgt], method="spearman"))
        L.append(f"| {f}{' (abs)' if f in ('gap', 'ret', 'sep') else ''} | " + " | ".join(f"{v:+.2f}" for v in c) + " |")

    # ---- D. trend label direction: does a trend-state move continue?
    t = R[(R.state == "trend") & (R.fwd.abs() >= FLAT)]
    L += ["", "## D. Trend state, continuation by checkpoint", "", "| checkpoint | n | continues H1 | H2 |", "|---|---|---|---|"]
    for m in CPS:
        x = t[t.m == m]
        L.append(f"| {m} | {len(x)} | {x[x.half=='H1'].cont.mean():.0%} | {x[x.half=='H2'].cont.mean():.0%} |")

    # ---- E. rest-of-day risk score (the call the Live tab ships): fit H1, grade H2
    feats = ["rng_rel", "ret5d", "er", "chop"]
    med_r = tr.groupby("m").rng.median(); med_t = tr.groupby("m").rest_rng.median()
    R["rng_rel"] = R.rng / R.m.map(med_r)
    R["tgt"] = R.rest_rng / R.m.map(med_t)
    tr = R[R.half == "H1"]
    mu, sd = tr[feats].mean(), tr[feats].std()
    Z = (R[feats] - mu) / sd
    w = np.linalg.lstsq(np.c_[np.ones(len(tr)), Z[R.half == "H1"]], np.log(tr.tgt), rcond=None)[0]
    R["risk"] = np.c_[np.ones(len(R)), Z] @ w
    cuts = R[R.half == "H1"].risk.quantile([.2, .6, .8]).values
    levels = ["calm", "normal", "elevated", "stormy"]
    R["lvl"] = np.searchsorted(cuts, R.risk)
    L += ["", "## E. Rest-of-day risk score (log rest-range model on H1; levels = H1 p20 / p60 / p80)", "",
          "Weights (z-scored): " + ", ".join(f"{k} {v:+.3f}" for k, v in zip(feats, w[1:])) + f"; intercept {w[0]:+.3f}", "",
          "| level | half | n | rest range ÷ typical | P(drop ≥ 0.5 ATR) | P(drop ≥ 1 ATR) | worst-10 % drop |", "|---|---|---|---|---|---|---|"]
    stats = {}
    for i, lv in enumerate(levels):
        for h in ("H1", "H2"):
            x = R[(R.lvl == i) & (R.half == h)]
            L.append(f"| {lv} | {h} | {len(x):,} | {x.tgt.median():.2f} | {(x.rest_dd <= -.5).mean():.0%} | {(x.rest_dd <= -1).mean():.0%} | {x.rest_dd.quantile(.1):.2f} |")
        x = R[R.lvl == i]
        stats[lv] = {"pDropHalfAtr": round(float((x.rest_dd <= -.5).mean()), 3), "pDropOneAtr": round(float((x.rest_dd <= -1).mean()), 3),
                     "restRangeRel": round(float(x.tgt.median()), 2), "n": int(len(x))}
    x2 = R[R.half == "H2"]
    L += ["", "H2 by checkpoint, P(drop ≥ 0.5 ATR) calm vs stormy: " + ", ".join(
        f"{m}m {(g[g.lvl == 0].rest_dd <= -.5).mean():.0%}/{(g[g.lvl == 3].rest_dd <= -.5).mean():.0%}" for m, g in x2.groupby("m"))]
    model = {"study": "S126", "fitThrough": str(split), "features": feats, "mu": mu.round(5).to_dict(), "sd": sd.round(5).to_dict(),
             "weights": [round(float(v), 4) for v in w], "cuts": [round(float(c), 4) for c in cuts], "levels": levels,
             "rngMedianByMin": {int(k): round(float(v), 4) for k, v in med_r.items()}, "stats": stats}
    (OUT.parent / "S126_model.json").write_text(json.dumps(model, indent=1))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    R.to_csv(OUT.with_suffix(".csv"), index=False)
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
