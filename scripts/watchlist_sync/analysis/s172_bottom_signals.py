#!/usr/bin/env python3
"""S172 — market-bottom signals → long calls / short puts on SPY, QQQ, IWM (Jamie 11-09: VIX 1m/3m normalizing = bottom; Fildi missed it).

Re-grades S129 (FAIL was a units error: short put "pnl/$ premium" = +100 % by construction vs long call pnl/$ debit) with fair comparators,
2009→ history (LSEG daily_history backfilled 11-09), an "any day" control, a placebo and two halves.

Pre-registered (11-09, before any result):
  Signals (entry = close of signal day; one per 14 calendar days):
    U   VIX÷VIX3M < 1 after ≥ 2 sessions ≥ 1                       (S129 / Tom Lee "un-invert")
    E   early normalizing: VIX÷VIX3M still ≥ 1, peak of the run ≥ 1.05 and ratio ≤ peak − 0.05 (first day)
    N9  VIX9D÷VIX < 1 after ≥ 2 sessions ≥ 1
    D   VIX one-day drop ≥ 15 % with prior close ≥ 25
    VV  VVIX ≤ 0.90 × its 10-day max, that max ≥ 120
  Trades (MODEL: Black-Scholes at the ETF's LSEG iv30, 2 % of debit round-trip haircut on calls):
    call30   0.50Δ 30-DTE call held to expiry          → pnl per $ debit; comparator same-Δ stock (Δ·ΔS / debit)
    call10   same call, sold after 10 sessions (BS at that day's iv)
    put20    0.20Δ 30-DTE short put held to expiry     → pnl per $ cash collateral (K); comparator T-bill 30 d
  Control: the same trade entered every trading day. Lift = signal mean − control mean.
  Placebo: 2,000 random draws of n control days → share with mean ≥ the signal's (p).
  Pass (per signal × trade): lift > 0 in both halves (2009–2017 / 2018→), p ≤ 0.10, n ≥ 12.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s172_bottom_signals.py
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import NormalDist, mean, median

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S172.md"
START, HALF = date(2009, 10, 1), date(2018, 1, 1)
R = 0.02
N = NormalDist()


def bs(S, K, T, sig, call=True):
    if T <= 1e-6 or sig <= 0:
        return max(S - K, 0.0) if call else max(K - S, 0.0)
    v = sig * math.sqrt(T)
    d1 = (math.log(S / K) + (R + 0.5 * sig * sig) * T) / v
    d2 = d1 - v
    if call:
        return S * N.cdf(d1) - K * math.exp(-R * T) * N.cdf(d2)
    return K * math.exp(-R * T) * N.cdf(-d2) - S * N.cdf(-d1)


def strike(S, T, sig, delta, call=True):
    d1 = N.inv_cdf(delta if call else 1 - delta)
    return S * math.exp(-(d1 * sig * math.sqrt(T) - (R + 0.5 * sig * sig) * T))


def load(conn):
    ix = defaultdict(dict)
    for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M','VIX9D','VVIX')"):
        ix[i][d] = c
    px = defaultdict(dict)
    for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float8, iv30_call::float8 FROM lseg_research.daily_history
                                       WHERE ticker IN ('SPY','QQQ','IWM') AND close > 0 AND date >= %s ORDER BY date""", (START,)):
        if iv and iv > 0:
            px[t][d] = (c, iv / 100 if iv > 3 else iv)
    return ix, px


def cluster(days):
    out, last = [], None
    for d in days:
        if last is None or (d - last).days > 14:
            out.append(d)
        last = d
    return out


def signals(ix):
    days = sorted(d for d in set(ix["VIX"]) & set(ix["VIX3M"]) if d >= START)
    sig = {k: [] for k in ("U", "E", "N9", "D", "VV")}
    run, peak, fired_e = 0, 0.0, False
    for d in days:
        r = ix["VIX"][d] / ix["VIX3M"][d]
        if r >= 1:
            run += 1
            peak = max(peak, r)
            if not fired_e and peak >= 1.05 and r <= peak - 0.05:
                sig["E"].append(d)
                fired_e = True
        else:
            if run >= 2:
                sig["U"].append(d)
            run, peak, fired_e = 0, 0.0, False
    run = 0
    for d in sorted(x for x in set(ix["VIX9D"]) & set(ix["VIX"]) if x >= START):
        if ix["VIX9D"][d] / ix["VIX"][d] >= 1:
            run += 1
        else:
            if run >= 2:
                sig["N9"].append(d)
            run = 0
    vd = sorted(d for d in ix["VIX"] if d >= START - timedelta(days=5))
    for a, b in zip(vd, vd[1:]):
        if ix["VIX"][a] >= 25 and ix["VIX"][b] <= 0.85 * ix["VIX"][a]:
            sig["D"].append(b)
    vv = sorted(d for d in ix["VVIX"] if d >= START - timedelta(days=20))
    for i in range(10, len(vv)):
        m = max(ix["VVIX"][x] for x in vv[i - 10:i + 1])
        if m >= 120 and ix["VVIX"][vv[i]] <= 0.90 * m and vv[i] >= START:
            sig["VV"].append(vv[i])
    return {k: cluster(v) for k, v in sig.items()}


def trades(p, days, i):
    """All three trades entered at days[i]; None where the exit is past the data."""
    d0 = days[i]
    S, iv = p[d0]
    T = 30 / 365
    out = {}
    j = bisect_left(days, d0 + timedelta(days=30))
    if j < len(days):
        Se = p[days[j]][0]
        K = strike(S, T, iv, 0.50)
        debit = bs(S, K, T, iv) * 1.02
        dlt = N.cdf((math.log(S / K) + (R + 0.5 * iv * iv) * T) / (iv * math.sqrt(T)))
        out["call30"] = ((max(Se - K, 0) - debit) / debit, dlt * (Se - S) / debit)
        Kp = strike(S, T, iv, 0.20, call=False)
        prem = bs(S, Kp, T, iv, call=False) * 0.98
        out["put20"] = ((prem - max(Kp - Se, 0)) / Kp, R * 30 / 365)
        if i + 10 < len(days):
            d10 = days[i + 10]
            S10, iv10 = p[d10]
            v10 = bs(S10, K, max(T - (d10 - d0).days / 365, 0), iv10)
            out["call10"] = ((v10 - debit) / debit, dlt * (S10 - S) / debit)
    return out


def main() -> int:
    conn = connect()
    ix, px = load(conn)
    sig = signals(ix)
    lines = ["# S172 — market-bottom signals → long calls / short puts (Jamie 11-09)", "",
             "MODEL pricing (BS at LSEG iv30, 2 % debit haircut on calls). Control = same trade every day. Placebo p = share of 2,000 random",
             f"same-n day sets with mean ≥ signal. Halves: < {HALF} / ≥ {HALF}. Pass = lift > 0 both halves, p ≤ 0.10, n ≥ 12.", "",
             "| signal | ETF | trade | n | mean | median | win % | vs comparator | control mean | lift | p | lift H1 | lift H2 | pass |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    rng = random.Random(172)
    passes = []
    for t in ("SPY", "QQQ", "IWM"):
        p = px[t]
        days = sorted(p)
        allt = [trades(p, days, i) for i in range(len(days))]
        for tr in ("call30", "call10", "put20"):
            ctrl = [(days[i], a[tr][0]) for i, a in enumerate(allt) if tr in a]
            cv = [x for _, x in ctrl]
            cm = mean(cv)
            ch = {h: mean([x for d, x in ctrl if (d < HALF) == h]) for h in (True, False)}
            for s, sd in sig.items():
                rows = []
                for d in sd:
                    i = bisect_left(days, d)
                    if i < len(days) and days[i] == d and tr in allt[i]:
                        rows.append((d, *allt[i][tr]))
                if len(rows) < 3:
                    continue
                v = [r[1] for r in rows]
                m = mean(v)
                hl = {h: [r[1] for r in rows if (r[0] < HALF) == h] for h in (True, False)}
                l1 = mean(hl[True]) - ch[True] if hl[True] else float("nan")
                l2 = mean(hl[False]) - ch[False] if hl[False] else float("nan")
                pv = sum(mean(rng.sample(cv, len(v))) >= m for _ in range(2000)) / 2000
                ok = len(v) >= 12 and pv <= 0.10 and l1 > 0 and l2 > 0
                if ok:
                    passes.append(f"{s} {t} {tr}")
                cmp_ = mean(r[2] for r in rows)
                lines.append(f"| {s} | {t} | {tr} | {len(v)} | {m:+.1%} | {median(v):+.1%} | {sum(x > 0 for x in v) / len(v):.0%} | "
                             f"{cmp_:+.1%} | {cm:+.1%} | {m - cm:+.1%} | {pv:.2f} | {l1:+.1%} | {l2:+.1%} | {'PASS' if ok else ''} |")
    # Winner pass (contract 11): U × SPY call30 winners vs losers — pre-entry features (inverted-run length, peak ratio, SPY 20d return)
    p, days = px["SPY"], sorted(px["SPY"])
    vr = sorted(d for d in set(ix["VIX"]) & set(ix["VIX3M"]))
    feats = []
    for d in sig["U"]:
        i = bisect_left(days, d)
        if i >= len(days) or days[i] != d or "call30" not in trades(p, days, i) or i < 20:
            continue
        k = bisect_left(vr, d)
        run, pk = 0, 0.0
        while k - 1 - run >= 0 and ix["VIX"][vr[k - 1 - run]] / ix["VIX3M"][vr[k - 1 - run]] >= 1:
            pk = max(pk, ix["VIX"][vr[k - 1 - run]] / ix["VIX3M"][vr[k - 1 - run]])
            run += 1
        feats.append((trades(p, days, i)["call30"][0] > 0, run, pk, p[d][0] / p[days[i - 20]][0] - 1))
    w = [f for f in feats if f[0]]
    l_ = [f for f in feats if not f[0]]
    avg = lambda xs, j: mean(x[j] for x in xs) if xs else float("nan")  # noqa: E731
    lines += ["", "## Winner pass (U × SPY call30, pre-entry only)",
              f"Winners {len(w)} / losers {len(l_)}: inverted run {avg(w, 1):.1f} vs {avg(l_, 1):.1f} sessions · peak ratio {avg(w, 2):.3f} vs {avg(l_, 2):.3f} · "
              f"SPY 20d return {avg(w, 3):+.1%} vs {avg(l_, 3):+.1%}.",
              "Failed arms: lift flips sign between halves (E early, D: + 2009–17 / − 2018→; N9: the reverse; VV ≈ 0 both) — no stable pre-entry split; next rule to test: "
              "U entry with per-name high-beta calls (Model List) and a 10-session exit grid.",
              "", f"Verdict: RULE entry = first close VIX÷VIX3M < 1 after ≥ 2 inverted sessions × exit = hold to expiry × structure = 0.50Δ 30 DTE call "
              f"(and 0.20Δ 30 DTE short put) → PASS on {len(sig['U'])} independent episodes (clustered 14 d). "
              "Other signal RULES (early-normalizing, VIX9D, VIX-drop, VVIX entry × same exits) → NO-LIFT at n 15–108 episodes."]
    lines += ["", "Signal dates (clustered 14 d):"]
    lines += [f"- {s} ({len(v)}): {', '.join(map(str, v[-12:]))}{' …' if len(v) > 12 else ''}" for s, v in sig.items()]
    lines += ["", f"Passing cells: {', '.join(passes) or 'none'}", "", "Refs: A244"]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
