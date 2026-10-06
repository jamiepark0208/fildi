#!/usr/bin/env python3
"""Monthly validation of the live blended fair value (monthly.py step). Read-only.

Uses our own fair_value_snapshots (which include the cash-flow DCF and StarMine votes the 2020-26 backtest could not
replay) and later LSEG/Yahoo closes:
  1 predictive  rank IC of log(fair/price) and of the ~3-month fair value change vs the next 63 trading days'
                peer-relative return (monthly cross-sections; needs ≥ 6 months of matured outcomes)
  2 stability   share of names whose fair value moved > 30% month-over-month while price moved < 5%
  3 coverage    valued names per month and extreme ratios (> 3x or < 1/3)
Report only — a change to the blend goes through a challenger row + compare-fair-value-params.ts + user approval.

Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/validate_snapshots.py
"""
import math
import os
import statistics as st
import sys
from bisect import bisect_left
from collections import defaultdict
from pathlib import Path

import numpy as np
import psycopg

OUT = Path(__file__).parent / "VALIDATION.md"
c = psycopg.connect(os.environ["DATABASE_URL"])
snaps = c.execute("""SELECT DISTINCT ON (ticker, date_trunc('month', as_of)) ticker, as_of, price::float, fair_value::float, mode
                     FROM fair_value_snapshots WHERE fair_value IS NOT NULL AND price > 0
                     ORDER BY ticker, date_trunc('month', as_of), as_of""").fetchall()
lines = ["# Fair value validation (live snapshots)\n"]
if not snaps:
    print("fair value validation: no snapshots yet")
    sys.exit(0)
months = sorted({s[1] for s in snaps})
span = (months[-1] - months[0]).days
lines.append(f"Snapshot months: {len(months)} ({months[0]} → {months[-1]}, {span} days).")

px = defaultdict(list)
for t, d, cl in c.execute("""SELECT ticker, date, close::float FROM lseg_research.daily_history WHERE close IS NOT NULL AND date >= %s
                             UNION ALL SELECT ticker, date, close::float FROM prices_historical WHERE close IS NOT NULL AND date >= %s
                             ORDER BY 1, 2""", (months[0], months[0])).fetchall():
    if not px[t] or px[t][-1][0] != d:
        px[t].append((d, cl))
grp = dict(c.execute("SELECT ticker, split_part(COALESCE(primary_peer_group_id,'x'),'.',1) FROM ticker_registry").fetchall())


def fwd(t, d, n=63):
    s = px.get(t, [])
    i = bisect_left([x[0] for x in s], d)
    return math.log(s[i + n][1] / s[i][1]) if i < len(s) and i + n < len(s) else None


by_month = defaultdict(dict)
for t, d, p, fv, mode in snaps:
    by_month[d.replace(day=1)][t] = (d, p, fv)
mkeys = sorted(by_month)

# 2 stability + 3 coverage
for i, m in enumerate(mkeys):
    cur = by_month[m]
    ext = sum(1 for _, p, fv in cur.values() if fv > 3 * p or fv < p / 3)
    jumps = None
    if i:
        prev = by_month[mkeys[i - 1]]
        both = [t for t in cur if t in prev]
        jumps = sum(1 for t in both if abs(math.log(cur[t][2] / prev[t][2])) > math.log(1.3)
                    and abs(math.log(cur[t][1] / prev[t][1])) < math.log(1.05))
        jumps = f"{jumps}/{len(both)}"
    lines.append(f"- {m:%Y-%m}: valued {len(cur)}, extremes {ext}, unexplained >30% moves {jumps or '—'}")


def ic(pairs):
    if len(pairs) < 30:
        return None
    a, b = np.array([x for x, _ in pairs]), np.array([y for _, y in pairs])
    return float(np.corrcoef(a.argsort().argsort(), b.argsort().argsort())[0, 1])


# 1 predictive (peer-relative = minus sector median forward return)
gap_ics, chg_ics = [], []
for i, m in enumerate(mkeys):
    rows = []
    for t, (d, p, fv) in by_month[m].items():
        r = fwd(t, d)
        if r is None:
            continue
        old = by_month[mkeys[i - 3]].get(t) if i >= 3 else None
        rows.append((t, math.log(fv / p), math.log(fv / old[2]) if old else None, r))
    if len(rows) < 30:
        continue
    sec = defaultdict(list)
    for t, _, _, r in rows:
        sec[grp.get(t, "x")].append(r)
    rel = [(g, ch, r - st.median(sec[grp.get(t, "x")])) for t, g, ch, r in rows]
    if (v := ic([(g, r) for g, _, r in rel])) is not None:
        gap_ics.append(v)
    if (v := ic([(ch, r) for _, ch, r in rel if ch is not None])) is not None:
        chg_ics.append(v)


def summ(name, xs):
    if len(xs) < 6:
        return f"{name}: {len(xs)} matured months (need ≥ 6)"
    t = st.mean(xs) / (st.pstdev(xs) / math.sqrt(len(xs) / 3)) if st.pstdev(xs) > 0 else 0
    return f"{name}: IC {st.mean(xs):+.3f} (t {t:+.1f}, {len(xs)} months, hit {sum(x > 0 for x in xs) / len(xs):.0%})"


lines += ["", "## Predictive (63-day peer-relative)", "- " + summ("fair/price gap", gap_ics), "- " + summ("3-month fair value change", chg_ics)]
OUT.write_text("\n".join(lines) + "\n")
print("\n".join(lines))
print(f"fair value validation: {len(months)} snapshot months; " + summ("gap", gap_ics) + "; " + summ("3m change", chg_ics))
