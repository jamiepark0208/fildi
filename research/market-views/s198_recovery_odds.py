#!/usr/bin/env python3
"""S198 (Jamie 11-17: 'selloffs like this don't last… ~4 weeks average… I bought ~1m calls on high-beta names… prove/disprove').

Data checked: SPY LSEG daily_history 2009→; stocks CRSP dsf by permno 2009-04→2019 (px ≥ $5 at signal unless noted) + LSEG
daily_history 2020→. Weekly samples (Wednesdays) to limit overlap; n_indep = distinct weeks.

Part A — SPY drawdowns ≥ 5 % since 2009: days peak→trough and peak→recovery; forward 26 / 41 sessions when SPY is 4–8 % off
  a high set 30–60 sessions ago (today: −5.0 %, 41 days).
Part B — Jamie's call breakevens vs history. For a stock in the same state as today, P(stock ≥ breakeven at expiry) and
  P(stock ≥ strike) over 26 sessions (Dec 24) / 41 (Jan 15). States (pre-registered):
    SPEC_CRASHED: ≥ 60 % below its 252-session high, high ≥ 120 sessions ago (RGTI, ONDS, USAR, POET, OPEN)
    FAST_CRASH:   25–40 % below a high set ≤ 60 sessions ago (NVDA)
    MID_CRASHED:  45–60 % below its 252-session high (MP)
  Each also split by market cell: SPY 3–10 % off its high (today) vs other.
Expected (Jamie's view): P(≥ breakeven) above the option's own implied odds. Expected (S177): below.
"""
from __future__ import annotations
import math, sys
from collections import defaultdict
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402

c = connect()
spy = pd.Series(dict(c.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' AND close>0").fetchall())).sort_index()
spy.index = pd.to_datetime(spy.index)

# ---- Part A
hi = spy.cummax(); dd = spy / hi - 1
eps, in_dd, start = [], False, None
for d, v in dd.items():
    if not in_dd and v <= -0.05:
        in_dd, start = True, hi.loc[:d].idxmax() if False else spy.loc[:d].idxmax()
    if in_dd and v == 0:
        seg = dd.loc[start:d]
        eps.append(dict(peak=start, trough=seg.idxmin(), depth=seg.min(), rec=d))
        in_dd = False
print("== A. SPY drawdowns ≥ 5 % since 2009 (trading days)")
E = pd.DataFrame(eps)
E["to_trough"] = [len(spy.loc[a:b]) - 1 for a, b in zip(E.peak, E.trough)]
E["to_recover"] = [len(spy.loc[a:b]) - 1 for a, b in zip(E.peak, E.rec)]
for lo, hi_ in ((-0.10, -0.05), (-0.20, -0.10), (-1, -0.20)):
    s = E[(E.depth > lo) & (E.depth <= hi_)]
    if len(s):
        print(f"depth {hi_:+.0%}..{lo:+.0%}: n {len(s):2} · median to trough {s.to_trough.median():.0f} d · to recover {s.to_recover.median():.0f} d (max {s.to_recover.max()})")
print("all: median peak→trough", E.to_trough.median(), "d · peak→recovery", E.to_recover.median(), "d · n", len(E))
print("episodes:", "; ".join(f"{r.peak.date()} {r.depth:+.0%} trough {r.to_trough}d rec {r.to_recover}d" for r in E.itertuples()))
if in_dd:
    print(f"open episode: peak {start.date()} now {dd.iloc[-1]:+.1%} after {len(spy.loc[start:]) - 1} sessions")

# SPY conditional forward
sd = pd.DataFrame({"c": spy, "dd": dd})
sd["age"] = [len(spy.loc[spy.loc[:d].idxmax():d]) - 1 for d in sd.index]
for h in (26, 41):
    sd[f"f{h}"] = spy.shift(-h) / spy - 1
cond = sd[(sd.dd <= -0.04) & (sd.dd >= -0.08) & sd.age.between(30, 60)].dropna()
base = sd.dropna()
wk = cond.index.to_period("W").nunique()
print(f"SPY 4–8 % off a 30–60-session-old high: n_indep {wk} weeks · +26d {cond.f26.mean():+.2%} (up {100*(cond.f26>0).mean():.0f} %) vs any day {base.f26.mean():+.2%} ({100*(base.f26>0).mean():.0f} %) · +41d {cond.f41.mean():+.2%} vs {base.f41.mean():+.2%} · P(+41d < −5 %) {100*(cond.f41<-0.05).mean():.0f} % vs {100*(base.f41<-0.05).mean():.0f} %")
spy_off = dd

# ---- Part B panel
pan = {}
cur = None
rows = []
for t, d, ret, prc in c.execute("SELECT permno, date, ret::float8, abs(prc)::float8 FROM wrds_research.crsp_dsf WHERE date < '2020-03-01' AND ret IS NOT NULL ORDER BY permno, date"):
    if t != cur:
        if rows:
            pan[f"C:{cur}"] = rows
        cur, rows, ix = t, [], 100.0
    ix *= 1 + ret
    rows.append((d, ix, prc))
if rows:
    pan[f"C:{cur}"] = rows
cur, rows = None, []
for t, d, cl in c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close > 0 AND date >= '2019-01-01' ORDER BY ticker, date"):
    if t != cur:
        if rows:
            pan[f"L:{cur}"] = rows
        cur, rows = t, []
    rows.append((d, cl, cl))
if rows:
    pan[f"L:{cur}"] = rows

NEED = {  # Jamie's calls (11-05..11-16 buys), breakeven = strike + premium paid; spot 11-16 close
    "NVDA 165C 12-24": ("FAST_CRASH", 156.14, 165, 10.8, 26), "NVDA 180C 12-24": ("FAST_CRASH", 156.14, 180, 8.7, 26),
    "MP 40C 12-24": ("MID_CRASHED", 36.09, 40, 2.18, 26),
    "RGTI 10C 12-24": ("SPEC_CRASHED", 9.06, 10, 1.01, 26), "RGTI 12C 12-18": ("SPEC_CRASHED", 9.06, 12, 0.91, 22),
    "RGTI 10C 01-15": ("SPEC_CRASHED", 9.06, 10, 1.04, 41), "RGTI 11C 01-15": ("SPEC_CRASHED", 9.06, 11, 1.04, 41),
    "ONDS 6C 12-24": ("SPEC_CRASHED", 4.71, 6, 0.55, 26), "ONDS 5.5C 01-15": ("SPEC_CRASHED", 4.71, 5.5, 0.49, 41),
}
H = sorted({v[4] for v in NEED.values()})
samp = defaultdict(list)  # state → list of (week, mkt_cell, {h: fwd})
for key, r in pan.items():
    if len(r) < 300:
        continue
    d = [x[0] for x in r]; px = np.array([x[1] for x in r]); raw = np.array([x[2] if x[2] is not None else np.nan for x in r])
    s = pd.Series(px)
    hi252 = s.rolling(252, min_periods=200).max().values
    argage = s.rolling(252, min_periods=200).apply(lambda w: len(w) - 1 - int(np.argmax(w)), raw=True).values
    src = key[0]
    for i in range(252, len(r) - max(H)):
        if d[i].weekday() != 2:
            continue
        if (src == "C" and d[i].year >= 2020) or (src == "L" and d[i].year < 2020):
            continue
        if not (raw[i] >= 1):  # penny filter $1 (spec names trade $4–9 today)
            continue
        ddv = px[i] / hi252[i] - 1; age = argage[i]
        st = ("SPEC_CRASHED" if ddv <= -0.60 and age >= 120 else
              "FAST_CRASH" if -0.40 <= ddv <= -0.25 and age <= 60 else
              "MID_CRASHED" if -0.60 < ddv <= -0.45 else None)
        if not st:
            continue
        ts = pd.Timestamp(d[i]); so = spy_off.asof(ts)
        mk = "SPY 3–10 % off" if -0.10 <= so <= -0.03 else "other"
        samp[st].append((ts.to_period("W"), mk, {h: px[i + h] / px[i] - 1 for h in H}))

print("\n== B. Odds your calls finish above breakeven (history, same stock state)")
for st in ("FAST_CRASH", "MID_CRASHED", "SPEC_CRASHED"):
    for mk in ("SPY 3–10 % off", "all"):
        s = [x for x in samp[st] if mk == "all" or x[1] == mk]
        print(f"{st:12} {mk:15} n {len(s):6} · n_indep {len({x[0] for x in s}):4} wks · median +26d {np.median([x[2][26] for x in s]):+.1%} · mean {np.mean([x[2][26] for x in s]):+.1%}")
print()
for nm, (st, S, K, prem, h) in NEED.items():
    s = [x for x in samp[st] if x[1] == "SPY 3–10 % off"]
    f = np.array([x[2][h] for x in s])
    be = (K + prem) / S - 1; ks = K / S - 1
    payoff = np.maximum(S * (1 + f) - K, 0) / prem - 1
    print(f"{nm:16} needs {be:+.0%} in {h} sessions · P(≥ breakeven) {100*(f>=be).mean():3.0f} % · P(worthless) {100*(f<=ks).mean():3.0f} % · avg return on premium {payoff.mean():+.0%} (median {np.median(payoff):+.0%}) · n {len(f)}")

# ---- Part C (Jamie 11-17 follow-up: 'further OTM calls, longer expiry; deeper drawdown = more opportunity')
# Needs forward 63 / 126 sessions: rebuild samples with longer horizons (same states, SPY 3–10 % off cell + all).
from quantcore.bs import bs_call, years_from_sessions  # noqa: E402
HC = (41, 63, 126)
samp2 = defaultdict(list)
for key, r in pan.items():
    if len(r) < 300:
        continue
    d = [x[0] for x in r]; px = np.array([x[1] for x in r]); raw = np.array([x[2] if x[2] is not None else np.nan for x in r])
    s = pd.Series(px); hi252 = s.rolling(252, min_periods=200).max().values
    argage = s.rolling(252, min_periods=200).apply(lambda w: len(w) - 1 - int(np.argmax(w)), raw=True).values
    for i in range(252, len(r) - max(HC)):
        if d[i].weekday() != 2 or (key[0] == "C" and d[i].year >= 2020) or (key[0] == "L" and d[i].year < 2020) or not raw[i] >= 1:
            continue
        ddv = px[i] / hi252[i] - 1
        st = "SPEC_CRASHED" if ddv <= -0.60 and argage[i] >= 120 else "FAST_CRASH" if -0.40 <= ddv <= -0.25 and argage[i] <= 60 else None
        if st:
            samp2[st].append((pd.Timestamp(d[i]).to_period("W"), {h: px[i + h] / px[i] - 1 for h in HC}))
print("\n== C. Call grid: mean return on premium / P(profit), priced at today's IV (spec 90 %, NVDA-type 62 %)")
for st, iv in (("SPEC_CRASHED", 0.90), ("FAST_CRASH", 0.62)):
    for h in HC:
        f = np.array([x[1][h] for x in samp2[st]])
        cells = []
        for m in (1.0, 1.2, 1.4, 1.6, 2.0):
            prem = bs_call(spot=1.0, strike=m, iv=iv, years=years_from_sessions(h))
            pay = np.maximum(1 + f - m, 0) / prem - 1
            cells.append(f"K {m:.1f}×: {pay.mean():+.0%} (win {100*(pay>0).mean():.0f} %)")
        print(f"{st:12} {h:3} sessions n {len(f):5} · " + " · ".join(cells))
print("\n== C2. SPY: deeper drawdown → better long? forward 126 sessions by depth")
sd["f126"] = spy.shift(-126) / spy - 1
for lo, hi_ in ((-0.03, 0.01), (-0.05, -0.03), (-0.10, -0.05), (-0.20, -0.10), (-1, -0.20)):
    s = sd[(sd.dd > lo) & (sd.dd <= hi_)].dropna(subset=["f126"])
    print(f"SPY {hi_:+.0%}..{lo:+.0%} off high: n {len(s):4} ({s.index.to_period('M').nunique()} months) · +126d {s.f126.mean():+.1%} · up {100*(s.f126>0).mean():.0f} % · worst {s.f126.min():+.0%}")
