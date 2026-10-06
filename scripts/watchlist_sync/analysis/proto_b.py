#!/usr/bin/env python3
"""Gate 1b (PLAN_next_session.md §7): the simple fallbacks after gate 1 stopped the fitted confidence model. Read-only.

Pre-registered (written before the first run):
  B1 lookup   "wins historically" = put P&L > 0 rate per delta (0.15 / 0.20 / 0.30), built on 2020-03 → 2023-12, checked on 2024-01 →.
              Pass: every delta's test rate within 5 pts of the lookup.
  B2 split    same lookup split by PREMIUM tier (top fifth / middle / bottom fifth of that month). Adopt the split only if it beats
              B1 on test Brier AND every cell is within 5 pts AND the tiers are ordered the same way in both periods.
  B3 tail cap Model List rule (top 20 by PREMIUM, ~0.20Δ, SPY 20d pause) vs (a) ≤ 2 picks per peer group, (b) no earnings inside the
              window. No fitting, so both periods are tests. Adopt a variant only if, in BOTH periods, tail rate (loss > 5% of
              collateral) and worst month improve and mean monthly return drops by ≤ 0.10 pts. Trials: 2.
  Stock score trend part: settled in gate 1 (distance from 200-day alone); not re-tested.

Usage: .venv/bin/python analysis/proto_b.py   → out/proto/gate1b.md (reuses out/proto/trades.pkl)
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import mean

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import proto as P  # noqa: E402

TIERS = ("bottom", "middle", "top")


def tier(t):
    p = t["premium"]
    return None if p is None else "top" if p >= 0.8 else "bottom" if p < 0.2 else "middle"


def lookup(T, keyf):
    tr = [t for t in T if t["entry"] < P.SPLIT and keyf(t) is not None]
    g = defaultdict(list)
    for t in tr:
        g[keyf(t)].append(t["win"])
    return {k: (mean(v), len(v)) for k, v in g.items()}


def check(T, keyf, L, title):
    lk = lookup(T, keyf)
    te = [t for t in T if t["entry"] >= P.SPLIT and keyf(t) is not None]
    g = defaultdict(list)
    for t in te:
        g[keyf(t)].append(t["win"])
    L += [f"**{title}**", "", "| cell | 2020–23 rate (n) | 2024–26 rate (n) | gap |", "|---|---|---|---|"]
    worst = 0.0
    for k in sorted(lk, key=str):
        a, n = lk[k]
        b = mean(g[k]) if g[k] else None
        if b is not None:
            worst = max(worst, abs(b - a))
        L.append(f"| {k} | {100 * a:.1f}% ({n:,}) | {'–' if b is None else f'{100 * b:.1f}%'} ({len(g[k]):,}) | "
                 f"{'–' if b is None else f'{100 * (b - a):+.1f}'} |")
    brier = float(np.mean([(lk[keyf(t)][0] - t["win"]) ** 2 for t in te]))
    L += ["", f"Largest gap {100 * worst:.1f} pts · test Brier {brier:.4f}", ""]
    return worst, brier, lk, {k: mean(v) for k, v in g.items() if v}


def ladder(T, L):
    Pz = [t for t in T if t["delta"] == 0.20 and t["premium"] is not None]
    bym = defaultdict(list)
    for t in Pz:
        bym[t["entry"]].append(t)

    def pick(ts, cap=None, no_earn=False):
        if (ts[0]["spy_m20"] or 0) < -0.05:
            return []
        out, per = [], defaultdict(int)
        for t in sorted(ts, key=lambda t: -t["premium"]):
            if no_earn and t["earnings_in_window"]:
                continue
            if cap and per[t["peer"] or t["ticker"]] >= cap:
                continue
            per[t["peer"] or t["ticker"]] += 1
            out.append(t)
            if len(out) == P.TOP_N:
                break
        return out

    rules = {"today (top 20 PREMIUM, SPY pause)": {}, "(a) ≤ 2 per peer group": {"cap": 2}, "(b) no earnings in window": {"no_earn": True}}
    res = {}
    L += ["## B3. Tail control on the Model List rule (0.20Δ puts; skipped month = 0)", "",
          "| rule | period | months | trades | mean monthly | loss rate | tail rate | worst month |", "|---|---|---|---|---|---|---|---|"]
    for name, kw in rules.items():
        for per, lo, hi in (("2020–23", date(2020, 1, 1), P.SPLIT), ("2024–26", P.SPLIT, date(2100, 1, 1))):
            ms = [m for m in sorted(bym) if lo <= m < hi]
            mret, picks = [], []
            for m in ms:
                ts = pick(bym[m], **kw)
                picks += ts
                mret.append(mean(t["ret"] for t in ts) if ts else 0.0)
            r = (mean(mret), sum(t["ret"] < -0.05 for t in picks) / len(picks), min(mret))
            res[(name, per)] = r
            L.append(f"| {name} | {per} | {len(ms)} | {len(picks)} | {100 * r[0]:+.2f}% | {100 * sum(t['ret'] <= 0 for t in picks) / len(picks):.1f}% | "
                     f"{100 * r[1]:.1f}% | {100 * r[2]:+.2f}% |")
    L.append("")
    base = "today (top 20 PREMIUM, SPY pause)"
    for name in list(rules)[1:]:
        ok = all(res[(name, p)][1] < res[(base, p)][1] and res[(name, p)][2] > res[(base, p)][2]
                 and res[(base, p)][0] - res[(name, p)][0] <= 0.001 for p in ("2020–23", "2024–26"))
        L.append(f"- {name}: **{'adopt' if ok else 'reject'}** (needs lower tail rate, better worst month, ≤ 0.10 pt return cost in both periods)")
    return L + [""], res


def main() -> None:
    H, T = P.get_trades(False)
    labels = P.confirm(P.raw_labels(H))
    T = P.cross_section(T, {r["date"]: r for r in labels})
    T = [t for t in T if t["premium"] is not None]
    for t in T:
        t["tier"] = tier(t)
    L = [f"# Gate 1b: simple fallbacks ({date.today()})", "",
         f"{len(T):,} reconstructed 30-day puts (Δ0.15 / 0.20 / 0.30), same data as gate 1. Success = put P&L > 0.", "",
         "## B1 / B2. \"Wins historically\" lookup", ""]
    w1, b1, _, _ = check(T, lambda t: f"Δ{t['delta']:.2f}", L, "B1: by delta")
    w2, b2, lk2, te2 = check(T, lambda t: f"Δ{t['delta']:.2f} · {t['tier']}", L, "B2: by delta × PREMIUM tier")
    ordered = all(
        [lk2[f"Δ{d:.2f} · {x}"][0] for x in TIERS] == sorted(lk2[f"Δ{d:.2f} · {x}"][0] for x in TIERS)
        and [te2[f"Δ{d:.2f} · {x}"] for x in TIERS] == sorted(te2[f"Δ{d:.2f} · {x}"] for x in TIERS) for d in P.DELTAS)
    L += [f"- B1: **{'pass' if w1 <= 0.05 else 'fail'}** (largest gap {100 * w1:.1f} pts, rule ≤ 5)",
          f"- B2: **{'adopt split' if (b2 < b1 and w2 <= 0.05 and ordered) else 'keep B1'}** (Brier {b2:.4f} vs {b1:.4f}; largest gap "
          f"{100 * w2:.1f}; tiers ordered bottom < middle < top in both periods: {ordered})", ""]
    L3, _ = ladder(T, [])
    L += L3
    (P.OUT / "gate1b.md").write_text("\n".join(L) + "\n")
    print("\n".join(l for l in L if l.startswith("- ")))
    print("→ out/proto/gate1b.md")


if __name__ == "__main__":
    main()
