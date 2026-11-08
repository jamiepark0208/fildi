"""Prototype: vectorized leg-path pricing + exit rules as array ops. Speed + parity vs scalar loop."""
import sys, time, math, numpy as np, pandas as pd, psycopg
from scipy.special import ndtr, ndtri
URL = open('/Users/jamiepark/Cursor/fildi/.env.local').read().split('DATABASE_URL=')[1].split('\n')[0]
N_T = int(sys.argv[1]) if len(sys.argv) > 1 else 30
with psycopg.connect(URL) as c:
    tk = [r[0] for r in c.execute("select ticker from lseg_research.daily_history where date>='2021-01-01' and iv30_put is not null group by 1 order by count(*) desc limit %s", (N_T,))]
    df = pd.read_sql("select ticker,date,close::float c,iv30_put::float ivp,iv30_call::float ivc from lseg_research.daily_history where ticker = any(%s) and date between '2021-01-01' and '2023-12-31' order by ticker,date", c, params=(tk,))
for col in ('ivp', 'ivc'):
    df[col] = df[col].where(df[col] < 5, df[col] / 100)  # percent → decimal if needed
H = 32  # max path length (trading days) for ~45 cal DTE
def bs(S, K, v, T, call):
    T = np.maximum(T, 1/365); sd = v*np.sqrt(T); d1 = (np.log(S/K)+0.5*sd*sd)/sd; d2 = d1-sd
    return np.where(call, S*ndtr(d1)-K*ndtr(d2), K*ndtr(-d2)-S*ndtr(-d1))
def strike(S, v, T, dl, call):  # strike at |delta| dl
    sd = v*np.sqrt(T); d1 = ndtri(dl) if call else -ndtri(dl)
    return S*np.exp(-(d1*sd - 0.5*sd*sd))
t0 = time.time(); n_marks = 0; out = []
LEGS = [("put", .16, -1), ("put", .08, +1), ("call", .16, -1), ("call", .08, +1)]  # iron condor
for t, g in df.groupby('ticker'):
    S = g.c.values; ivp = np.r_[g.ivp.values[:1], g.ivp.values[:-1]]; ivc = np.r_[g.ivc.values[:1], g.ivc.values[:-1]]
    dates = pd.to_datetime(g.date).values; n = len(S)
    ent = np.where((pd.to_datetime(g.date).dt.weekday.values == 0) & (np.arange(n) < n-H))[0]
    if not len(ent): continue
    idx = ent[:, None] + np.arange(H)[None, :]            # (E, H) path rows
    Tleft = np.maximum((H-1-np.arange(H))[None, :] * 1.4/365, 1/365) * np.ones((len(ent), 1))
    T0 = Tleft[:, 0]
    V = np.zeros((len(ent), H)); credit = np.zeros(len(ent)); Ks = []
    for side, dl, q in LEGS:
        call = side == "call"; iv = ivc if call else ivp
        K = strike(S[ent], iv[ent], T0, dl, call); Ks.append(K)
        path = bs(S[idx], K[:, None], iv[idx], Tleft, call)   # one call prices the whole path for all entries
        path[:, -1] = np.maximum(S[idx[:, -1]]-K, 0) if call else np.maximum(K-S[idx[:, -1]], 0)
        V += q * path; n_marks += path.size
        credit += -q * path[:, 0]
    pnl = credit[:, None] + V                               # mark-to-market P&L if closed day k
    wid = np.maximum(Ks[0]-Ks[1], Ks[3]-Ks[2]); bp = wid - credit
    res = {}
    for name, rule in {"hold": None, "tp50": pnl >= .5*credit[:, None], "tp25": pnl >= .25*credit[:, None],
                       "stop2x": pnl <= -2*credit[:, None], "d21": (np.arange(H) >= H-15)[None, :] & np.ones_like(pnl, bool)}.items():
        if rule is None: k = np.full(len(ent), H-1)
        else:
            r = rule.copy(); r[:, 0] = False; r[:, -1] = True; k = r.argmax(1)
        res[name] = pnl[np.arange(len(ent)), k] / bp
    out.append((t, ent, credit, bp, res, Ks, S, idx, ivp, ivc, Tleft))
dt = time.time() - t0
E = sum(len(o[1]) for o in out)
print(f"tickers {len(out)} entries {E} leg-marks {n_marks:,} time {dt:.2f}s → {n_marks/dt/1e6:.1f}M marks/s")
for k in ("hold", "tp50", "tp25", "stop2x", "d21"):
    v = np.concatenate([o[4][k] for o in out]); v = v[np.isfinite(v)]; print(f"  {k:6s} mean/BP {v.mean()*100:+.2f}%  win {(v>0).mean()*100:.0f}%  n {len(v)}")
# parity: scalar re-price of one trade's day-10 mark
t, ent, credit, bp, res, Ks, S, idx, ivp, ivc, Tl = out[0]; e, k = 3, 10
def bs1(S, K, v, T, call):
    sd = v*math.sqrt(T); d1 = (math.log(S/K)+0.5*sd*sd)/sd; d2 = d1-sd; N = lambda x: 0.5*(1+math.erf(x/math.sqrt(2)))
    return S*N(d1)-K*N(d2) if call else K*N(-d2)-S*N(-d1)
r = idx[e, k]; sc = sum(q*bs1(S[r], Ks[j][e], (ivc if s == "call" else ivp)[r], Tl[e, k], s == "call") for j, (s, _, q) in enumerate(LEGS))
print(f"parity {t} entry {e} day {k}: scalar {credit[e]+sc:.4f} vs vector {credit[e] + sum(q*bs(S[r],Ks[j][e],(ivc if s=='call' else ivp)[r],Tl[e,k],s=='call') for j,(s,_,q) in enumerate(LEGS)):.4f}")
# scalar baseline: same marks via Python loop (what a per-trade engine does)
t1 = time.time(); m = 0
for t, ent, credit, bp, res, Ks, S, idx, ivp, ivc, Tl in out[:5]:
    for e in range(len(ent)):
        for k in range(H):
            r = idx[e, k]
            for j, (s, _, q) in enumerate(LEGS):
                bs1(S[r], Ks[j][e], (ivc if s == "call" else ivp)[r], Tl[e, k], s == "call"); m += 1
d1 = time.time() - t1; print(f"scalar loop: {m:,} marks {d1:.2f}s → {m/d1/1e6:.2f}M marks/s")
