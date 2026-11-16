#!/usr/bin/env python3
"""A410 — does learning from graded recs help? Walk-forward, no look-ahead.

For each rec week W: learn cells only from recs whose expiry < W's first rec date (outcome known), demote by rule,
apply to W's recs, compare kept vs all (% of strike at the scoreboard's realistic fill).
Rules: strict = learn_cells rule (n ≥ 30, ≥ 4 weeks, shrunk < 0, P<0 ≥ 0.9); loose (exploratory) = n ≥ 15, shrunk mean < 0.
Also: live vs claim — engine recs carry hist_bp (bp/wk historical claim) → claimed % of strike vs realized per cell.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import learn_cells as LC  # noqa: E402
RS = LC.RS


def model_list(c) -> pd.DataFrame:
    df = RS.q(c, """SELECT snapshot_date d, ticker t, strike::float k, expiry e, premium::float px, spot::float spot,
                    abs(delta)::float delta, strike_iv::float iv, option_score::float score, vol_regime, macro_regime
                    FROM model_recs WHERE side = 'put'""")
    sec = RS.q(c, """SELECT DISTINCT ON (ticker) ticker t, payload->>'sector' sector FROM watchlist_sync.put_recs_daily
                     ORDER BY ticker, as_of DESC""")
    df = df.merge(sec, on="t", how="left").fillna({"sector": "unknown"})
    df["band"] = pd.cut(df.delta, [0, .08, .12, .16, 1], labels=["<.08", ".08-.12", ".12-.16", ">.16"]).astype(str)
    df["score_q"] = pd.qcut(df.score.rank(method="first"), 4, labels=["s1", "s2", "s3", "s4"]).astype(str)
    df["iv_tier"] = pd.cut(df.iv, [0, .5, .8, 9], labels=["iv<50", "iv50-80", "iv>80"]).astype(str)
    names = sorted(set(df.t) | {"QQQ"})
    px = RS.q(c, "SELECT ticker t, date, close::float c, low::float lo FROM prices_historical WHERE date >= '2026-08-15' AND ticker = ANY(%s)", (names,))
    px["date"] = pd.to_datetime(px["date"])
    P = {t: g.set_index("date").sort_index() for t, g in px.groupby("t")}
    qq = P["QQQ"]["c"]
    g = RS.grade(df, P, px["date"].max(), qq / qq.shift(20) - 1)
    g["week"] = g["e"].dt.to_period("W").astype(str)
    return g


def walk(g, cells_cols, label):
    LC.CELLS = cells_cols
    g = g[(g.expired == 1) & ~g.skip.astype(bool)].copy()
    g["rweek"] = g["d"].dt.to_period("W")
    rows = []
    for rw, test in g.groupby("rweek"):
        start = test.d.min()
        train = g[g.e < start]
        if len(train) < 15:
            continue
        for rule, (mn, mw, strict) in {"strict": (30, 4, True), "loose": (15, 1, False)}.items():
            LC.MIN_N, LC.MIN_WEEKS = mn, (mw if strict else 99)
            tab = LC.cells(train)
            dem = tab[tab.demote] if strict else tab[(tab.n >= mn) & (tab.shrunk < 0)]
            hit = np.zeros(len(test), bool)
            for r in dem.itertuples():
                hit |= (test[r.cell].astype(str) == str(r.value)).to_numpy()
            k = test[~hit]
            rows.append(dict(week=str(rw), rule=rule, train_n=len(train), demoted=len(dem), test_n=len(test), kept_n=len(k),
                             all=test.ret.mean(), kept=k.ret.mean() if len(k) else np.nan,
                             skipped=test[hit].ret.mean() if hit.any() else np.nan))
    out = pd.DataFrame(rows)
    print(f"\n== {label}: walk-forward (learn from expiries before the rec week, apply to that week) ==")
    print(out.to_string(index=False, float_format=lambda v: f"{v:+.2f}"))
    for rule, x in out.groupby("rule"):
        w = x.dropna(subset=["kept"])
        lift = (w.kept - w["all"])
        print(f"{rule}: weeks {len(w)} · mean lift {lift.mean():+.2f} pts/rec · weeks helped {(lift > 0).sum()}/{len(w)}")


def claim_vs_live(c):
    g = LC.load(c)
    hb = RS.q(c, "SELECT as_of d, ticker t, (payload->>'hist_bp')::float hist_bp, (payload->>'hist_kept')::float hist_kept "
                 "FROM watchlist_sync.put_recs_daily WHERE pass")
    hb["d"] = pd.to_datetime(hb["d"])
    g = g.merge(hb, on=["d", "t"], how="left")
    g = g[(g.expired == 1) & ~g.skip.astype(bool) & g.hist_bp.notna()]
    g["claim"] = g.hist_bp / 100 * np.maximum(g.dte, 1) / 7         # bp/wk × weeks held → % of strike
    g["kept_live"] = (g.ret > 0).astype(float)
    print("\n== engine: live vs its own historical claim ==")
    print(f"all n {len(g)}: claimed {g.claim.mean():+.2f} % · live {g.ret.mean():+.2f} % · claimed kept {g.hist_kept.mean():.0%} · live kept {g.kept_live.mean():.0%}")
    for col in ["market_state", "stock_state", "sector", "band"]:
        t = g.groupby(col).agg(n=("ret", "size"), weeks=("week", "nunique"), claim=("claim", "mean"), live=("ret", "mean"),
                               kept_claim=("hist_kept", "mean"), kept_live=("kept_live", "mean"))
        t = t[t.n >= 10]
        t["gap"] = t.live - t.claim
        print(t.sort_values("gap").to_string(float_format=lambda v: f"{v:+.2f}"))


def horizons(c):
    g = LC.load(c)
    g = g[(g.expired == 1) & ~g.skip.astype(bool)]
    for name, lo, hi in [("Friday 11-13 expiries", "2026-11-13", "2026-11-13"), ("week 11-09..11-13", "2026-11-09", "2026-11-13"),
                         ("month 10-16..11-13", "2026-10-16", "2026-11-13")]:
        x = g[(g.e >= lo) & (g.e <= hi)]
        if x.empty:
            print(f"{name}: no graded engine recs"); continue
        worst = x.groupby("sector").ret.agg(["size", "mean"]).sort_values("mean").head(3)
        print(f"{name}: n {len(x)} · {x.ret.mean():+.2f} % · win {(x.ret > 0).mean():.0%} · worst sectors "
              + ", ".join(f"{s} {r['mean']:+.1f} (n {int(r['size'])})" for s, r in worst.iterrows()))


if __name__ == "__main__" and "--relative" not in sys.argv:
    c = RS.L.connect()
    print("== what each horizon's graded engine recs say ==")
    horizons(c)
    walk(model_list(c), ["sector", "band", "score_q", "iv_tier", "vol_regime", "macro_regime"], "Model List puts (since 10-01)")
    walk(LC.load(c), ["sector", "market_state", "stock_state", "band", "ivrv_tier", "edge_q", "dte_tier"], "engine puts (since 10-26)")
    claim_vs_live(c)


def walk_relative(g, cols, label, min_n=15, cut=-1.0):
    """Relative learner: cell effect = mean of (ret − same-expiry-week mean); demote if n ≥ min_n and effect ≤ cut pts."""
    g = g[(g.expired == 1) & ~g.skip.astype(bool)].copy()
    g["rel"] = g.ret - g.groupby("week").ret.transform("mean")
    g["rweek"] = g["d"].dt.to_period("W")
    rows = []
    for rw, test in g.groupby("rweek"):
        train = g[g.e < test.d.min()]
        if len(train) < 15:
            continue
        dem = [(col, v) for col in cols for v, x in train.groupby(col) if len(x) >= min_n and x.rel.mean() <= cut]
        hit = np.zeros(len(test), bool)
        for col, v in dem:
            hit |= (test[col].astype(str) == str(v)).to_numpy()
        rows.append(dict(week=str(rw), demoted=";".join(f"{c}={v}" for c, v in dem)[:70], test_n=len(test), kept_n=int((~hit).sum()),
                         all=test.ret.mean(), kept=test[~hit].ret.mean() if (~hit).any() else np.nan,
                         skipped=test[hit].ret.mean() if hit.any() else np.nan))
    out = pd.DataFrame(rows)
    print(f"\n== {label}: RELATIVE walk-forward (cell vs same-week mean ≤ {cut} pts, n ≥ {min_n}) ==")
    print(out.to_string(index=False, float_format=lambda v: f"{v:+.2f}"))
    w = out.dropna(subset=["kept"])
    print(f"lift {(w.kept - w['all']).mean():+.2f} pts/rec over {len(w)} weeks · recs skipped {int((w.test_n - w.kept_n).sum())}")


if __name__ == "__main__" and "--relative" in sys.argv:
    c = RS.L.connect()
    walk_relative(model_list(c), ["sector", "band", "score_q", "iv_tier"], "Model List puts")
    walk_relative(LC.load(c), ["sector", "market_state", "stock_state", "band", "ivrv_tier", "edge_q", "dte_tier"], "engine puts")
