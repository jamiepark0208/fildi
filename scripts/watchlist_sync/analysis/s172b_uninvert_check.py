#!/usr/bin/env python3
"""S172b (Jamie 11-17: 'check the VIX/VIX3M un-inverting by backtesting'): model-free re-check of S172's signal.

Signal U (S172): VIX÷VIX3M < 1 after ≥ 2 sessions ≥ 1; entry = close of signal day; one per 14 calendar days.
Outcome: SPY total move (close→close) 5 / 10 / 21 sessions later, and max drawdown below entry within 21 sessions — no option model.
Control: every trading day. Regime (pre-registered): SPY vs 200 d SMA on the signal day.
Expected: forward 21 d move > any-day in both regimes; drawdown ≥ any-day (bottoms are volatile). n per regime cell printed;
< 30 episodes → "can't answer at this n" for that cell (pooled number still shown).
"""
from __future__ import annotations
import math, sys
from pathlib import Path
import numpy as np, pandas as pd
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

c = connect()
ix = pd.DataFrame(c.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')").fetchall(),
                  columns=["d", "i", "c"]).pivot(index="d", columns="i", values="c").dropna()
spy = pd.Series(dict(c.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close>0").fetchall())).sort_index()
spy.index = pd.to_datetime(spy.index); ix.index = pd.to_datetime(ix.index)
df = pd.DataFrame({"spy": spy}).join(ix, how="inner")
df["ratio"] = df.VIX / df.VIX3M
df["sma200"] = df.spy.rolling(200).mean()
for h in (5, 10, 21):
    df[f"f{h}"] = (df.spy.shift(-h) / df.spy - 1) * 100
df["dd21"] = (df.spy[::-1].rolling(21, min_periods=1).min()[::-1].shift(-1) / df.spy - 1) * 100
inv = df.ratio >= 1
raw = df.index[(df.ratio < 1) & inv.shift(1, fill_value=False) & inv.shift(2, fill_value=False)]
ep, last = [], None
for d in raw:
    if last is None or (d - last).days > 14:
        ep.append(d)
    last = d
df["reg"] = np.where(df.spy > df.sma200, "bull", "bear")
E = df.loc[ep].dropna(subset=["f21", "sma200"])
base = df.dropna(subset=["f21", "sma200"])
print(f"span {base.index.min().date()} → {df.index.max().date()} · episodes {len(ep)} (graded {len(E)}) · last fire {ep[-1].date()}")
def t_vs(a, b):
    return (a.mean() - b.mean()) / math.sqrt(a.var() / len(a) + b.var() / len(b))
for reg, sub in [("all", E)] + list(E.groupby("reg")):
    b = base if reg == "all" else base[base.reg == reg]
    row = [f"{reg:4} n {len(sub):3}"]
    for h in (5, 10, 21):
        row.append(f"+{h}d {sub[f'f{h}'].mean():+.2f} % vs {b[f'f{h}'].mean():+.2f} (up {100*(sub[f'f{h}']>0).mean():.0f} % vs {100*(b[f'f{h}']>0).mean():.0f} %, t {t_vs(sub[f'f{h}'], b[f'f{h}']):+.1f})")
    row.append(f"worst dip 21d {sub.dd21.mean():+.2f} vs {b.dd21.mean():+.2f}")
    print(" · ".join(row) + ("" if len(sub) >= 30 or reg == "all" else "  ← can't answer at this n"))
half = E.index < "2018-01-01"
for nm, s in [("2009–17", E[half]), ("2018→", E[~half])]:
    print(f"{nm}: n {len(s)}, +21d {s.f21.mean():+.2f} % (up {100*(s.f21>0).mean():.0f} %)")
print("last 8 fires:", ", ".join(f"{d.date()} ({df.f21.get(d, float('nan')):+.1f} %)" for d in ep[-8:]))
