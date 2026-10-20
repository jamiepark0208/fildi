"""S061 — call edge (Claude 10-19): do the S059 put-edge factors also rank weekly covered calls? Pre-registered in research/studies/INDEX.md.

Trades: S046 harness unchanged (5-session covered call at K = S·exp(+IV·√(5/252)), overwrite pnl = (BS call − max(0, S_T − K)) / S).
Factors: iv_rv (lab_outcomes), vol_of_vol (S059 definition). Baseline = live call tech per S046 (low call_volume, low trend extension).
Bar: fm on call_pnl with IV controls |t| ≥ 3 + both halves; composite beats baseline on 2024-07→ (paired weekly top quintile t ≥ 2, halves).

    .venv/bin/python analysis/s061_call_edge.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s046_calls_avoid as C  # noqa: E402
import s059_option_factors as F  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out/opt/S061.md"


def main():
    with connect() as conn:
        rows, tech, fund, px = S.load(conn)
        ev = C.build(rows, tech, fund, px)
        C.attach_call_tech(conn, ev)
        F.add_features(conn, ev)   # vol_of_vol etc. keyed on (t, d), same as the put study
    for e in ev:
        e["pnl"] = e["call_pnl"]   # S.fm / quint read 'pnl'
        e.setdefault("breach", 0.0)
        if e.get("call_volume") is not None and e.get("call_trend_ext") is not None:
            e["call_tech_s046"] = -(e["call_volume"] + e["call_trend_ext"])
    L = [f"# S061 — call edge on {len(ev)} simulated covered calls", "", "| feature | controls | IC | t | halves | verdict |", "|---|---|---|---|---|---|"]
    passing = []
    for f, ctl in (("iv_rv", False), ("vol_of_vol", True), ("call_tech_s046", True)):
        r = S.fm(ev, f, "pnl", controls=ctl)
        if not r:
            L.append(f"| {f} | | n/a | | | |"); continue
        ok = abs(r["t"]) >= 3 and np.sign(r["ic_a"]) == np.sign(r["ic_b"]) == np.sign(r["ic"])
        if ok and f != "call_tech_s046":
            passing.append((f, int(np.sign(r["ic"]))))
        L.append(f"| {f} | {'yes' if ctl else 'no'} | {r['ic']:+.4f} | {r['t']:+.1f} | {r['ic_a']:+.4f} / {r['ic_b']:+.4f} | {'PASS' if ok else '—'} |")
    if passing:
        by = defaultdict(list)
        keys = [f for f, _ in passing] + ["call_tech_s046"]
        for e in ev:
            if e["d"] >= F.SPLIT and all(e.get(k) is not None for k in keys):
                by[e["d"]].append(e)
        d, qs = [], defaultdict(list)
        for g in by.values():
            if len(g) < 30:
                continue
            base = S.rank([e["call_tech_s046"] for e in g])
            comp = base + sum(sg * S.rank([e[f] for e in g]) for f, sg in passing)
            q = len(g) // 5
            top = lambda sc: np.mean([g[k]["pnl"] for k in np.argsort(sc)[-q:]])
            d.append(1e4 * (top(comp) - top(base)))
            cr = S.rank(comp)
            for e, v in zip(g, cr):
                qs[min(4, int(v * 5))].append(e["pnl"])
        d = np.array(d); h = len(d) // 2
        t = d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))
        L += ["", f"Holdout {F.SPLIT}→ ({len(d)} weeks): composite − S046 call tech, top quintile {d.mean():+.1f} bp/wk (t {t:+.2f}), "
              f"halves {d[:h].mean():+.1f} / {d[h:].mean():+.1f}, weeks better {np.mean(d > 0):.0%} → {'PASS' if t >= 2 and d[:h].mean() > 0 and d[h:].mean() > 0 else 'FAIL'}",
              "Composite quintiles (holdout): " + " · ".join(f"Q{q + 1} {1e4 * np.mean(v):+.1f} bp" for q, v in sorted(qs.items()))]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
