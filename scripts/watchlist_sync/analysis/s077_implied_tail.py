"""S077 — implied (risk-neutral) put-tail odds from real LSEG option prices vs what happened, 2021 → (A217 historical leg).

Jamie 10-21: "don't we have implied probabilities from options prices historical data? from lseg? why wait until January?"
The cached ladders (S071/S064/S066) are entry events (dips, earnings) → a biased sample (pilot 10-21: breach ~22 % in every
Q bucket). This pulls an unbiased one: random names × every monthly expiry × 3 neighbouring put strikes around the 1σ put.
One LSEG request = the contract's whole daily life (bid/ask/IV), cached in optlab.lseg_opt_daily.

Q(S_T < K) = ∂P/∂K ≈ (P(K+step) − P(K−step)) / (2·step) on real mids (Breeden–Litzenberger, first derivative).
Compared with: realized S_T < K · flat-vol N(−d2) at the stock's ATM iv30 (what the harness assumes) · N(−d2) at RV20.
Gap = Q − N(−d2 at RV20): the variance premium in probability units at the sold strike, skew included.

Pre-registered (A217 Claude plan 10-21), checked once, no re-cut:
  1. Calibration: implied Q vs realized by Q bucket, Brier vs flat-vol BS (descriptive).
  2. Signal: within IV/RV terciles, top − bottom gap tercile in put pnl (sold at bid + 23 % of spread, held to expiry,
     on strike), month-cluster t ≥ 2 and same sign 2021–23 / 2024 → → the gap adds to IV/RV. Else display-only.

    cd scripts/watchlist_sync && ../../research/lseg/.venv/bin/python analysis/s077_implied_tail.py [--fetch] [--names=50]
"""
from __future__ import annotations

import math
import random
import statistics as st
import sys
from bisect import bisect_right
from collections import defaultdict
from contextlib import nullcontext
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s045_put_retest import ncdf  # noqa: E402
from s049_panic_puts import split_factor  # noqa: E402
from s066_earnings_puts import OP, lseg_session  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S077.md"
START, SPLIT = date(2021, 1, 1), date(2024, 1, 1)
FILL = 0.23   # Robinhood fill = bid + 23 % of the spread (S012)
SEED = 77


def arg(name, default):
    return next((type(default)(a.split("=", 1)[1]) for a in sys.argv if a.startswith(f"--{name}=")), default)


def third_fridays(lo: date, hi: date) -> list[date]:
    out, d = [], date(lo.year, lo.month, 1)
    while d <= hi:
        f = d + timedelta(days=(4 - d.weekday()) % 7 + 14)
        if lo <= f <= hi:
            out.append(f)
        d = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
    return out


def step_for(s: float) -> float:
    # measured 10-21 on Polygon-listed monthlies (k − g, k, k + g all listed): $0.5 < $5 86 % · $1 $5–100 81–92 %
    # · $5 $100–200 86 % · $10 > $200 100 % (the $2.5 grid was listed only 36–38 % → wasted requests)
    return 0.5 if s < 5 else 1.0 if s < 100 else 5.0 if s < 200 else 10.0


def listed(conn, t: str, exp: date) -> list[float]:
    return sorted(k for (k,) in conn.execute("SELECT strike FROM optlab.contracts WHERE underlying = %s AND expiry = %s "
                                               "AND type = 'put'", (t, exp)))


def load_hist(conn):
    h = defaultdict(list)
    for t, d, c, ivp in conn.execute("SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history "
                                     "WHERE close > 0 ORDER BY ticker, date"):
        h[t].append((d, c, (ivp / 100 if ivp and ivp > 3 else ivp)))
    return h, {t: [r[0] for r in v] for t, v in h.items()}


def names(conn, hist, n):
    roots = [r for (r,) in conn.execute("""SELECT DISTINCT substring(ric from '^([A-Z]+)[M-X][0-9]') FROM optlab.lseg_opt_daily""")
             if r and r in hist and hist[r][0][0] <= START + timedelta(days=60)]
    return sorted(random.Random(SEED).sample(sorted(roots), min(n, len(roots))))


def plan(conn, hist, keys, tickers):
    """(ticker, expiry, [k−, k, k+]) — 1σ put strike ~30 calendar days before each monthly expiry, traded (unadjusted) prices."""
    out = []
    for t in tickers:
        for exp in third_fridays(START + timedelta(days=45), date.today() - timedelta(days=3)):
            i = bisect_right(keys[t], exp - timedelta(days=30)) - 1
            if i < 0 or not hist[t][i][2]:
                continue
            d, c, iv = hist[t][i]
            s = c * split_factor(conn, t, d)
            k = s * math.exp(-iv * math.sqrt((exp - d).days / 365))
            ls = listed(conn, t, exp)   # Polygon chain already cached → exact listed neighbours, zero misses
            j = min(range(len(ls)), key=lambda x: abs(ls[x] - k)) if ls else None
            if j is not None and 0 < j < len(ls) - 1 and abs(ls[j] - k) / s < 0.05:
                out.append((t, exp, [ls[j - 1], ls[j], ls[j + 1]]))
                continue
            stp = step_for(s)
            k = round(k / stp) * stp
            out.append((t, exp, [round(k - stp, 2), round(k, 2), round(k + stp, 2)]))
    random.Random(SEED).shuffle(out)   # a run cut short by the budget is still a random sample
    return out


def fetch(conn, todo):
    import fcntl
    lock = open("/tmp/fildi-logs/s077-fetch.lock", "w")
    try:   # one fetch at a time (maintain's research queue + manual runs)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another fetch holds the lock; exiting")
        return
    with lseg_session() as ld:
        done, got_any = 0, False
        for t, exp, ks in todo:
            if ld.remaining < 200 or ld.dp_remaining < 20_000:
                print(f"stop: LSEG reserve reached after {done} expiries (requests left {ld.remaining}, datapoints left "
                      f"{ld.dp_remaining:,.0f}); the cache keeps progress — re-run resumes")
                break
            lo, k, hi = ks
            if done == 10 and not got_any:   # smoke: 10 expiries with no data at all → RIC/strike logic is wrong; stop spending
                print("stop: smoke check failed — first 10 expiries returned no option history")
                break
            try:   # middle strike first: if it isn't listed, skip its neighbours (saves 2 requests)
                if OP.history(ld, conn, t, exp, "P", k) is None:
                    done += 1
                    continue
                got_any = True
                for kk in (lo, hi):
                    OP.history(ld, conn, t, exp, "P", kk)
            except RuntimeError as e:
                if "budget guard" in str(e):
                    print(f"stop: {e}")
                    break
                print(f"  {t} {exp}: {str(e)[:80]}")
            except Exception as e:   # one bad contract must not end the run
                print(f"  {t} {exp}: {str(e)[:80]}")
            conn.commit()
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(todo)} expiries · LSEG remaining {ld.remaining}", flush=True)


def rows_for(conn, hist, keys, todo):
    rows = []
    for t, exp, ks in todo:
        px = {}
        for k in ks:
            try:
                h = OP.history(None, conn, t, exp, "P", k)
            except RuntimeError:     # not cached yet
                h = None
            px[k] = {r[0]: r for r in (h or []) if r[1] and r[2] and r[1] > 0 and r[2] >= r[1]}
        lo, k, hi = ks
        j = bisect_right(keys[t], exp) - 1
        if j < 0 or (exp - hist[t][j][0]).days > 4:
            continue
        st_ = hist[t][j][1] * split_factor(conn, t, exp)
        weeks = set()
        for d in sorted(set(px[lo]) & set(px[k]) & set(px[hi])):
            dte = (exp - d).days
            wk = d.isocalendar()[:2]
            if not 7 <= dte <= 45 or wk in weeks:
                continue
            i = bisect_right(keys[t], d) - 1
            if i < 20 or hist[t][i][0] != d or not hist[t][i][2]:
                continue
            weeks.add(wk)
            s = hist[t][i][1] * split_factor(conn, t, d)
            iv = hist[t][i][2]
            cl = [hist[t][x][1] for x in range(i - 20, i + 1)]
            lr = [math.log(cl[x] / cl[x - 1]) for x in range(1, 21)]
            m = sum(lr) / 20
            rv = math.sqrt(sum((x - m) ** 2 for x in lr) / 19 * 252)
            mid = lambda kk: (px[kk][d][1] + px[kk][d][2]) / 2
            q = (mid(hi) - mid(lo)) / (hi - lo)
            if not 0 < q < 1 or not rv:
                continue
            T = dte / 365
            n2 = lambda v: ncdf((math.log(k / s) + 0.5 * v * v * T) / (v * math.sqrt(T)))
            bid, ask = px[k][d][1], px[k][d][2]
            fill = bid + FILL * (ask - bid)
            rows.append({"t": t, "d": d, "dte": dte, "q": q, "bs": n2(iv), "rvp": n2(rv), "iv_rv": iv / rv,
                         "y": 1.0 if st_ < k else 0.0, "pnl": (fill - max(k - st_, 0)) / k, "mon": d.strftime("%Y-%m")})
    return rows


def cluster_t(diffs):
    """t of the mean of per-month values (month-cluster)."""
    if len(diffs) < 3:
        return float("nan")
    return st.mean(diffs) / (st.stdev(diffs) / math.sqrt(len(diffs))) if st.stdev(diffs) else float("nan")


def report(rows, n_names, n_exp):
    L = ["# S077 — implied put-tail odds (real LSEG mids, ∂P/∂K) vs realized, 2021 →", "",
         f"{len(rows):,} weekly observations · {len({r['t'] for r in rows})} of {n_names} sampled names · {n_exp} name-expiries planned · "
         f"monthly expiries, 1σ put ± one strike step, 7–45 DTE.", "",
         "## 1. Calibration (does the option market's breach probability match what happened?)", "",
         "| implied Q bucket | n | implied Q | flat-vol BS | realized | Q ÷ realized |", "|---|---|---|---|---|---|"]
    def line(rs, lab):
        if len(rs) < 30:
            return
        q, b, y = (st.mean(r[x] for r in rs) for x in ("q", "bs", "y"))
        L.append(f"| {lab} | {len(rs)} | {q:.3f} | {b:.3f} | {y:.3f} | {q / y:.2f} |" if y else f"| {lab} | {len(rs)} | {q:.3f} | {b:.3f} | 0 | – |")
    for lo, hi in ((0, .05), (.05, .10), (.10, .15), (.15, .20), (.20, .30), (.30, 1)):
        line([r for r in rows if lo <= r["q"] < hi], f"{lo:.2f}–{hi:.2f}")
    line(rows, "all")
    line([r for r in rows if r["d"] < SPLIT], "2021–23")
    line([r for r in rows if r["d"] >= SPLIT], "2024 →")
    base = st.mean(r["y"] for r in rows)
    br = lambda k: st.mean((r[k] - r["y"]) ** 2 for r in rows)
    L += ["", f"Brier (lower = better): implied Q {br('q'):.4f} · flat-vol BS {br('bs'):.4f} · RV-based {br('rvp'):.4f} · "
              f"base rate {st.mean((base - r['y']) ** 2 for r in rows):.4f}", "",
          "## 2. Does the gap (Q − RV-based odds) add to IV/RV for put pnl? (pre-registered)", ""]
    for r in rows:
        r["gap"] = r["q"] - r["rvp"]
    def terc(rs, key):
        v = sorted(r[key] for r in rs)
        a, b = v[len(v) // 3], v[2 * len(v) // 3]
        return lambda r: 0 if r[key] < a else 1 if r[key] < b else 2
    ti = terc(rows, "iv_rv")
    bym = defaultdict(list)
    per_era = defaultdict(list)
    for g in range(3):
        rs = [r for r in rows if ti(r) == g]
        if len(rs) < 90:
            continue
        tg = terc(rs, "gap")
        hi_, lo_ = [r for r in rs if tg(r) == 2], [r for r in rs if tg(r) == 0]
        L.append(f"- IV/RV tercile {g + 1}: top-gap pnl {st.mean(r['pnl'] for r in hi_):+.2%} vs bottom-gap {st.mean(r['pnl'] for r in lo_):+.2%} "
                 f"(n {len(hi_)} / {len(lo_)}; breach {st.mean(r['y'] for r in hi_):.1%} vs {st.mean(r['y'] for r in lo_):.1%})")
        for side, sign in ((hi_, 1), (lo_, -1)):
            for r in side:
                bym[r["mon"]].append(sign * r["pnl"])
                per_era["2021–23" if r["d"] < SPLIT else "2024 →"].append(sign * r["pnl"])
    months = [st.mean(v) for v in bym.values() if v]
    t = cluster_t(months)
    eras = {k: st.mean(v) for k, v in per_era.items() if v}
    ok = t >= 2 and len(eras) == 2 and all(v > 0 for v in eras.values())
    L += ["", f"Top − bottom gap, within IV/RV terciles: mean {st.mean(months):+.3%}/trade-month, month-cluster t {t:+.2f}; "
              + " · ".join(f"{k} {v:+.3%}" for k, v in eras.items()),
          f"**Verdict: {'PASS — the gap adds to IV/RV' if ok else 'FAIL — display only (implied odds column), no signal claim'}**"]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


def main():
    conn = connect()
    OP.ensure(conn)
    hist, keys = load_hist(conn)
    tickers = names(conn, hist, arg("names", 50))
    todo = plan(conn, hist, keys, tickers)
    print(f"{len(tickers)} names · {len(todo)} name-expiries · ≤ {3 * len(todo)} LSEG requests if nothing is cached")
    if "--fetch" in sys.argv:
        fetch(conn, todo)
    rows = rows_for(conn, hist, keys, todo)
    if len(rows) < 100:
        print(f"only {len(rows)} observations cached — run with --fetch (needs LSEG Workspace open)")
        return
    report(rows, len(tickers), len(todo))


if __name__ == "__main__":
    main()
