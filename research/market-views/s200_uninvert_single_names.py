"""S200 (Jamie 11-17: "should the VIX un-invert rule apply to single names? check data is clean first").
Event: S172 fire = VIX ÷ VIX3M < 1 after ≥ 2 days ≥ 1 (2009→). Stock legs, not options (S173 did option prices).
Cells at the fire: (a) top-beta fifth (252-d beta vs SPY), (b) crashed names (≥ 40 % below 252-d high, like Jamie's book),
(c) everything else. Outcome: forward 21 / 63-session return minus SPY's, vs the same cell on every other week (own base).
Expected (Jamie): high-beta / crashed names beat SPY after the fire. Expected (S173 call leg): ≈ SPY on a beta-adjusted basis.
Data: CRSP dsf (ret incl. delisted) < 2020-03; LSEG daily_history ≥ 2020-03 (survivors only → upward bias; split jumps:
any window with a |daily move| > 60 % is dropped and counted). Price ≥ $2, ≥ 300 sessions history.
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402

c = connect()
def s(q):
    r = pd.Series(dict(c.execute(q).fetchall()), dtype=float).sort_index(); r.index = pd.to_datetime(r.index); return r
vix = s("SELECT date, close FROM wrds_research.cboe_daily WHERE index='VIX'").combine_first(s("SELECT date, value::float8 FROM watchlist_sync.macro_daily WHERE series='vix'"))
v3 = s("SELECT date, close FROM wrds_research.cboe_daily WHERE index='VIX3M'").combine_first(s("SELECT date, value::float8 FROM watchlist_sync.macro_daily WHERE series='vix3m'"))
r = (vix / v3).dropna()
fires = [r.index[i] for i in range(2, len(r)) if r.iloc[i] < 1 and r.iloc[i - 1] >= 1 and r.iloc[i - 2] >= 1]
spy = s("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close>0")
days = spy.index; sret = spy.pct_change()
fire_ix = set(days.get_indexer(pd.DatetimeIndex(fires), method="bfill"))
base_ix = set(range(260, len(days) - 64, 5)) - fire_ix  # every 5th session = own base
print(f"fires {len(fires)} ({fires[0].date()} → {fires[-1].date()}); base weeks {len(base_ix)}")

H = (21, 63)
out = {k: [] for k in ("fire", "base")}
dropped = kept = 0

def scan(name, dates, px, src):
    global dropped, kept
    ix = days.get_indexer(pd.DatetimeIndex(dates))
    ok = ix >= 0
    if ok.sum() < 300: return
    p = pd.Series(np.nan, index=range(len(days))); p[ix[ok]] = px[ok]
    p = p.ffill(limit=3).values
    ret = np.r_[np.nan, p[1:] / p[:-1] - 1]
    for kind, idxs in (("fire", fire_ix), ("base", base_ix)):
        for i in idxs:
            if i < 260 or i + 63 >= len(days) or np.isnan(p[i]) or p[i] < 2 or np.isnan(p[i + 63]): continue
            if src == "L" and days[i] < pd.Timestamp("2020-03-01"): continue
            if src == "C" and days[i] >= pd.Timestamp("2020-03-01"): continue
            w = ret[i + 1:i + 64]
            if np.nanmax(np.abs(w)) > 0.6: dropped += 1; continue
            hist = ret[i - 251:i + 1]; sh = sret.values[i - 251:i + 1]
            m = ~(np.isnan(hist) | np.isnan(sh))
            if m.sum() < 200: continue
            beta = np.cov(hist[m], sh[m])[0, 1] / np.var(sh[m])
            off = p[i] / np.nanmax(p[i - 251:i + 1]) - 1
            row = [i, beta, off] + [p[i + h] / p[i] - 1 - (spy.iloc[i + h] / spy.iloc[i] - 1) for h in H]
            out[kind].append(row); kept += 1

cur, d, v = None, [], []
for perm, dt, rt, prc in c.execute("SELECT permno, date, ret::float8, abs(prc)::float8 FROM wrds_research.crsp_dsf WHERE date < '2020-07-01' AND ret IS NOT NULL ORDER BY permno, date"):
    if perm != cur:
        if d: scan(cur, d, np.array(v), "C")
        cur, d, v, ix = perm, [], [], 100.0
    d.append(dt); v.append(prc if prc else np.nan)
if d: scan(cur, d, np.array(v), "C")
cur, d, v = None, [], []
for t, dt, cl in c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close > 0 AND date >= '2019-01-01' ORDER BY ticker, date"):
    if t != cur:
        if d: scan(cur, d, np.array(v), "L")
        cur, d, v = t, [], []
    d.append(dt); v.append(cl)
if d: scan(cur, d, np.array(v), "L")
print(f"CHECK windows kept {kept}, dropped for a > 60 % daily jump {dropped} ({100*dropped/max(1,kept+dropped):.1f} %)")

F = pd.DataFrame(out["fire"], columns=["i", "beta", "off", "x21", "x63"]); B = pd.DataFrame(out["base"], columns=F.columns)
cut = B.beta.quantile(0.8)
cells = {"top-beta fifth": lambda x: x.beta >= cut, "crashed ≥ 40 % off high": lambda x: x.off <= -0.40,
         "top-beta AND crashed": lambda x: (x.beta >= cut) & (x.off <= -0.40), "everything else": lambda x: (x.beta < cut) & (x.off > -0.40)}
print(f"top-beta cut {cut:.2f}. Excess return vs SPY (median | mean | % beat SPY):")
for name, f in cells.items():
    a, b = F[f(F)], B[f(B)]
    print(f"{name:24} fire n {len(a):6}: +21d {a.x21.median():+.1%} | {a.x21.mean():+.1%} | {100*(a.x21>0).mean():.0f} %  +63d {a.x63.median():+.1%} | {a.x63.mean():+.1%} | {100*(a.x63>0).mean():.0f} %"
          f"   base: +21d {b.x21.median():+.1%} | {b.x21.mean():+.1%}  +63d {b.x63.median():+.1%} | {b.x63.mean():+.1%}")
print("\nPer episode (each fire = 1 obs; mean excess of the cell's names at that fire, ≥ 5 names):")
for name, f in cells.items():
    a = F[f(F)]; sz = a.groupby("i").size(); g = a.groupby("i")[["x21", "x63"]].mean()[sz >= 5]
    for h in ("x21", "x63"):
        t = g[h].mean() / (g[h].std(ddof=1) / np.sqrt(len(g))) if len(g) > 2 else np.nan
        print(f"  {name:24} {h}: episodes {len(g):3} · mean {g[h].mean():+.1%} · median {g[h].median():+.1%} · positive {100*(g[h]>0).mean():.0f} % · t {t:.1f}")
