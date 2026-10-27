#!/usr/bin/env python3
"""S110 — Can support zones, analyst targets or a 3-month low stand in for the 10 % OTM buffer? (Jamie 10-27: ONDS 6p sits on ~$6
support, RKLB ~$50, both near 3-month lows with far analyst targets — "the exclusion logic is too simple".)

Same real-quote puts as S109 (optlab.lseg_opt_daily, fill bid + 23 % of spread, held to expiry). Among puts paying ≥ 0.9 %/wk:
  A  ≥ 10 % OTM (the rule)                       B  5–10 % OTM with backing           C  5–10 % OTM without it
Backing, each tested alone (point-in-time, bars ≤ entry day):
  support   a ≥ 2-method S088 confluence zone lies wholly between strike and spot (the strike sits under support)
  low3m     spot within 5 % of its 63-day low
  pt        StarMine mean target (latest monthly obs ≤ entry, ≤ 45 days old) ≥ 30 % above spot
Pass (pre-set): B beats C by ≥ 30 bp/wk with week-cluster t ≥ 2 and same sign in both halves, and B's worst-5 % week no worse than A's.
Fair value (fair_value_snapshots) starts 2026 — too short; not tested.

    .venv/bin/python analysis/s110_support_pt_puts.py   → out/opt/S110.md
"""
from __future__ import annotations

import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s088_sr_zones as Z  # noqa: E402
import s109_real_quote_rule as S  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S110.md"


def main():
    conn = connect()
    q, px = S.load(conn)
    rs = [r for r in S.trades(q, px) if r["inc"] >= 0.009 and r["otm"] >= 0.05]
    bars = Z.load(conn, {r["t"] for r in rs})
    pt = defaultdict(list)
    for t, d, v in conn.execute("SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history WHERE metric = 'pt_mean' "
                                "AND value > 0 ORDER BY ticker, obs_date"):
        pt[t].append((d, v))
    for r in rs:
        b = bars.get(r["t"])
        r["support"] = r["low3m"] = r["pt"] = None
        if b:
            ix = {d: i for i, d in enumerate(b["d"])}
            i = ix.get(r["d"])
            if i and i >= 300:
                zs, _ = Z.zones(b, i)
                r["support"] = any(z["score"] >= 2 and z["lo"] >= r["K"] and z["hi"] < r["S"] for z in zs)
                r["low3m"] = bool(r["S"] <= 1.05 * b["l"][i - 62: i + 1].min())
        p = pt.get(r["t"])
        if p:
            k = bisect_right([x[0] for x in p], r["d"]) - 1
            if k >= 0 and (r["d"] - p[k][0]).days <= 45:
                r["pt"] = bool(p[k][1] / r["S"] - 1 >= 0.30)
    A = [r for r in rs if r["otm"] >= 0.10]
    near = [r for r in rs if r["otm"] < 0.10]
    L = ["# S110 — support / 3-month low / analyst target as a substitute for the 10 % OTM buffer", "",
         f"{len(rs):,} real-quote weekly puts paying ≥ 0.9 %/wk at ≥ 5 % OTM ({len(A)} at ≥ 10 %, {len(near)} at 5–10 %). "
         "Fill bid + 23 % of spread, held to expiry; split 2024-07.", ""]
    verdicts = []
    for f, label in (("support", "strike under a ≥ 2-method support zone"), ("low3m", "spot within 5 % of 63-day low"),
                     ("pt", "analyst target ≥ 30 % above spot")):
        B = [r for r in near if r[f] is True]
        C = [r for r in near if r[f] is False]
        L += [f"## {label}", "", *S.HEAD]
        for nm, g in (("A ≥ 10 % OTM (rule)", A), (f"B 5–10 % OTM, {f} yes", B), (f"C 5–10 % OTM, {f} no", C),
                      (f"A and {f} yes", [r for r in A if r[f] is True]), (f"A and {f} no", [r for r in A if r[f] is False])):
            L.append(S.row(nm, S.stats(g)))
            for h, cut in (("<24-07", lambda r: r["d"] < S.SPLIT), ("≥24-07", lambda r: r["d"] >= S.SPLIT)):
                L.append(S.row(f"  {h}", S.stats([r for r in g if cut(r)])))
        sb, sc, sa = S.stats(B), S.stats(C), S.stats(A)
        halves = [(S.stats([r for r in B if c(r)]), S.stats([r for r in C if c(r)]))
                  for c in (lambda r: r["d"] < S.SPLIT, lambda r: r["d"] >= S.SPLIT)]
        diff = [(1e4 * np.mean([r["r"] for r in B]) - 1e4 * np.mean([r["r"] for r in C])) if B and C else float("nan")]
        same = all(hb and hc and hb["wk_bp"] > hc["wk_bp"] for hb, hc in halves)
        ok = bool(sb and sc and sb["wk_bp"] - sc["wk_bp"] >= 30 and sb["t"] >= 2 and same and sb["w5"] >= sa["w5"])
        verdicts.append(f"{label}: B − C {sb['wk_bp'] - sc['wk_bp'] if sb and sc else float('nan'):+.0f} bp/wk (per put {diff[0]:+.0f}), "
                        f"both halves {'yes' if same else 'no'}, B worst-5 % {sb['w5'] if sb else float('nan'):+.0f} vs A {sa['w5']:+.0f} → "
                        f"{'PASS' if ok else 'FAIL'}")
        L.append("")
    L[4:4] = ["## Verdicts", "", *[f"- {v}" for v in verdicts], ""]
    OUT.write_text("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
