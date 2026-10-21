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
from s045_put_retest import bs_put  # noqa: E402
from s049_panic_puts import put_delta, split_factor  # noqa: E402
from s066_earnings_puts import LSEG, OP, load, lseg_session, week_of  # noqa: E402,F401

START, HOLDOUT = date(2021, 1, 4), date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S071.md"
TARGETS = (0.10, 0.15, 0.20, 0.25, 0.30)
BUCKETS = ((0.05, 0.125), (0.125, 0.175), (0.175, 0.225), (0.225, 0.275), (0.275, 0.35))
NWEEK = 5
REQ_CAP = 2500
# Polygon listed chains (free, cached in optlab.contracts) so LSEG is only asked for strikes that exist (10-20: 55 % of
# requests were misses). --no-chain = use only chains already cached.
CHAIN = None if "--no-chain" in sys.argv else __import__("option_history").chain

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
        for K in OP.candidates(conn, t, e, "P", strike_at(S, iv / 100, T, tg), CHAIN)[:2]:
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
            nsess = j - i
            out.append(dict(t=t, d=d, e=e, K=K, dl=dl, prem=fill / K, iv=iv / 100, mid=(day[1] + day[2]) / 2 / K,
                            m252=bs_put(S, K, iv / 100, nsess / 252) / K, m365=bs_put(S, K, iv / 100, T) / K, Se=Se, pnl=(fill - max(0.0, K - Se)) / K, itm=Se < K))
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
            if ld.requests > REQ_CAP or ld.remaining < 200:  # 200 = one name's pulls; stop cleanly before the per-request guard
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
    # paired check (10-20 review): same name-week, each bucket minus the 0.175–0.225 bucket; week-cluster bootstrap t
    L += ["## Paired: bucket − 0.20Δ bucket, same name-week (bp of collateral/wk, week-cluster t)", "",
          "| slice | Δ bucket | pairs | diff bp | t |", "|---|---|---|---|---|"]
    bk = lambda dl: next((b for b in BUCKETS if b[0] <= dl < b[1]), None)
    nw = defaultdict(dict)
    for x in allx:
        b = bk(x["dl"])
        if b:
            nw[(x["t"], x["d"])][b] = x
    ref = BUCKETS[2]
    for lab, f in (("< 2024-07", lambda d: d < HOLDOUT), ("≥ 2024-07", lambda d: d >= HOLDOUT)):
        for b in BUCKETS:
            if b == ref:
                continue
            wk = defaultdict(list)
            for (t, d), m in nw.items():
                if f(d) and b in m and ref in m:
                    wk[m[ref]["e"]].append(m[b]["pnl"] - m[ref]["pnl"])
            ks = list(wk)
            n = sum(len(v) for v in wk.values())
            if n < 30:
                continue
            mean = lambda s: statistics.mean([v for k in s for v in wk[k]])
            obs = mean(ks)
            bs = [mean([rng.choice(ks) for _ in ks]) for _ in range(1000)]
            L.append(f"| {lab} | {b[0]:.3f}–{b[1]:.3f} | {n} | {obs * 1e4:+.1f} | {obs / statistics.stdev(bs):.1f} |")
    # income floor on real quotes (10-20 eve, Jamie: "target 0.75–1 %/wk?"): premium at the real fill ÷ strike, Mon→Fri
    L += ["", "## Income floor on real quotes: puts with fill ≥ floor vs below (all Δ buckets)", "",
          "| floor %/wk | kept n | kept pnl bp | below pnl bp | diff (t) | < 2024-07 | ≥ 2024-07 | kept worst 5 % |", "|---|---|---|---|---|---|---|---|"]
    def wdiff(k, r):
        wk = defaultdict(lambda: ([], []))
        for x in k:
            wk[x["e"]][0].append(x["pnl"])
        for x in r:
            wk[x["e"]][1].append(x["pnl"])
        ks = [w for w, (a, b) in wk.items() if a and b]
        if len(ks) < 10:
            return float("nan"), float("nan")
        f = lambda s: statistics.mean([v for w in s for v in wk[w][0]]) - statistics.mean([v for w in s for v in wk[w][1]])
        o = f(ks)
        return o, o / statistics.stdev([f([rng.choice(ks) for _ in ks]) for _ in range(500)])
    for fl in (0.003, 0.005, 0.0075, 0.01):
        k, r = [x for x in allx if x["prem"] >= fl], [x for x in allx if x["prem"] < fl]
        if len(k) < 30 or len(r) < 30:
            continue
        d, t = wdiff(k, r)
        h = [wdiff([x for x in k if (x["d"] < HOLDOUT) == hh], [x for x in r if (x["d"] < HOLDOUT) == hh])[0] for hh in (True, False)]
        w5 = sorted(x["pnl"] for x in k)[: max(1, len(k) // 20)]
        L.append(f"| {fl:.2%} | {len(k)} | {statistics.mean(x['pnl'] for x in k) * 1e4:+.1f} | {statistics.mean(x['pnl'] for x in r) * 1e4:+.1f} | "
                 f"{d * 1e4:+.1f} ({t:.1f}) | {h[0] * 1e4:+.1f} | {h[1] * 1e4:+.1f} | {statistics.mean(w5):+.2%} |")
    # harness check (10-20 eve): S059/S069 price the put with Black-Scholes at the stock's iv30 over trading sessions/252, minus a fill
    # model. Same contracts here: real mid and real fill vs model (sessions/252 = harness, calendar days/365), by iv30 bucket.
    L += ["", "## Harness check: real premium vs model premium on the same contracts (median ratio)", "",
          "| iv30 | n | real fill ÷ model 252 (harness) | real mid ÷ model 252 | real mid ÷ model 365 | real fill %/wk | model 252 %/wk |", "|---|---|---|---|---|---|---|"]
    for lo, hi in ((0, 0.3), (0.3, 0.5), (0.5, 0.8), (0.8, 9)):
        xs = [x for x in allx if lo <= x["iv"] < hi and x["m252"] > 1e-4]
        if len(xs) < 30:
            continue
        med = lambda f: statistics.median(f(x) for x in xs)
        L.append(f"| {lo:.0%}–{hi:.0%} | {len(xs)} | {med(lambda x: x['prem'] / x['m252']):.2f} | {med(lambda x: x['mid'] / x['m252']):.2f} | "
                 f"{med(lambda x: x['mid'] / x['m365']):.2f} | {statistics.mean(x['prem'] for x in xs):.2%} | {statistics.mean(x['m252'] for x in xs):.2%} |")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
