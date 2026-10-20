"""S073 — A196 (Visser trend/momentum filter) + A204 (index trend throttle), one run on the S069 harness
(weekly ~1σ puts, every name, 2020 →, pnl net of fills). Pre-registered in asks/A196.md + asks/A204.md (Claude plan 10-20).

A196 per-name gates (point-in-time, close ≤ entry day):
  up    = close > MA200 and MA200 > MA200 20 sessions ago
  reset = up and |ROC63| ≤ 1 % now and max ROC63 over the prior 10 sessions > +5 %
  Pass: kept − removed pnl ≥ 0 and breach −20 % relative, entries kept ≥ 40 %, same sign both halves, worst 1 % not worse.
  Marginal check: same comparison inside put-edge Q4–Q5 (what the live list already keeps).
  Use case 2: breached puts (≈ assignments) → next 63-session stock return after expiry, below a falling MA200 vs not.
A204 index throttle: trend-down = SPY < MA100 and SPY ROC63 < 0 → half size.
  Pass: mean of the worst 10 % of weeks (book = equal-weight puts) improves ≥ 15 % at ≤ 10 % premium cost, both halves.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s073_trend_gates.py
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s059_option_factors as S  # noqa: E402
from build_plan import connect  # noqa: E402
from s045_put_retest import Z, bs_put  # noqa: E402
from s069_gate_audit import boot_t, rank, summ  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S073.md"
SPLIT = date(2024, 1, 1)
rng = np.random.default_rng(73)


def trend_state(closes, i):
    """(up, reset, below_falling) at index i, or None without 263 sessions of history."""
    if i < 262:
        return None
    c = closes
    ma = c[i - 199:i + 1].mean()
    ma_prev = c[i - 219:i - 19].mean()
    roc = lambda j: c[j] / c[j - 63] - 1
    up = c[i] > ma and ma > ma_prev
    reset = up and abs(roc(i)) <= 0.01 and max(roc(j) for j in range(i - 10, i)) > 0.05
    return up, reset, c[i] < ma and ma < ma_prev


def gate_rows(name, ev, keep_f):
    L = []
    for lab, wf in (("all", lambda e: True), ("2020–23", lambda e: e["d"] < SPLIT), ("2024 →", lambda e: e["d"] >= SPLIT),
                    ("edge Q4–Q5", lambda e: (e.get("edge_q") or 0) >= 4)):
        xs = [e for e in ev if wf(e) and keep_f(e) is not None]
        keep, rem = [e for e in xs if keep_f(e)], [e for e in xs if not keep_f(e)]
        if len(keep) < 50 or len(rem) < 50:
            L.append(f"| {name} | {lab} | n/a (kept {len(keep)}, removed {len(rem)}) |||||||||")
            continue
        k, r = summ(keep), summ(rem)
        d, t = boot_t(keep, rem)
        rel_breach = k[2] / r[2] - 1 if r[2] else float("nan")
        L.append(f"| {name} | {lab} | {len(keep) / len(xs):.0%} | {k[1]:+.1f} | {r[1]:+.1f} | {d * 1e4:+.1f} ({t:.1f}) | {k[2]:.1%} | {r[2]:.1%} | "
                 f"{rel_breach:+.0%} | {k[3]:+.0f} | {r[3]:+.0f} |")
    return L


def main():
    conn = connect()
    ev = S.aligned_events(conn)
    tickers = sorted({e["t"] for e in ev} | {"SPY"})
    px = defaultdict(list)
    for t, d, c in conn.execute("SELECT ticker, date, close::float FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 "
                                "ORDER BY ticker, date", (tickers,)).fetchall():
        px[t].append((d, c))
    ser = {t: ([d for d, _ in v], np.array([c for _, c in v])) for t, v in px.items()}
    byw = defaultdict(list)
    for e in ev:
        byw[e["d"]].append(e)
        ds, cs = ser.get(e["t"], ([], np.array([])))
        i = bisect_right(ds, e["d"]) - 1
        st = trend_state(cs, i) if i >= 0 else None
        e["up"], e["reset"] = (st[0], st[1]) if st else (None, None)
        j = i + e["hold_sessions"]
        e["exp_i"] = (e["t"], j) if st and j + 63 < len(cs) else None
        sd, sc = ser["SPY"]
        k = bisect_right(sd, e["d"]) - 1
        e["spy_down"] = (sc[k] < sc[k - 99:k + 1].mean() and sc[k] / sc[k - 63] - 1 < 0) if k >= 99 else None
        tt = e["hold_sessions"] / 252
        kk = math.exp(-Z * e["iv30"] * math.sqrt(tt))
        e["prem"] = bs_put(1.0, kk, e["iv30"], tt) / kk
    for w, xs in byw.items():  # live put-edge quintile (S069)
        ok = [e for e in xs if all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech"))]
        if len(ok) >= 30:
            comp = rank(sum(rank([e[k] for e in ok]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
            for e, p in zip(ok, comp):
                e["edge_q"] = min(5, int(p * 5) + 1)

    L = ["# S073 — trend gates on weekly ~1σ puts (A196 Visser filter, A204 index throttle), net of fills, 2020 →", "",
         f"{len(ev)} puts, {len(byw)} weeks. kept/removed = puts the filter keeps vs blocks, same weeks; diff = kept − removed bp/wk, week-cluster t.", "",
         "## A196 — per-name filter (ablation)", "",
         "| filter | sample | kept % | kept pnl bp | removed pnl bp | diff (t) | kept breach | removed breach | breach rel | kept worst 1 % | removed worst 1 % |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    L += gate_rows("(1)+(2) up-trend", ev, lambda e: e["up"])
    L += gate_rows("(1)+(2)+(3) Visser reset", ev, lambda e: e["reset"])

    # use case 2: breached puts → 63-session forward stock return after expiry, by trend at expiry
    L += ["", "## A196 use case 2 — breached puts (≈ assigned): next 63 sessions after expiry", "",
          "| state at expiry | n | mean fwd 63 d | 90 % CI (week bootstrap) | 2020–23 | 2024 → |", "|---|---|---|---|---|---|"]
    grp = {True: [], False: []}
    for e in ev:
        if e["breach"] and e["exp_i"]:
            t, j = e["exp_i"]
            cs = ser[t][1]
            st = trend_state(cs, j)
            if st:
                grp[st[2]].append((e["d"], cs[j + 63] / cs[j] - 1))
    for lab, key in (("below falling MA200 (rule says exit)", True), ("otherwise (hold)", False)):
        xs = grp[key]
        if len(xs) < 30:
            L.append(f"| {lab} | {len(xs)} | n/a ||||")
            continue
        v = np.array([r for _, r in xs])
        wk = defaultdict(list)
        for d, r in xs:
            wk[d].append(r)
        ks = list(wk)
        bs = [np.mean([r for k in rng.choice(ks, len(ks)) for r in wk[k]]) for _ in range(1000)]
        h1 = np.mean([r for d, r in xs if d < SPLIT]) if any(d < SPLIT for d, _ in xs) else float("nan")
        h2 = np.mean([r for d, r in xs if d >= SPLIT]) if any(d >= SPLIT for d, _ in xs) else float("nan")
        L.append(f"| {lab} | {len(v)} | {v.mean():+.1%} | {np.percentile(bs, 5):+.1%} .. {np.percentile(bs, 95):+.1%} | {h1:+.1%} | {h2:+.1%} |")

    # A204: index throttle, book = equal-weight puts per week
    L += ["", "## A204 — SPY trend-down (SPY < MA100 and ROC63 < 0) → half size", "",
          "| sample | weeks | down weeks | worst 10 % weeks base bp | throttled bp | tail improvement | premium cost | 90 % CI improvement |",
          "|---|---|---|---|---|---|---|---|"]
    weeks = sorted(w for w, xs in byw.items() if xs[0]["spy_down"] is not None)
    for lab, wf in (("all", lambda w: True), ("2020–23", lambda w: w < SPLIT), ("2024 →", lambda w: w >= SPLIT)):
        ws = [w for w in weeks if wf(w)]
        base = np.array([np.mean([e["pnl"] for e in byw[w]]) for w in ws])
        sz = np.array([0.5 if byw[w][0]["spy_down"] else 1.0 for w in ws])
        prem = np.array([np.mean([e["prem"] for e in byw[w]]) for w in ws])

        def tail_imp(idx):
            b, th = base[idx], base[idx] * sz[idx]
            n = max(1, len(idx) // 10)
            tb, tt_ = np.sort(b)[:n].mean(), np.sort(th)[:n].mean()
            return (tt_ - tb) / abs(tb), tb, tt_

        imp, tb, tt_ = tail_imp(np.arange(len(ws)))
        cost = 1 - (prem * sz).sum() / prem.sum()
        bs = [tail_imp(rng.integers(0, len(ws), len(ws)))[0] for _ in range(1000)]
        L.append(f"| {lab} | {len(ws)} | {int((sz < 1).sum())} | {tb * 1e4:+.0f} | {tt_ * 1e4:+.0f} | {imp:+.0%} | {cost:.0%} | "
                 f"{np.percentile(bs, 5):+.0%} .. {np.percentile(bs, 95):+.0%} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
