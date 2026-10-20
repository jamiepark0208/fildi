"""S066 — weekly puts across earnings vs normal weeks (PLAN-buy-zone-puts.md §4; 89 names were blocked the week of 10-20).

Events: lseg_research.earnings_moves reports Tue–Thu, 2021-01 →. Trade: sell the weekly put expiring the Friday of the report
week, entry = first session of that week. Strike = listed strike nearest 0.20Δ, where σ covers the event the way a live chain
does: total variance = iv30²·T + m², m = median |move| of the name's previous ≤ 8 reports (point-in-time; iv30 alone for
normal weeks). Fill = bid + 23 % of spread from real LSEG quotes (A206); exit = intrinsic at the Friday close.
Baseline: same name, one random Mon→Fri week with no report within ±10 days, same rule (0.20Δ at iv30).
Pass (pre-registered in the plan): earnings net pnl per $ collateral ≥ normal weeks AND ITM rate ≤ normal + 2 pp, both
before and after 2024-07 → the block becomes a warning + smaller size; else the block stays.

    cd research/lseg && .venv/bin/python ../../scripts/watchlist_sync/analysis/s066_earnings_puts.py --tickers=MU,TMO,SHOP
"""
from __future__ import annotations

import math
import random
import statistics
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s049_panic_puts import FUNDS, put_delta, split_factor  # noqa: E402

LSEG = HERE.parents[2] / "research" / "lseg"
sys.path.insert(0, str(LSEG))
import option_prices as OP  # noqa: E402
from _session import lseg_session  # noqa: E402

START, HOLDOUT = date(2021, 1, 4), date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S066.md"
REQ_CAP = 3000  # ≤ 30 % of LSEG's 10k/day (S064 note)
rng = random.Random(66)


def load(conn, only):
    bars = defaultdict(list)
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history
                                       WHERE close > 0 AND date >= %s ORDER BY ticker, date""", (START - timedelta(days=30),)).fetchall():
        if t not in FUNDS and (not only or t in only):
            bars[t].append((d, c, iv))
    rep = defaultdict(list)
    for t, d, m in conn.execute("SELECT ticker, report_date, move_pct::float FROM lseg_research.earnings_moves ORDER BY report_date").fetchall():
        rep[t].append((d, abs(m) / 100 if m is not None else None))  # stored in %
    return bars, rep


def week_of(rows, d):
    """(entry index, expiry index) for the Mon→Fri week holding d, or None (Friday must be a session)."""
    mon = d - timedelta(days=d.weekday())
    idx = [i for i, r in enumerate(rows) if mon <= r[0] <= mon + timedelta(days=4)]
    if not idx or rows[idx[-1]][0].weekday() != 4:
        return None
    return idx[0], idx[-1]


def trade(ld, conn, t, rows, i, j, m):
    d, S, iv = rows[i]
    e, Se = rows[j][0], rows[j][1]
    if not iv or split_factor(conn, t, d) != split_factor(conn, t, e):
        return None
    fd = split_factor(conn, t, d)
    S, Se = S * fd, Se * fd
    T = max(1, (e - d).days) / 365
    v = math.sqrt((iv / 100) ** 2 + (m * m / T if m else 0))  # σ whose T-variance = iv30²T + m²
    lo, hi = S * 0.4, S
    for _ in range(40):
        k = (lo + hi) / 2
        lo, hi = (k, hi) if put_delta(S, k, v, T) > -0.20 else (lo, k)
    for K in OP.strike_ladder((lo + hi) / 2)[:3]:
        hist = OP.history(ld, conn, t, e, "P", K)
        if not hist:
            continue
        day = next((r for r in hist if r[0] == d), None)
        if not (day and day[1] and day[2] and day[2] >= day[1] > 0):
            return None
        fill = day[1] + 0.23 * (day[2] - day[1])
        return dict(t=t, d=d, e=e, K=K, S=S, Se=Se, fill=fill, pnl=(fill - max(0.0, K - Se)) / K, itm=Se < K, m=m, iv=iv)
    return None


def summ(xs):
    if not xs:
        return dict(n=0, pnl=float("nan"), itm=float("nan"), worst=float("nan"))
    r = sorted(x["pnl"] for x in xs)
    w = r[: max(1, len(r) // 10)]
    return dict(n=len(xs), pnl=sum(r) / len(r), itm=sum(x["itm"] for x in xs) / len(xs), worst=sum(w) / len(w))


def boot_p(a, b, n=3000):
    """One-sided p that mean(a) − mean(b) ≤ 0, resampling expiry weeks."""
    wk = defaultdict(lambda: ([], []))
    for x in a:
        wk[x["e"]][0].append(x["pnl"])
    for x in b:
        wk[x["e"]][1].append(x["pnl"])
    ks, bad = list(wk), 0
    for _ in range(n):
        s = [rng.choice(ks) for _ in ks]
        A, B = [r for k in s for r in wk[k][0]], [r for k in s for r in wk[k][1]]
        if A and B and sum(A) / len(A) - sum(B) / len(B) <= 0:
            bad += 1
    return bad / n


def main():
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--tickers=")), None)
    conn = connect()
    OP.ensure(conn)
    bars, rep = load(conn, only)
    ev, base = [], []
    with lseg_session() as ld:
        order = sorted(bars)
        rng.shuffle(order)  # a capped run is then a random sample of names, not A–F
        for t in order:
            if ld.requests > REQ_CAP:
                print(f"stopped: {ld.requests} LSEG requests (cap {REQ_CAP}); re-run tomorrow continues from cache")
                break
            rows, reps = bars[t], rep.get(t, [])
            pos = {r[0]: i for i, r in enumerate(rows)}
            rd = [d for d, _ in reps]
            for n, (d, _) in enumerate(reps):
                if d < START or d.weekday() not in (1, 2, 3):
                    continue
                wk = week_of(rows, d)
                if not wk:
                    continue
                prev = [x for _, x in reps[max(0, n - 8):n] if x]
                tr = trade(ld, conn, t, rows, *wk, statistics.median(prev) if len(prev) >= 3 else None)
                if tr:
                    ev.append(tr)
                ok = [i for i, r in enumerate(rows) if r[0] >= START and r[0].weekday() == 0
                      and all(abs((r[0] - x).days) > 10 for x in rd)]
                if ok:
                    w2 = week_of(rows, rows[rng.choice(ok)][0])
                    if w2:
                        bt = trade(ld, conn, t, rows, *w2, None)
                        if bt:
                            base.append(bt)
            print(f"{t}: {len(ev)} ev / {len(base)} base", flush=True)
    if only:
        for x in (ev[:8] + base[:4]):
            print(f"{x['t']} {x['d']}→{x['e']} S {x['S']:.2f} K {x['K']:g} fill {x['fill']:.2f} Se {x['Se']:.2f} "
                  f"m {x['m'] or 0:.1%} iv {x['iv']:.0f} pnl {x['pnl']:+.2%} itm {int(x['itm'])}")
    L = ["# S066 — weekly 0.20Δ puts across earnings vs normal weeks", "",
         f"{'SMOKE ' if only else ''}Real LSEG quotes, fill bid + 23 % of spread, exit intrinsic at Friday close.", "",
         "| slice | earnings n | pnl % coll | ITM | worst 10 % | normal n | pnl | ITM | worst 10 % | p(earn ≤ normal) |", "|---|---|---|---|---|---|---|---|---|---|"]
    verdict = []
    for lab, f in (("< 2024-07", lambda x: x["d"] < HOLDOUT), ("≥ 2024-07", lambda x: x["d"] >= HOLDOUT), ("all", lambda x: True)):
        a, b = [x for x in ev if f(x)], [x for x in base if f(x)]
        sa, sb = summ(a), summ(b)
        p = boot_p(a, b) if a and b else float("nan")
        L.append(f"| {lab} | {sa['n']} | {sa['pnl']:+.2%} | {sa['itm']:.0%} | {sa['worst']:+.1%} | {sb['n']} | {sb['pnl']:+.2%} | "
                 f"{sb['itm']:.0%} | {sb['worst']:+.1%} | {p:.3f} |")
        if lab != "all":
            verdict.append(sa["pnl"] >= sb["pnl"] and sa["itm"] <= sb["itm"] + 0.02)
    L += ["", f"**Verdict: {'PASS — earnings block → warning + smaller size' if all(verdict) else 'FAIL — block stays'}** "
              f"(pnl ≥ normal and ITM ≤ normal + 2 pp, both halves)"]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L))
    print("\n".join(L[2:]))


if __name__ == "__main__":
    main()
