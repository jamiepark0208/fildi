#!/usr/bin/env python3
"""S103b: which puts to sell TODAY across names — does an indicator signal pick better trades than the same day's average?
Every name × entry day with a priced S103 path (1-week 0.12Δ / 3-week 0.15Δ, held or pace-4× exit). Per date: mean P&L
(% of strike per week held) of trades whose signal is on minus the mean of all that day's trades; t over weeks, both periods.
Also checks IV/RV (higher premium) as the comparator: a signal must beat the day's average after IV/RV tercile matching."""
from __future__ import annotations
import math, pickle, sys
from collections import defaultdict
from datetime import date
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import indicators as IND  # noqa: E402
import s103_put_lifecycle as S  # noqa: E402
from build_plan import connect  # noqa: E402
OUT = HERE.parent / "out" / "opt" / "S103b.md"

def main():
    paths = pickle.loads(S.CACHE.read_bytes())
    with connect() as c:
        bars = IND.load_bars(c, list(paths))
    rows = []
    for t, nm in paths.items():
        b = bars[t]
        s = IND.compute(*b)
        rules = nm["rules"]
        rv = np.full(len(b[3]), np.nan)
        cl = np.asarray(b[3], float)
        lr = np.diff(np.log(cl), prepend=np.nan)
        for i in range(21, len(cl)):
            rv[i] = np.nanstd(lr[i - 19:i + 1]) * math.sqrt(252)
        for ten in S.TENORS:
            for i, tr in nm["paths"][ten].items():
                x = tr.get("std")
                if not x:
                    continue
                for ex in ("E0 hold", "E2 pace 4×"):
                    j, pnl = x["ex"][ex]
                    days = max((nm["d"][j] - nm["d"][i]).days, 1)
                    rows.append((ten, ex, nm["d"][i], pnl / x["K"] / days * 7, x["credit"] / x["K"],
                                 {k: bool(v[i]) for k, v in rules.items()}, s["stc_bull"][i], s["fear_greed"][i]))
    L = [f"# S103b — which names to sell today: signal trades vs the same day's average ({date.today()})", "",
         "bp per week held (P&L ÷ strike ÷ days × 7). Δ = signal-on minus all trades that day; t over weeks; ctrl = within credit-tercile of the day.", "",
         "| tenor | exit | signal | 20-22 Δ bp/wk (ctrl) | 23-26 Δ bp/wk (ctrl) | t (all) | share of trades |", "|---|---|---|---|---|---|---|"]
    sigs = [k for k in rows[0][5] if k not in ("N0 Monday", "N1 any day")] + ["cluster ≤ 0.2", "fear ≤ 30", "greed ≥ 70"]
    def on(r, k):
        if k == "cluster ≤ 0.2": return r[6] <= 0.2
        if k == "fear ≤ 30": return r[7] <= 30
        if k == "greed ≥ 70": return r[7] >= 70
        return r[5][k]
    for ten in S.TENORS:
        for ex in ("E0 hold", "E2 pace 4×"):
            xs = [r for r in rows if r[0] == ten and r[1] == ex]
            byd = defaultdict(list)
            for r in xs: byd[r[2]].append(r)
            for k in sigs:
                per = {}
                wk_all = defaultdict(list)
                for name, part in (("20-22", lambda d: d < S.SPLIT), ("23-26", lambda d: d >= S.SPLIT)):
                    dd, dc = [], []
                    for d, rs in byd.items():
                        if not part(d) or len(rs) < 30: continue
                        a = [r[3] for r in rs if on(r, k)]
                        if len(a) < 3: continue
                        m = np.mean([r[3] for r in rs]); dd.append(np.mean(a) - m)
                        q = np.percentile([r[4] for r in rs], [33.3, 66.7]); cc = []
                        for lo, hi in ((-1, q[0]), (q[0], q[1]), (q[1], 9)):
                            g = [r for r in rs if lo < r[4] <= hi]; ga = [r[3] for r in g if on(r, k)]
                            if len(ga) >= 2 and len(g) >= 10: cc.append(np.mean(ga) - np.mean([r[3] for r in g]))
                        if cc: dc.append(np.mean(cc))
                        wk_all[d.isocalendar()[:2]].append(dd[-1])
                    per[name] = (np.mean(dd) * 1e4 if dd else float("nan"), np.mean(dc) * 1e4 if dc else float("nan"))
                w = np.array([np.mean(v) for v in wk_all.values()])
                t = w.mean() / (w.std(ddof=1) / math.sqrt(len(w))) if len(w) > 5 else float("nan")
                share = np.mean([on(r, k) for r in xs]) * 100
                L.append(f"| {ten} | {ex} | {k} | {per['20-22'][0]:+.1f} ({per['20-22'][1]:+.1f}) | {per['23-26'][0]:+.1f} ({per['23-26'][1]:+.1f}) | {t:.1f} | {share:.0f} % |")
    OUT.write_text("\n".join(L) + "\n"); print("\n".join(L))

if __name__ == "__main__":
    main()
