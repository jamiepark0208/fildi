#!/usr/bin/env python3
"""T3 (A281, pre-registered by Grok): UT Bot trail on stock already held vs plain hold vs a vol-scaled smaller position (S064).

Per name, daily bars from lseg_research.daily_history, 2020-06 → today (indicators.compute on the full history, author defaults):
  hold        always long
  ut_trail    long while ut_dir = +1, else cash; the signal publishes after the close → acts one bar later (two-bar lag on returns)
  vol_scaled  weight = min(1, name's expanding-median rv20 ÷ rv20), same lag; rest in cash
Cash earns the 3-month T-bill (FRED DTB3, out/opt/dtb3.csv). Each change of weight costs 5 bp of the traded amount.
Portfolio = equal weight across names with ≥ 320 warm-up bars that day. Also per-name Sharpe wins.
Pass (indicators.md T3): ut_trail has higher return per unit of risk (Sharpe) than both, same sign both halves, and its monthly
alpha on each comparator has t ≥ 2.5.

    .venv/bin/python analysis/t3_ut_trail.py [--tickers=A,B]   → out/opt/T3.md
"""
from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402

START, SPLIT, COST = date(2020, 6, 1), date(2023, 7, 1), 0.0005
STRATS = ("hold", "ut_trail", "vol_scaled")


def tbill() -> dict[date, float]:
    rf = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        d, v = line.split(",")
        if v not in ("", "."):
            rf[date.fromisoformat(d)] = float(v) / 100 / 252
    return rf


def name_returns(d, h, l, c, v, o, rf):
    s = IND.compute(d, h, l, c, v, o)
    c = np.asarray(c, float)
    r = np.r_[np.nan, c[1:] / c[:-1] - 1]
    rv = np.full(len(c), np.nan)
    lr = np.r_[np.nan, np.diff(np.log(c))]
    for i in range(21, len(c)):
        rv[i] = np.nanstd(lr[i - 19:i + 1]) * np.sqrt(252)
    med = np.array([np.nanmedian(rv[:i + 1]) if i >= 60 else np.nan for i in range(len(c))])
    w = {"hold": np.ones(len(c)),
         "ut_trail": (s["ut_dir"] > 0).astype(float),
         "vol_scaled": np.minimum(1.0, med / rv)}
    out = defaultdict(dict)
    last = "rf"
    rfv = 0.0
    for k in STRATS:
        prev = 0.0
        for i in range(320, len(c)):
            if d[i] < START:
                prev = w[k][i - 2] if not np.isnan(w[k][i - 2]) else 0.0
                continue
            rfv = rf.get(d[i], rfv)
            wi = w[k][i - 2] if not np.isnan(w[k][i - 2]) else 0.0   # signal at close i-2 known after it; trade at close i-1
            out[k][d[i]] = wi * r[i] + (1 - wi) * rfv - COST * abs(wi - prev)
            prev = wi
    return out, last


def stats(daily: dict[date, float], rf: dict[date, float]):
    ds = sorted(daily)
    x = np.array([daily[k] for k in ds])
    ex = x - np.array([rf.get(k, 0.0) for k in ds])
    eq = np.cumprod(1 + x)
    return {"ann": float(np.prod(1 + x) ** (252 / len(x)) - 1), "vol": float(np.std(x) * np.sqrt(252)),
            "sharpe": float(np.mean(ex) / np.std(ex) * np.sqrt(252)), "mdd": float(np.min(eq / np.maximum.accumulate(eq) - 1))}


def monthly(daily):
    m = defaultdict(lambda: 1.0)
    for k, v in daily.items():
        m[(k.year, k.month)] *= 1 + v
    return {k: v - 1 for k, v in m.items()}


def alpha_t(y: dict, x: dict, rfm: dict):
    ks = sorted(set(y) & set(x))
    Y = np.array([y[k] - rfm.get(k, 0) for k in ks]); X = np.array([x[k] - rfm.get(k, 0) for k in ks])
    A = np.c_[np.ones(len(X)), X]
    b, *_ = np.linalg.lstsq(A, Y, rcond=None)
    e = Y - A @ b
    cov = np.linalg.inv(A.T @ A) * (e @ e) / (len(Y) - 2)
    return float(b[0] * 12), float(b[0] / np.sqrt(cov[0, 0])), float(b[1])


def main():
    only = [x for a in sys.argv[1:] if a.startswith("--tickers=") for x in a[10:].upper().split(",")]
    rf = tbill()
    with connect() as conn:
        bars = IND.load_bars(conn, only or None)
    port = {k: defaultdict(list) for k in STRATS}
    wins = defaultdict(int)
    n = 0
    for t, (d, h, l, c, v, o) in bars.items():
        if len(c) < 400 or d[-1] < date(2026, 1, 1):
            continue
        out, _ = name_returns(d, h, l, c, v, o, rf)
        if not out["hold"]:
            continue
        n += 1
        sh = {k: stats(out[k], rf)["sharpe"] for k in STRATS}
        wins["trail>hold"] += sh["ut_trail"] > sh["hold"]
        wins["trail>vol"] += sh["ut_trail"] > sh["vol_scaled"]
        for k in STRATS:
            for dd, x in out[k].items():
                port[k][dd].append(x)
    P = {k: {dd: float(np.mean(v)) for dd, v in port[k].items()} for k in STRATS}
    rfm = monthly({k: rf.get(k, 0.0) for k in P["hold"]})
    L = [f"# T3 — UT Bot trail on held stock ({date.today()})", "",
         f"{n} names, equal weight, {START} → {max(P['hold'])}; signal lag 1 bar; cash at T-bill; 5 bp per weight change.", "",
         "| period | strategy | ann. return | vol | Sharpe | max DD |", "|---|---|---|---|---|---|"]
    verdict = []
    for lab, lo, hi in (("all", START, date(2100, 1, 1)), ("2020-06→2023-06", START, SPLIT), ("2023-07→now", SPLIT, date(2100, 1, 1))):
        sub = {k: {dd: x for dd, x in P[k].items() if lo <= dd < hi} for k in STRATS}
        st = {k: stats(sub[k], rf) for k in STRATS}
        for k in STRATS:
            s = st[k]
            L.append(f"| {lab} | {k} | {100 * s['ann']:+.1f} % | {100 * s['vol']:.1f} % | {s['sharpe']:.2f} | {100 * s['mdd']:.1f} % |")
        m = {k: monthly(sub[k]) for k in STRATS}
        a1 = alpha_t(m["ut_trail"], m["hold"], rfm)
        a2 = alpha_t(m["ut_trail"], m["vol_scaled"], rfm)
        verdict.append((lab, st, a1, a2))
    L += ["", "| period | trail α vs hold (ann., t, β) | trail α vs vol-scaled (ann., t, β) |", "|---|---|---|"]
    for lab, st, a1, a2 in verdict:
        L.append(f"| {lab} | {100 * a1[0]:+.1f} %, t {a1[1]:.1f}, β {a1[2]:.2f} | {100 * a2[0]:+.1f} %, t {a2[1]:.1f}, β {a2[2]:.2f} |")
    L.append(f"\nPer name: trail Sharpe > hold in {wins['trail>hold']}/{n}, > vol-scaled in {wins['trail>vol']}/{n}.")
    halves = verdict[1:]
    ok = all(v[1]["ut_trail"]["sharpe"] > max(v[1]["hold"]["sharpe"], v[1]["vol_scaled"]["sharpe"]) for v in halves) and \
        all(v[2][1] >= 2.5 and v[3][1] >= 2.5 for v in verdict[:1]) and all(v[2][0] > 0 and v[3][0] > 0 for v in halves)
    L.append(f"\n**Verdict: {'PASS' if ok else 'FAIL'}** (bar: Sharpe above both comparators in both halves, α t ≥ 2.5 vs each, same sign both halves).")
    txt = "\n".join(L)
    if not only:
        (HERE.parent / "out" / "opt" / "T3.md").write_text(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
