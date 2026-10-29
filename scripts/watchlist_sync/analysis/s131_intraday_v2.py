"""S131 — Intraday direction, second try with new indicators (Jamie 10-28: "find new indicators, double check the test").

S126 graded checkpoint → close direction on SPY/QQQ with the Live composite + momentum/VWAP/ER: nothing beat the
base rate. New inputs here (none were in S126):
  breadth      share of 160+ watchlist stocks above their session open / above their own VWAP (optlab.breadth_5m),
               its level and its change over the last 30 min — the NYSE-TICK / A-D idea on our own universe
  dispersion   SPY return from open − mean stock return from open (narrow vs broad move)
  gap          open ÷ prior close − 1, and whether the gap has filled by the checkpoint (gap-fill literature)
  overnight    prior close → open sign vs open → now sign (overnight/intraday reversal, Lou–Polk–Skouras 2019)
  size spread  QQQ − IWM return from open (risk-on/off within the day)
  prior day    prior day return and close location in its range
  calendar     Monday / Friday, turn of month (last 1 + first 3 trading days)
Targets: direction to the close, next 30 min, next 60 min, and to the NEXT day's close (overnight put holders).
Grading: per-feature accuracy & rank IC by half (H1 < 2025-11-10 ≤ H2, day-clustered), logistic fit on H1 → AUC on H2.
Pass: AUC ≥ 0.55 on H2 or a single rule with ≥ 55 % accuracy, same sign both halves, |t| ≥ 2.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s130_daily_regime import auc_score, fit_logit  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S131.md"
CPS = [30, 60, 90, 120, 180, 240, 300]


def rth(c, tk):
    df = pd.read_sql("select ts, o, h, l, c, v from optlab.bars_5m where ticker=%s order by ts", c, params=(tk,))
    df["ts"] = pd.to_datetime(df.ts, utc=True).dt.tz_convert("America/New_York")
    m = df.ts.dt.hour * 60 + df.ts.dt.minute
    df = df[(m >= 570) & (m < 960)].copy()
    df["d"] = df.ts.dt.date; df["m"] = m[(m >= 570) & (m < 960)] - 570
    return df


def main() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as c:
        bars = {tk: rth(c, tk) for tk in ("SPY", "QQQ", "IWM")}
        br = pd.read_sql("select ts, d, n, up_open, above_vwap, mean_ret from optlab.breadth_5m", c)
    br["ts"] = pd.to_datetime(br.ts, utc=True).dt.tz_convert("America/New_York")
    br["m"] = br.ts.dt.hour * 60 + br.ts.dt.minute - 570
    br = br.set_index(["d", "m"]).sort_index()
    day = {tk: b.groupby("d").agg(o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"), n=("c", "size")) for tk, b in bars.items()}
    rows = []
    for tk in ("SPY", "QQQ"):
        B, Dd = bars[tk], day[tk]
        Dd = Dd[Dd.n >= 70]
        dates = list(Dd.index)
        g = dict(tuple(B.groupby("d")))
        gi = dict(tuple(bars["IWM"].groupby("d"))); gq = dict(tuple(bars["QQQ"].groupby("d")))
        for k in range(1, len(dates) - 1):
            d, pd_, nd = dates[k], dates[k - 1], dates[k + 1]
            x = g[d]; prev = Dd.loc[pd_]; o = x.o.iloc[0]
            for m in CPS:
                b = x[x.m < m]
                if len(b) < 4 or (d, m - 5) not in br.index: continue
                p = b.c.iloc[-1]
                bnow = br.loc[(d, m - 5)]
                b30 = br.loc[(d, m - 35)] if (d, m - 35) in br.index else bnow
                gap = o / prev.c - 1
                filled = (b.l.min() <= prev.c) if gap > 0 else (b.h.max() >= prev.c)
                ri = gi.get(d); rq = gq.get(d)
                iwm = ri[ri.m < m].c.iloc[-1] / ri.o.iloc[0] - 1 if ri is not None and (ri.m < m).any() else np.nan
                qqq = rq[rq.m < m].c.iloc[-1] / rq.o.iloc[0] - 1 if rq is not None and (rq.m < m).any() else np.nan
                after = x[x.m >= m]
                def at(mm):
                    s = x[x.m < mm]
                    return s.c.iloc[-1] if mm <= 385 and len(s) else np.nan
                pos_in_month = pd.Timestamp(d).day
                rows.append(dict(
                    tk=tk, d=d, m=m, ret=p / o - 1, gap=gap, gap_filled=int(filled),
                    overnight_vs_intraday=np.sign(gap) * np.sign(p / o - 1),
                    breadth=bnow.up_open - .5, breadth_vwap=bnow.above_vwap - .5, breadth_chg=bnow.up_open - b30.up_open,
                    dispersion=(p / o - 1) - bnow.mean_ret, size_spread=qqq - iwm,
                    prev_ret=prev.c / Dd.loc[dates[k - 2]].c - 1 if k >= 2 else np.nan,
                    prev_loc=(prev.c - prev.l) / (prev.h - prev.l) - .5 if prev.h > prev.l else 0,
                    monday=int(pd.Timestamp(d).weekday() == 0), friday=int(pd.Timestamp(d).weekday() == 4),
                    tom=int(pos_in_month <= 3 or pd.Timestamp(nd).month != pd.Timestamp(d).month),
                    fwd_close=x.c.iloc[-1] / p - 1, fwd30=at(m + 30) / p - 1, fwd60=at(m + 60) / p - 1,
                    fwd_next=Dd.loc[nd].c / p - 1,
                ))
    R = pd.DataFrame(rows)
    dates = sorted(R.d.unique()); split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    feats = ["ret", "gap", "gap_filled", "overnight_vs_intraday", "breadth", "breadth_vwap", "breadth_chg", "dispersion",
             "size_spread", "prev_ret", "prev_loc", "monday", "friday", "tom"]
    L = ["# S131 — Intraday direction with new indicators (breadth, gap, dispersion, size spread, calendar)", "",
         f"SPY+QQQ, {len(dates)} sessions {dates[0]} → {dates[-1]}, checkpoints {CPS}; H1 < {split} ≤ H2. Moves < 0.1 % excluded from accuracy.", ""]
    for tgt in ("fwd_close", "fwd30", "fwd60", "fwd_next"):
        x = R.dropna(subset=[tgt]); x = x[x[tgt].abs() >= .001]
        base = (x[tgt] > 0).mean()
        L += [f"## Target {tgt} (base rate up {100 * base:.1f} %)", "", "| feature | IC H1 | t | IC H2 | t | sign-rule acc H1 | H2 |", "|---|---|---|---|---|---|---|"]
        for f in feats:
            cells = []; accs = []
            for h in ("H1", "H2"):
                y = x[x.half == h].dropna(subset=[f])
                ics = pd.Series({dd: g[f].corr(g[tgt], method="spearman") for dd, g in y.groupby(y.d.astype(str).str[:7]) if g[f].nunique() > 1}).dropna()
                t = ics.mean() / (ics.std() / np.sqrt(len(ics))) if len(ics) > 2 else np.nan
                cells += [f"{ics.mean():+.3f}", f"{t:+.1f}"]
                s = np.sign(y[f] - (y[f].median() if y[f].nunique() > 3 else 0.5 if set(y[f].unique()) <= {0, 1} else 0))
                k = s != 0
                accs.append(f"{100 * (np.sign(y[tgt][k]) == s[k]).mean():.1f}")
            L.append(f"| {f} | " + " | ".join(cells) + f" | {accs[0]} | {accs[1]} |")
        tr, te = x[x.half == "H1"].dropna(subset=feats), x[x.half == "H2"].dropna(subset=feats)
        mu, sd = tr[feats].mean(), tr[feats].std().replace(0, 1)
        w = fit_logit(((tr[feats] - mu) / sd).values, (tr[tgt] > 0).astype(float).values, l2=5.0)
        p = 1 / (1 + np.exp(-(np.c_[np.ones(len(te)), ((te[feats] - mu) / sd).values] @ w)))
        yb = (te[tgt] > 0).astype(float).values
        conf = np.abs(p - .5) >= np.quantile(np.abs(p - .5), .8)
        # day-clustered check of the confident subset: one vote per day (rows within a day are not independent)
        cd = te[conf].assign(hit=((p[conf] > .5) == yb[conf]).astype(float)).groupby("d").hit.mean()
        day_acc, day_n = float(cd.mean()), len(cd)
        day_t = (day_acc - .5) / (cd.std() / np.sqrt(day_n)) if day_n > 2 else np.nan
        L += ["", f"Logistic (all features, fit H1) → H2 AUC **{auc_score(yb, p):.3f}**, accuracy {100 * ((p > .5) == yb).mean():.1f} % "
              f"(always-up {100 * yb.mean():.1f} %); most-confident 20 %: accuracy {100 * ((p[conf] > .5) == yb[conf]).mean():.1f} % (n {conf.sum()} rows / {day_n} days; per-day mean {100 * day_acc:.1f} %, t {day_t:+.1f})",
              "Weights: " + ", ".join(f"{k} {v:+.2f}" for k, v in sorted(zip(feats, w[1:]), key=lambda z: -abs(z[1]))[:6]), ""]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
