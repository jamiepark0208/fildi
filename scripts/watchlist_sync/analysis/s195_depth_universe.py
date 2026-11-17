#!/usr/bin/env python3
"""S195 (A410 part 3/7, Jamie 11-17 "ok go"): does S194's split of Jamie's put sales hold across the universe?

S194 on his 1,526 sales: within the same week, strike depth separates clean from risky/loss (t −3.0); a QQQ 20 d
run-up raises the bad rate (t +2.4); "beaten down" (off 60 d high) is mostly the market week (t 1.6).
Question here: on REAL quotes for every optionable name, does a deeper strike earn more per $ of strike, inside the
same week AND on the same stock in the same week (pure depth effect, stock + market held fixed)?

Data: optlab.lseg_opt_daily (LSEG EOD bid/ask, 2020→) via S109 RIC parse; lseg_research.daily_history closes/lows.
Trade: per put contract, first quote 3–9 calendar days before expiry, |Δ| 0.02–0.40 (quote's own IV), held to expiry.
Fill = bid + 23 % of spread (RH median, S071); stress = bid. r = (fill − intrinsic) ÷ strike, scaled to 7 days (%).
Entry = EOD quote with that day's close (S109 convention) — not an intraday entry-candle test (contract item 13): depth
is a strike choice, the entry minute is a separate question (S191).

PRE-REGISTERED (11-17, before the run)
Regime = SPY close vs its 200 d SMA on the entry day: bull / bear.
Depth = strike % below spot: near < 6 · 6–10 · 10–14 · deep ≥ 14 (S192 cut 13.7).
Expected sign per regime:
  bull: deep − near r ≥ 0 (small; near strikes rarely hit)   · bear: deep − near r > 0 (near strikes get run over)
  beaten (≥ 40 % off 60 d high) vs not, within week: ≈ 0 both regimes (S194)
  QQQ 20 d return ≥ +3 % at entry: lower r for all depths next week (S194: run-up → more bad)
Independent unit = entry week; < 30 weeks in a cell → "can't answer at this n". Week-clustered t; same-stock-week
pairs for the pure depth effect. Pass bar for the engine to prefer depth: deep − near > 0 at the STRESS fill, t ≥ 2,
in each regime separately (never one sign demanded across regimes beyond that).

    .venv/bin/python analysis/s195_depth_universe.py [preflight]
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402
from quantcore.bs import implied_vol, put_delta, years_from_days  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S195.md"
DEPTH = [(-1, 6, "a <6%"), (6, 10, "b 6-10%"), (10, 14, "c 10-14%"), (14, 99, "d >=14%")]


def load(c):
    q = defaultdict(list)
    for ric, d, b, a, v in c.execute("SELECT ric, date, bid::float8, ask::float8, iv::float8 FROM optlab.lseg_opt_daily "
                                     "WHERE bid > 0 AND ask >= bid AND ric ~ '[M-X][0-9]{4}[0-9]{5}\\.U'"):
        q[ric].append((d, b, a, v))
    px = defaultdict(dict)
    for t, d, cl, lo in c.execute("SELECT ticker, date, close::float8, COALESCE(low, close)::float8 FROM lseg_research.daily_history "
                                  "WHERE close > 0 ORDER BY ticker, date"):
        px[t][d] = (cl, lo)
    return q, px


def series_feats(px):
    """Per ticker: off 60 d high (closes up to and incl. d), keyed by date. SPY bull flag, QQQ 20 d return."""
    off = {}
    for t, p in px.items():
        ds = sorted(p); c = pd.Series([p[d][0] for d in ds], index=ds)
        off[t] = (c / c.rolling(60, min_periods=40).max() - 1).to_dict()
    spy = pd.Series({d: v[0] for d, v in px["SPY"].items()}).sort_index()
    bull = (spy > spy.rolling(200).mean()).to_dict()
    qqq = pd.Series({d: v[0] for d, v in px["QQQ"].items()}).sort_index()
    q20 = (qqq / qqq.shift(20) - 1).to_dict()
    return off, bull, q20


def trades(q, px, off, bull, q20):
    out = []
    for ric, qs in q.items():
        m = S109.RIC.match(ric)
        if not m:
            continue
        root, mon, dd, yy, k = m.group(1), ord(m.group(2)) - ord("M") + 1, int(m.group(3)), int(m.group(4)), int(m.group(5)) / 100
        try:
            exp = date(2000 + yy, mon, dd)
        except ValueError:
            continue
        p = px.get(root)
        if not p:
            continue
        qs.sort()
        ent = next((x for x in qs if 3 <= (exp - x[0]).days <= 9), None)
        if not ent or ent[0] not in p or ent[0] not in bull:
            continue
        d, b, a, v = ent
        S = p[d][0]
        if S109.K_bad(k, S) or S < 5:
            continue
        stx = next((x for x in (exp - timedelta(days=n) for n in range(4)) if x in p), None)
        if stx is None:
            continue
        days = (exp - d).days
        iv = v / 100 if v and v > 0 else implied_vol(price=(a + b) / 2, spot=S, strike=k, years=years_from_days(days))
        if not iv or iv > 5:
            continue
        dl = abs(float(put_delta(spot=S, strike=k, iv=iv, years=years_from_days(days))))
        if not 0.02 <= dl <= 0.40:
            continue
        otm = (1 - k / S) * 100
        intr = max(k - p[stx][0], 0.0)
        lows = [p[x][1] for x in p if d < x <= stx]
        f = 7 / days * 100
        out.append(dict(t=root, d=d, wk=d - timedelta(days=d.weekday()), K=k, S=S, otm=otm, dl=dl, iv=iv,
                        depth=next(lbl for lo, hi, lbl in DEPTH if lo <= otm < hi),
                        r=(b + 0.23 * (a - b) - intr) / k * f, r_bid=(b - intr) / k * f,
                        loss=intr > b + 0.23 * (a - b), touched=bool(lows) and min(lows) < k,
                        off=off[root].get(d), reg="bull" if bull[d] else "bear", q20=q20.get(d)))
    return pd.DataFrame(out)


def wk_t(s: pd.Series):
    s = s.dropna()
    return (s.mean(), s.mean() / (s.std() / math.sqrt(len(s))) if len(s) > 2 and s.std() > 0 else np.nan, len(s))


def main() -> int:
    c = connect()
    q, px = load(c)
    off, bull, q20 = series_feats(px)
    T = trades(q, px, off, bull, q20)
    T["beaten"] = T.off <= -0.40
    T["runup"] = T.q20 >= 0.03
    L = [f"# S195 — strike depth on real quotes, universe (A410)\n",
         f"n {len(T):,} put trades · {T.t.nunique()} names · {T.wk.nunique()} weeks · {T.d.min()} → {T.d.max()}\n"]

    L.append("\n## Preflight: independent weeks per regime × depth\n")
    L.append(T.groupby(["reg", "depth"]).wk.nunique().unstack().to_string() + "\n")
    if len(sys.argv) > 1 and sys.argv[1] == "preflight":
        print("".join(L)); return 0

    L.append("\n## Per regime × depth (week-averaged): r %/wk at fill · stress (bid) · loss rate · touched rate\n")
    for reg, g in T.groupby("reg"):
        w = g.groupby(["wk", "depth"]).agg(r=("r", "mean"), rb=("r_bid", "mean"), loss=("loss", "mean"), tch=("touched", "mean")).reset_index()
        L.append(f"\n**{reg}** (weeks {g.wk.nunique()}, trades {len(g):,})\n")
        L.append(w.groupby("depth")[["r", "rb", "loss", "tch"]].mean().round(3).to_string() + "\n")
        rk = w.groupby("depth").rb.agg(sd="std", worst5=lambda x: x.quantile(0.05), mean="mean")
        rk["mean/sd"] = rk["mean"] / rk.sd
        L.append("risk per depth (stress fill, week averages): sd · worst-5 % week · mean/sd\n" + rk.round(3).to_string() + "\n")
        # within week: deep − near
        pv = w.pivot(index="wk", columns="depth", values="rb")
        for lbl in ["b 6-10%", "c 10-14%", "d >=14%"]:
            m, t, n = wk_t(pv[lbl] - pv["a <6%"]) if lbl in pv and "a <6%" in pv else (np.nan, np.nan, 0)
            L.append(f"- within week, {lbl} − <6 % (stress fill): {m:+.3f} %/wk, t {t:.2f}, weeks {n}\n")
        # same stock, same week: deepest − nearest strike
        sw = g.groupby(["t", "wk"]).filter(lambda x: x.otm.max() - x.otm.min() >= 6)
        pair = sw.sort_values("otm").groupby(["t", "wk"]).agg(near=("r_bid", "first"), deep=("r_bid", "last"))
        pw = (pair.deep - pair.near).groupby(level="wk").mean()
        m, t, n = wk_t(pw)
        L.append(f"- same stock same week, deepest − nearest strike (≥ 6 pts apart, stress fill): {m:+.3f} %/wk, t {t:.2f}, weeks {n}, pairs {len(pair):,}\n")
        for flag, name in [("beaten", "beaten ≥ 40 % off 60 d high"), ("runup", "QQQ 20 d ≥ +3 %")]:
            wf = g.groupby(["wk", flag]).r_bid.mean().unstack()
            if flag == "beaten" and True in wf and False in wf:
                m, t, n = wk_t(wf[True] - wf[False])
                L.append(f"- within week, {name} − not: {m:+.3f} %/wk, t {t:.2f}, weeks {n}\n")
            if flag == "runup":
                a_ = g[g.runup].groupby("wk").r_bid.mean(); b_ = g[~g.runup].groupby("wk").r_bid.mean()
                L.append(f"- {name}: weeks {len(a_)} avg {a_.mean():+.3f} vs other weeks {len(b_)} avg {b_.mean():+.3f} %/wk (across weeks, not within)\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(L))
    print("".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
