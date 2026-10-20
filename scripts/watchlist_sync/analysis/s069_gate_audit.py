"""S069 — gate audit (Jamie 10-20: "why do untested filters exclude deterministically? maybe we exclude too much"). Start from NO filters:
every weekly ~1σ put on every name, 2020 → (S059 harness, 70k puts, pnl net of fills). For each live L1/verdict gate, compare the puts
it would REMOVE with the puts it KEEPS, all weeks and crash weeks (SPY 20-day < −5 %). A gate earns its place only if removed puts
are worse (lower pnl or fatter tail) — same weeks, so the market move cancels.

Gates (point-in-time proxies; the live fit/OWN score has no history, so its inputs stand in):
  put_edge     S059 composite (rank of iv_rv + vol_of_vol + put_tech within week) in Q1–Q3            → live: block
  regime_pause SPY 20-day return < −5 % at entry (fit params pause_puts_spy20)                         → live: holds back every put
  earnings     earnings within 21 days of entry (lab earnings_21; live = before expiry, tighter)        → live: block
  min_income   premium < 0.30 % of strike per week (rules.MIN_WEEKLY_INCOME_PCT)                        → live: block
  own_proxy    StarMine combined alpha < 50 or IBES breadth < 0 (OWN inputs, S064 gate)                → live: OWN < 45 blocks
Stats: mean pnl bp/wk, breach, worst 1 % / 5 % of puts; diff = kept − removed with a week-cluster bootstrap t.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s069_gate_audit.py
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import s059_option_factors as S  # noqa: E402
from build_plan import connect  # noqa: E402
from s045_put_retest import Z, bs_put  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S069.md"
rng = random.Random(69)


def rank(v):
    a = np.argsort(np.argsort(v))
    return a / max(1, len(v) - 1)


def asof(series, d):
    i = bisect_right(series, (d, float("inf"))) - 1
    return series[i][1] if i >= 0 else None


def boot_t(keep, drop, n=1000):
    wk = defaultdict(lambda: ([], []))
    for e in keep:
        wk[e["d"]][0].append(e["pnl"])
    for e in drop:
        wk[e["d"]][1].append(e["pnl"])
    ks = [k for k, (a, b) in wk.items() if a and b]
    if len(ks) < 10:
        return float("nan"), float("nan")
    diff = lambda s: np.mean([x for k in s for x in wk[k][0]]) - np.mean([x for k in s for x in wk[k][1]])
    obs = diff(ks)
    bs = [diff([rng.choice(ks) for _ in ks]) for _ in range(n)]
    return obs, obs / np.std(bs)


def summ(x):
    p = np.sort([e["pnl"] for e in x])
    return len(p), p.mean() * 1e4, np.mean([e["breach"] for e in x]), p[len(p) // 100] * 1e4, p[len(p) // 20] * 1e4


def main():
    conn = connect()
    ev = S.aligned_events(conn)
    spy = conn.execute("SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date").fetchall()
    ds = [d for d, _ in spy]
    alpha = defaultdict(list)
    for t, d, v in conn.execute("SELECT ticker, obs_date, value::float FROM lseg_research.starmine_history WHERE metric = 'combined_alpha_rank' "
                                "ORDER BY obs_date").fetchall():
        alpha[t].append((d, v))
    fund = {(t, d): f.get("ibes_breadth") for t, d, f in conn.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_fund").fetchall()}
    byw = defaultdict(list)
    for e in ev:
        byw[e["d"]].append(e)
        i = bisect_right(ds, e["d"]) - 1
        e["spy20"] = spy[i][1] / spy[i - 20][1] - 1 if i >= 20 else None
        tt = e["hold_sessions"] / 252
        k = math.exp(-Z * e["iv30"] * math.sqrt(tt))
        e["prem_k_wk"] = bs_put(1.0, k, e["iv30"], tt) / k * 5 / max(1, e["hold_sessions"])
        a, b = asof(alpha[e["t"]], e["d"]), fund.get((e["t"], e["d"]))
        e["own_bad"] = None if a is None and b is None else bool((a is not None and a < 50) or (b is not None and b < 0))
    for w, xs in byw.items():  # put-edge quintile within week, as live
        ok = [e for e in xs if all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech"))]
        if len(ok) >= 30:
            comp = rank(sum(rank([e[k] for e in ok]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
            for e, p in zip(ok, comp):
                e["edge_q"] = min(5, int(p * 5) + 1)
    gates = [("put_edge Q1–Q3", lambda e: None if e.get("edge_q") is None else e["edge_q"] <= 3),
             ("regime_pause SPY20 < −5 %", lambda e: None if e["spy20"] is None else e["spy20"] < -0.05),
             ("earnings ≤ 21 d", lambda e: bool(e["earn"])),
             ("min_income < 0.30 %/wk", lambda e: e["prem_k_wk"] < 0.003),
             ("own_proxy (alpha < 50 or breadth < 0)", lambda e: e["own_bad"])]
    L = ["# S069 — gate audit: what each live filter removes vs keeps (weekly ~1σ puts, net of fills, 2020 →)", "",
         f"{len(ev)} puts, {len(byw)} weeks. Crash weeks = SPY 20-day < −5 % at entry. diff = kept − removed (bp/wk), week-cluster t.", "",
         "| gate | weeks | removed n | removed pnl bp | removed breach | removed worst 1 % | kept n | kept pnl bp | kept breach | kept worst 1 % | diff (t) | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, f in gates:
        for lab, wf in (("all", lambda e: True), ("crash", lambda e: e["spy20"] is not None and e["spy20"] < -0.05)):
            if name.startswith("regime") and lab == "crash":
                continue
            xs = [e for e in ev if wf(e) and f(e) is not None]
            rem, keep = [e for e in xs if f(e)], [e for e in xs if not f(e)]
            if len(rem) < 50 or len(keep) < 50:
                continue
            r, k = summ(rem), summ(keep)
            if name.startswith("regime"):  # different weeks by construction → compare levels, no paired t
                d, t = k[1] - r[1], float("nan")
            else:
                d, t = boot_t(keep, rem)
                d *= 1e4
            good = (d > 0 and (math.isnan(t) or t >= 2)) or k[3] > r[3] + 50
            L.append(f"| {name} | {lab} | {r[0]} | {r[1]:+.1f} | {r[2]:.0%} | {r[3]:+.0f} | {k[0]} | {k[1]:+.1f} | {k[2]:.0%} | {k[3]:+.0f} | "
                     f"{d:+.1f} ({t:.1f}) | {'earns its place' if good else 'NOT supported'} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
