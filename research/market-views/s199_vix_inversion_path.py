"""S199 (Jamie 11-17: "if VIX ÷ VIX3M is at 0.995, is it trending lower or higher?" — today 11-17 it closed 1.02 = day 1).
Regime: fresh inversion = ratio ≥ 1 today, < 1 yesterday. Cells: how many days it stays ≥ 1; does it then un-invert
(< 1 after ≥ 2 inverted days = S172 fire); SPY forward 21 / 63 sessions from day 1 vs any day.
Expected: spikes mean-revert (most inversions end in ≤ 3 days); day-1 forward SPY ≈ base or better.
Data: wrds_research.cboe_daily VIX/VIX3M 2009-09 → 11-09, macro_daily (Yahoo) after; SPY lseg_research.daily_history.
Checks first: overlap agreement Yahoo vs CBOE, gaps, outliers.
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
cv, c3 = (s(f"SELECT date, close FROM wrds_research.cboe_daily WHERE index='{i}' AND close>0") for i in ("VIX", "VIX3M"))
yv, y3 = (s(f"SELECT date, value::float8 FROM watchlist_sync.macro_daily WHERE series='{i}'") for i in ("vix", "vix3m"))
spy = s("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close>0")

# ---- data checks
ov = pd.concat([cv, yv], axis=1, keys=["cboe", "yahoo"]).dropna()
print(f"CHECK overlap VIX Yahoo vs CBOE: {len(ov)} days, max |diff| {(ov.cboe-ov.yahoo).abs().max():.2f}")
bad = ov[(ov.cboe - ov.yahoo).abs() > 0.5]
if len(bad): print("  disagree:", bad.tail(5).to_dict("index"))
vix = cv.combine_first(yv); v3 = c3.combine_first(y3)
r = (vix / v3).dropna()
print(f"CHECK ratio: {r.index[0].date()} → {r.index[-1].date()}, n {len(r)}, min {r.min():.2f} max {r.max():.2f}, "
      f"gaps > 5 cal days {(r.index.to_series().diff().dt.days > 5).sum()}")
print("last 8:", " ".join(f"{d:%m-%d}:{v:.3f}" for d, v in r.tail(8).items()))

# ---- episodes
inv = r >= 1
fresh = inv & ~inv.shift(1, fill_value=False)
f21 = spy.shift(-21) / spy - 1; f63 = spy.shift(-63) / spy - 1
rows = []
for d in r.index[fresh]:
    i = r.index.get_loc(d); n = 0
    while i + n < len(r) and r.iloc[i + n] >= 1: n += 1
    if i + n >= len(r): continue  # still open (today)
    prior_min = r.iloc[max(0, i - 5):i].min()
    rows.append(dict(d=d, length=n, fired=n >= 2, spike=prior_min < 0.95, peak=r.iloc[i:i + n].max(),
                     f21=f21.get(d, np.nan), f63=f63.get(d, np.nan)))
e = pd.DataFrame(rows)
print(f"\nFresh inversions 2009→ (closed): {len(e)}; from a calm curve (< 0.95 within 5 d, like today): {e.spike.sum()}")
for name, x in (("all", e), ("from calm (today's cell)", e[e.spike])):
    L = x.length
    print(f"{name:26} n {len(x):3} · P(still ≥ 1 next day) {100*(L>=2).mean():.0f} % · ≥ 5 d {100*(L>=5).mean():.0f} % · "
          f"median {L.median():.0f} d · mean {L.mean():.1f} · peak ratio median {x.peak.median():.2f}")
base21, base63 = f21.dropna().mean(), f63.dropna().mean()
for name, x in (("1-day blips", e[~e.fired]), ("≥ 2 d (S172 armed)", e[e.fired]), ("from calm", e[e.spike])):
    print(f"SPY from day 1, {name:20} n {len(x):3}: +21d {x.f21.mean():+.2%} (up {100*(x.f21>0).mean():.0f} %) · "
          f"+63d {x.f63.mean():+.2%} (up {100*(x.f63>0).mean():.0f} %)  vs any day {base21:+.2%} / {base63:+.2%}")
