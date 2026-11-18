#!/usr/bin/env python3
"""S202 (signal-enhancements-2026-11-17 queue #4): should the put strike go deeper or nearer when VIX is high?

S101 (model prices, 256 names): in sharp drops net bp rises with Δ → sell NEARER. Tosi–Ziegler (OTM put overpricing
grows with VIX) → sell DEEPER when VIX is high. Settle on REAL quotes: S195 trade set (optlab.lseg_opt_daily EOD
bid/ask 2020-12→, 3–9 DTE, held to expiry, r = (fill − intrinsic) ÷ strike per week, stress fill = bid).

PRE-REGISTERED (11-18, before the run)
Regime cell = VIX close on the prior trading day (wrds_research.cboe_daily): low < 16 · mid 16–22 · high ≥ 22.
Depth = S195 buckets (< 6 · 6–10 · 10–14 · ≥ 14 % below spot).
Expected sign of within-week (deep ≥ 14 %) − (near < 6 %) at the stress fill, per cell:
  Tosi–Ziegler: low ≤ 0 → mid ≈ 0 → high > 0 (rises with VIX)   ·   S101: high < 0 (near strikes pay more after drops)
Independent unit = entry week; < 30 weeks in a cell → "can't answer at this n" for that cell.
Pass bar (engine tilt): high-VIX deep − near > 0, t ≥ 2 → go deeper when VIX ≥ 22; < 0, t ≤ −2 → go nearer; else no tilt.
Secondary (reported, not gating): mean/sd per depth (deep has lower variance), loss rate, worst-5 % week.

    .venv/bin/python analysis/s202_depth_by_vix.py [preflight]
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import s195_depth_universe as S195  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S202.md"
CELLS = [(0, 16, "1 low <16"), (16, 22, "2 mid 16-22"), (22, 999, "3 high >=22")]


def main() -> int:
    c = S195.connect()
    q, px = S195.load(c)
    off, bull, q20 = S195.series_feats(px)
    T = S195.trades(q, px, off, bull, q20)
    vix = pd.Series({d: v for d, v in c.execute(
        "SELECT date, close::float8 FROM wrds_research.cboe_daily WHERE index = 'VIX' ORDER BY date")}).sort_index()
    prior = vix.shift(1)  # prior close, no look-ahead
    T["vix"] = T.d.map(lambda d: prior.asof(d) if d >= vix.index[0] else np.nan)
    T = T.dropna(subset=["vix"])
    T["cell"] = T.vix.map(lambda v: next(l for lo, hi, l in CELLS if lo <= v < hi))
    L = [f"# S202 — put strike depth by VIX level, real quotes\n",
         f"n {len(T):,} trades · {T.t.nunique()} names · {T.wk.nunique()} weeks · {T.d.min()} → {T.d.max()}\n",
         "\n## Preflight: independent weeks per VIX cell × depth\n",
         T.groupby(["cell", "depth"]).wk.nunique().unstack().to_string() + "\n"]
    if len(sys.argv) > 1 and sys.argv[1] == "preflight":
        print("".join(L)); return 0
    for cell, g in T.groupby("cell"):
        w = g.groupby(["wk", "depth"]).agg(r=("r", "mean"), rb=("r_bid", "mean"), loss=("loss", "mean")).reset_index()
        L.append(f"\n**VIX {cell}** (weeks {g.wk.nunique()}, trades {len(g):,})\n")
        tab = w.groupby("depth").agg(r=("r", "mean"), rb=("rb", "mean"), sd=("rb", "std"), worst5=("rb", lambda x: x.quantile(0.05)), loss=("loss", "mean"))
        tab["mean/sd"] = tab.rb / tab.sd
        L.append(tab.round(3).to_string() + "\n")
        pv = w.pivot(index="wk", columns="depth", values="rb")
        for lbl in ["b 6-10%", "c 10-14%", "d >=14%"]:
            if lbl in pv and "a <6%" in pv:
                m, t, n = S195.wk_t(pv[lbl] - pv["a <6%"])
                flag = "" if n >= 30 else "  ← can't answer at this n"
                L.append(f"- within week, {lbl} − <6 % (stress fill): {m:+.3f} %/wk, t {t:.2f}, weeks {n}{flag}\n")
        # secondary: mean/sd deep vs near, bootstrap over weeks (each depth's own week series)
        rng = np.random.default_rng(202)
        a_, d_ = pv["a <6%"].dropna().values, pv["d >=14%"].dropna().values if "d >=14%" in pv else np.array([])
        if len(a_) > 10 and len(d_) > 10:
            sr = lambda x: x.mean() / x.std()
            bs = [sr(rng.choice(d_, len(d_))) - sr(rng.choice(a_, len(a_))) for _ in range(4000)]
            sdb = [rng.choice(a_, len(a_)).std() - rng.choice(d_, len(d_)).std() for _ in range(4000)]
            L.append(f"- mean/sd deep − near {sr(d_) - sr(a_):+.3f}, P(≤ 0) {np.mean(np.array(bs) <= 0):.3f} · "
                     f"sd near − deep {a_.std() - d_.std():+.3f}, P(≤ 0) {np.mean(np.array(sdb) <= 0):.3f} (week bootstrap)\n")
        sw = g.groupby(["t", "wk"]).filter(lambda x: x.otm.max() - x.otm.min() >= 6)
        if len(sw):
            pair = sw.sort_values("otm").groupby(["t", "wk"]).agg(near=("r_bid", "first"), deep=("r_bid", "last"))
            m, t, n = S195.wk_t((pair.deep - pair.near).groupby(level="wk").mean())
            L.append(f"- same stock same week, deepest − nearest (≥ 6 pts apart): {m:+.3f} %/wk, t {t:.2f}, weeks {n}, pairs {len(pair):,}\n")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(L))
    print("".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
