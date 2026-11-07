"""Quick check: long stock after daily RSI(14) drops below X. Signal at close t, fill open t+1.
Exits (first hit): RSI(14) > ceiling, or time stop N days. Cost 5 bp/side.
Base rate = same ticker, same hold, entered every day. Reports gate fields (A1–A7)."""
import pickle, sys
from pathlib import Path
import numpy as np, pandas as pd

pack = pickle.load(open(Path.home() / ".fildi/cache/fast_screen_bars.pkl", "rb"))
O, C = pack["o"], pack["c"]
SUBSET = sys.argv[1].split(",") if len(sys.argv) > 1 and sys.argv[1] != "ALL" else None
if SUBSET:
    O, C = O[[t for t in SUBSET if t in C.columns]], C[[t for t in SUBSET if t in C.columns]]
COST = 0.0005 * 2


def rsi(c, n=14):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn)


R = C.apply(rsi)
o, c, r = O.to_numpy(), C.to_numpy(), R.to_numpy()
dates = C.index
n, m = c.shape


def run(th, ceiling, max_hold):
    trades = []  # (ticker j, entry i, exit i, ret)
    for j in range(m):
        i = 15
        while i < n - 2:
            if r[i, j] < th and not (r[i - 1, j] < th) and np.isfinite(o[i + 1, j]):
                e = i + 1
                x = min(e + max_hold - 1, n - 1)
                for k in range(e, min(e + max_hold, n)):
                    if ceiling and r[k, j] > ceiling:
                        x = k
                        break
                if not np.isfinite(c[x, j]):
                    i += 1
                    continue
                trades.append((j, i, x, c[x, j] / o[e, j] - 1 - COST))
                i = x + 1
            else:
                i += 1
    return trades


def base(max_hold):
    fwd = (C.shift(-max_hold) / O.shift(-1) - 1 - COST).to_numpy()
    ok = np.isfinite(fwd)
    tick_mean = np.nanmean(fwd, axis=0)
    return float(fwd[ok].mean()), float((fwd[ok] > 0).mean()), tick_mean


def stats(tr, tick_mean=None):
    if not tr:
        return None
    rets = np.array([t[3] for t in tr])
    w, l = rets[rets > 0], rets[rets <= 0]
    days = len({t[1] for t in tr})  # N_eff proxy: distinct signal days
    pf = w.sum() / -l.sum() if l.sum() < 0 else np.inf
    # equal-weight per trade, sequential equity on signal date order for max DD
    order = np.argsort([t[1] for t in tr])
    eq = np.cumsum(rets[order])
    dd = float((eq - np.maximum.accumulate(eq)).min())
    hold = np.mean([t[2] - t[1] for t in tr])
    lift = float(np.mean([t[3] - tick_mean[t[0]] for t in tr])) if tick_mean is not None else np.nan
    return dict(lift=lift, n=len(rets), days=days, win=(rets > 0).mean(), mean=rets.mean(), med=np.median(rets),
                pf=pf, avg_w=w.mean() if len(w) else 0, avg_l=l.mean() if len(l) else 0,
                p5=np.percentile(rets, 5), dd_sum=dd, hold=hold)


print(f"A2 window {dates[0].date()} → {dates[-1].date()} bars {n} tickers {m}")
print(f"A3 min RSI14 {np.nanmin(r):.1f}; ticker-days < 10: {(r < 10).sum()}, < 15: {(r < 15).sum()}, < 20: {(r < 20).sum()}")
split = pd.Timestamp("2022-01-01")
for ceiling, hold in [(50, 10), (None, 5), (None, 10), (None, 20)]:
    b_mean, b_win, tm = base(hold)
    print(f"\nexit {'RSI>'+str(ceiling)+' or ' if ceiling else ''}{hold}d | base every-day: mean {b_mean*100:+.2f}% win {b_win:.0%}")
    print("  th     n  days   win   mean   med    PF  avgW   avgL    p5   hold  liftT | pre22 mean / post22 mean")
    for th in [5, 7.5, 10, 12.5, 15, 20, 25, 30]:
        tr = run(th, ceiling, hold)
        s = stats(tr, tm)
        if not s:
            print(f"  {th:<4}  0 trades")
            continue
        pre = [t[3] for t in tr if dates[t[1]] < split]
        post = [t[3] for t in tr if dates[t[1]] >= split]
        print(f"  {th:<4}{s['n']:>6}{s['days']:>6}{s['win']:>6.0%}{s['mean']*100:>+7.2f}{s['med']*100:>+6.2f}{s['pf']:>6.2f}"
              f"{s['avg_w']*100:>+6.1f}{s['avg_l']*100:>+7.1f}{s['p5']*100:>+6.1f}{s['hold']:>6.1f}{s['lift']*100:>+7.2f} | "
              f"{np.mean(pre)*100 if pre else float('nan'):+.2f} ({len(pre)}) / {np.mean(post)*100 if post else float('nan'):+.2f} ({len(post)})")
