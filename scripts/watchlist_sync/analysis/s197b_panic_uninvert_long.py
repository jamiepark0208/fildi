#!/usr/bin/env python3
"""S197b — S197 on the long panel (Jamie 11-17: 'we have more than enough history').

Panel: CRSP dsf (total-return index) for entries 2017-04 → 2019-12; LSEG daily_history (close + iv30_put) for 2020 → now.
Panic event (S049 rule): 5-day log move ≤ −2σ of the prior 60 daily moves; one per name per 10 days.
Base arm: every name every Wednesday not within 10 days of its own event.
Trade: enter at the NEXT session's close after the signal (no look-ahead), sell the 0.20Δ put, 30 calendar days (BS, r = 0),
  IV = iv30_put when present, else RV60 × k (k = median iv30_put ÷ RV60 on LSEG rows); exit = intrinsic at close 21 sessions later.
  Return = (premium − intrinsic) ÷ strike, in %. Model-priced: compares cells, not a live fill.
Cells (prior-close VIX÷VIX3M, same as S197): UNINV ≤ 10 sessions after an un-invert · INV ratio ≥ 1 · CALM.
Pre-registered (unchanged from S197): UNINV > CALM > INV. S197 found INV best on 2022/25/26 → this run's OOS years
  (2017–21, 2023–24) test that. Bar: p < 0.05 by episode bootstrap with ≥ 30 episodes; otherwise UNDERPOWERED.
"""
from __future__ import annotations
import math, random, sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from quantcore.bs import bs_put, put_delta, years_from_days  # noqa: E402

rng = random.Random(11)
c = connect()
SPLITS = np.array([1/2, 1/3, 1/4, 1/5, 1/8, 1/10, 1/20, 2, 3, 4, 5, 8, 10, 20, 2/3, 3/2])

# --- VIX state
ix = defaultdict(dict)
for d, i, v in c.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')"):
    ix[d][i] = v
days = sorted(d for d in ix if len(ix[d]) == 2)
ratio = [ix[d]["VIX"] / ix[d]["VIX3M"] for d in days]
ep = []
for k in range(2, len(days)):
    if ratio[k] < 1 and ratio[k - 1] >= 1 and ratio[k - 2] >= 1 and (not ep or (days[k] - days[ep[-1]]).days > 14):
        ep.append(k)
inv_run = [None] * len(days)  # id of the inverted run a day belongs to (start date)
for k in range(len(days)):
    if ratio[k] >= 1:
        inv_run[k] = inv_run[k - 1] if k and ratio[k - 1] >= 1 and inv_run[k - 1] else days[k]


def cell(d):
    k = bisect_left(days, d) - 1
    if k < 0:
        return None, None
    for e in reversed(ep):
        if e <= k and k - e < 10:
            return "UNINV", days[e]
        if e < k - 10:
            break
    return ("INV", inv_run[k]) if ratio[k] >= 1 else ("CALM", None)


# --- price panels
pan = defaultdict(list)  # ticker → [(date, px, iv)]
for t, d, ret in c.execute("SELECT ticker, date, ret::float8 FROM wrds_research.crsp_dsf WHERE date < '2020-03-01' AND ret IS NOT NULL ORDER BY ticker, date"):
    p = pan["C:" + t]
    p.append((d, (p[-1][1] if p else 100.0) * (1 + ret), None))
for t, d, cl, iv in c.execute("SELECT ticker, date, close::float8, iv30_put::float8 FROM lseg_research.daily_history WHERE close > 0 AND date >= '2019-09-01' ORDER BY ticker, date"):
    pan["L:" + t].append((d, cl, iv if iv and iv > 0 else None))


def strike_for(S, v, T, dt=-0.20):
    """Strike whose BS put delta = dt (bisection on quantcore.bs.put_delta)."""
    lo, hi = S * 0.2, S
    for _ in range(60):
        m = (lo + hi) / 2
        (lo, hi) = (lo, m) if put_delta(spot=S, strike=m, iv=v, years=T) < dt else (m, hi)
    return (lo + hi) / 2


# k: iv30_put ÷ RV60 on LSEG rows
ks = []
for key, rows in pan.items():
    if key[0] != "L" or len(rows) < 70:
        continue
    px = np.array([r[1] for r in rows]); lr = np.diff(np.log(px))
    for i in range(61, len(rows), 21):
        if rows[i][2]:
            rv = lr[i - 60:i].std() * math.sqrt(252)
            if rv > 0.05:
                ks.append(rows[i][2] / 100 / rv)
K_IV = float(np.median(ks))
print(f"IV proxy k = median iv30_put ÷ RV60 = {K_IV:.2f} (n {len(ks)})")

T = years_from_days(30)
tr = []
for key, rows in pan.items():
    src = key[0]
    if len(rows) < 90:
        continue
    px = np.array([r[1] for r in rows]); lr = np.diff(np.log(px))
    jumps = px[1:] / px[:-1]
    last_ev = None
    evd = set()
    for i in range(66, len(rows) - 23):
        d = rows[i][0]
        if (src == "C" and not (date(2017, 4, 1) <= d < date(2020, 1, 1))) or (src == "L" and d < date(2020, 1, 1)):
            continue
        w = lr[i - 64:i - 4]
        sd = w.std(ddof=1)
        z = (math.log(px[i] / px[i - 5]) / (sd * math.sqrt(5))) if sd > 0 else 0
        is_ev = z <= -2 and (last_ev is None or (d - last_ev).days >= 10)
        if is_ev:
            last_ev = d
        is_base = (not is_ev) and d.weekday() == 2 and (last_ev is None or (d - last_ev).days > 10)
        if not (is_ev or is_base):
            continue
        j = i + 1  # enter next session close
        win = jumps[i - 65:j + 21]
        if np.any(np.min(np.abs(win[:, None] - SPLITS[None, :]) / SPLITS[None, :], axis=1) < 0.02):
            continue  # unadjusted split in window
        S = px[j]
        iv = rows[j][2] / 100 if rows[j][2] else lr[j - 60:j].std(ddof=1) * math.sqrt(252) * K_IV
        if not (0.05 < iv < 3):
            continue
        Kp = strike_for(S, iv, T)
        prem = bs_put(spot=S, strike=Kp, iv=iv, years=T)
        ST = px[j + 21]
        ret = (prem - max(Kp - ST, 0)) / Kp * 100
        cl, gid = cell(rows[j][0])
        if cl:
            tr.append(dict(a="event" if is_ev else "base", d=rows[j][0], y=rows[j][0].year, ret=ret, itm=ST < Kp,
                           iv=iv, real=rows[j][2] is not None, cell=cl, g=gid, src=src))

print(f"trades {len(tr)} · events {sum(x['a']=='event' for x in tr)} · span {min(x['d'] for x in tr)} → {max(x['d'] for x in tr)} · VIX to {days[-1]}")


def stats(x):
    r = sorted(y["ret"] for y in x)
    if not r:
        return "n 0"
    w = r[: max(1, len(r) // 10)]
    return f"n {len(r):6} mean {np.mean(r):+.2f} % ITM {100*np.mean([y['itm'] for y in x]):.0f} % worst10 {np.mean(w):+.1f}"


def boot(a, b, n=3000):
    """p(mean a ≤ mean b); a resampled by VIX episode/run, b by ISO week."""
    ga, gb = defaultdict(list), defaultdict(list)
    for x in a:
        ga[x["g"]].append(x["ret"])
    for x in b:
        gb[x["d"].isocalendar()[:2]].append(x["ret"])
    ka, kb = list(ga), list(gb)
    sa = {k: (sum(v), len(v)) for k, v in ga.items()}; sb = {k: (sum(v), len(v)) for k, v in gb.items()}
    bad = 0
    for _ in range(n):
        A = [sa[rng.choice(ka)] for _ in ka]; B = [sb[rng.choice(kb)] for _ in kb]
        bad += sum(s for s, _ in A) / sum(m for _, m in A) <= sum(s for s, _ in B) / sum(m for _, m in B)
    return bad / n


def table(sub, label):
    print(f"\n== {label}")
    for arm in ("event", "base"):
        for cl in ("UNINV", "CALM", "INV"):
            s = [x for x in sub if x["a"] == arm and x["cell"] == cl]
            ng = len({x["g"] for x in s})
            tag = f" · {ng} episodes" if cl != "CALM" else ""
            under = "  ← UNDERPOWERED (< 30 episodes)" if cl != "CALM" and ng < 30 else ""
            print(f"{arm:5} {cl:5} {stats(s)}{tag}{under}")
    E = {cl: [x for x in sub if x["a"] == "event" and x["cell"] == cl] for cl in ("UNINV", "CALM", "INV")}
    B = {cl: [x for x in sub if x["a"] == "base" and x["cell"] == cl] for cl in ("UNINV", "CALM", "INV")}
    for cl in ("UNINV", "INV"):
        if E[cl] and E["CALM"]:
            print(f"p(event {cl} ≤ event CALM) = {boot(E[cl], E['CALM']):.3f} · p(base {cl} ≤ base CALM) = {boot(B[cl], B['CALM']):.3f}")


table(tr, "all 2017-04 → now")
table([x for x in tr if x["y"] not in (2022, 2025, 2026)], "OOS years vs S197 (2017–21, 2023–24)")
table([x for x in tr if x["real"]], "real iv30_put only (LSEG)")
print("\nevent mean by year × cell:")
for y in sorted({x["y"] for x in tr}):
    row = [f"{y}"]
    for cl in ("UNINV", "CALM", "INV"):
        s = [x["ret"] for x in tr if x["a"] == "event" and x["cell"] == cl and x["y"] == y]
        row.append(f"{cl} {np.mean(s):+.2f} (n {len(s)})" if s else f"{cl} —")
    print(" · ".join(row))
print("\nsizing (event arm, per $ collateral, monthly):")
for nm, w in (("flat", lambda x: 1.0), ("1.5× stressed", lambda x: 1.5 if x["cell"] != "CALM" else 1.0),
              ("1.5× INV only", lambda x: 1.5 if x["cell"] == "INV" else 1.0)):
    mon = defaultdict(lambda: [0.0, 0.0])
    for x in tr:
        if x["a"] == "event":
            m = mon[(x["y"], x["d"].month)]; m[0] += w(x) * x["ret"]; m[1] += w(x)
    r = {k: v[0] / v[1] for k, v in mon.items()}
    tot = sum(v[0] for v in mon.values()) / sum(v[1] for v in mon.values())
    print(f"{nm:14} per-$ {tot:+.2f} % · worst month {min(r.values()):+.2f} % · 5th-pct month {np.percentile(list(r.values()), 5):+.2f} %")
