#!/usr/bin/env python3
"""A410 part 1 — cell tracker: learn from graded put recs which *kinds* of trade lose.

Every engine PASS put (watchlist_sync.put_recs_daily) graded at expiry by rec_scoreboard.grade (one grading home) →
one row per rec with its cells (sector, market_state, stock_state, delta band, IV÷RV tier, put-edge quintile, DTE tier).
Per cell: n, mean % of strike, shrunk mean (normal-normal, prior = all-rec mean, prior weight K recs), and
P(true mean < 0) from the shrunk mean and a week-clustered SE.

Demote rule (pre-registered 11-16, A410): n ≥ 30 AND ≥ 4 expiry weeks AND shrunk mean < 0 AND P(<0) ≥ 0.9.

  learn_cells.py                      table of cells on all graded recs (+ writes watchlist_sync.rec_cells)
  learn_cells.py --holdout 2026-11-06  learn on recs expiring ≤ date, test on recs entered after it
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import rec_scoreboard as RS  # noqa: E402

MIN_N, MIN_WEEKS, K, P_NEG = 30, 4, 30, 0.9
CELLS = ["sector", "market_state", "stock_state", "band", "ivrv_tier", "edge_q", "dte_tier"]


def load(c, since="2026-09-01") -> pd.DataFrame:
    df = RS.q(c, """SELECT as_of d, ticker t, (payload->>'strike')::float k, (payload->>'expiry')::date e,
                    (payload->>'bid')::float bid, (payload->>'ask')::float ask, (payload->>'spot')::float spot,
                    payload->>'sector' sector, payload->>'market_state' market_state, payload->>'stock_state' stock_state,
                    payload->>'band' band, (payload->>'iv_rv')::float iv_rv, (payload->>'put_edge_q')::int edge_q,
                    (payload->>'dte')::int dte
                    FROM watchlist_sync.put_recs_daily WHERE pass AND as_of >= %s""", (since,))
    df["px"] = df["bid"] + 0.1 * (df["ask"] - df["bid"])          # same realistic fill as the scoreboard
    df["ivrv_tier"] = pd.cut(df["iv_rv"], [-np.inf, 1.0, 1.3, np.inf], labels=["iv<rv", "iv 1-1.3x", "iv>1.3x"]).astype(str)
    df["dte_tier"] = pd.cut(df["dte"], [-1, 7, 21, 999], labels=["≤7d", "8-21d", ">21d"]).astype(str)
    df["edge_q"] = df["edge_q"].map(lambda x: f"q{int(x)}" if pd.notna(x) else "none")
    names = sorted(set(df.t) | {"QQQ"})
    px = RS.q(c, "SELECT ticker t, date, close::float c, low::float lo FROM prices_historical WHERE date >= %s AND ticker = ANY(%s)",
              (pd.Timestamp(since) - pd.Timedelta(days=40), names))
    px["date"] = pd.to_datetime(px["date"])
    P = {t: g.set_index("date").sort_index() for t, g in px.groupby("t")}
    qq = P["QQQ"]["c"]
    g = RS.grade(df, P, px["date"].max(), qq / qq.shift(20) - 1)
    g["week"] = g["e"].dt.to_period("W").astype(str)
    return g


def cells(g: pd.DataFrame) -> pd.DataFrame:
    w = g[(g.expired == 1) & ~g.skip.astype(bool)]
    mu0 = w.ret.mean()
    out = []
    for col in CELLS:
        for val, x in w.groupby(col):
            n = len(x)
            # week-clustered SE: SD of weekly means / sqrt(weeks); fall back to per-rec SE with < 3 weeks
            wk = x.groupby("week").ret.mean()
            # < MIN_WEEKS expiry weeks → no SE (per-rec SE ignores that one week's names move together → overconfident)
            se = (wk.std(ddof=1) / math.sqrt(len(wk))) if len(wk) >= MIN_WEEKS else np.nan
            shr = (n * x.ret.mean() + K * mu0) / (n + K)
            sd = max(se * n / (n + K), 1e-9) if pd.notna(se) else np.nan
            p_neg = 0.5 * (1 + math.erf((0 - shr) / (sd * math.sqrt(2)))) if pd.notna(sd) else np.nan
            demote = n >= MIN_N and shr < 0 and pd.notna(p_neg) and p_neg >= P_NEG
            out.append(dict(cell=col, value=val, n=n, weeks=len(wk), mean=x.ret.mean(), shrunk=shr, p_neg=p_neg,
                            win=(x.ret > 0).mean(), demote=demote))
    return pd.DataFrame(out).sort_values(["demote", "shrunk"], ascending=[False, True])


def holdout(g: pd.DataFrame, cut: str) -> None:
    cut = pd.Timestamp(cut)
    train = g[g.e <= cut]
    test = g[(g.d > cut) & (g.expired == 1) & ~g.skip.astype(bool)]
    tab = cells(train)
    dem = tab[tab.demote]
    print(f"train: recs expiring ≤ {cut.date()} · graded n {int(((train.expired == 1) & ~train.skip.astype(bool)).sum())}")
    print("demoted cells:", ", ".join(f"{r.cell}={r.value} (n {r.n}, {r.mean:+.2f} %, P<0 {r.p_neg:.2f})" for r in dem.itertuples()) or "none")
    hit = np.zeros(len(test), bool)
    for r in dem.itertuples():
        hit |= (test[r.cell] == r.value).to_numpy()
    k, d = test[~hit], test[hit]
    print(f"test: recs entered > {cut.date()}, graded n {len(test)} ({test.week.nunique()} expiry weeks)")
    print(f"  all {test.ret.mean():+.2f} % (n {len(test)}) · kept {k.ret.mean():+.2f} % (n {len(k)}) · demoted {d.ret.mean() if len(d) else float('nan'):+.2f} % (n {len(d)})")
    print(f"  lift from skipping demoted cells: {k.ret.mean() - test.ret.mean():+.2f} pts of strike per rec")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout")
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()
    c = RS.L.connect()
    g = load(c)
    if a.holdout:
        return holdout(g, a.holdout)
    tab = cells(g)
    pd.set_option("display.width", 160)
    print(tab.to_string(index=False, float_format=lambda v: f"{v:+.2f}"))
    if not a.no_write:
        cur = c.cursor()
        cur.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.rec_cells (as_of date, source text, cell text, value text, n int,
                       weeks int, mean float, shrunk float, p_neg float, win float, demote bool, PRIMARY KEY (as_of, source, cell, value))""")
        today = pd.Timestamp.today().date()
        cur.execute("DELETE FROM watchlist_sync.rec_cells WHERE as_of = %s AND source = 'put_engine'", (today,))
        for r in tab.itertuples():
            cur.execute("INSERT INTO watchlist_sync.rec_cells VALUES (%s,'put_engine',%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (today, r.cell, str(r.value), int(r.n), int(r.weeks), float(r.mean), float(r.shrunk),
                         None if pd.isna(r.p_neg) else float(r.p_neg), float(r.win), bool(r.demote)))
        c.commit()
        print(f"rec_cells: {len(tab)} cells, {int(tab.demote.sum())} demoted → watchlist_sync.rec_cells")


if __name__ == "__main__":
    main()
