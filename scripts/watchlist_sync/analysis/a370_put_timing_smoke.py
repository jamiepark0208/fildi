"""Smoke v2: indicators as timing filters INSIDE the right universe.
SELL side = names in the top IV tercile that day (cross-sectional iv30_put rank); BUY side = bottom tercile.
Alt selection = IV/RV20 tercile (rich vs cheap relative to own realised vol).
B) daily panel (931 names, 2018-07 ->): seller edge = iv30 - realised vol next 5 days (vol pts); buyer edge = minus that.
A) real LSEG quotes: sold puts (bid+23% spread, held to expiry, bp of strike/wk) in SELL universe;
   bought puts/calls (ask-23% spread, % return on premium) in BUY universe.
Filters use bars <= d. arg1 = shift (1 = leak check).
"""
import re, sys
from datetime import date, timedelta
import numpy as np, pandas as pd
sys.path.insert(0, '/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync')
from build_plan import connect

SHIFT = int(sys.argv[1]) if len(sys.argv) > 1 else 0
EVAL0, EVAL1 = date(2018, 7, 1), date(2026, 11, 1)
FLAGS = ['rsi_lo', 'rsi_hi', 'st_bear', 'st_bull', 'squeeze', 'below200', 'drop5', 'relvol']
c = connect()
df = pd.DataFrame(c.execute(
    "SELECT ticker, date, high::float8, low::float8, close::float8, volume::float8, iv30_put::float8 "
    "FROM lseg_research.daily_history WHERE close > 0 ORDER BY ticker, date").fetchall(),
    columns=['t', 'd', 'h', 'l', 'c', 'v', 'iv'])


def ind(g):
    g = g.copy()
    c_, h, l = g.c, g.h.fillna(g.c), g.l.fillna(g.c)
    dlt = c_.diff()
    up, dn = dlt.clip(lower=0).ewm(alpha=1/14).mean(), (-dlt.clip(upper=0)).ewm(alpha=1/14).mean()
    rsi = 100 - 100 / (1 + up / dn)
    tr = pd.concat([h - l, (h - c_.shift()).abs(), (l - c_.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1/10).mean()
    hl2 = (h + l) / 2; ub = (hl2 + 3 * atr).values; lb = (hl2 - 3 * atr).values; cc = c_.values
    n = len(g); dirn = np.ones(n); fu, fl = ub.copy(), lb.copy()
    for i in range(1, n):
        fu[i] = ub[i] if (ub[i] < fu[i-1] or cc[i-1] > fu[i-1]) else fu[i-1]
        fl[i] = lb[i] if (lb[i] > fl[i-1] or cc[i-1] < fl[i-1]) else fl[i-1]
        dirn[i] = 1 if cc[i] > fu[i-1] else (-1 if cc[i] < fl[i-1] else dirn[i-1])
    m20, s20 = c_.rolling(20).mean(), c_.rolling(20).std()
    bw = 4 * s20 / m20
    lr = np.log(c_).diff()
    f = pd.DataFrame({
        'rsi_lo': rsi < 30, 'rsi_hi': rsi > 70, 'st_bear': dirn < 0, 'st_bull': dirn > 0,
        'squeeze': bw <= bw.rolling(120).quantile(0.2), 'below200': c_ < c_.rolling(200).mean(),
        'drop5': c_ / c_.shift(5) - 1 <= -0.05, 'relvol': g.v / g.v.rolling(20).mean().shift() >= 1.5}, index=g.index)
    if SHIFT:
        f = f.shift(SHIFT).fillna(False).astype(bool)
    g[FLAGS] = f
    g['rv20'] = lr.rolling(20).std() * np.sqrt(252)
    g['rv5f'] = lr[::-1].rolling(5).std()[::-1].shift(-1) * np.sqrt(252)
    g['ok'] = g.c.notna() & (np.arange(n) >= 200)
    return g

df = pd.concat([ind(g) for _, g in df.groupby('t', sort=False)])
df = df[df.ok & (df.d >= EVAL0) & (df.d < EVAL1) & (df.iv > 0)].copy()
df['iv'] /= 100
df['ivrv'] = df.iv / df.rv20
df['ivx'] = df.groupby('d').iv.rank(pct=True)
df['rvx'] = df.groupby('d').ivrv.rank(pct=True)
df['vrp'] = df.iv - df.rv5f
df['wk'] = pd.to_datetime(df.d).dt.to_period('W').astype(str)


def wt(x, g):
    """t of mean, clustered by week."""
    x = np.asarray(x, float); g = np.asarray(g)
    if len(x) < 20: return np.nan
    m = x.mean(); s = pd.Series(x - m).groupby(g).sum().values
    se = np.sqrt((s ** 2).sum()) / len(x)
    return m / se if se > 0 else np.nan


def table(sub, y, label, scale, unit):
    """filter on vs same-week others in the same universe."""
    sub = sub.dropna(subset=[y])
    rel = sub[y] - sub.groupby('wk')[y].transform('mean')
    half = pd.to_datetime(sub.d) >= pd.Timestamp('2023-01-01')
    print(f"\n{label}: N={len(sub)} names={sub.t.nunique()} base {sub[y].mean()*scale:+.1f}{unit}")
    print(f"{'filter':9} {'N on':>6} {'names':>5} {'on':>7} {'off':>7} {'vs wk':>7} {'t':>6} {'t pre23':>7} {'t 23+':>6}")
    for f in FLAGS:
        on = sub[f].astype(bool)
        if on.sum() < 20:
            print(f"{f:9} {on.sum():6}  too few"); continue
        print(f"{f:9} {on.sum():6} {sub.t[on].nunique():5} {sub[y][on].mean()*scale:+7.1f} {sub[y][~on].mean()*scale:+7.1f} "
              f"{rel[on].mean()*scale:+7.1f} {wt(rel[on], sub.wk[on]):6.2f} {wt(rel[on & ~half], sub.wk[on & ~half]):7.2f} {wt(rel[on & half], sub.wk[on & half]):6.2f}")

print(f"shift={SHIFT}  panel {EVAL0}->{EVAL1}  names {df.t.nunique()}")
# B) daily panel, sampled weekly (Mondays-ish: first day of each week per name) to cut overlap
wkly = df.sort_values('d').groupby(['t', 'wk']).head(1)
table(wkly[wkly.ivx >= 2/3], 'vrp', 'B SELL  top-IV tercile, seller edge IV-RV5fwd', 100, ' vol pts')
table(wkly[wkly.rvx >= 2/3], 'vrp', 'B SELL  top IV/RV tercile, seller edge', 100, ' vol pts')
wkly = wkly.assign(bvrp=-wkly.vrp)
table(wkly[wkly.ivx <= 1/3], 'bvrp', 'B BUY   bottom-IV tercile, buyer edge RV5fwd-IV', 100, ' vol pts')
table(wkly[wkly.rvx <= 1/3], 'bvrp', 'B BUY   bottom IV/RV tercile, buyer edge', 100, ' vol pts')

# A) real quotes
RIC = re.compile(r"^(.+?)([A-X])(\d\d)(\d\d)(\d{5})\.U(\^.*)?$")
q = {}
for ric, d, b, a in c.execute("SELECT ric, date, bid::float8, ask::float8 FROM optlab.lseg_opt_daily WHERE bid > 0 AND ask >= bid"):
    q.setdefault(ric, []).append((d, b, a))
close = df.set_index(['t', 'd']).c if False else None
px = {}
for t, d, cl in c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close > 0"):
    px[(t, d)] = cl
rows = []
for ric, qs in q.items():
    m = RIC.match(ric)
    if not m: continue
    root, L = m.group(1), m.group(2)
    put = L >= 'M'; mon = ord(L) - ord('M' if put else 'A') + 1
    try: exp = date(2000 + int(m.group(4)), mon, int(m.group(3)))
    except ValueError: continue
    k = int(m.group(5)) / 100
    qs.sort()
    ent = next((x for x in qs if 3 <= (exp - x[0]).days <= 9), None)
    if not ent: continue
    d, b, a = ent; S = px.get((root, d))
    ST = next((px[(root, exp - timedelta(days=n))] for n in range(4) if (root, exp - timedelta(days=n)) in px), None)
    if not S or ST is None or not (0.3 < k / S < 2): continue
    intr = max(k - ST, 0) if put else max(ST - k, 0)
    days = (exp - d).days
    sell = b + 0.23 * (a - b); buy = a - 0.23 * (a - b)
    rows.append({'t': root, 'd': d, 'put': put, 'otm': (S - k) / S if put else (k - S) / S,
                 'r_sell': (sell - intr) / k * 7 / days, 'r_buy': (intr - buy) / buy if buy > 0 else np.nan})
op = pd.DataFrame(rows)
op = op.merge(df[['t', 'd', 'ivx', 'rvx', 'wk'] + FLAGS], on=['t', 'd'], how='inner')
print(f"\nreal-quote options joined: {len(op)} (puts {op.put.sum()}, calls {(~op.put).sum()}), names {op.t.nunique()}")
sp = op[op.put & (op.otm > 0)]
table(sp[sp.ivx >= 2/3], 'r_sell', 'A SELL  OTM puts, top-IV tercile, bp strike/wk', 1e4, ' bp')
table(sp[sp.rvx >= 2/3], 'r_sell', 'A SELL  OTM puts, top IV/RV tercile', 1e4, ' bp')
table(sp[sp.ivx < 2/3], 'r_sell', 'A SELL  OTM puts, rest (comparator)', 1e4, ' bp')
lo = op[(op.ivx <= 1/3) & (op.otm > -0.05)]
table(lo[lo.put], 'r_buy', 'A BUY   puts, bottom-IV tercile, % on premium', 100, '%')
table(lo[~lo.put], 'r_buy', 'A BUY   calls, bottom-IV tercile, % on premium', 100, '%')
