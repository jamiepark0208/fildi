#!/usr/bin/env python3
"""S204 (signal-enhancements-2026-11-17 queue #6): is the IV÷RV put-selling edge (S003) shrinking?

S003 (17k reconstructed puts 2020-26): IV/RV is the main put edge (premium-kept IC t 4+). One pooled number hides decay.
Test: per calendar year, edge = (rich IV÷RV tercile) − (cheap tercile) put return per $ strike, same entry week.

PRE-REGISTERED (11-18, before the run)
Signal   : iv30_put (lseg_research.daily_history) ÷ RV60 (annualised stdev of 60 daily log closes), at each Wednesday close.
Cells    : tercile of IV÷RV across all names that Wednesday (rich = top, cheap = bottom). Names with iv30_put and 0.05 < iv < 3 only.
Trade    : sell 0.20Δ 30-calendar-day put at that close, BS at the name's own iv30_put (r = 0), exit = intrinsic 21 sessions later,
           return = (premium − intrinsic) ÷ strike, %. Model-priced (compares cells, not a live fill). Split-contaminated windows dropped.
Expected : edge > 0 every year (S003). Weekly unit = entry week; <30 weeks in a year → that year "can't answer at this n".
Shrinking: slope of weekly edge vs year (OLS, Newey-West lag 4 for the 21-session overlap) < 0 with t ≤ −2. Also yearly-OLS
           slope over the years with ≥ 30 weeks (reported; ≤ 7 points, low power). Else "not shrinking" (t > −2) — never "shrinking" on yearly means alone.
Data span: IV panel exists cross-sectionally only from 2020 (2009-17 have 3-4 names with iv30_put, 2018-19 ~4 names): pre-2020
           years can't form terciles → reported as "can't answer", not imputed. Universe grows 235 → 950 names: fixed-name control
           (names with iv30_put in every year 2020-26) is run too.
Check    : real quotes (optlab.lseg_opt_daily via S195 trade set, 2020-12 →): same-week mean r_bid by IV÷RV tercile, per year (n weeks shown).
Expected sign of the check: same as model. Reported, not gating.

    .venv/bin/python analysis/s204_ivrv_edge_by_year.py [preflight]
"""
from __future__ import annotations

import math, sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from quantcore.bs import bs_put, put_delta, years_from_days  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S204.md"
SPLITS = np.array([1/2, 1/3, 1/4, 1/5, 1/8, 1/10, 1/20, 2, 3, 4, 5, 8, 10, 20, 2/3, 3/2])
T30 = years_from_days(30)


def strike_for(S, v, dt=-0.20):
    lo, hi = S * 0.2, S
    for _ in range(50):
        m = (lo + hi) / 2
        (lo, hi) = (lo, m) if put_delta(spot=S, strike=m, iv=v, years=T30) < dt else (m, hi)
    return (lo + hi) / 2


def nw_slope(x, y, lag=4):
    """OLS slope of y on x with Newey-West SE → (slope, t)."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    X = np.c_[np.ones_like(x), x]
    b = np.linalg.lstsq(X, y, rcond=None)[0]
    e = y - X @ b
    xe = X * e[:, None]
    S = xe.T @ xe
    for l in range(1, lag + 1):
        G = xe[l:].T @ xe[:-l]
        S += (1 - l / (lag + 1)) * (G + G.T)
    XtXi = np.linalg.inv(X.T @ X)
    V = XtXi @ S @ XtXi
    return b[1], b[1] / math.sqrt(V[1, 1])


def tstat(s):
    s = pd.Series(s).dropna()
    return (s.mean(), s.mean() / (s.std(ddof=1) / math.sqrt(len(s))) if len(s) > 2 else float("nan"), len(s))


def main() -> int:
    c = connect()
    rows = c.execute("SELECT ticker, date, close::float8, iv30_put::float8 FROM lseg_research.daily_history "
                     "WHERE close > 0 AND date >= '2019-09-01' ORDER BY ticker, date").fetchall()
    pan = defaultdict(list)
    for t, d, cl, iv in rows:
        pan[t].append((d, cl, iv if iv and iv > 0 else None))
    tr = []
    for t, r in pan.items():
        if len(r) < 90:
            continue
        px = np.array([x[1] for x in r]); lr = np.diff(np.log(px)); jumps = px[1:] / px[:-1]
        for i in range(61, len(r) - 21):
            d = r[i][0]
            if d.year < 2020 or d.weekday() != 2 or r[i][2] is None:
                continue
            iv = r[i][2] / 100
            if not 0.05 < iv < 3:
                continue
            rv = lr[i - 60:i].std(ddof=1) * math.sqrt(252)
            if rv < 0.05:
                continue
            win = jumps[i - 60:i + 21]
            if np.any(np.min(np.abs(win[:, None] - SPLITS[None, :]) / SPLITS[None, :], axis=1) < 0.02):
                continue
            S = px[i]; K = strike_for(S, iv)
            ret = (bs_put(spot=S, strike=K, iv=iv, years=T30) - max(K - px[i + 21], 0)) / K * 100
            tr.append((t, d, d.year, iv / rv, ret))
    df = pd.DataFrame(tr, columns=["t", "d", "y", "ivrv", "r"])
    df["wk"] = pd.to_datetime(df.d).dt.to_period("W")
    df["terc"] = df.groupby("wk").ivrv.transform(lambda s: pd.qcut(s.rank(method="first"), 3, labels=False) if len(s) >= 30 else np.nan)
    df = df.dropna(subset=["terc"])
    L = [f"# S204 — is the IV÷RV put edge shrinking? (S003 per year)\n",
         f"Model-priced 0.20Δ 30d puts, weekly (Wed), n {len(df):,} trades · {df.t.nunique()} names · {df.wk.nunique()} weeks · {df.d.min()} → {df.d.max()}\n",
         "\n## Preflight: names with iv30_put by year (lseg_research.daily_history; pre-2020 → cross-section absent)\n"]
    pre = c.execute("SELECT extract(year from date)::int y, count(distinct ticker) FROM lseg_research.daily_history WHERE iv30_put IS NOT NULL "
                    "AND date < '2020-01-01' GROUP BY 1 ORDER BY 1").fetchall()
    L.append(" · ".join(f"{y}: {n} names" for y, n in pre) + "  → terciles impossible; those years: can't answer at this n.\n")
    L.append("\nWeeks (≥ 30 names) per year: " + " · ".join(f"{y}: {n}" for y, n in df.groupby("y").wk.nunique().items()) + "\n")
    if len(sys.argv) > 1 and sys.argv[1] == "preflight":
        print("".join(L)); return 0

    def weekly_edge(d):
        g = d.groupby(["wk", "terc"]).r.mean().unstack()
        return (g[2.0] - g[0.0]).dropna(), g

    def by_year(d, title):
        e, g = weekly_edge(d)
        L.append(f"\n## {title}\n")
        L.append("| year | weeks | rich r % | cheap r % | edge (rich−cheap) %/trade | t (weeks) | t (4-wk spaced) | note |\n|---|---|---|---|---|---|---|---|\n")
        yr = {}
        for y in sorted(set(w.year for w in e.index)):
            ey = e[[w.year == y for w in e.index]]; gy = g.loc[ey.index]
            m, t, n = tstat(ey); _, t4, _ = tstat(ey.iloc[::4])
            note = "" if n >= 30 else "can't answer at this n"
            L.append(f"| {y} | {n} | {gy[2.0].mean():+.2f} | {gy[0.0].mean():+.2f} | {m:+.2f} | {t:.2f} | {t4:.2f} | {note} |\n")
            if n >= 30:
                yr[y] = m
        yrs = e.index.map(lambda w: w.year + (w.start_time.dayofyear - 1) / 365.25).values
        sl, st = nw_slope(yrs, e.values)
        L.append(f"\nWeekly-edge slope vs time (Newey-West lag 4): {sl:+.3f} %/trade per year, t {st:.2f}, weeks {len(e)} · "
                 f"pooled edge {e.mean():+.2f}, t {tstat(e)[1]:.2f}\n")
        ys = np.array(list(yr)); ms = np.array(list(yr.values()))
        if len(ys) >= 4:
            b = np.polyfit(ys, ms, 1); res = ms - np.polyval(b, ys)
            se = math.sqrt(res.var(ddof=2) / ((ys - ys.mean()) ** 2).sum()) if len(ys) > 2 else float("nan")
            L.append(f"Yearly-OLS slope over {len(ys)} years: {b[0]:+.3f} per year, t {b[0] / se:.2f}\n")
        return sl, st

    sl, st = by_year(df, "All names (universe grows 235 → 950)")
    full = df.groupby("t").y.nunique()
    keep = full[full == full.max()].index
    by_year(df[df.t.isin(keep)].copy().assign(terc=lambda x: x.terc), f"Fixed-name control ({len(keep)} names present every year; terciles from full cross-section)")
    # tercile within fixed names only
    f = df[df.t.isin(keep)].copy()
    f["terc"] = f.groupby("wk").ivrv.transform(lambda s: pd.qcut(s.rank(method="first"), 3, labels=False) if len(s) >= 30 else np.nan)
    f = f.dropna(subset=["terc"])
    if f.wk.nunique() >= 30:
        by_year(f, "Fixed names, terciles re-cut within the fixed set")

    # real-quote check
    try:
        import s195_depth_universe as S195
        q, px = S195.load(c); off, bull, q20 = S195.series_feats(px)
        Tq = S195.trades(q, px, off, bull, q20)
        Tq["d"] = pd.to_datetime(Tq.d)
        m = df.assign(d=pd.to_datetime(df.d))[["t", "d", "ivrv"]]
        Tq = Tq.copy(); Tq["dw"] = Tq.d.dt.to_period("W"); m["dw"] = m.d.dt.to_period("W")
        J = Tq.merge(m[["t", "dw", "ivrv"]], on=["t", "dw"])
        J["terc"] = J.groupby("dw").ivrv.transform(lambda s: pd.qcut(s.rank(method="first"), 3, labels=False) if len(s) >= 9 else np.nan)
        J = J.dropna(subset=["terc"])
        L.append("\n## Check: real quotes (S195 trade set, 3-9 DTE, stress fill r_bid, same-week terciles of IV÷RV)\n")
        L.append("| year | weeks | rich | cheap | edge | t |\n|---|---|---|---|---|---|\n")
        g = J.groupby(["dw", "terc"]).r_bid.mean().unstack()
        e = (g[2.0] - g[0.0]).dropna()
        for y in sorted(set(w.year for w in e.index)):
            ey = e[[w.year == y for w in e.index]]; m_, t_, n_ = tstat(ey)
            L.append(f"| {y} | {n_} | {g.loc[ey.index][2.0].mean():+.3f} | {g.loc[ey.index][0.0].mean():+.3f} | {m_:+.3f} | {t_:.2f} |{'' if n_ >= 30 else ' can\'t answer at this n'}\n")
        L.append(f"\nPooled real-quote edge {e.mean():+.3f} %/wk, t {tstat(e)[1]:.2f}, weeks {len(e)}, trades {len(J):,}\n")
    except Exception as ex:  # noqa: BLE001
        L.append(f"\nReal-quote check skipped: {ex}\n")

    verdict = "SHRINKING" if (st <= -2 and sl < 0) else "NOT shrinking at this power"
    L.append(f"\n## Verdict (pre-registered bar: slope < 0 and t ≤ −2): **{verdict}** — slope {sl:+.3f}, t {st:.2f}. "
             "Pre-2020: can't answer (no cross-section of IV).\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(L)); print("".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
