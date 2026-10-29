"""S127 — Can we tell, before the report, which names gap UP vs DOWN on earnings? (Jamie 10-28)

Jamie: "earnings wasn't the mistake (GOOGL −8.8 %, but plenty moved higher). The mistake was not trying to
predict which companies go up or down after earnings, from history."

Pre-report features (all point-in-time, known the day before the reaction window opens):
  pred_surprise  StarMine predicted EPS surprise % (SmartEstimate vs consensus; last month-end obs before)
                 — literature: SmartEstimate gaps predict surprise sign (StarMine white papers; Bradshaw et al.)
  alpha          StarMine combined alpha rank (last obs before)
  pt_rev         analyst price-target mean change over the prior ~3 months (revision momentum, Gleason & Lee 2003)
  runup          20-day return into the report minus SPY (pre-earnings run-up reverses: Aboody et al. 2018)
  skew           dropped: lseg daily_history iv30_put == iv30_call on every row (one field) — no skew history
  prev_move      the stock's previous earnings reaction (is the reaction sign persistent per name?)
  prev_surprise  previous quarter EPS surprise % (SUE persistence, Bernard & Thomas 1990)
Outcome: lseg_research.earnings_moves.move_pct (reaction window by report time), sign, and P(drop ≤ −5 %).
Split: H1 report_date < 2023-01-01, H2 ≥ 2023-01-01. Pass = same-sign rank IC in both halves with |t| ≥ 2
(quarter-clustered), and a top-vs-bottom-fifth gap that a put seller would notice.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg

OUT = Path(__file__).resolve().parents[1] / "out" / "opt" / "S127.md"
SPLIT = pd.Timestamp("2023-01-01")


def q(c, sql, params=None) -> pd.DataFrame:
    cur = c.execute(sql, params)
    return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])


def asof_merge(ev: pd.DataFrame, side: pd.DataFrame, on: str, col: str, tol_days: int) -> pd.Series:
    """Last side[col] strictly before ev.d per ticker, within tol_days."""
    side = side.dropna(subset=[col]).copy()
    side[on] = pd.to_datetime(side[on]).astype("datetime64[ns]")
    side = side.sort_values(on)
    ev = ev.copy(); ev["d_prev"] = ev["d_prev"].astype("datetime64[ns]")
    m = pd.merge_asof(ev.sort_values("d_prev"), side.rename(columns={on: "d_prev"}), on="d_prev", by="ticker",
                      direction="backward", tolerance=pd.Timedelta(days=tol_days))
    return m.set_index("key")[col]


def qic(y: pd.DataFrame, f: str) -> pd.Series:
    """Per-quarter Spearman IC (quarters with ≥ 10 reports)."""
    out = {k: g[f].corr(g.move, method="spearman") for k, g in y.groupby("qtr") if len(g) >= 10}
    return pd.Series(out, dtype=float).dropna()


def main() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as c:
        ev = q(c, "select ticker, report_date d, move_pct::float move from lseg_research.earnings_moves where move_pct is not null")
        sm = q(c, "select ticker, obs_date, metric, value::float v from lseg_research.starmine_history")
        dh = q(c, "select ticker, date, close::float close, iv30_put::float ivp, iv30_call::float ivc from lseg_research.daily_history")
        spy = q(c, "select date, close::float spy from prices_historical where ticker='SPY'")
        ec = q(c, "select ticker, report_date, surprise_pct::float sp from earnings_calendar where surprise_pct is not null")
    ev["d"] = pd.to_datetime(ev.d); ev["d_prev"] = ev.d - pd.Timedelta(days=2)  # strictly before the window
    ev = ev.sort_values(["ticker", "d"]).reset_index(drop=True); ev["key"] = ev.index
    sm["obs_date"] = pd.to_datetime(sm.obs_date)
    for met, col in [("pred_surprise_pct_fq1", "pred_surprise"), ("combined_alpha_rank", "alpha"), ("pt_mean", "pt")]:
        s = sm[sm.metric == met][["ticker", "obs_date", "v"]].rename(columns={"v": col})
        ev[col] = ev.key.map(asof_merge(ev, s, "obs_date", col, 45))
        if col == "pt":
            ev2 = ev[["ticker", "d_prev", "key"]].copy(); ev2["d_prev"] = ev2.d_prev - pd.Timedelta(days=91)
            ev["pt_old"] = ev.key.map(asof_merge(ev2, s, "obs_date", col, 45))
    ev["pt_rev"] = ev.pt / ev.pt_old - 1
    dh["date"] = pd.to_datetime(dh.date); dh = dh.sort_values(["ticker", "date"])
    dh["ret20"] = dh.groupby("ticker").close.pct_change(20)
    dh["skew"] = dh.ivp - dh.ivc
    spy["date"] = pd.to_datetime(spy.date); spy = spy.sort_values("date"); spy["spy20"] = spy.spy.pct_change(20)
    # SPY history in prices_historical is short; per-quarter rank ICs already net out the market move.
    dh["runup"] = dh.ret20
    for col in ("runup",):
        ev[col] = ev.key.map(asof_merge(ev, dh[["ticker", "date", col]], "date", col, 6))
    ev["prev_move"] = ev.groupby("ticker").move.shift(1)
    ev["absmed"] = ev.groupby("ticker").move.transform(lambda s: s.abs().shift(1).rolling(8, min_periods=3).median())
    ec["report_date"] = pd.to_datetime(ec.report_date)
    # previous quarter's surprise: calendar rows dated > 20 days before this report (calendar dates are noisy)
    ev3 = ev[["ticker", "d_prev", "key"]].copy(); ev3["d_prev"] = ev3.d_prev - pd.Timedelta(days=20)
    ev["prev_surprise"] = ev.key.map(asof_merge(ev3, ec, "report_date", "sp", 120))
    ev["half"] = np.where(ev.d < SPLIT, "H1", "H2")
    ev["qtr"] = ev.d.dt.to_period("Q")
    ev["down5"] = ev.move <= -5
    ev["zmove"] = ev.move / ev.absmed

    feats = ["pred_surprise", "alpha", "pt_rev", "runup", "prev_move", "prev_surprise"]
    L = ["# S127 — Predicting the earnings reaction sign before the report", "",
         f"{len(ev):,} reports, {ev.ticker.nunique()} names, {ev.d.min():%Y-%m} → {ev.d.max():%Y-%m}. H1 < 2023 ≤ H2. "
         f"Base rates: up {100 * (ev.move > 0).mean():.0f} %, drop ≤ −5 % {100 * ev.down5.mean():.0f} %.", "",
         "## Rank IC with the reaction (quarter-clustered t)", "",
         "| feature | n | IC H1 | t H1 | IC H2 | t H2 | top-fifth up % | bottom-fifth up % | top P(≤−5 %) | bottom P(≤−5 %) | (H2 only) |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    res = {}
    for f in feats:
        x = ev.dropna(subset=[f, "move"])
        row = [f, f"{len(x):,}"]
        for h in ("H1", "H2"):
            y = x[x.half == h]
            ics = qic(y, f)
            t = ics.mean() / (ics.std() / np.sqrt(len(ics))) if len(ics) > 2 else np.nan
            row += [f"{ics.mean():+.3f}", f"{t:+.1f}"]
            res[(f, h)] = (ics.mean(), t)
        y = x[x.half == "H2"].copy()
        y["fifth"] = y.groupby("qtr")[f].transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False) if len(s) >= 10 else np.nan)
        top, bot = y[y.fifth == 4], y[y.fifth == 0]
        row += [f"{100 * (top.move > 0).mean():.0f}", f"{100 * (bot.move > 0).mean():.0f}",
                f"{100 * top.down5.mean():.0f}", f"{100 * bot.down5.mean():.0f}", f"n {len(top)}/{len(bot)}"]
        L.append("| " + " | ".join(row) + " |")

    # put-seller question: not the sign but the left tail — P(drop ≤ −5 %) bottom vs top fifth, both halves
    L += ["", "## Left tail: P(drop ≤ −5 %) by fifth of each feature (per-quarter fifths)", "",
          "| feature | H1 bottom | H1 top | H2 bottom | H2 top | n H2 |", "|---|---|---|---|---|---|"]
    for f in feats:
        x = ev.dropna(subset=[f]).copy()
        x["fifth"] = x.groupby("qtr")[f].transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False) if len(s) >= 10 else np.nan)
        cells = []
        for h in ("H1", "H2"):
            y = x[x.half == h]
            cells += [f"{100 * y[y.fifth == 0].down5.mean():.0f} %", f"{100 * y[y.fifth == 4].down5.mean():.0f} %"]
        L.append(f"| {f} | " + " | ".join(cells) + f" | {int((x.half == 'H2').sum())} |")

    # composite of features that pass H1 (sign from H1), graded on H2 only
    keep = [f for f in feats if abs(res[(f, "H1")][1]) >= 2]
    L += ["", f"## Composite (features with |t| ≥ 2 in H1, signed by H1 IC): {', '.join(keep) or 'none'}", ""]
    if keep:
        z = pd.DataFrame({f: np.sign(res[(f, 'H1')][0]) * ev.groupby("qtr")[f].transform(lambda s: (s.rank(pct=True) - .5)) for f in keep})
        ev["comp"] = z.mean(axis=1, skipna=True).where(z.notna().sum(axis=1) >= max(1, len(keep) // 2))
        y = ev[(ev.half == "H2")].dropna(subset=["comp"]).copy()
        ics = qic(y, "comp")
        t = ics.mean() / (ics.std() / np.sqrt(len(ics)))
        y["fifth"] = y.groupby("qtr").comp.transform(lambda s: pd.qcut(s.rank(method="first"), 5, labels=False) if len(s) >= 10 else np.nan)
        L += [f"H2 IC {ics.mean():+.3f} (t {t:+.1f}, {len(ics)} quarters, n {len(y):,})", "",
              "| H2 fifth | n | up % | mean move % | P(≤ −5 %) | P(≥ +5 %) |", "|---|---|---|---|---|---|"]
        for k in range(5):
            g = y[y.fifth == k]
            L.append(f"| {k + 1} | {len(g)} | {100 * (g.move > 0).mean():.0f} | {g.move.mean():+.2f} | {100 * g.down5.mean():.0f} | {100 * (g.move >= 5).mean():.0f} |")
        last = ev.sort_values("d").groupby("ticker").tail(1)
        L += ["", "Latest report per name with the composite (for notes):", ""]
        for tk in ["GOOGL", "NOW", "VRT", "CVNA", "PLTR", "MSFT", "META", "AMZN", "AAPL"]:
            r = last[last.ticker == tk]
            if len(r):
                r = r.iloc[0]
                L.append(f"- {tk} {r.d:%Y-%m-%d}: move {r.move:+.1f} %, composite {r.comp:+.2f}" if pd.notna(r.get("comp")) else f"- {tk} {r.d:%Y-%m-%d}: move {r.move:+.1f} %, composite n/a")
    OUT.write_text("\n".join(L) + "\n")
    ev.to_csv(OUT.with_suffix(".csv"), index=False)
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
