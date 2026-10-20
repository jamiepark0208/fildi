"""S071 — how far OTM should a weekly short put be? Market-wide, real LSEG option quotes (Jamie 10-20: "you cannot use my trading
history for Model List rules — it's sporadic, not systematic"). Replaces S068's evidence (Jamie's 957 trades; the universe sim had a
skew-ratio step artifact) for rules.PUT_DELTA / PUT_TARGET_ABS_DELTA.

Trades: per name, NWEEK random Mon→Fri weeks 2021 → with no earnings report within ±10 days (earnings = S066). Entry Monday close,
strikes for target |Δ| 0.10 / 0.15 / 0.20 / 0.25 / 0.30 at iv30 (nearest listed strike), each bucketed by its REAL entry Δ from the
contract's own LSEG implied vol (so skew is in the data, not modeled). Fill = bid + 23 % of spread; exit = intrinsic at Friday close.
pnl per $ collateral (strike). Same name-weeks across buckets → the market move cancels in the paired diffs.

Pre-registered: for each Δ bucket, mean pnl, week-cluster Sharpe, ITM rate, worst 5 %, both before and after 2024-07. Cap = the
largest bucket whose Sharpe is within 0.03 of the best in BOTH halves; target = the best-Sharpe bucket (ties → farther OTM).

    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s071_delta_real.py [--tickers=MU,SHOP]
"""
from __future__ import annotations

import math
import random
import statistics
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s049_panic_puts import put_delta, split_factor  # noqa: E402
from s066_earnings_puts import LSEG, OP, load, lseg_session, week_of  # noqa: E402,F401

START, HOLDOUT = date(2021, 1, 4), date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S071.md"
TARGETS = (0.10, 0.15, 0.20, 0.25, 0.30)
BUCKETS = ((0.05, 0.125), (0.125, 0.175), (0.175, 0.225), (0.225, 0.275), (0.275, 0.35))
NWEEK = 5
REQ_CAP = 2500
rng = random.Random(71)


def strike_at(S, v, T, target):
    lo, hi = S * 0.3, S
    for _ in range(40):
        k = (lo + hi) / 2
        lo, hi = (k, hi) if put_delta(S, k, v, T) > -target else (lo, k)
    return (lo + hi) / 2


def week_trades(ld, conn, t, rows, i, j):
    d, S, iv = rows[i]
    e, Se = rows[j][0], rows[j][1]
    if not iv or split_factor(conn, t, d) != split_factor(conn, t, e):
        return []
    fd = split_factor(conn, t, d)
    S, Se = S * fd, Se * fd
    T = max(1, (e - d).days) / 365
    out, seen = [], set()
    for tg in TARGETS:
        for K in OP.strike_ladder(strike_at(S, iv / 100, T, tg))[:2]:
            if K in seen:
                break
            hist = OP.history(ld, conn, t, e, "P", K)
            if not hist:
                continue
            seen.add(K)
            day = next((r for r in hist if r[0] == d), None)
            if not (day and day[1] and day[2] and day[2] >= day[1] > 0):
                break
            civ = day[6] / 100 if day[6] and day[6] > 1.5 else day[6]
            dl = abs(put_delta(S, K, civ or iv / 100, T))
            fill = day[1] + 0.23 * (day[2] - day[1])
            out.append(dict(t=t, d=d, e=e, K=K, dl=dl, pnl=(fill - max(0.0, K - Se)) / K, itm=Se < K))
            break
    return out


def stats(xs):
    if len(xs) < 30:
        return None
    wk = defaultdict(list)
    for x in xs:
        wk[x["e"]].append(x["pnl"])
    w = [statistics.mean(v) for v in wk.values()]
    r = sorted(x["pnl"] for x in xs)
    w5 = r[: max(1, len(r) // 20)]
    sd = statistics.stdev(w) if len(w) > 1 else float("nan")
    return dict(n=len(xs), pnl=statistics.mean(r), sh=statistics.mean(w) / sd if sd else float("nan"),
                itm=sum(x["itm"] for x in xs) / len(xs), w5=statistics.mean(w5))


def main():
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--tickers=")), None)
    conn = connect()
    OP.ensure(conn)
    bars, rep = load(conn, only)
    allx = []
    with lseg_session() as ld:
        order = sorted(bars)
        rng.shuffle(order)
        for t in order:
            if ld.requests > REQ_CAP:
                print(f"stopped: {ld.requests} LSEG requests (cap {REQ_CAP}); re-run tomorrow continues from cache")
                break
            rows, rd = bars[t], [d for d, _ in rep.get(t, [])]
            ok = [i for i, r in enumerate(rows) if r[0] >= START and r[0].weekday() == 0 and all(abs((r[0] - x).days) > 10 for x in rd)]
            for i in rng.sample(ok, min(NWEEK, len(ok))):
                wk = week_of(rows, rows[i][0])
                if wk:
                    allx += week_trades(ld, conn, t, rows, *wk)
            print(f"{t}: {len(allx)} puts ({ld.requests} req)", flush=True)
    if only:
        for x in allx[:12]:
            print(f"{x['t']} {x['d']}→{x['e']} K {x['K']:g} Δ {x['dl']:.2f} pnl {x['pnl']:+.2%} itm {int(x['itm'])}")
    L = ["# S071 — weekly short puts by real entry Δ (market-wide, real LSEG quotes, no earnings weeks)", "",
         f"{'SMOKE ' if only else ''}{len(allx)} puts, {len({(x['t'], x['d']) for x in allx})} name-weeks. Fill bid + 23 % of spread, "
         "exit intrinsic at Friday close, pnl per $ collateral. Sharpe = mean / sd of weekly averages.", "",
         "| slice | Δ bucket | n | pnl % coll/wk | Sharpe | ITM | worst 5 % |", "|---|---|---|---|---|---|---|"]
    best = {}
    for lab, f in (("< 2024-07", lambda x: x["d"] < HOLDOUT), ("≥ 2024-07", lambda x: x["d"] >= HOLDOUT)):
        res = []
        for lo, hi in BUCKETS:
            s = stats([x for x in allx if f(x) and lo <= x["dl"] < hi])
            if s:
                res.append(((lo + hi) / 2, s))
                L.append(f"| {lab} | {lo:.3f}–{hi:.3f} | {s['n']} | {s['pnl']:+.3%} | {s['sh']:+.3f} | {s['itm']:.0%} | {s['w5']:+.2%} |")
        best[lab] = res
    if all(best.values()):
        top = {lab: max(s["sh"] for _, s in r) for lab, r in best.items()}
        ok = [m for m, _ in best["< 2024-07"] if all(any(mm == m and s["sh"] >= top[lab] - 0.03 for mm, s in r) for lab, r in best.items())]
        L += ["", f"Buckets within 0.03 Sharpe of the best in both halves: {', '.join(f'{m:.2f}' for m in ok) or 'none'} → "
                  f"cap = {max(ok):.2f}Δ, target = {min(ok):.2f}Δ" if ok else "", ""]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
