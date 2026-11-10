"""S176b — sector-first stock narrowing: does a cheap shortlist keep the names that move most? (trade-funnel step 2)

Jamie 11-09: "stocks too, start by checking sector, then narrow down which stocks to check, not do all, based on daily
intraday movements." Plan: research/common/trade-funnel-plan.md.

Pre-registered (11-09, before any run):
  universe   LSEG daily_history names with a GICS industry (research_common.security_class), close ≥ $5, every session 2019-06 →.
  group      GICS industry with ≥ 5 names that day.
  shortlists (built from data at the close of day d):
    G60   names in the top k and bottom k industries by median 60-session return
    G1    names in the top k and bottom k industries by median 1-session return (today's sector move)
    MOV   the M names with the largest |1-session return ÷ own 20-day σ| (single-name movers)
    FUNNEL = G60 ∪ G1 ∪ MOV   (k = 5, M = 40)
  winners    view-specific, forward 21 sessions from close d: bull = top decile return, bear = bottom decile, vol = top
             decile |return| ÷ own 20-day σ.
  recall     share of winners inside the shortlist; size = shortlist ÷ universe; lift = recall ÷ size (random = 1.0).
  pass       FUNNEL recall ≥ 80 % for every view at size ≤ 50 %, both halves (2019-06–2022 / 2023 →). Also k = 3, 8 and
             M = 20, 80 reported as the recall curve (not a re-pick of the bar).
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

START, SPLIT = date(2019, 6, 1), date(2023, 1, 1)
OUT = HERE.parent / "out/opt/S176.md"
DATA = HERE.parent.parent.parent / "research/studies/data/s176_sector_narrowing.json"
VIEWS = ("bull", "bear", "vol")


def load(conn):
    ind = dict(conn.execute("SELECT ticker, gics_industry FROM research_common.security_class WHERE gics_industry IS NOT NULL").fetchall())
    px = defaultdict(list)
    for t, d, c in conn.execute("""SELECT ticker, date, close::float8 FROM lseg_research.daily_history
                                   WHERE ticker = ANY(%s) AND date >= '2018-12-01' AND close > 0 ORDER BY ticker, date""", (list(ind),)):
        px[t].append((d, c))
    return ind, px


def build(ind, px):
    """{day: {ticker: (ret1, ret60, z1, fwd21, fwdz)}} on a shared calendar."""
    days = sorted({d for v in px.values() for d, _ in v if d >= START})
    pos = {d: k for k, d in enumerate(days)}
    out = defaultdict(dict)
    for t, rows in px.items():
        ds = [d for d, _ in rows]
        cs = np.array([c for _, c in rows])
        lr = np.diff(np.log(cs))
        for i in range(61, len(rows) - 21):
            d = ds[i]
            if d < START or cs[i] < 5 or d not in pos:
                continue
            if (ds[i + 21] - d).days > 40:
                continue
            sig = lr[i - 20:i].std() if i >= 21 else 0
            if not sig or sig <= 0:
                continue
            r1 = cs[i] / cs[i - 1] - 1
            fwd = cs[i + 21] / cs[i] - 1
            out[d][t] = (r1, cs[i] / cs[i - 60] - 1, abs(math.log(cs[i] / cs[i - 1])) / sig, fwd,
                         abs(math.log(cs[i + 21] / cs[i])) / (sig * math.sqrt(21)))
    return out


def shortlist(row, ind, k, m):
    g = defaultdict(list)
    for t in row:
        g[ind[t]].append(t)
    g = {i: ts for i, ts in g.items() if len(ts) >= 5}
    m60 = sorted(g, key=lambda i: statistics.median(row[t][1] for t in g[i]))
    m1 = sorted(g, key=lambda i: statistics.median(row[t][0] for t in g[i]))
    pick = {"G60": set(), "G1": set()}
    for name, order in (("G60", m60), ("G1", m1)):
        for i in order[:k] + order[-k:]:
            pick[name].update(g[i])
    pick["MOV"] = set(sorted(row, key=lambda t: -row[t][2])[:m])
    pick["FUNNEL"] = pick["G60"] | pick["G1"] | pick["MOV"]
    return pick


def winners(row):
    ts = list(row)
    n = max(1, len(ts) // 10)
    by_f = sorted(ts, key=lambda t: row[t][3])
    return {"bull": set(by_f[-n:]), "bear": set(by_f[:n]), "vol": set(sorted(ts, key=lambda t: row[t][4])[-n:])}


def main():
    with connect() as conn:
        ind, px = load(conn)
    panel = build(ind, px)
    days = sorted(d for d, r in panel.items() if len(r) >= 200)
    print(f"{len(days)} days, median {int(np.median([len(panel[d]) for d in days]))} names/day", flush=True)
    grid = [(5, 40), (3, 20), (3, 40), (5, 20), (5, 80), (8, 40), (8, 80)]
    res = {}
    for k, m in grid:
        acc = defaultdict(lambda: defaultdict(list))   # (list, view) -> half -> recall; size
        for d in days:
            row = panel[d]
            sl, w = shortlist(row, ind, k, m), winners(row)
            h = "h1" if d < SPLIT else "h2"
            for name, s in sl.items():
                acc[(name, "size")][h].append(len(s) / len(row))
                for v in VIEWS:
                    acc[(name, v)][h].append(len(s & w[v]) / len(w[v]))
        res[(k, m)] = {f"{a}|{b}": {h: float(np.mean(x)) for h, x in hs.items()} for (a, b), hs in acc.items()}
        f = res[(k, m)]
        print(f"k={k} M={m}: FUNNEL size {f['FUNNEL|size']['h1']:.0%}/{f['FUNNEL|size']['h2']:.0%} · " +
              " · ".join(f"{v} {f[f'FUNNEL|{v}']['h1']:.0%}/{f[f'FUNNEL|{v}']['h2']:.0%}" for v in VIEWS), flush=True)
    base = res[(5, 40)]
    L = ["# S176b — sector-first stock narrowing (recall of the next 21 sessions' biggest movers)", "",
         f"{len(days)} sessions 2019-06 →, median {int(np.median([len(panel[d]) for d in days]))} names/day, 58 GICS industries. "
         "Halves 2019-06–2022 / 2023 →. Recall = share of the top-decile forward-21-session names inside the shortlist; "
         "random shortlist recall = its size.", "",
         "| Shortlist (k=5, M=40) | size | bull recall | bear recall | vol recall |", "|---|---|---|---|---|"]
    for name in ("G60", "G1", "MOV", "FUNNEL"):
        z = base[f"{name}|size"]
        L.append(f"| {name} | {z['h1']:.0%} / {z['h2']:.0%} | " + " | ".join(
            f"{base[f'{name}|{v}']['h1']:.0%} / {base[f'{name}|{v}']['h2']:.0%} (lift {np.mean([base[f'{name}|{v}'][h] / z[h] for h in ('h1', 'h2')]):.2f})"
            for v in VIEWS) + " |")
    L += ["", "Recall curve (FUNNEL):", "", "| k | M | size | bull | bear | vol |", "|---|---|---|---|---|---|"]
    for (k, m), f in res.items():
        L.append(f"| {k} | {m} | {np.mean(list(f['FUNNEL|size'].values())):.0%} | " +
                 " | ".join(f"{np.mean(list(f[f'FUNNEL|{v}'].values())):.0%}" for v in VIEWS) + " |")
    ok = all(base[f"FUNNEL|{v}"][h] >= 0.8 for v in VIEWS for h in ("h1", "h2")) and max(base["FUNNEL|size"].values()) <= 0.5
    L += ["", f"Pre-registered pass (k=5, M=40: recall ≥ 80 % every view, both halves, size ≤ 50 %): **{'PASS' if ok else 'FAIL'}**"]
    OUT.write_text("\n".join(L) + "\n")
    DATA.write_text(json.dumps({f"{k}|{m}": v for (k, m), v in res.items()}, indent=1))
    print("\n".join(L))


if __name__ == "__main__":
    main()
