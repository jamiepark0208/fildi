"""S063 — does the StarMine credit gate (rank < 20 blocks puts, rules.MIN_CREDIT_RANK_PUTS) help put sales? (Jamie 10-19: 18 put names
+ CRWV blocked by an untested gate.)

No credit history before 2026-10-04 (S060), so this uses the 10-04 rank (pre-crash) as a fixed label on the S059 put sims
(Monday close → Friday close, ~1σ strike, pnl net of fills). Bias: a rank at the END of the window partly reflects the window's own
drops, which makes low-credit puts look WORSE than they were → the test is tilted toward keeping the gate. Read asymmetrically:
low-credit puts not worse (pnl and breach, week-clustered) → gate costs trades for nothing → loosen; worse → keep.
Literature prior: Vasquez & Xiao (Mgmt Sci 2024) — delta-hedged option buyers earn less on high-default firms (sellers more);
Campbell-Hilscher-Szilagyi (2008) — distressed stocks earn less (hurts unhedged put sellers). Net sign is empirical.
The lab panel ends 2026-10-01, so the crash weeks after the label can't be checked here (live grading covers them).

    .venv/bin/python analysis/s063_credit_gate.py [--smoke]
"""
from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]
import s059_option_factors as S9  # noqa: E402

LABEL_DAY = date(2026, 10, 4)
CUT = 20


def wk_test(ev, key):
    """Mean of per-week (low − rest) differences, t over weeks (clusters the crash weeks)."""
    by = defaultdict(lambda: ([], []))
    for e in ev:
        by[e["d"]][0 if e["low"] else 1].append(e[key])
    d = [sum(a) / len(a) - sum(b) / len(b) for a, b in by.values() if a and b]
    if len(d) < 3:
        return None, None, len(d)
    m = sum(d) / len(d)
    sd = math.sqrt(sum((x - m) ** 2 for x in d) / (len(d) - 1))
    return m, m / (sd / math.sqrt(len(d))) if sd else None, len(d)


def summary(name, ev):
    lo = [e for e in ev if e["low"]]
    hi = [e for e in ev if not e["low"]]
    if not lo or not hi:
        return f"| {name} | {len(lo)} | {len(hi)} | — | — | — | — |"
    f = lambda xs, k: sum(x[k] for x in xs) / len(xs)  # noqa: E731
    dp, tp, nw = wk_test(ev, "pnl")
    db, tb, _ = wk_test(ev, "breach")
    return (f"| {name} | {len(lo)} | {len(hi)} | {1e4 * f(lo, 'pnl'):+.1f} vs {1e4 * f(hi, 'pnl'):+.1f} | "
            f"{100 * f(lo, 'breach'):.1f} % vs {100 * f(hi, 'breach'):.1f} % | "
            f"{'—' if dp is None else f'{1e4 * dp:+.1f} bp (t {tp:.2f})'} | {'—' if db is None else f'{100 * db:+.1f} pp (t {tb:.2f})'} | {nw} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="5 names, print a few events to hand-check")
    a = ap.parse_args()
    conn = S9.connect() if hasattr(S9, "connect") else __import__("s045_put_retest").connect()
    rank = dict(conn.execute("""SELECT DISTINCT ON (ticker) ticker, credit_combined_rank::float8 FROM lseg_research.signals_daily
                                WHERE credit_combined_rank IS NOT NULL AND as_of <= %s ORDER BY ticker, as_of DESC""",
                             (LABEL_DAY,)).fetchall())
    ev = [e for e in S9.aligned_events(conn) if e["t"] in rank]
    if a.smoke:
        keep = sorted({e["t"] for e in ev if rank[e["t"]] < CUT})[:3] + sorted({e["t"] for e in ev if rank[e["t"]] >= CUT})[:2]
        ev = [e for e in ev if e["t"] in keep]
        for e in sorted(ev, key=lambda e: e["d"])[-6:]:
            print(e["t"], e["d"], f"credit {rank[e['t']]:.0f}", f"iv30 {e['iv30']:.2f}", f"breach {e['breach']:.0f}", f"pnl {1e4 * e['pnl']:+.1f} bp")
    for e in ev:
        e["low"] = rank[e["t"]] < CUT
    # put-edge proxy: top 40 % IV/RV within the week (S059's strongest factor; the live lane only sells Q4–Q5)
    wk = defaultdict(list)
    for e in ev:
        if e.get("iv_rv") is not None:
            wk[e["d"]].append(e)
    for es in wk.values():
        es.sort(key=lambda e: e["iv_rv"])
        for i, e in enumerate(es):
            e["rich"] = i >= 0.6 * len(es)
    pre = [e for e in ev if e["d"] < LABEL_DAY]
    last52 = [e for e in pre if (LABEL_DAY - e["d"]).days <= 364]
    lines = ["| Sample | low-credit puts | other puts | pnl bp/wk (low vs other) | breach (low vs other) | weekly diff pnl | weekly diff breach | weeks |",
             "|---|---|---|---|---|---|---|---|",
             summary("2020→10-04, all", pre),
             summary("2020→10-04, rich IV/RV (edge proxy)", [e for e in pre if e.get("rich")]),
             summary("last 52 wks, all", last52),
             summary("last 52 wks, rich IV/RV", [e for e in last52 if e.get("rich")]),
             ]
    # tails: distress = gap risk; per-put worst 1 % / 5 % pnl and pnl ÷ stdev (risk-adjusted), pre-label sample
    def tail(xs):
        v = sorted(e["pnl"] for e in xs)
        m = sum(v) / len(v)
        sd = math.sqrt(sum((x - m) ** 2 for x in v) / (len(v) - 1))
        return f"worst 1 % {1e4 * v[len(v) // 100]:+.0f} bp · worst 5 % {1e4 * v[len(v) // 20]:+.0f} bp · mean/sd {m / sd:.3f}"
    lines += ["", f"Tails 2020→10-04 — low credit: {tail([e for e in pre if e['low']])}", f"Tails 2020→10-04 — other: {tail([e for e in pre if not e['low']])}"]
    names = sorted({e["t"] for e in ev if e["low"]})
    print(f"S063 credit gate: {len(rank)} ranked names, {len(names)} below {CUT}; events {len(ev)}")
    print("\n".join(lines))
    if not a.smoke:
        out = HERE.parent / "out" / "opt" / "S063.md"
        out.write_text(f"# S063 — StarMine credit gate (< {CUT}) on put sales\n\n{__doc__}\n\nLow-credit names ({len(names)}): {', '.join(names)}\n\n"
                       + "\n".join(lines) + "\n")
        print("→", out)


if __name__ == "__main__":
    main()
