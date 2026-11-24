"""Panic-day structure comparison: long call vs bull call spread vs short put vs stock.
Event = VIX >= vmin AND VIX/VIX3M >= inv AND idx close >= dd below 20d high. Decluster: gap >= 10 td.
BS marks, IV from VIX (ATM = 0.9*VIX for SPY; QQQ = 1.15*SPY-ATM), skew: 5% OTM put +4 vol, +5% call -2 vol.
Exit IV uses VIX at exit day (vol crush captured). Rates 0.
"""
import pickle, sys, math
import numpy as np, pandas as pd
from scipy.stats import norm

S = sys.argv[1]
d = pickle.load(open('/Users/jamiepark/.fildi/cache/fast_screen_bars_2003.pkl', 'rb'))
C = d['c']
vix = pd.read_csv(f'{S}/fred/VIXCLS.csv', index_col=0, parse_dates=True).iloc[:, 0]
v3 = pd.read_csv(f'{S}/fred/VXVCLS.csv', index_col=0, parse_dates=True).iloc[:, 0]
vix = pd.to_numeric(vix, errors='coerce'); v3 = pd.to_numeric(v3, errors='coerce')

def bs(S0, K, T, iv, call):
    if T <= 1e-6:
        return max(S0 - K, 0) if call else max(K - S0, 0)
    s = iv * math.sqrt(T); d1 = (math.log(S0 / K) + 0.5 * s * s) / s; d2 = d1 - s
    return S0 * norm.cdf(d1) - K * norm.cdf(d2) if call else K * norm.cdf(-d2) - S0 * norm.cdf(-d1)

def run(tk, vmin, inv, dd, H=(1, 5, 20), ivmult=0.9):
    px = C[tk].dropna()
    df = pd.DataFrame({'c': px}).join(vix.rename('vix')).join(v3.rename('v3')).dropna()
    df['hi20'] = df.c.rolling(20).max(); df['ma200'] = df.c.rolling(200).mean()
    trig = (df.vix >= vmin) & (df.vix / df.v3 >= inv) & (df.c <= df.hi20 * (1 - dd))
    idx = list(df.index); out = []; last = -99
    for i, t in enumerate(idx):
        if not trig.iloc[i] or i - last < 10 or i + max(H) >= len(idx):
            if trig.iloc[i]: last = i if i - last >= 10 else last
            continue
        last = i
        s0, iv0 = df.c.iloc[i], df.vix.iloc[i] / 100 * ivmult
        T0 = 30 / 365
        row = {'date': t.date(), 'vix': round(df.vix.iloc[i], 1), 'bull_regime': df.c.iloc[i] > df.ma200.iloc[i]}
        c0 = bs(s0, s0, T0, iv0, True); c5 = bs(s0, s0 * 1.05, T0, iv0 - .02, True)
        p0 = bs(s0, s0 * .95, T0, iv0 + .04, False)
        for h in H:
            sh, ivh = df.c.iloc[i + h], df.vix.iloc[i + h] / 100 * ivmult
            Th = max(T0 - (idx[i + h] - t).days / 365, 0)
            ch = bs(sh, s0, Th, ivh, True); c5h = bs(sh, s0 * 1.05, Th, ivh - .02, True)
            ph = bs(sh, s0 * .95, Th, ivh + .04, False)
            row[f'stk{h}'] = sh / s0 - 1
            row[f'call{h}'] = ch / c0 - 1                      # % on premium
            row[f'bcs{h}'] = (ch - c5h) / (c0 - c5) - 1         # % on debit
            row[f'put{h}'] = (p0 - ph) / (s0 * .95)             # % on cash collateral
            row[f'putm{h}'] = (p0 - ph) / (s0 * .95 * .20)      # % on ~20% Reg-T margin
        out.append(row)
    return pd.DataFrame(out)

pd.set_option('display.width', 220)
for tk, vmin, inv, dd, mult in [('SPY', 30, 1.0, .07, .9), ('SPY', 25, 1.0, .05, .9), ('QQQ', 30, 1.0, .07, 1.04), ('QQQ', 25, 1.0, .05, 1.04)]:
    r = run(tk, vmin, inv, dd, ivmult=mult)
    print(f'\n== {tk} VIX>={vmin} inverted dd>={dd:.0%}: n={len(r)}  (bull-regime {r.bull_regime.sum()} / bear {(~r.bull_regime).sum()})')
    for h in (1, 5, 20):
        cols = [f'stk{h}', f'call{h}', f'bcs{h}', f'put{h}', f'putm{h}']
        m = r[cols].mean(); w = (r[cols] > 0).mean(); med = r[cols].median()
        print(f' h{h:>2} mean ' + ' '.join(f'{c[:-len(str(h))]}={m[c]*100:+6.1f}%' for c in cols)
              + ' | win ' + ' '.join(f'{w[c]*100:3.0f}' for c in cols) + ' | med call ' + f'{med[f"call{h}"]*100:+.0f}%')
        for reg, g in r.groupby('bull_regime'):
            print(f'     {"above200" if reg else "below200"} n={len(g):>2} stk={g[f"stk{h}"].mean()*100:+5.1f}% call={g[f"call{h}"].mean()*100:+6.1f}% bcs={g[f"bcs{h}"].mean()*100:+6.1f}% put={g[f"put{h}"].mean()*100:+5.2f}% putm={g[f"putm{h}"].mean()*100:+5.1f}%')
    if tk == 'SPY' and vmin == 30:
        r.to_csv(f'{S}/panic_spy.csv', index=False)
        print(r[['date', 'vix', 'bull_regime', 'stk1', 'stk20', 'call20', 'bcs20', 'put20']].round(3).to_string(index=False))
