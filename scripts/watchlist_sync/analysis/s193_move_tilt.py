#!/usr/bin/env python3
"""S193 (A410 part 6 step 1-2): realized 21-trading-day move in IV sigma units, by state.

State at entry close t (no look-ahead: all features use data <= t):
  dd   = drawdown off 60 d high close: <5 %, 5-15 %, 15-30 %, >30 %
  vrp  = IV30 / RV20: <0.9 (IV cheap), 0.9-1.3, >1.3 (IV rich)
  spy  = SPY close vs its 200 d SMA: bull / bear
Outcome: z = ln(C[t+21]/C[t]) / (IV30 * sqrt(21/252)).
Market odds (IV-only, lognormal, zero drift): P(z < -k) = Phi(-k + s/2), s = IV*sqrt(21/252).
Events: k = 0.5, 1.0, 1.5 down (put ITM at that depth) and k = 1.0 up.
Held-out: leave-one-year-out. Models: market; market + one global excess (plain IV-overprice
correction = the comparator a state tilt must beat); market + shrunk state-cell excess (m = 200).
Brier diff SE clustered by month. Sample = one obs per ticker-week (Fridays).
Caveat: universe = tickers alive today (survivorship) -> left tail understated.
"""
import os, sys, math
import numpy as np, pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from build_plan import connect

H, M_SHRINK = 21, 200
_cur = connect().execute("""select ticker, date, close, iv30_put, iv30_call from lseg_research.daily_history
                    where close > 0 and date >= '2012-01-01' order by ticker, date""")
df = pd.DataFrame(_cur.fetchall(), columns=['ticker', 'date', 'close', 'iv30_put', 'iv30_call'])
df['date'] = pd.to_datetime(df['date'])
spy = df[df.ticker == 'SPY'].set_index('date')['close']
spy_bull = (spy > spy.rolling(200).mean()).rename('bull')

df['close'] = df['close'].astype(float)
_g = df.groupby('ticker')['close']
df['rv20'] = _g.transform(lambda c: np.log(c).diff().rolling(20).std() * math.sqrt(252))
df['dd'] = 1 - df['close'] / _g.transform(lambda c: c.rolling(60).max())
df['c_fwd'] = _g.shift(-H)
iv = df[['iv30_put', 'iv30_call']].astype(float).mean(axis=1) / 100
df['iv'] = iv
df = df[(df.iv > 0.05) & (df.iv < 3) & df.c_fwd.notna() & df.rv20.gt(0) & df.dd.notna()]
df = df[df.date.dt.day_of_week == 4].join(spy_bull, on='date').dropna(subset=['bull'])
df = df[df.ticker != 'SPY']
s = df.iv * math.sqrt(H / 252)
df['z'] = np.log(df.c_fwd / df.close) / s
df['s'] = s
df['dd_b'] = pd.cut(df.dd, [-1, .05, .15, .30, 2], labels=['dd<5', 'dd5-15', 'dd15-30', 'dd>30'])
df['vrp_b'] = pd.cut(df.iv / df.rv20, [0, .9, 1.3, 99], labels=['iv<0.9rv', 'iv0.9-1.3', 'iv>1.3rv'])
df['spy_b'] = np.where(df.bull.astype(bool), 'bull', 'bear')
df['cell'] = df.dd_b.astype(str) + '|' + df.vrp_b.astype(str) + '|' + df.spy_b
df['iv_b'] = pd.cut(df.iv, [0, .3, .5, .8, 3], labels=['iv<30', 'iv30-50', 'iv50-80', 'iv>80']).astype(str)
if os.environ.get('CELL') == 'iv': df['cell'] = df.iv_b
if os.environ.get('CELL') == 'iv_dd': df['cell'] = df.iv_b + '|' + df.dd_b.astype(str)
df = df[df.date >= '2020-01-01']  # pre-2020 has ~100 obs/yr
df['year'] = df.date.dt.year
df['month'] = df.date.dt.to_period('M')
Phi = lambda x: 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))

print(f"n obs {len(df):,} · tickers {df.ticker.nunique()} · {df.date.min():%Y-%m} → {df.date.max():%Y-%m}")
print("\n== cell counts + z quantiles (pooled all years) ==")
q = df.groupby('cell').z.describe(percentiles=[.05, .1, .25, .5, .75, .9, .95])
print(q[['count', '5%', '10%', '25%', '50%', '75%', '90%', '95%']].round(2).to_string())
print(f"normal ref: 5% -1.64 · 10% -1.28 · 25% -0.67 · 50% 0 · 95% +1.64")

events = {'dn0.5': (-0.5, 'lt'), 'dn1.0': (-1.0, 'lt'), 'dn1.5': (-1.5, 'lt'), 'up1.0': (1.0, 'gt')}
rows = []
for name, (k, side) in events.items():
    hit = (df.z < k) if side == 'lt' else (df.z > k)
    mkt = Phi(k + df.s / 2) if side == 'lt' else 1 - Phi(k + df.s / 2)
    d = pd.DataFrame({'hit': hit.astype(float), 'mkt': mkt, 'cell': df.cell, 'year': df.year, 'month': df.month})
    d['exc'] = d.hit - d.mkt
    p_glob = np.empty(len(d)); p_cell = np.empty(len(d))
    for y in sorted(d.year.unique()):
        te = (d.year == y).values; tr = ~te
        g = d.exc[tr].mean()
        cs = d[tr].groupby('cell').exc.agg(['sum', 'count'])
        # shrink cell excess toward the global excess by n/(n+m)
        cell_exc = (cs['sum'] + M_SHRINK * g) / (cs['count'] + M_SHRINK)
        p_glob[te] = d.mkt[te] + g
        p_cell[te] = d.mkt[te] + d.cell[te].map(cell_exc).fillna(g).values
    d['p_glob'] = np.clip(p_glob, 1e-4, 1 - 1e-4); d['p_cell'] = np.clip(p_cell, 1e-4, 1 - 1e-4)
    for m in ['mkt', 'p_glob', 'p_cell']:
        d['b_' + m] = (d[m] - d.hit) ** 2
    mo = d.groupby('month')[['b_mkt', 'b_glob' if False else 'b_p_glob', 'b_p_cell']].mean()
    diff = mo.b_p_cell - mo.b_p_glob
    t = diff.mean() / (diff.std() / math.sqrt(len(diff)))
    # calibration slope of cell model: regress hit on p_cell
    slope = np.polyfit(d.p_cell, d.hit, 1)[0]
    rows.append(dict(event=name, base_rate=d.hit.mean(), mkt_p=d.mkt.mean(), brier_mkt=d.b_mkt.mean(),
                     brier_glob=d.b_p_glob.mean(), brier_cell=d.b_p_cell.mean(), cell_vs_glob_t=t, calib_slope=slope))
    cellt = d.groupby('cell').agg(n=('hit', 'size'), hit=('hit', 'mean'), mkt=('mkt', 'mean'))
    cellt['excess_pp'] = (cellt.hit - cellt.mkt) * 100
    print(f"\n== {name}: hit vs market odds by cell (pp) ==")
    print(cellt.round(3).to_string())
print("\n== held-out (leave-one-year-out) Brier ==")
print(pd.DataFrame(rows).round(4).to_string(index=False))

print("\n== dn1.0 by IV level (is the -s/2 lognormal drift right?) ==")
df['iv_b'] = pd.cut(df.iv, [0, .3, .5, .8, 3], labels=['iv<30', 'iv30-50', 'iv50-80', 'iv>80'])
df['hit1'] = (df.z < -1).astype(float); df['mkt1'] = Phi(-1 + df.s / 2); df['nodrift1'] = 0.1587
print(df.groupby('iv_b', observed=True).agg(n=('z', 'size'), hit=('hit1', 'mean'), mkt=('mkt1', 'mean'),
      med_z=('z', 'median'), sd_z=('z', 'std'), tickers=('ticker', 'nunique')).round(3).to_string())
print("by year:"); print(df.groupby('year').agg(n=('z', 'size'), hit=('hit1', 'mean'), mkt=('mkt1', 'mean')).round(3).T.to_string())
