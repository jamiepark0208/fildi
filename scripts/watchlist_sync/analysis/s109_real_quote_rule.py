#!/usr/bin/env python3
"""S109 — Jamie's put rule on REAL option quotes (S074 left this pending: harness said a high-income floor wins, S071 real quotes said no).

Data: every cached LSEG daily put quote (optlab.lseg_opt_daily, 2019→, contracts fetched by S066/S071/S103 etc.) + LSEG underlying
closes (lseg_research.daily_history). No vendor calls.
Entry: per contract, the first quote day 3–9 calendar days before expiry with bid > 0 and ask ≥ bid. Fill = bid + 23 % of spread (S071).
Exit: held to expiry, intrinsic at the expiry-day close. pnl = (fill − intrinsic) ÷ strike, per week (× 7 / days).
Rule (Jamie 10-26): income ≥ 0.9 %/wk · ≥ 10 % OTM · stock ≥ 25 % off its 52-week high. Comparators = the other puts on the same weeks,
and the rule's pieces alone. Weekly portfolio = equal weight of the week's picks; Sharpe/Sortino annualised on weekly returns.
Split 2024-07 (S074's break). Per-name and per-sector track record (sector = best-correlated sector ETF, band_engine).
Selection caveat: strikes were chosen by earlier studies (mostly 0.05–0.35Δ), not by this rule.

    .venv/bin/python analysis/s109_real_quote_rule.py   → out/opt/S109.md
"""
from __future__ import annotations

import math
import re
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

RIC = re.compile(r"^(.+?)([M-X])(\d\d)(\d\d)(\d{5})\.U(\^.*)?$")
SPLIT = date(2024, 7, 1)
OUT = HERE.parent / "out" / "opt" / "S109.md"


def load(conn):
    q = defaultdict(list)
    for ric, d, b, a in conn.execute("SELECT ric, date, bid::float8, ask::float8 FROM optlab.lseg_opt_daily WHERE bid > 0 AND ask >= bid"):
        q[ric].append((d, b, a))
    px = defaultdict(dict)
    for t, d, c, h in conn.execute("SELECT ticker, date, close::float8, COALESCE(high, close)::float8 FROM lseg_research.daily_history "
                                   "WHERE close > 0 ORDER BY ticker, date"):
        px[t][d] = (c, h)
    return q, px


def trades(q, px):
    out = []
    hi_cache = {}
    for ric, qs in q.items():
        m = RIC.match(ric)
        if not m:
            continue
        root, mon, dd, yy, k = m.group(1), ord(m.group(2)) - ord("M") + 1, int(m.group(3)), int(m.group(4)), int(m.group(5)) / 100
        try:
            exp = date(2000 + yy, mon, dd)
        except ValueError:
            continue
        p = px.get(root)
        if not p:
            continue
        qs.sort()
        ent = next((x for x in qs if 3 <= (exp - x[0]).days <= 9), None)
        if not ent or ent[0] not in p:
            continue
        d, b, a = ent
        if root not in hi_cache:
            ds = sorted(p)
            hi_cache[root] = (ds, np.array([p[x][1] for x in ds]), {x: i for i, x in enumerate(ds)})
        ds, hs, ix = hi_cache[root]
        i = ix[d]
        if i < 200:
            continue
        j = next((ix[x] for x in (exp - timedelta(days=n) for n in range(0, 4)) if x in ix), None)
        if j is None or j <= i:
            continue
        S, ST = p[d][0], p[ds[j]][0]
        if K_bad(k, S):
            continue
        fill = b + 0.23 * (a - b)
        days = (exp - d).days
        out.append({"t": root, "d": d, "exp": exp, "K": k, "S": S, "days": days, "otm": (S - k) / S,
                    "inc": fill / k * 7 / days, "dd52": S / hs[max(0, i - 251): i + 1].max() - 1,
                    "r": (fill - max(k - ST, 0.0)) / k * 7 / days, "kept": ST >= k, "spread": (a - b) / max(fill, 1e-9)})
    return out


def K_bad(k, S):
    return k <= 0 or k >= S * 1.0 or k < 0.4 * S   # OTM puts only; deep wings are quote noise


def week(d):
    return d - timedelta(days=d.weekday())


def stats(rs):
    if not rs:
        return None
    r = np.array([x["r"] for x in rs])
    wk = defaultdict(list)
    for x in rs:
        wk[week(x["d"])].append(x["r"])
    w = np.array([np.mean(v) for v in wk.values()])
    dn = w[w < 0]
    sd = w.std(ddof=1) if len(w) > 1 else float("nan")
    t = w.mean() / (sd / math.sqrt(len(w))) if len(w) > 1 and sd > 0 else float("nan")
    return {"n": len(rs), "weeks": len(w), "bp": 1e4 * r.mean(), "wk_bp": 1e4 * w.mean(), "t": t,
            "kept": 100 * np.mean([x["kept"] for x in rs]), "inc": 100 * np.mean([x["inc"] for x in rs]),
            "w5": 1e4 * np.percentile(w, 5) if len(w) >= 20 else float("nan"),
            "sharpe": w.mean() / sd * math.sqrt(52) if sd > 0 else float("nan"),
            "sortino": w.mean() / math.sqrt(np.mean(np.minimum(w, 0) ** 2)) * math.sqrt(52) if len(dn) else float("nan")}


def row(name, s):
    if not s:
        return f"| {name} | 0 | | | | | | | | |"
    return (f"| {name} | {s['n']:,} | {s['weeks']} | {s['inc']:.2f} | {s['kept']:.0f} | {s['wk_bp']:+.1f} | {s['t']:+.1f} | "
            f"{s['w5']:+.0f} | {s['sharpe']:.2f} | {s['sortino']:.2f} |")


HEAD = ["| Set | Puts | Weeks | Income %/wk | Kept % | bp/wk (week avg) | t (weeks) | Worst-5 % week bp | Sharpe | Sortino |",
        "|---|---|---|---|---|---|---|---|---|---|"]


def main():
    conn = connect()
    q, px = load(conn)
    rs = trades(q, px)
    import band_engine as BE
    BE.add_sector(conn, rs)   # r["sec"] = best-correlated sector ETF (prior year), where it can
    inc, otm, crash = (lambda r: r["inc"] >= 0.009), (lambda r: r["otm"] >= 0.10), (lambda r: r["dd52"] <= -0.25)
    rule = lambda r: inc(r) and otm(r) and crash(r)   # noqa: E731
    wks = {week(r["d"]) for r in rs if rule(r)}
    same = [r for r in rs if week(r["d"]) in wks]
    sets = {
        "Jamie rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high)": [r for r in rs if rule(r)],
        "Same weeks, every other put": [r for r in same if not rule(r)],
        "Income ≥ 0.9 %/wk only": [r for r in rs if inc(r)],
        "Income ≥ 0.9 %/wk + ≥ 10 % OTM (any chart)": [r for r in rs if inc(r) and otm(r)],
        "≥ 10 % OTM, ≥ 25 % off high, income < 0.9": [r for r in rs if otm(r) and crash(r) and not inc(r)],
        "Income 0.3–0.9 %/wk (engine-like)": [r for r in rs if 0.003 <= r["inc"] < 0.009],
        "All puts": rs,
    }
    L = ["# S109 — Jamie's put rule on real LSEG option quotes", "",
         f"{len(rs):,} weekly puts (3–9 days to expiry) from {len({r['t'] for r in rs})} names, {min(r['d'] for r in rs)} → "
         f"{max(r['d'] for r in rs)}. Fill = bid + 23 % of spread, held to expiry. bp/wk = net per collateral-week; week avg = "
         "equal-weight portfolio of that week's puts.", ""]
    for label, cut in (("All years", lambda r: True), (f"Before {SPLIT}", lambda r: r["d"] < SPLIT), (f"From {SPLIT}", lambda r: r["d"] >= SPLIT)):
        L += [f"## {label}", "", *HEAD] + [row(n, stats([r for r in s if cut(r)])) for n, s in sets.items()] + [""]
    jr = sets["Jamie rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high)"]
    # one bet per sector per week: does counting clusters once change the verdict?
    cl = defaultdict(list)
    for r in jr:
        cl[(week(r["d"]), r.get("sec") or r["t"])].append(r)
    one = [{**v[0], "r": float(np.mean([x["r"] for x in v])), "kept": all(x["kept"] for x in v)} for v in cl.values()]
    L += ["## Rule puts counted once per sector per week", "", *HEAD, row("Jamie rule, sector-week = one bet", stats(one)), ""]
    # peer cap: ≤ 2 per sector per week (best income) vs uncapped
    cap = [x for v in cl.values() for x in sorted(v, key=lambda r: -r["inc"])[:2]]
    L += ["## Peer cap (≤ 2 per sector per week, highest income kept)", "", *HEAD, row("Uncapped", stats(jr)), row("Capped", stats(cap)), ""]
    # track record per sector / name (rule puts)
    for key, title in (("sec", "sector ETF"), ("t", "name")):
        g = defaultdict(list)
        for r in jr:
            g[r.get(key) or "?"].append(r)
        top = sorted(((k, stats(v)) for k, v in g.items() if len(v) >= 8), key=lambda kv: -kv[1]["sortino"] if kv[1]["sortino"] == kv[1]["sortino"] else 0)
        L += [f"## Rule puts by {title} (≥ 8 puts)", "", *HEAD] + [row(k, s) for k, s in top[:25]] + [""]
    OUT.write_text("\n".join(L))
    print("\n".join(L[:40]))


if __name__ == "__main__":
    main()
