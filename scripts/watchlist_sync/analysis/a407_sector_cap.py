#!/usr/bin/env python3
"""A407 step 2 — does a per-sector slot cap on the weekly sold-put book cut the tail without costing mean?

Pool: put_benchmark's (S088 1-week puts, real-fill haircut, band table fit < 2023, live engine rule picks one contract per
name-week). Book: N = 8 slots a week (the plan sells a handful, not hundreds), equal weight; no-trade weeks count 0.
Slot fill = random among the engine's picks that week (50 seeds, averaged) so the cap's effect is not mixed with a ranking rule.
Cap = max picks per point-in-time sector ETF (band_engine.add_sector `sec`; same cluster as pm_alerts / N_eff). Pre-registered
caps: none / 3 / 2 / 1. Verdict = put_benchmark.verdict on the seed-averaged weekly series, holdout 2023 →, and the same
sign before 2023 (else "holdout only").

    .venv/bin/python analysis/a407_sector_cap.py   → out/opt/A407-sector-cap.md
"""
from __future__ import annotations

import pickle
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import band_engine as BE  # noqa: E402
from build_plan import connect  # noqa: E402
from put_benchmark import engine_rule, verdict  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A407-sector-cap.md"
SLOTS, SEEDS = 8, 50
CAPS = [None, 3, 2, 1]


MODE = "random"   # or "income": slots go to the highest-premium picks (how an income ranker concentrates)


def book(picks_by_wk, weeks, cap, seed):
    rng = random.Random(seed)
    out = np.zeros(len(weeks))
    for i, w in enumerate(weeks):
        ps = picks_by_wk.get(w, [])[:]
        rng.shuffle(ps)
        if MODE == "income":
            ps.sort(key=lambda p: -p["inc"])
        kept, per = [], defaultdict(int)
        for p in ps:
            g = p.get("sec") or p["t"]
            if cap is not None and per[g] >= cap:
                continue
            kept.append(p["hc"])
            per[g] += 1
            if len(kept) == SLOTS:
                break
        out[i] = np.mean(kept) if kept else 0.0
    return out


def run(picks, weeks):
    by = defaultdict(list)
    for p in picks:
        by[p["d"]].append(p)
    return {cap: np.mean([book(by, weeks, cap, s) for s in range(SEEDS)], axis=0) for cap in CAPS}


def describe(x):
    return x.mean() * 1e4, np.percentile(x, 5) * 1e4, np.percentile(x, 1) * 1e4


def main() -> int:
    global MODE, SEEDS, OUT
    if "--income" in sys.argv:
        MODE, SEEDS, OUT = "income", 1, OUT.with_name("A407-sector-cap-income.md")
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
        BE.add_breadth(c, rows)
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    live = engine_rule(BE.fit(tr))
    picks = BE.pick_rows(rows, live)
    halves = {"holdout 2023 →": [p for p in picks if p["d"] >= BE.SPLIT], "fit period < 2023": [p for p in picks if p["d"] < BE.SPLIT]}
    L = [f"# A407 step 2 — sector slot cap on an 8-slot weekly put book (slot fill: {MODE})", "",
         f"{len(picks):,} engine picks. Seeds {SEEDS}, slots {SLOTS}. bp = per collateral-week. Method: script docstring.", ""]
    res = {}
    for name, ps in halves.items():
        weeks = sorted({p["d"] for p in ps})
        res[name] = (weeks, run(ps, weeks))
        sec_share = np.mean([max(np.bincount([hash(p.get("sec")) % 997 for p in g])) / len(g)
                             for g in [[p for p in ps if p["d"] == w] for w in weeks] if len(g) >= SLOTS])
        L += [f"## {name} — {len(weeks)} weeks, {len(ps):,} picks; avg largest-sector share of the pool {100 * sec_share:.0f} %", "",
              "| cap / sector | book bp/wk | Δ vs none | t | worst-5 % wk | Δ | worst-1 % wk | verdict |", "|---|---|---|---|---|---|---|---|"]
        base = res[name][1][None]
        for cap in CAPS:
            x = res[name][1][cap]
            m, w5, w1 = describe(x)
            if cap is None:
                L.append(f"| none | {m:+.1f} | | | {w5:+.0f} | | {w1:+.0f} | |")
                continue
            d = x - base
            t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if d.std() > 0 else 0.0
            dm, dw5 = m - describe(base)[0], w5 - describe(base)[1]
            L.append(f"| {cap} | {m:+.1f} | {dm:+.1f} | {t:+.1f} | {w5:+.0f} | {dw5:+.0f} | {w1:+.0f} | {verdict(dm, t, dw5)} |")
        L.append("")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
