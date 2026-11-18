#!/usr/bin/env python3
"""S197 (test queue #1, research/common/signal-enhancements-2026-11-17.md): panic puts × VIX÷VIX3M un-invert.

Pre-registered before running (Tosi–Ziegler: short puts do best moving from a high- to a low-vol state):
  Trades: S049 simulated 0.20Δ monthly put sales (watchlist_sync.study_trades; 2022 / 2025 / 2026; event + random-day base arms).
  Regime cell on entry day (VIX÷VIX3M from wrds_research.cboe_daily, prior close):
    UNINV = within 10 sessions after an S172 un-invert (ratio < 1 after ≥ 2 sessions ≥ 1)
    INV   = ratio ≥ 1 on the entry day (still in panic)
    CALM  = everything else
  Expected sign: UNINV > CALM > INV for panic puts; lift = event − same-cell base.
  Use = rank/size boost, never a filter (jamie-rules 11-17). Bar: UNINV event beats CALM event, p < 0.05 by
  un-invert-episode bootstrap, both in pooled and ≥ 2 of 3 years. Cell < 30 trades or < 5 episodes → can't answer.
"""
from __future__ import annotations
import random, sys
from bisect import bisect_left
from collections import defaultdict
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

rng = random.Random(7)
c = connect()
ix = defaultdict(dict)
for d, i, v in c.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M') AND date >= '2021-06-01'"):
    ix[d][i] = v
days = sorted(d for d in ix if len(ix[d]) == 2)
ratio = [ix[d]["VIX"] / ix[d]["VIX3M"] for d in days]
ep = []  # (episode start index)
for k in range(2, len(days)):
    if ratio[k] < 1 and ratio[k - 1] >= 1 and ratio[k - 2] >= 1 and (not ep or (days[k] - days[ep[-1]]).days > 14):
        ep.append(k)
last_vix = days[-1]


def cell(d):
    k = bisect_left(days, d) - 1  # prior close only (no look-ahead)
    if k < 0:
        return None, None
    for e in reversed(ep):
        if e <= k and k - e < 10:
            return "UNINV", days[e]
    return ("INV" if ratio[k] >= 1 else "CALM"), None


tr = []
for p, a, t, d, e, r, l, iv in c.execute(
        "SELECT period, arm, ticker, entry_d, exit_d, ret, loss, (feats->>'iv')::float FROM watchlist_sync.study_trades WHERE study='S049'"):
    if d > last_vix:
        continue
    cl, epd = cell(d)
    if cl:
        tr.append(dict(p=p, a=a, t=t, d=d, ret=float(r) * 100, itm=bool(l), iv=iv, cell=cl, ep=epd))

print(f"un-invert episodes in span: {sum(1 for e in ep if days[e].year >= 2022)} · VIX data to {last_vix} · trades {len(tr)}")
print("episodes:", ", ".join(str(days[e]) for e in ep if days[e].year >= 2022))


def stats(x):
    r = sorted(y["ret"] for y in x)
    if not r:
        return "n 0"
    w = r[: max(1, len(r) // 10)]
    return f"n {len(r):4} mean {sum(r)/len(r):+.2f} % ITM {100*sum(y['itm'] for y in x)/len(x):.0f} % worst10 {sum(w)/len(w):+.1f}"


for arm in ("event", "base"):
    for cl in ("UNINV", "CALM", "INV"):
        s = [x for x in tr if x["a"] == arm and x["cell"] == cl]
        neps = len({x["ep"] for x in s if x["ep"]})
        flag = "  ← can't answer at this n" if len(s) < 30 or (cl == "UNINV" and neps < 5) else ""
        print(f"{arm:5} {cl:5} {stats(s)}" + (f" · {neps} episodes" if cl == "UNINV" else "") + flag)
for yr in ("2022", "2025", "2026"):
    row = [yr]
    for cl in ("UNINV", "CALM", "INV"):
        s = [x["ret"] for x in tr if x["a"] == "event" and x["cell"] == cl and x["p"] == yr]
        row.append(f"{cl} {sum(s)/len(s):+.2f} (n {len(s)})" if s else f"{cl} —")
    print("event " + " · ".join(row))


def boot(a, b, n=4000):
    """p(mean a ≤ mean b), resampling clusters: a by un-invert episode, b by ISO week."""
    ga, gb = defaultdict(list), defaultdict(list)
    for x in a:
        ga[x["ep"]].append(x["ret"])
    for x in b:
        gb[x["d"].isocalendar()[:2]].append(x["ret"])
    ka, kb, bad = list(ga), list(gb), 0
    for _ in range(n):
        A = [r for k in (rng.choice(ka) for _ in ka) for r in ga[k]]
        B = [r for k in (rng.choice(kb) for _ in kb) for r in gb[k]]
        bad += sum(A) / len(A) <= sum(B) / len(B)
    return bad / n


U = [x for x in tr if x["a"] == "event" and x["cell"] == "UNINV"]
C = [x for x in tr if x["a"] == "event" and x["cell"] == "CALM"]
if U and C:
    print(f"p(UNINV event ≤ CALM event), episode bootstrap: {boot(U, C):.3f}")
hiv = [x for x in U if x["iv"] and x["iv"] > 48.7]
hivc = [x for x in C if x["iv"] and x["iv"] > 48.7]
print(f"IV > 48.7 only: UNINV {stats(hiv)} · CALM {stats(hivc)}")
print("per episode (event):", ", ".join(f"{e} {sum(y['ret'] for y in g)/len(g):+.1f} (n {len(g)})" for e, g in
      sorted({x['ep']: [y for y in U if y['ep'] == x['ep']] for x in U}.items())))

# --- #3 VIX-state sizing (Wysocki), pre-registered: size 1.5× in INV/UNINV, 1× CALM vs flat 1×; per-$ return
# and worst calendar month, both arms. Stressed runs counted as distinct inverted episodes (gap > 14 d).
runs, prev = [], None
for x in sorted((x for x in tr if x["cell"] in ("INV", "UNINV")), key=lambda x: x["d"]):
    if prev is None or (x["d"] - prev).days > 14:
        runs.append(x["d"])
    prev = x["d"]
print(f"\nstressed-state runs with trades: {len(runs)} ({', '.join(str(r) for r in runs)})")
for arm in ("event", "base"):
    for nm, w in (("flat", lambda x: 1.0), ("tilt", lambda x: 1.5 if x["cell"] != "CALM" else 1.0)):
        mon = defaultdict(lambda: [0.0, 0.0])
        for x in tr:
            if x["a"] == arm:
                m = mon[(x["d"].year, x["d"].month)]
                m[0] += w(x) * x["ret"]; m[1] += w(x)
        rets = {k: v[0] / v[1] for k, v in mon.items()}
        tot = sum(v[0] for v in mon.values()) / sum(v[1] for v in mon.values())
        print(f"{arm:5} {nm}: per-$ {tot:+.2f} % · worst month {min(rets.values()):+.2f} % · months < 0: {sum(r < 0 for r in rets.values())}/{len(rets)}")
