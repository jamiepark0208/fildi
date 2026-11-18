"""S201 (Jamie 11-17: "data-center names had tons of negative news baked in and reversed higher after earnings — won't that
persist for other Q3 reports?"). Event = LSEG report date (true day; move_pct = reaction). Pre-run = 20-session return
into the report (close day −21 → day −1). Market cell = SPY ≥ 5 % below its 252-d high at the report (today: −6 %).
Cells: pre-run ≤ −20 % ('baked in') / −20..−5 / −5..+5 / > +5. Outcomes: reaction day (move_pct), then +20 sessions after
the reaction minus SPY. Expected (Jamie): baked-in × market dip → positive reaction and drift. Under 30 per cell → no read.
Data: lseg_research.earnings_moves 2019-09→ (910 tickers, survivors → upward bias); prices lseg daily_history.
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402

c = connect()
spy = pd.Series(dict(c.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close>0").fetchall())).sort_index()
spy.index = pd.to_datetime(spy.index); sdd = spy / spy.rolling(252, min_periods=200).max() - 1
ev = pd.DataFrame(c.execute("SELECT ticker, report_date, move_pct::float8 FROM lseg_research.earnings_moves WHERE move_pct IS NOT NULL").fetchall(),
                  columns=["t", "d", "move"])
ev.d = pd.to_datetime(ev.d)
print(f"CHECK events {len(ev)}, |move| > 60 %: {(ev.move.abs() > 60).sum()} (dropped), move units sample {ev.move.describe()[['50%','std']].round(2).to_dict()}")
ev = ev[ev.move.abs() <= 60]
px = {}
for t, d, cl in c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close>0 AND date >= '2019-06-01' AND ticker = ANY(%s) ORDER BY ticker, date", (list(ev.t.unique()),)):
    px.setdefault(t, []).append((d, cl))
rows, jumps = [], 0
for t, g in ev.groupby("t"):
    if t not in px: continue
    p = pd.Series(dict(px[t])); p.index = pd.to_datetime(p.index); dr = p.pct_change()
    for _, e in g.iterrows():
        i = p.index.searchsorted(e.d)  # first session ≥ report date
        if i < 22 or i + 22 >= len(p): continue
        pre = p.iloc[i - 1] / p.iloc[i - 21] - 1
        # reaction session = the one whose return ≈ move_pct (report before open → day i, after close → day i+1)
        j = i if abs(100 * dr.iloc[i] - e.move) < abs(100 * dr.iloc[i + 1] - e.move) else i + 1
        if dr.iloc[j + 1:j + 21].abs().max() > 0.6: jumps += 1; continue
        d0, d20 = p.index[j], p.index[j + 20]
        if d0 not in spy.index or d20 not in spy.index: continue
        drift = p.iloc[j + 20] / p.iloc[j] - 1 - (spy[d20] / spy[d0] - 1)
        rows.append(dict(t=t, d=e.d, pre=pre, move=e.move, drift=drift, mkt_dip=sdd.asof(e.d) <= -0.05, q=e.d.to_period("Q")))
x = pd.DataFrame(rows)
print(f"CHECK usable {len(x)} events; dropped for a > 60 % daily jump after {jumps}; market-dip events {x.mkt_dip.sum()} in {x[x.mkt_dip].q.nunique()} quarters")
x["cell"] = pd.cut(x.pre, [-9, -0.20, -0.05, 0.05, 9], labels=["baked-in ≤ −20 %", "−20..−5 %", "flat ±5 %", "ran up > +5 %"])
for mk, lab in ((True, "SPY ≥ 5 % off high (today)"), (False, "SPY near high")):
    print(f"\n== {lab}")
    for cell, g in x[x.mkt_dip == mk].groupby("cell", observed=True):
        flag = "" if len(g) >= 30 else "  ← under 30, no read"
        print(f"{cell:18} n {len(g):5} ({g.q.nunique():2} qtrs) · reaction mean {g.move.mean():+.1f} % median {g.move.median():+.1f} % up {100*(g.move>0).mean():.0f} % · "
              f"next 20 d vs SPY {g.drift.mean():+.1%} (median {g.drift.median():+.1%}){flag}")
# per-quarter stability for the claim cell
g = x[(x.mkt_dip) & (x.cell == "baked-in ≤ −20 %")]
if len(g): print("\nbaked-in × dip by quarter:", " ".join(f"{q}: n{len(h)} {h.move.mean():+.1f}%" for q, h in g.groupby("q")))
