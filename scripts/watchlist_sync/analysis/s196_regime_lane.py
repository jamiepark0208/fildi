#!/usr/bin/env python3
"""S196 (A410, Jamie 11-17 'yes' on S195's next): two engine changes on REAL LSEG put quotes, same weeks.

  E    engine proxy: per name-week the put an engine would sell — |Δ| 0.06–0.20 (live top-10 10–90 % = 0.07–0.17),
       bid ≥ 0.3 %/wk (rules.MIN_WEEKLY_INCOME_PCT), IV ÷ RV20 ≥ 1.15 (sell_put gate); per name the strike with the best
       ev_rv_cap = (bid − BS put at RV20) ÷ strike per week (put_recs rank); top-10 names per week by ev_rv_cap.
       Not modelled: band_engine state bands, put-edge Q gate, earnings push-out, OI/volume (LSEG EOD has none).
  E-   same, 6–10 % OTM strikes removed before picking (refill from the name's other strikes / the next names).
  G    regime-gated rich lane: SPY < 200 d SMA → S109 lane (bid ≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off 252 d high),
       top-10 by income + OTM percentile (put_recs.rich_pick confidence); SPY ≥ 200 d → E.
Trade = S195's: first quote 3–9 days before expiry, held to expiry, fill bid + 23 % spread, stress = bid, r = % of strike/wk.

PRE-REGISTERED (11-17, before the run)
Regime = SPY vs 200 d SMA at entry (rule 12). Unit = entry week (each week = mean of its ≤ 10 picks).
Expected: bear: G − E > 0 (S195 beaten-names +0.63 t 2.4; S109 lane +101 bp); E- − E ≥ 0 both regimes (6–10 % worst cell
both, t −2.1/−2.2). Pass (ship) = paired week diff > 0 at the STRESS fill, t ≥ 2, ≥ 30 weeks in the cell, and worst-5 % week
not worse by > 0.5 pt. Fewer than 30 weeks with both portfolios filled → "can't answer at this n".

    .venv/bin/python analysis/s196_regime_lane.py [preflight]
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s195_depth_universe as S195  # noqa: E402
from quantcore.bs import bs_put  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S196.md"
TOP = 10


def feats(px):
    rv, hi = {}, {}
    for t, p in px.items():
        ds = sorted(p); c = pd.Series([p[d][0] for d in ds], index=ds)
        rv[t] = (np.log(c).diff().rolling(20).std() * math.sqrt(252)).to_dict()
        hi[t] = (c / c.rolling(252, min_periods=120).max() - 1).to_dict()
    return rv, hi


def pick_engine(g: pd.DataFrame, drop_mid: bool) -> pd.DataFrame:
    x = g[(g.dl >= 0.06) & (g.dl <= 0.20) & (g.inc >= 0.3) & (g.ivrv >= 1.15) & g.ev.notna()]
    if drop_mid:
        x = x[(x.otm < 6) | (x.otm >= 10)]
    best = x.sort_values("ev", ascending=False).groupby("t").head(1)
    return best.head(TOP)


def pick_rich(g: pd.DataFrame) -> pd.DataFrame:
    x = g[(g.inc >= 0.9) & (g.otm >= 10) & (g.off52 <= -0.25)].copy()
    if x.empty:
        return x
    x["conf"] = x.inc.rank(pct=True) + x.otm.rank(pct=True)
    best = x.sort_values("conf", ascending=False).groupby("t").head(1)
    return best.head(TOP)


def paired(a: pd.Series, b: pd.Series):
    d = (a - b).dropna()
    t = d.mean() / (d.std() / math.sqrt(len(d))) if len(d) > 2 and d.std() > 0 else np.nan
    return d.mean(), t, len(d)


def main() -> int:
    c = connect()
    q, px = S195.load(c)
    off, bull, q20 = S195.series_feats(px)
    T = S195.trades(q, px, off, bull, q20)
    rv, hi = feats(px)
    T["rv20"] = [rv[t].get(d) for t, d in zip(T.t, T.d)]
    T["off52"] = [hi[t].get(d) for t, d in zip(T.t, T.d)]
    T["ivrv"] = T.iv / T.rv20
    T["inc"] = T.bid_wk   # bid ÷ strike, %/wk
    T["ev"] = [((b - float(bs_put(spot=S, strike=K, iv=v, years=dy / 365))) / K * 7 / dy * 100) if v and v > 0 and not math.isnan(v) else np.nan
               for b, S, K, v, dy in zip(T.bid, T.S, T.K, T.rv20, T.dte)]

    L = [f"# S196 — regime-gated rich lane + drop 6–10 % OTM vs engine proxy (A410)\n",
         f"universe {len(T):,} put trades · {T.t.nunique()} names · {T.wk.nunique()} weeks · {T.d.min()} → {T.d.max()}\n"]
    rows, picks = [], []
    for wk, g in T.groupby("wk"):
        reg = g.reg.mode().iat[0]
        E, Em, R_ = pick_engine(g, False), pick_engine(g, True), pick_rich(g)
        picks.append(E)
        G = R_ if reg == "bear" else E
        rec = dict(wk=wk, reg=reg)
        for k, s in [("E", E), ("Em", Em), ("R", R_), ("G", G)]:
            rec[f"{k}_n"] = len(s)
            rec[f"{k}_rb"] = s.r_bid.mean() if len(s) else np.nan
            rec[f"{k}_r"] = s.r.mean() if len(s) else np.nan
            rec[f"{k}_loss"] = s.loss.mean() if len(s) else np.nan
            rec[f"{k}_mid"] = ((s.otm >= 6) & (s.otm < 10)).mean() if len(s) else np.nan
        rows.append(rec)
    W = pd.DataFrame(rows)

    L.append("\n## Preflight: weeks with picks per regime\n")
    for reg, w in W.groupby("reg"):
        L.append(f"- {reg}: weeks {len(w)} · E filled {w.E_rb.notna().sum()} (avg n {w.E_n.mean():.1f}, 6–10 % share "
                 f"{w.E_mid.mean():.0%}) · E- {w.Em_rb.notna().sum()} · rich {w.R_rb.notna().sum()} (avg n {w.R_n.mean():.1f})\n")
    if len(sys.argv) > 1 and sys.argv[1] == "preflight":
        print("".join(L)); return 0

    L.append("\n## Portfolios, week-averaged (%/wk of strike) — fill · stress · loss rate · worst-5 % week (stress)\n")
    L.append("| regime | book | weeks | fill | stress | loss | worst-5 % | mean/sd |\n|---|---|---|---|---|---|---|---|\n")
    for reg, w in W.groupby("reg"):
        for k, name in [("E", "engine proxy"), ("Em", "engine − 6–10 %"), ("R", "rich lane"), ("G", "gated (rich in bear)")]:
            s = w[f"{k}_rb"].dropna()
            if s.empty:
                continue
            L.append(f"| {reg} | {name} | {len(s)} | {w[f'{k}_r'].mean():+.3f} | {s.mean():+.3f} | {w[f'{k}_loss'].mean():.0%} | "
                     f"{s.quantile(0.05):+.2f} | {s.mean() / s.std():.2f} |\n")
    L.append("\n## Paired week differences (stress fill)\n")
    for reg, w in W.groupby("reg"):
        for a, b, lbl in [("Em", "E", "E- − E (drop 6–10 %)"), ("R", "E", "rich − E")]:
            m, t, n = paired(w[f"{a}_rb"], w[f"{b}_rb"])
            both = w[[f"{a}_rb", f"{b}_rb"]].dropna()
            dw5 = both[f"{a}_rb"].quantile(0.05) - both[f"{b}_rb"].quantile(0.05) if len(both) else np.nan
            verdict = "can't answer at this n" if n < 30 else ("PASS" if m > 0 and t >= 2 and dw5 > -0.5 else "no lift")
            L.append(f"- {reg} · {lbl}: {m:+.3f} %/wk, t {t:.2f}, weeks {n}, Δ worst-5 % {dw5:+.2f} → {verdict}\n")
    m, t, n = paired(W.G_rb, W.E_rb)
    L.append(f"- all weeks · G − E: {m:+.3f} %/wk, t {t:.2f}, weeks {n}\n")
    L.append(f"\nn_indep (distinct entry weeks with an engine pick): {W.E_rb.notna().sum()}\n")
    # Winner pass (contract item 11): engine-proxy picks, train weeks only (< 2024-07), winners = kept, losers = loss at expiry
    P = pd.concat(picks)
    P = P[P.wk.astype(str) < "2024-07-01"]
    L.append("\n## Winner pass — engine-proxy picks, train weeks < 2024-07, median pre-entry features (kept vs loss)\n")
    cols = ["otm", "dl", "inc", "ivrv", "off52", "off"]
    for reg, g in P.groupby("reg"):
        tab = g.groupby("loss")[cols].median().round(3)
        L.append(f"\n**{reg}** (picks {len(g)}, losses {int(g.loss.sum())}, weeks {g.wk.nunique()})\n" + tab.to_string() + "\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(L))
    print("".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
