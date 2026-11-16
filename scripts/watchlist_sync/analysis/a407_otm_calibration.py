#!/usr/bin/env python3
"""A407 step 3 — is pick_odds' P(OTM) (market odds × 1.14, S016) calibrated, and would a walk-forward refit beat it?

Two independent samples, both 1-week sold puts held to expiry:
  A  real quotes   S109 loader (optlab.lseg_opt_daily, 2020→), |Δ| 0.04–0.16, IV from the quote (a407_bid_floor.rows)
  B  engine picks  put_benchmark pool (S088 rows, LSEG iv30, 2018→), the live band rule's one pick per name-week
Predicted P(ITM) = pick_odds.p_below(S, K, iv, days/365) × ratio. Forecasters compared (Brier, week-clustered):
  market ×1.00 · live ×1.14 · walk-forward ratio = realized ÷ market breach over the prior 104 weeks (strictly before the week).
Calibration gap reported per year and per SPY 20-day RV bucket. Live ledger (4 resolved weeks) is NOT used to fit: N_eff = 4.

    .venv/bin/python analysis/a407_otm_calibration.py   → out/opt/A407-otm-calibration.md
"""
from __future__ import annotations

import pickle
import sys
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import band_engine as BE  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402
from build_plan import connect  # noqa: E402
from pick_odds import S016_RATIO, p_below  # noqa: E402
from put_benchmark import engine_rule  # noqa: E402
from a407_bid_floor import load_iv, rows as real_rows, spy_rv  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A407-otm-calibration.md"
LOOKBACK_WK = 104


def prep(rs):
    out = []
    for r in rs:
        if not r["iv"] or r["iv"] <= 0 or r["S"] <= 0 or r["K"] <= 0:
            continue
        out.append({**r, "pm": p_below(r["S"], r["K"], r["iv"], r["days"] / 365), "itm": 0.0 if r["kept"] else 1.0,
                    "wk": r["d"] - timedelta(days=r["d"].weekday())})
    return out


def walk_forward(rs):
    by = defaultdict(list)
    for r in rs:
        by[r["wk"]].append(r)
    wks = sorted(by)
    for i, w in enumerate(wks):
        past = [x for v in wks[max(0, i - LOOKBACK_WK):i] for x in by[v]]
        pm = sum(x["pm"] for x in past)
        ratio = (sum(x["itm"] for x in past) / pm) if len(past) >= 200 and pm > 0 else None
        for r in by[w]:
            r["wf"] = ratio


def brier(rs, f):
    wk = defaultdict(list)
    for r in rs:
        p = f(r)
        if p is None:
            return None
        wk[r["wk"]].append((min(.99, p) - r["itm"]) ** 2)
    w = np.array([np.mean(v) for v in wk.values()])
    return w.mean(), w


FC = {"market ×1.00": lambda r: r["pm"], f"live ×{S016_RATIO}": lambda r: r["pm"] * S016_RATIO,
      "walk-forward ratio": lambda r: None if r.get("wf") is None else r["pm"] * r["wf"]}


def section(name, rs, rv):
    rs = prep(rs)
    walk_forward(rs)
    ev = [r for r in rs if r.get("wf") is not None]
    L = [f"## {name} — {len(rs):,} puts, {len({r['wk'] for r in rs})} weeks ({len(ev):,} with a walk-forward ratio)", "",
         "| forecaster | mean P(OTM) | real OTM | gap pts | Brier ×1000 | Δ vs live | t (weeks) |", "|---|---|---|---|---|---|---|"]
    real = 100 * (1 - np.mean([r["itm"] for r in ev]))
    _, base = brier(ev, FC[f"live ×{S016_RATIO}"])
    for k, f in FC.items():
        m, w = brier(ev, f)
        pred = 100 * (1 - np.mean([min(.99, f(r)) for r in ev]))
        d = w - base
        t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if d.std() > 0 else 0.0
        L.append(f"| {k} | {pred:.1f} | {real:.1f} | {pred - real:+.1f} | {1000 * m:.2f} | {1000 * d.mean():+.2f} | {t:+.1f} |")
    L += ["", "Live ×1.14 by year and SPY RV20 bucket (pred − real P(OTM), pts; cells < 30 puts omitted):", "",
          "| cell | puts | weeks | pred P(OTM) | real | gap |", "|---|---|---|---|---|---|"]
    cells = defaultdict(list)
    for r in rs:
        cells[str(r["d"].year)].append(r)
        v = rv.get(r["d"])
        if v is not None:
            cells["RV20 " + ("< 12 %" if v < .12 else "12–20 %" if v < .20 else "> 20 %")].append(r)
    for k in sorted(cells):
        c = cells[k]
        if len(c) < 30:
            continue
        pred = 100 * (1 - np.mean([min(.99, r["pm"] * S016_RATIO) for r in c]))
        real_c = 100 * (1 - np.mean([r["itm"] for r in c]))
        L.append(f"| {k} | {len(c):,} | {len({r['wk'] for r in c})} | {pred:.1f} | {real_c:.1f} | {pred - real_c:+.1f} |")
    return L + [""]


def main() -> int:
    with connect() as c:
        q, px = S109.load(c)
        iv = load_iv(c)
        pool = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
        BE.add_sector(c, pool)
        BE.add_breadth(c, pool)
    rv = spy_rv(px)
    A = real_rows(q, px, iv, rv)
    live = engine_rule(BE.fit([r for r in pool if r["d"] < BE.SPLIT]))
    B = [{**r, "days": 7} for r in BE.pick_rows(pool, live)]
    L = ["# A407 step 3 — P(OTM) calibration of pick_odds (market × 1.14) on history", "",
         "Method: script docstring. Gap = predicted − realized P(OTM); positive = overconfident.", ""]
    L += section("A real quotes (S109, 2020→)", A, rv)
    L += section("B engine picks (S088 pool, 2018→)", B, rv)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
