#!/usr/bin/env python3
"""S194 (A410 part 7, Jamie 11-17: "differentiate between good and bad trades that i did").
Grades each of Jamie's short-put opens, then asks which entry traits separate good from bad trades.

Grade (held to expiry, from rec_scoreboard.grade):
  clean = kept the premium and the stock never traded below the strike
  risky = kept money but the strike was touched (won, took the risk anyway)
  loss  = lost money at expiry
  bad   = risky or loss  (the label the model predicts)
Luck control: every trait is compared WITHIN the same entry week (week-demeaned), so a week where everything
rose can't make a trait look good. Week-clustered t.
Traits (prior close, no look-ahead): jamie_traits.feats + implied vol of his fill, IV÷RV20, earnings before expiry,
QQQ 20 d return.
Held-out: fit on trades entered before CUT, score after. Comparator = the live Journal odds model (strike depth +
off 60 d high). New traits ship only if they beat it on the held-out AUC.
"""
from __future__ import annotations
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE.parents[1]))
import rec_scoreboard as RS  # noqa: E402
from jamie_traits import load  # noqa: E402
from quantcore.bs import implied_vol  # noqa: E402

CUT = pd.Timestamp("2026-04-01")


def auc(y, p):
    y, p = np.asarray(y), np.asarray(p)
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return np.nan
    r = pd.Series(np.r_[pos, neg]).rank().values
    return (r[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def logit_fit(X, y, l2=1.0, it=300):
    X = np.c_[np.ones(len(X)), X]; w = np.zeros(X.shape[1])
    for _ in range(it):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + l2 * np.r_[0, w[1:]]
        H = X.T @ (X * (p * (1 - p))[:, None]) + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        w -= np.linalg.solve(H, g)
    return w


def predict(w, X):
    return 1 / (1 + np.exp(-(np.c_[np.ones(len(X)), X] @ w)))


def main() -> None:
    c = RS.L.connect()
    J = load(c)
    J = J[J.ret.notna() & J.otm.notna()].copy()
    J["grade"] = np.where(J.ret < 0, "loss", np.where(J.touched > 0, "risky", "clean"))
    J["bad"] = (J.grade != "clean").astype(float)
    J["wk"] = J.d.dt.to_period("W")
    yrs = (J.e - J.d).dt.days.clip(lower=1) / 365
    J["iv"] = [implied_vol(price=p, spot=s, strike=k, years=y) for p, s, k, y in zip(J.px, J.S, J.k, yrs)]
    J["iv"] = pd.to_numeric(J["iv"], errors="coerce") * 100
    J["iv_rv"] = J.iv / J.rv20
    er = RS.q(c, "SELECT ticker t, report_date r FROM public.earnings_calendar WHERE ticker = ANY(%s)", (sorted(J.t.unique()),))
    er["r"] = pd.to_datetime(er["r"])
    E = {t: g.r.values for t, g in er.groupby("t")}
    J["earn"] = [float(any((x > np.datetime64(d)) & (x <= np.datetime64(e)) for x in E.get(t, []))) for t, d, e in zip(J.t, J.d, J.e)]
    qq = RS.q(c, "SELECT date, close::float c FROM prices_historical WHERE ticker = 'QQQ' ORDER BY date")
    qq = qq.set_index(pd.to_datetime(qq.date)).c
    q20 = (qq / qq.shift(20) - 1) * 100
    J["qqq20"] = [q20[q20.index < d].iloc[-1] for d in J.d]

    n_wk = J.wk.nunique()
    print(f"S194 — Jamie's put sales graded: n {len(J)} · {J.t.nunique()} names · {n_wk} entry weeks (independent unit) · "
          f"{J.d.min():%Y-%m-%d} → {J.d.max():%Y-%m-%d}")
    for gname, g in J.groupby("grade"):
        print(f"  {gname:5s} n {len(g):4d} ({len(g)/len(J):.0%}) · avg {g.ret.mean():+.2f} % of strike · sum {g.ret.sum():+.0f}")

    traits = ["otm", "otm_sd", "off_hi", "off_lo", "r5", "r20", "rv20", "iv", "iv_rv", "yld", "dte", "earn", "qqq20"]
    print("\n== trait: clean vs bad (median), and within-week effect on P(bad) per +1 SD (week-clustered t) ==")
    rows = []
    for f in traits:
        x = J[f]; ok = x.notna()
        xd = x - J.groupby("wk")[f].transform("mean")       # within-week
        z = (xd / xd[ok].std())
        yd = J.bad - J.groupby("wk").bad.transform("mean")
        # per-week slope contribution → clustered t
        prod = (z * yd)[ok].groupby(J.wk[ok]).sum() / (z[ok] ** 2).sum()
        beta = prod.sum(); se = prod.std() * np.sqrt(len(prod))
        rows.append(dict(trait=f, clean_med=J.loc[J.bad == 0, f].median(), bad_med=J.loc[J.bad == 1, f].median(),
                         dP_bad_per_sd=beta * 100, t=beta / se if se > 0 else np.nan, n=int(ok.sum())))
    print(pd.DataFrame(rows).round(2).to_string(index=False))

    tr, te = J[J.d < CUT].copy(), J[J.d >= CUT].copy()
    print(f"\n== held-out: train < {CUT:%Y-%m-%d} n {len(tr)} ({tr.wk.nunique()} wk, bad {tr.bad.mean():.0%}) · "
          f"test n {len(te)} ({te.wk.nunique()} wk, bad {te.bad.mean():.0%}) ==")
    sets = {"journal (otm, off_hi)": ["otm", "off_hi"],
            "+ iv_rv, earn": ["otm", "off_hi", "iv_rv", "earn"],
            "+ otm_sd, r5, rv20": ["otm", "off_hi", "otm_sd", "r5", "rv20"],
            "all traits": [t for t in traits if t != "qqq20"]}
    for name, cols in sets.items():
        a, b = tr.dropna(subset=cols), te.dropna(subset=cols)
        mu, sd = a[cols].mean(), a[cols].std()
        w = logit_fit(((a[cols] - mu) / sd).values, a.bad.values)
        p = predict(w, ((b[cols] - mu) / sd).values)
        b = b.assign(p=p)
        q = pd.qcut(b.p, 3, labels=["low", "mid", "high"])
        by = b.groupby(q, observed=True).agg(n=("bad", "size"), bad=("bad", "mean"), ret=("ret", "mean"))
        print(f"  {name:24s} test AUC {auc(b.bad, b.p):.3f} · P(bad) terciles: " +
              " · ".join(f"{k} n {r.n} bad {r.bad:.0%} ret {r.ret:+.2f}" for k, r in by.iterrows()))
    out = HERE.parent / "out" / "studies"; out.mkdir(parents=True, exist_ok=True)
    J.drop(columns=["wk"]).to_csv(out / "S194-graded-trades.csv", index=False)


if __name__ == "__main__":
    main()
