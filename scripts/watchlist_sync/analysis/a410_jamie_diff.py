#!/usr/bin/env python3
"""A410 part 3 — learn from Jamie's put sales: how do his picks differ from the engine's, and which traits of his
own trades predicted his wins? Output = candidate rules to pre-register (never his trades as a rule directly).

Labels: every filled short-put open in portfolio_orders (DISTINCT order_id), graded hold-to-expiry by
rec_scoreboard.grade (one grading home). Features use the PRIOR close (no same-day look-ahead):
otm % = 1 − K/S, otm_sd = otm ÷ (RV20·√(DTE/365)) (moneyness in vol units ≈ delta proxy), DTE, r5/r20, off the
20 d low, RV20, premium yield (px/K), weekday. Splits = terciles of each feature, week-clustered t on the
top-vs-bottom tercile gap (one week = one episode).
Engine side: put_recs_daily PASS rows (from 10-26) with the same features → where the two pick differently.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE.parent))
import rec_scoreboard as RS  # noqa: E402


def feats(df: pd.DataFrame, P: dict) -> pd.DataFrame:
    rows = []
    for r in df.itertuples():
        g = P.get(r.t)
        h = None if g is None else g[g.index < r.d].tail(260)
        if h is None or len(h) < 25:
            rows.append({}); continue
        s = h["c"].iloc[-1]
        lr = np.log(h["c"]).diff().dropna()
        rv = lr.tail(20).std() * np.sqrt(252)
        dte = max((r.e - r.d).days, 1)
        otm = 1 - r.k / s
        rows.append(dict(S=s, otm=otm * 100, dte=dte, rv20=rv * 100,
                         otm_sd=otm / (rv * np.sqrt(dte / 365)) if rv > 0 else np.nan,
                         r5=(s / h["c"].iloc[-6] - 1) * 100, r20=(s / h["c"].iloc[-21] - 1) * 100,
                         off_lo=(s / h["lo"].tail(20).min() - 1) * 100,
                         off_hi=(s / h["c"].tail(60).max() - 1) * 100,
                         yld=r.px / r.k * 100, wd=r.d.dayofweek))
    return pd.concat([df.reset_index(drop=True), pd.DataFrame(rows)], axis=1)


def wk_t(a: pd.DataFrame, b: pd.DataFrame) -> tuple[float, int]:
    w = lambda x: x["d"].dt.to_period("W")  # noqa: E731
    gw = (a.groupby(w(a)).ret.mean() - b.groupby(w(b)).ret.mean()).dropna()
    k = len(gw)
    if k < 3 or gw.std(ddof=1) == 0:
        return float("nan"), k
    return gw.mean() / (gw.std(ddof=1) / np.sqrt(k)), k


def main() -> None:
    c = RS.L.connect()
    jam = RS.q(c, """SELECT DISTINCT ON (order_id) created_at::date d, account a, symbol t, option_strike::float k,
                     option_expiration e, avg_fill_price::float px, quantity::float qn
                     FROM portfolio_orders WHERE state = 'filled' AND is_option AND option_side = 'put'
                     AND side = 'credit' AND leg_effect = 'open' ORDER BY order_id, created_at""")
    eng = RS.q(c, """SELECT as_of d, ticker t, (payload->>'strike')::float k, (payload->>'expiry')::date e,
                     (payload->>'bid')::float bid, (payload->>'ask')::float ask, (payload->>'spot')::float spot,
                     abs((payload->>'delta')::float) delta, payload->>'sector' sector
                     FROM watchlist_sync.put_recs_daily WHERE pass""")
    eng["px"] = eng["bid"] + 0.1 * (eng["ask"] - eng["bid"])
    names = sorted(set(jam.t) | set(eng.t) | {"QQQ"})
    px = RS.q(c, "SELECT ticker t, date, close::float c, low::float lo FROM prices_historical WHERE date >= '2025-01-01' AND ticker = ANY(%s)", (names,))
    px["date"] = pd.to_datetime(px["date"])
    last = px["date"].max()
    P = {t: g.set_index("date").sort_index() for t, g in px.groupby("t")}
    qq = P["QQQ"]["c"]
    r20 = qq / qq.shift(20) - 1
    J = feats(RS.grade(jam, P, last, r20), P)
    E = feats(RS.grade(eng, P, last, r20), P)
    Jg, Eg = J.dropna(subset=["ret", "otm"]), E.dropna(subset=["ret", "otm"])

    print(f"A410 part 3 — Jamie put sales vs engine (prices to {last:%Y-%m-%d})")
    print(f"Jamie: {len(J)} opens, graded {len(Jg)} ({Jg.t.nunique()} names, {Jg.d.dt.to_period('W').nunique()} weeks) · "
          f"{Jg.ret.mean():+.2f} % of strike · win {(Jg.ret > 0).mean():.0%} · touched {Jg.touched.mean():.0%} · worst {Jg.ret.min():+.1f}")
    print(f"  by account: " + " · ".join(f"{a} n {len(g)} {g.ret.mean():+.2f} % win {(g.ret > 0).mean():.0%}" for a, g in Jg.groupby("a")))
    print(f"  by regime: " + " · ".join(f"{k} n {len(g)} {g.ret.mean():+.2f} % win {(g.ret > 0).mean():.0%}" for k, g in Jg.groupby("reg")))
    print(f"Engine PASS: graded {len(Eg)} ({Eg.t.nunique()} names) · {Eg.ret.mean():+.2f} % · win {(Eg.ret > 0).mean():.0%}")

    cols = ["otm", "otm_sd", "dte", "rv20", "r5", "r20", "off_lo", "off_hi", "yld"]
    print("\nPROFILE (median) — Jamie all-time | Jamie from 10-26 | engine PASS")
    j26 = J[J.d >= E.d.min()]
    for col in cols:
        print(f"  {col:7s} {J[col].median():7.2f} | {j26[col].median():7.2f} | {E[col].median():7.2f}")
    top = Jg.groupby("t").agg(n=("ret", "size"), m=("ret", "mean")).sort_values("n", ascending=False).head(10)
    print("  Jamie top names: " + " · ".join(f"{t} {r.n} ({r.m:+.2f})" for t, r in top.iterrows()))
    print(f"  overlap names Jamie∩engine: {sorted(set(J.t) & set(E.t))}")

    print("\nWHAT PREDICTED JAMIE'S RESULTS (terciles; gap = top − bottom tercile, week-clustered t)")
    cands = []
    for col in cols + ["wd"]:
        x = Jg.dropna(subset=[col])
        if col == "wd":
            parts = [(f"wd{int(v)}", g) for v, g in x.groupby("wd")]
        else:
            qs = pd.qcut(x[col].rank(method="first"), 3, labels=["lo", "mid", "hi"])
            parts = [(f"{lab} ≤{x[col][qs == lab].max():.1f}", x[qs == lab]) for lab in ["lo", "mid", "hi"]]
        s = " · ".join(f"{lab} n {len(g)} {g.ret.mean():+.2f}/{(g.ret > 0).mean():.0%}" for lab, g in parts)
        if col != "wd":
            t, k = wk_t(parts[2][1], parts[0][1])
            gap = parts[2][1].ret.mean() - parts[0][1].ret.mean()
            s += f"  | gap {gap:+.2f} t {t:+.1f} ({k} wk)"
            if abs(t) >= 2:
                cands.append((col, gap, t, k))
        print(f"  {col:7s} {s}")

    print("\nENGINE ON THE SAME TRAITS (live, few weeks — direction only)")
    for col, gap, t, k in cands:
        x = Eg.dropna(subset=[col])
        if len(x) < 30:
            continue
        cut = Jg[col].quantile([1 / 3, 2 / 3]).values
        lo, hi = x[x[col] <= cut[0]], x[x[col] > cut[1]]
        print(f"  {col}: engine below Jamie's 1/3 cut ({cut[0]:.1f}) n {len(lo)} {lo.ret.mean():+.2f} · above 2/3 cut ({cut[1]:.1f}) n {len(hi)} {hi.ret.mean():+.2f}"
              f"  (Jamie gap {gap:+.2f}, t {t:+.1f}, {k} wk)")
    out = HERE / "analysis" / "out"
    out.mkdir(exist_ok=True)
    J.to_csv(out / "a410_jamie_trades.csv", index=False)
    print(f"\nrows → {out / 'a410_jamie_trades.csv'}")


if __name__ == "__main__":
    main()
