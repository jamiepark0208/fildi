"""S159 — RSI extreme grid (Jamie 11-06: rare = opportunity; test many combinations).
Entry: first close where RSI(p) < th (cross), long next open, hold h days, 5 bp/side.
Day-clustered stats (N_eff = signal days): each signal day = mean of its trades.
Lift = trade return − same ticker's every-day return over the same hold.
Win CI = Wilson on day-level wins. BH-FDR over all cells on day-level lift t.
Also: SPY RSI(p) < th as a market condition → buy every stock that day (and SPY alone).
Usage: .venv/bin/python -I analysis/s159_rsi_grid.py [--min-days 8]
"""
import pickle, sys, math
from pathlib import Path
import numpy as np, pandas as pd

MIN_DAYS = int(sys.argv[sys.argv.index("--min-days") + 1]) if "--min-days" in sys.argv else 8
pack = pickle.load(open(Path.home() / ".fildi/cache/fast_screen_bars.pkl", "rb"))
O, C = pack["o"], pack["c"]
COST = 0.001
dates = C.index
SPLIT = np.searchsorted(dates.values, np.datetime64("2022-01-01"))


def rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn)


def wilson_lo(k, n, z=1.96):
    if n == 0:
        return float("nan")
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


HOLDS = [1, 2, 3, 5, 10, 20]
FWD = {h: (C.shift(-h) / O.shift(-1) - 1 - COST).to_numpy() for h in HOLDS}
TBASE = {h: np.nanmean(FWD[h], axis=0) for h in HOLDS}
c_np = C.to_numpy()
valid = np.isfinite(c_np) & (c_np > 1.0)  # skip sub-$1 prints


def cell(mask, h):
    f = FWD[h]
    ok = mask & np.isfinite(f)
    rows, cols = np.nonzero(ok)
    if len(rows) == 0:
        return None
    ret = f[rows, cols]
    lift = ret - TBASE[h][cols]
    df = pd.DataFrame({"d": rows, "ret": ret, "lift": lift})
    g = df.groupby("d").mean()
    nd = len(g)
    if nd < 2:
        return None
    wins = int((g["ret"] > 0).sum())
    lt = g["lift"].mean() / (g["lift"].std(ddof=1) / math.sqrt(nd)) if g["lift"].std(ddof=1) > 0 else 0.0
    pre, post = g[g.index < SPLIT], g[g.index >= SPLIT]
    return dict(n=len(ret), days=nd, win_trade=(ret > 0).mean(), win_day=wins / nd, win_lo=wilson_lo(wins, nd),
                mean=g["ret"].mean(), lift=g["lift"].mean(), t=lt,
                p5=np.percentile(ret, 5), pre=pre["lift"].mean() if len(pre) else np.nan,
                post=post["lift"].mean() if len(post) else np.nan, npre=len(pre), npost=len(post))


TH = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 35]
out = []
for p in [2, 3, 5, 7, 14]:
    R = C.apply(lambda s: rsi(s, p)).to_numpy()
    prev = np.vstack([np.full((1, R.shape[1]), np.nan), R[:-1]])
    for th in TH:
        cross = (R < th) & ~(prev < th) & valid
        for h in HOLDS:
            s = cell(cross, h)
            if s and s["days"] >= MIN_DAYS:
                out.append(dict(cond=f"stock RSI{p}<{th}", h=h, **s))

# market condition: SPY RSI
if "SPY" in C.columns:
    for p in [2, 5, 14]:
        rs = rsi(C["SPY"], p).to_numpy()
        prv = np.r_[np.nan, rs[:-1]]
        for th in TH:
            day = (rs < th) & ~(prv < th)
            if day.sum() < 2:
                continue
            m_all = np.zeros_like(valid)
            m_all[day, :] = True
            m_all &= valid
            m_spy = np.zeros_like(valid)
            m_spy[day, C.columns.get_loc("SPY")] = True
            for h in HOLDS:
                for tag, m in (("SPY RSI{}<{} → all stocks", m_all), ("SPY RSI{}<{} → SPY", m_spy)):
                    s = cell(m, h)
                    if s and s["days"] >= 3:
                        out.append(dict(cond=tag.format(p, th), h=h, **s))

df = pd.DataFrame(out)
# BH-FDR on two-sided p of day-level lift t (normal approx)
from scipy.stats import norm
df["p"] = 2 * (1 - norm.cdf(df["t"].abs()))
df = df.sort_values("p").reset_index(drop=True)
m = len(df)
df["q"] = (df["p"] * m / (np.arange(m) + 1))[::-1].cummin()[::-1].clip(upper=1)
df.to_csv(Path(__file__).resolve().parents[3] / "research/studies/out/s159_rsi_grid.csv", index=False)

print(f"window {dates[0].date()}→{dates[-1].date()} tickers {C.shape[1]} cells {m} (min {MIN_DAYS} signal days)")
cols = ["cond", "h", "n", "days", "win_trade", "win_day", "win_lo", "mean", "lift", "t", "q", "p5", "pre", "post", "npre", "npost"]
pd.set_option("display.width", 250, "display.max_columns", 30, "display.max_rows", 200)
fmt = lambda d: d[cols].round({"win_trade": 2, "win_day": 2, "win_lo": 2, "mean": 4, "lift": 4, "t": 2, "q": 3, "p5": 3, "pre": 4, "post": 4})
print("\n== FDR q < 0.10, lift > 0, both eras lift > 0 (robust), by lift ==")
rob = df[(df.q < 0.10) & (df.lift > 0) & (df.pre > 0) & (df.post > 0)].sort_values("lift", ascending=False)
print(fmt(rob.head(30)).to_string(index=False))
print("\n== Rare & strong: days < 60, win_lo > 0.55, lift > 0 ==")
rare = df[(df.days < 60) & (df.win_lo > 0.55) & (df.lift > 0)].sort_values("win_lo", ascending=False)
print(fmt(rare.head(25)).to_string(index=False))
print("\n== RSI14 frontier, hold 5 / 10 ==")
fr = df[df.cond.str.startswith("stock RSI14<") & df.h.isin([5, 10])].copy()
fr["th"] = fr.cond.str.split("<").str[1].astype(float)
print(fmt(fr.sort_values(["h", "th"])).to_string(index=False))
# today
r14 = C.apply(lambda s: rsi(s, 14)).iloc[-1]
print(f"\nToday {dates[-1].date()}: SPY RSI14 {r14.get('SPY', float('nan')):.1f}; stocks RSI14<25: {(r14 < 25).sum()}, <20: {(r14 < 20).sum()}, <10: {(r14 < 10).sum()}")
