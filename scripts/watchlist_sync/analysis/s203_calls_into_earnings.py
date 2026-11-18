#!/usr/bin/env python3
"""S203 (signal-enhancements-2026-11-17 queue #5): S100's live call angle 'Revisions + 60-day strength' — does
buying the call 5–10 days before the earnings print beat buying it on any other day?

S100 graded the angle on S085's engine (0.50Δ ~45 DTE call, held to expiry, S076 pricer = BS × S075 skew at the
name's iv30, bid + 23 % fill, excess over T-bill). price_long does NOT skip earnings, so S100's +69.6 % holdout mixes
windows that cross a print with ones that don't. Here the same picks are split by days from entry to the next report
(lseg_research.earnings_moves). Pricing: iv30 at entry already carries the event bump when the print is ≤ 30 d out,
so pre-earnings calls are priced rich (45 DTE spreads the event over more days → slightly conservative); the
post-print IV crush is in the expiry intrinsic (held to expiry, no mark).

PRE-REGISTERED (11-18, before the run)
Picks = top 10 (and top 30, secondary) each Monday by rank(ibes_drift) + rank(ret60), signs as adopted in S100 (both +).
Comparator = 30 random names the same Monday (seed 203), any timing = "random date"; plus T-bill (returns are excess).
Timing cell by calendar days from entry to the next report: pre 5–10 · early 1–4 · later 11–45 · none in window.
Regime = SPY vs 200 d SMA at entry.
Expected sign: pre 5–10 − none > 0 for picks (revisions forecast the surprise, Chan-Jegadeesh-Lakonishok; options
underprice the event, Gao-Xing-Zhang 2018) in bull; bear unclear (sign not demanded). Same for random names smaller.
Independent unit = entry week; a cell < 30 weeks → "can't answer at this n".
Pass bar (Fildi shows 'enter into earnings' on this angle): picks pre 5–10 − picks none ≥ 0 with t ≥ 2 across
weeks where both exist, AND pre 5–10 picks − random names pre 5–10 > 0 (the edge is the pick, not just the print).

    .venv/bin/python analysis/s203_calls_into_earnings.py [preflight]
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_right
from datetime import timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S203.md"
CELLS = ["pre 5-10", "early 1-4", "later 11-45", "none"]


def cell(d, reps):
    k = bisect_right(reps, d)
    if k >= len(reps):
        return "none"
    gap = (reps[k] - d).days
    return "early 1-4" if gap <= 4 else "pre 5-10" if gap <= 10 else "later 11-45" if gap <= 45 else "none"


def rank(x):
    a = np.asarray(x, float)
    return a.argsort().argsort() / max(len(a) - 1, 1)


def wk_t(pairs):
    v = np.array([x for x in pairs if x == x])
    if len(v) < 3 or v.std() == 0:
        return float("nan"), float("nan"), len(v)
    return float(v.mean()), float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))), len(v)


def main() -> int:
    import s085_regime_analog as e
    import s086_strategy_board as B
    conn = connect()
    e.DIGEST = B.pick_digest(conn)
    px = e.load_prices(conn)
    universe = sorted(t for t in px if t not in e.BENCH)
    tech, fund, tgt, _ = e.load_lab(conn, set(universe))
    weeks = sorted(d for d in set(tech) | set(fund) if tgt.get(d))
    panel = e.build_panel(px, universe, weeks, tech, fund)
    for row in panel.values():
        for t, f in row.items():
            f.update(B.extras(px[t], f["_i"]))
    reps = {}
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY report_date"):
        reps.setdefault(t, []).append(d)
    spy = px["SPY"]; sc = np.array([r[1] for r in spy], float); sd = [r[0] for r in spy]
    ma = {sd[i]: sc[i] > sc[i - 199:i + 1].mean() for i in range(199, len(sc))}
    rng = random.Random(203)

    def val(row, t, f):
        v = row[t].get(f)
        return v if isinstance(v, (int, float)) and v == v else None

    recs = []  # (week, group, ticker, cell, regime)
    for d in weeks:
        row = panel.get(d, {})
        names = [t for t in row if val(row, t, "ibes_drift") is not None and val(row, t, "ret60") is not None and t in reps]
        if len(names) < 40 or d not in ma and not any(x <= d for x in sd):
            continue
        reg = "bull" if ma.get(d, ma.get(max(x for x in ma if x <= d), True)) else "bear"
        s = rank([row[t]["ibes_drift"] for t in names]) + rank([row[t]["ret60"] for t in names])
        order = [names[k] for k in np.argsort(-s)]
        for g, ts in (("top10", order[:10]), ("top30", order[:30]), ("random", rng.sample(names, min(30, len(names))))):
            for t in ts:
                recs.append((d, g, t, cell(d, reps[t]), reg))
    L = ["# S203 — revisions + 60-day calls timed into earnings\n",
         f"{len(weeks)} weeks · {weeks[0]} → {weeks[-1]} · picks/random rows {len(recs):,}\n",
         "\n## Preflight: weeks with ≥ 1 trade per group × timing cell\n"]
    for g in ("top10", "top30", "random"):
        L.append(f"- {g}: " + " · ".join(f"{c} {len({r[0] for r in recs if r[1] == g and r[3] == c})}" for c in CELLS) + "\n")
    if len(sys.argv) > 1 and sys.argv[1] == "preflight":
        print("".join(L)); return 0

    pricer, tb = e.Pricer(conn), e.tbill_map(conn)
    cache = {}

    def opt(t, d):
        if (t, d) not in cache:
            tr = e.price_long(pricer, px[t], panel[d][t]["_i"], "call", e.tbill_at(tb, d))
            cache[(t, d)] = tr["expiry"] if tr else None
        return cache[(t, d)]

    res = [(d, g, t, c, reg, opt(t, d)) for d, g, t, c, reg in recs]
    res = [r for r in res if r[5] is not None]
    L.append(f"\npriced {len(res):,} trades\n\n## Mean return per $ debit (excess over T-bill), week-averaged · win = ends above breakeven\n")
    by = {}
    for d, g, t, c, reg, x in res:
        by.setdefault((g, c, reg), {}).setdefault(d, []).append(x)
        by.setdefault((g, c, "all"), {}).setdefault(d, []).append(x)
        by.setdefault((g, "any", reg), {}).setdefault(d, []).append(x)
        by.setdefault((g, "any", "all"), {}).setdefault(d, []).append(x)
    wk = lambda k: {d: float(np.mean(v)) for d, v in by.get(k, {}).items()}
    for reg in ("all", "bull", "bear"):
        L.append(f"\n**{reg}**\n\n| group | " + " | ".join(CELLS + ["any (random date)"]) + " |\n|---|" + "---|" * 5 + "\n")
        for g in ("top10", "top30", "random"):
            cells = []
            for c in CELLS + ["any"]:
                w = wk((g, c, reg)); allx = [x for v in by.get((g, c, reg), {}).values() for x in v]
                cells.append(f"{np.mean(list(w.values())) * 100:+.1f} % (n {len(allx)}, wk {len(w)}, win {np.mean([x > 0 for x in allx]) * 100:.0f} %)" if w else "—")
            L.append(f"| {g} | " + " | ".join(cells) + " |\n")
        for g in ("top10", "top30"):
            a, b, r_ = wk((g, "pre 5-10", reg)), wk((g, "none", reg)), wk(("random", "pre 5-10", reg))
            m, t, n = wk_t([a[d] - b[d] for d in a if d in b])
            m2, t2, n2 = wk_t([a[d] - r_[d] for d in a if d in r_])
            m3, t3, n3 = wk_t([a[d] - v for d in a if (v := wk((g, "any", reg)).get(d)) is not None])
            fl = lambda n_: "" if n_ >= 30 else " ← can't answer at this n"
            L.append(f"- {g}: pre 5–10 − none {m * 100:+.1f} pts, t {t:.2f}, wk {n}{fl(n)} · pre 5–10 − random names pre 5–10 "
                     f"{m2 * 100:+.1f} pts, t {t2:.2f}, wk {n2}{fl(n2)} · pre 5–10 − same group any date {m3 * 100:+.1f} pts, t {t3:.2f}, wk {n3}{fl(n3)}\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(L))
    print("".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
