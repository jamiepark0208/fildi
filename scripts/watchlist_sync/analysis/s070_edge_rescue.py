"""S070 — selective put-edge filter (Jamie 10-20: "your filter is too binary — out of the excluded names, are there good ones?
selectively exclude bad tickers and add good ones by finding patterns"). Same harness as S069 (weekly ~1σ puts, net of fills, 2020 →).

Pre-registered (written before the run):
  rescue  inside put-edge Q1–Q3 (live: blocked), find cells (one feature tercile, or two-feature tercile × tercile) whose puts earn
          ≥ the kept Q4–Q5 average on TRAIN (entry < 2024-07-01) with week-cluster t ≥ 3 vs 0. Cutoffs from train only.
          A cell is adopted only if on HOLDOUT (≥ 2024-07-01) its pnl > 0 with t ≥ 2 and its worst 1 % is no worse than Q4–Q5's − 50 bp.
  prune   same search inside Q4–Q5 for cells with train pnl < 0 (t ≤ −3) → holdout pnl < 0 (t ≤ −2) → block them.
  catalyst  FOMC decision inside the hold vs not, all puts (same weeks cancel the market): diff and t, both halves.
Many cells are searched → the t ≥ 3 train bar + untouched holdout is the multiple-testing guard.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s070_edge_rescue.py
"""
from __future__ import annotations

import itertools
import math
import random
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s059_option_factors as S  # noqa: E402
import s069_gate_audit as G  # noqa: E402
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S070.md"
SPLIT = date(2024, 7, 1)
FEATS = ["iv_rv", "vol_of_vol", "put_tech", "iv30", "ret5", "rev_1m", "mom_12_1", "idio_vol", "term_slope", "tech_oversoldDepth",
         "tech_reversalSignal", "tech_trendContext", "sr_cushion", "sue", "spy20", "spy_dd_52w", "down_streak"]
FOMC = [date(*x) for x in [
    (2020, 1, 29), (2020, 3, 3), (2020, 3, 15), (2020, 4, 29), (2020, 6, 10), (2020, 7, 29), (2020, 9, 16), (2020, 11, 5), (2020, 12, 16),
    (2021, 1, 27), (2021, 3, 17), (2021, 4, 28), (2021, 6, 16), (2021, 7, 28), (2021, 9, 22), (2021, 11, 3), (2021, 12, 15),
    (2022, 1, 26), (2022, 3, 16), (2022, 5, 4), (2022, 6, 15), (2022, 7, 27), (2022, 9, 21), (2022, 11, 2), (2022, 12, 14),
    (2023, 2, 1), (2023, 3, 22), (2023, 5, 3), (2023, 6, 14), (2023, 7, 26), (2023, 9, 20), (2023, 11, 1), (2023, 12, 13),
    (2024, 1, 31), (2024, 3, 20), (2024, 5, 1), (2024, 6, 12), (2024, 7, 31), (2024, 9, 18), (2024, 11, 7), (2024, 12, 18),
    (2025, 1, 29), (2025, 3, 19), (2025, 5, 7), (2025, 6, 18), (2025, 7, 30), (2025, 9, 17), (2025, 10, 29), (2025, 12, 10),
    (2026, 1, 28), (2026, 3, 18), (2026, 4, 29), (2026, 6, 17), (2026, 7, 29), (2026, 9, 16)]]


def wk_t(xs):
    """mean bp and week-cluster t vs 0."""
    byw = defaultdict(list)
    for e in xs:
        byw[e["d"]].append(e["pnl"])
    w = np.array([np.mean(v) for v in byw.values()])
    m = np.mean([e["pnl"] for e in xs])
    if len(w) < 20:
        return 1e4 * m, float("nan"), len(xs)
    return 1e4 * m, w.mean() / (w.std(ddof=1) / math.sqrt(len(w))), len(xs)


def worst1(xs):
    return 1e4 * float(np.percentile([e["pnl"] for e in xs], 1))


def tercile(e, f, cuts):
    v = e.get(f)
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return 0 if v <= cuts[f][0] else (1 if v <= cuts[f][1] else 2)


def search(pool, cuts, want):
    """cells (tuple of (feat, tercile)) → train stats. want=+1 rescue, −1 prune."""
    tr = [e for e in pool if e["d"] < SPLIT]
    cells = defaultdict(list)
    for e in tr:
        ts = {f: tercile(e, f, cuts) for f in FEATS}
        ok = [(f, q) for f, q in ts.items() if q is not None]
        for c in ok:
            cells[(c,)].append(e)
        for a, b in itertools.combinations(ok, 2):
            cells[(a, b)].append(e)
    return {c: wk_t(xs) for c, xs in cells.items() if len(xs) >= 300}


def in_cell(e, cell, cuts):
    return all(tercile(e, f, cuts) == q for f, q in cell)


def name(cell):
    lab = ("low", "mid", "high")
    return " & ".join(f"{f} {lab[q]}" for f, q in cell)


def main():
    conn = connect()
    ev = S.aligned_events(conn)
    spy = conn.execute("SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date").fetchall()
    ds = [d for d, _ in spy]
    from bisect import bisect_right
    byw = defaultdict(list)
    for e in ev:
        byw[e["d"]].append(e)
        i = bisect_right(ds, e["d"]) - 1
        e["spy20"] = spy[i][1] / spy[i - 20][1] - 1 if i >= 20 else None
        e["fomc"] = any(e["d"] < f <= e["expiry"] for f in FOMC)
    for w, xs in byw.items():
        ok = [e for e in xs if all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech"))]
        if len(ok) >= 30:
            comp = G.rank(sum(G.rank([e[k] for e in ok]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
            for e, p in zip(ok, comp):
                e["edge_q"] = min(5, int(p * 5) + 1)
    ev = [e for e in ev if e.get("edge_q")]
    tr_all = [e for e in ev if e["d"] < SPLIT]
    cuts = {}
    for f in FEATS:
        v = [e[f] for e in tr_all if e.get(f) is not None and not (isinstance(e[f], float) and math.isnan(e[f]))]
        cuts[f] = (np.percentile(v, 33.3), np.percentile(v, 66.7))
    low = [e for e in ev if e["edge_q"] <= 3]
    high = [e for e in ev if e["edge_q"] >= 4]
    kept_tr, kept_ho = wk_t([e for e in high if e["d"] < SPLIT]), wk_t([e for e in high if e["d"] >= SPLIT])
    kept_w1 = worst1([e for e in high if e["d"] >= SPLIT])
    L = ["# S070 — selective put-edge filter: rescue good names from Q1–Q3, prune bad ones from Q4–Q5", "",
         f"{len(ev)} puts. Train < {SPLIT}, holdout ≥ {SPLIT}. Kept Q4–Q5: train {kept_tr[0]:+.1f} bp/wk, holdout {kept_ho[0]:+.1f} "
         f"(worst 1 % {kept_w1:+.0f}). Removed Q1–Q3: train {wk_t([e for e in low if e['d'] < SPLIT])[0]:+.1f}, "
         f"holdout {wk_t([e for e in low if e['d'] >= SPLIT])[0]:+.1f}.", ""]
    for lab, pool, sign, bar in (("Rescue from Q1–Q3", low, 1, kept_tr[0]), ("Prune from Q4–Q5", high, -1, 0.0)):
        res = search(pool, cuts, sign)
        npass = sum(1 for s in res.values() if (sign > 0 and s[0] >= bar and s[1] >= 3) or (sign < 0 and s[0] < 0 and s[1] <= -3))
        cand = sorted(res.items(), key=lambda x: -sign * (x[1][1] if not math.isnan(x[1][1]) else 0))
        L += [f"## {lab} — {npass} train cells pass the pre-registered bar (of {len(res)} searched); top 12 by train t shown, holdout check", "",
              "| cell | train n | train bp | train t | holdout n | holdout bp | holdout t | holdout worst 1 % | verdict |", "|---|---|---|---|---|---|---|---|---|"]
        for c, s in cand[:12]:
            ho = [e for e in pool if e["d"] >= SPLIT and in_cell(e, c, cuts)]
            h = wk_t(ho)
            w1 = worst1(ho) if len(ho) >= 100 else float("nan")
            ok = (s[0] >= bar and s[1] >= 3 and h[0] > 0 and h[1] >= 2 and w1 >= kept_w1 - 50) if sign > 0 else (s[0] < 0 and s[1] <= -3 and h[0] < 0 and h[1] <= -2)
            L.append(f"| {name(c)} | {s[2]} | {s[0]:+.1f} | {s[1]:.1f} | {h[2]} | {h[0]:+.1f} | {h[1]:.1f} | {w1:+.0f} | {'ADOPT' if ok else ('holdout +' if h[0] > 0 else 'holdout −')} |")
        L.append("")
    L += ["## Catalyst: FOMC decision inside the hold (all puts, same-week pairs not possible → level compare + halves)", "",
          "| period | FOMC n | FOMC bp | FOMC breach | no-FOMC n | no-FOMC bp | no-FOMC breach |", "|---|---|---|---|---|---|---|"]
    for lab, f in (("train", lambda e: e["d"] < SPLIT), ("holdout", lambda e: e["d"] >= SPLIT)):
        a = [e for e in ev if f(e) and e["fomc"]]
        b = [e for e in ev if f(e) and not e["fomc"]]
        L.append(f"| {lab} | {len(a)} | {wk_t(a)[0]:+.1f} | {np.mean([e['breach'] > 0 for e in a]):.1%} | {len(b)} | {wk_t(b)[0]:+.1f} | "
                 f"{np.mean([e['breach'] > 0 for e in b]):.1%} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
