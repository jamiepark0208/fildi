#!/usr/bin/env python3
"""S185c (A390 amendment 2026-11-18) — does a name's put skew vs its OWN history time short puts?

Pre-registered in research/common/asks/A390.md before the 62-name data existed. Card claim (Today › Risk reversals,
'skew rank own'): puts rich vs own past → better to sell. Competing: Xing–Zhang–Zhao (steep smirk → stock lags).
  Trade   short put |Δ| nearest 0.20 on the skew_daily ~30-DTE expiry, weekly first session, mid × HAIRCUT, to expiry.
  Feature z over the name's prior 40 skew days (≥ 20) of smirk (P25 − ATM) and putrich (−rr25 = P25 − C25).
  Bucket  high z ≥ +0.84 vs rest.   Regime QQQ 20-session return at entry (up ≥ 0 / down < 0).
  Stat    weekly mean(high) − mean(rest) inside regime; t on every 4th week; raw and ivrv-neutral (within-week rank).
  PASS    |t| ≥ 2 and same sign in both episodes (split 2026-05-01). < 30 high trades or < 8 sampled weeks → can't answer.
  cd scripts/watchlist_sync && .venv/bin/python analysis/s185c_own_skew_puts.py
"""
from __future__ import annotations

import math
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from s185_skew_test import load, L  # noqa: E402

SPLIT = pd.Timestamp("2026-05-01")
OUT = HERE.parent / "out/opt/S185c.md"
Z_HI, LOOK, MIN_HIST = 0.84, 40, 20


def tstat(x) -> float:
    x = pd.Series(x).dropna()
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))) if len(x) > 2 and x.std() > 0 else float("nan")


def trades(conn, haircut: float) -> pd.DataFrame:
    sk, g, px = load(conn)
    sk = sk.sort_values(["t", "d"]).copy()
    sk["putrich"] = -sk["rr25"]
    for col in ("smirk", "putrich"):
        grp = sk.groupby("t")[col]
        m = grp.transform(lambda s: s.shift(1).rolling(LOOK, min_periods=MIN_HIST).mean())
        sd = grp.transform(lambda s: s.shift(1).rolling(LOOK, min_periods=MIN_HIST).std())
        sk[f"z_{col}"] = (sk[col] - m) / sd
    px = px.sort_values(["t", "d"])
    px["rv20"] = px.groupby("t")["c"].transform(lambda s: np.log(s).diff().rolling(20).std() * math.sqrt(252))
    close = {(t, d): c for t, d, c in px[["t", "d", "c"]].itertuples(index=False)}
    rv = {(t, d): v for t, d, v in px[["t", "d", "rv20"]].itertuples(index=False)}
    q = pd.DataFrame(conn.execute("""SELECT date, close FROM lseg_research.daily_history WHERE ticker = 'QQQ'
                                     AND date >= '2025-06-01' AND close > 0 ORDER BY date""").fetchall(), columns=["d", "c"])
    q = q.assign(d=pd.to_datetime(q["d"])).set_index("d")["c"].astype(float)
    qqq20 = (q / q.shift(20) - 1).to_dict()
    last_px = px["d"].max()
    sk["wk"] = sk["d"].dt.to_period("W-SUN")
    ent = sk.groupby(["t", "wk"]).head(1)
    ent = ent[(ent["e"] <= last_px) & ~ent["t"].isin(["SPY", "QQQ"])]
    gi = g.set_index(["t", "d", "e"]).sort_index()

    def settle(t, e):
        for k in range(4):
            c = close.get((t, e - pd.Timedelta(days=k)))
            if c:
                return c
        return None

    rows = []
    for r in ent.itertuples(index=False):
        try:
            ch = gi.loc[(r.t, r.d, r.e)]
        except KeyError:
            continue
        if isinstance(ch, pd.Series):
            ch = ch.to_frame().T
        st = settle(r.t, r.e)
        p = ch[(ch["side"] == "put") & ch["delta"].abs().between(0.10, 0.32)]
        if st is None or not len(p) or r.d not in qqq20 or pd.isna(qqq20[r.d]):
            continue
        k = p.iloc[(p["delta"].abs() - 0.20).abs().argmin()]
        rows.append({"t": r.t, "d": r.d, "z_smirk": r.z_smirk, "z_putrich": r.z_putrich,
                     "ivrv": (r.iv_atm / rv[(r.t, r.d)]) if rv.get((r.t, r.d)) else np.nan,
                     "put": (k["px"] * haircut - max(k["k"] - st, 0.0)) / k["k"],
                     "regime": "up" if qqq20[r.d] >= 0 else "down"})
    T = pd.DataFrame(rows)
    T["o"] = T["d"].dt.to_period("W-SUN")
    T["ep"] = np.where(T["d"] < SPLIT, "E1", "E2")
    # ivrv-neutral return: residual of put ret on within-week ivrv rank
    def resid(w):
        w = w.dropna(subset=["ivrv"])
        if len(w) < 5:
            return pd.Series(np.nan, index=w.index)
        z = w["ivrv"].rank()
        return w["put"] - np.polyval(np.polyfit(z, w["put"], 1), z)
    T["put_n"] = T.groupby("o", group_keys=False).apply(resid)
    return T


def cell(T: pd.DataFrame, feat: str, reg: str, y: str):
    w = T[(T["regime"] == reg)].dropna(subset=[feat, y]).copy()
    w["hi"] = w[feat] >= Z_HI
    pv = w.pivot_table(index="o", columns="hi", values=y, aggfunc="mean")
    wk = (pv[True] - pv[False]).dropna().astype(float) if {True, False} <= set(pv.columns) else pd.Series(dtype=float)
    samp = wk.iloc[::4]
    e1 = np.array([o.start_time < SPLIT for o in wk.index], dtype=bool)
    eps = {"E1": wk[e1].mean() if e1.any() else np.nan, "E2": wk[~e1].mean() if (~e1).any() else np.nan}
    return {"n_hi": int(w["hi"].sum()), "n": len(w), "weeks": len(wk), "samp": len(samp), "diff": wk.mean(), "t": tstat(samp),
            "E1": eps["E1"], "E2": eps["E2"], "hi_mean": w.loc[w["hi"], y].mean(), "rest_mean": w.loc[~w["hi"], y].mean()}


def main() -> None:
    conn = L.connect()
    lines = ["# S185c — own-history put skew × short puts, inside regime (A390 amendment 11-18)", ""]
    verdict = []
    for hc in (0.95, 0.98):
        T = trades(conn, hc)
        if hc == 0.95:
            lines += [f"Run {date.today()} · {T['t'].nunique()} names · {T['o'].nunique()} weeks · {len(T)} short puts "
                      f"({T['d'].min().date()} → {T['d'].max().date()}) · up {int((T['regime']=='up').sum())} / down {int((T['regime']=='down').sum())}", ""]
        lines += [f"## Fill = mid × {hc}", "", "| feature | regime | ret | high n / all | weeks (sampled) | high − rest /wk | t | E1 | E2 | high mean | rest mean | verdict |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for feat in ("z_putrich", "z_smirk"):
            for reg in ("down", "up"):
                for y in ("put", "put_n"):
                    c = cell(T, feat, reg, y)
                    if c["n_hi"] < 30 or c["samp"] < 8:
                        v = f"can't answer (high n {c['n_hi']}, {c['samp']} sampled wks; need ≥ 30 / ≥ 8)"
                    else:
                        ok = abs(c["t"]) >= 2 and np.sign(c["E1"]) == np.sign(c["E2"]) == np.sign(c["diff"])
                        v = ("PASS " + ("H1 rich→better" if c["diff"] > 0 else "H2 rich→worse")) if ok else "fail"
                    if hc == 0.95 and v.startswith("PASS"):
                        verdict.append(f"{feat} {reg} {y} {v}")
                    lines.append(f"| {feat[2:]} | {reg} | {'ivrv-neutral' if y == 'put_n' else 'raw'} | {c['n_hi']} / {c['n']} | {c['weeks']} ({c['samp']}) | "
                                 f"{100*c['diff']:+.2f} % | {c['t']:+.2f} | {100*c['E1']:+.2f} | {100*c['E2']:+.2f} | "
                                 f"{100*c['hi_mean']:+.2f} % | {100*c['rest_mean']:+.2f} % | {v} |")
        lines.append("")
    lines += ["Returns = per $ strike, per ~30-day hold. E1 = before 2026-05-01, E2 = after.", "",
              f"Verdict: RULE weekly 0.20Δ ~30-DTE short put × own-history skew z ≥ +0.84 inside QQQ-20d regime — "
              f"{'PASS: ' + '; '.join(verdict) if verdict else 'no cell passes at mid × 0.95'}."]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
