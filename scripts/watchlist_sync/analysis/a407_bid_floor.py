#!/usr/bin/env python3
"""A407 step 1 (B13) — does the hard `bid ≥ $0.10` put floor throw away money, on REAL quotes?

Data: optlab.lseg_opt_daily (LSEG daily bid/ask, 2018→) + lseg_research.daily_history closes, via S109's loader. No vendor calls.
Entry: per contract, first quote 3–9 calendar days before expiry (S109). Held to expiry, intrinsic at the expiry-day close.
Fill = bid + 23 % of spread (RH median, S071); stress fill = bid only. r = (fill − intrinsic) ÷ strike per week (× 7 / days).
Band: put |Δ| 0.04–0.16 from the quote's own IV (quantcore.bs, r = 0) — the engine's 0.06–0.15 bands plus one step of slack.

Pre-registered groups (fixed before the run, 11-15):
  LIVE      bid ≥ 0.10                                    (today's floor)
  ADD       0.05 ≤ bid < 0.10 and spread ≤ 35 % of mid     (what Carbon's rule would add on cheap strikes)
  ADD_WIDE  0.05 ≤ bid < 0.10 and spread > 35 % of mid     (the part the spread gate keeps out)
  REL       bid ≥ max(0.05, 0.004 × strike) and spread ≤ 35 % (Carbon's full rule — note: STRICTER than 0.10 above a $25 strike)
Cells: spot tier ($5–15 / > $15) × SPY 20-day realized vol (< 12 % / 12–20 % / > 20 %). Cells with < 30 trades: not reported.
Split: before / after 2024-07 (S109). Verdict for ADD: ship only if mean r > 0 at the stress fill too, week-clustered t ≥ 2,
same sign both halves, and its worst-5 % week no worse than LIVE's.

    .venv/bin/python analysis/a407_bid_floor.py   → out/opt/A407-bid-floor.md
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s109_real_quote_rule as S109  # noqa: E402
from quantcore.bs import put_delta, years_from_days  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A407-bid-floor.md"
SPLIT = date(2024, 7, 1)
MIN_N = 30


def load_iv(conn) -> dict:
    iv = {}
    for ric, d, v in conn.execute("SELECT ric, date, iv::float8 FROM optlab.lseg_opt_daily WHERE iv > 0"):
        iv[(ric, d)] = v / 100.0          # LSEG IV is in percent
    return iv


def spy_rv(px) -> dict:
    p = px.get("SPY") or {}
    ds = sorted(p)
    c = np.array([p[d][0] for d in ds])
    lr = np.diff(np.log(c))
    out = {}
    for i in range(21, len(ds)):
        out[ds[i]] = float(lr[i - 21:i - 1].std(ddof=1) * math.sqrt(252))   # closes strictly before day i
    return out


def rows(q, px, iv, rv):
    out = []
    for ric, qs in q.items():
        m = S109.RIC.match(ric)
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
        st = next((p[x][0] for x in (exp - timedelta(days=n) for n in range(4)) if x in p), None)
        if st is None:
            continue
        S = p[d][0]
        if S109.K_bad(k, S) or S < 5:
            continue
        v = iv.get((ric, d))
        if not v or v > 5:
            continue
        days = (exp - d).days
        dl = abs(float(put_delta(spot=S, strike=k, iv=v, years=years_from_days(days))))
        if not 0.04 <= dl < 0.16:
            continue
        mid = (a + b) / 2
        intr = max(k - st, 0.0)
        f = 7 / days
        out.append({"t": root, "d": d, "wk": d - timedelta(days=d.weekday()), "K": k, "S": S, "bid": b, "sp": (a - b) / mid,
                    "dl": dl, "iv": v, "days": days, "r": (b + 0.23 * (a - b) - intr) / k * f, "r_bid": (b - intr) / k * f, "kept": st >= k,
                    "tier": "$5–15" if S < 15 else "> $15", "rv": rv.get(d)})
    return out


GROUPS = {
    "LIVE  bid ≥ 0.10": lambda r: r["bid"] >= 0.10,
    "ADD   0.05–0.10, spread ≤ 35 %": lambda r: 0.05 <= r["bid"] < 0.10 and r["sp"] <= 0.35,
    "ADD_WIDE 0.05–0.10, spread > 35 %": lambda r: 0.05 <= r["bid"] < 0.10 and r["sp"] > 0.35,
    "REL   ≥ max(0.05, 0.4 % K), spread ≤ 35 %": lambda r: r["bid"] >= max(0.05, 0.004 * r["K"]) and r["sp"] <= 0.35,
}


def stats(rs, key="r"):
    if len(rs) < MIN_N:
        return None
    wk = defaultdict(list)
    for r in rs:
        wk[r["wk"]].append(r[key])
    w = np.array([np.mean(v) for v in wk.values()])
    t = w.mean() / (w.std(ddof=1) / math.sqrt(len(w))) if len(w) > 2 and w.std() > 0 else float("nan")
    x = np.array([r[key] for r in rs])
    return {"n": len(rs), "weeks": len(w), "bp": 1e4 * x.mean(), "t": t, "w5": 1e4 * np.percentile(w, 5),
            "kept": 100 * np.mean([r["kept"] for r in rs]), "names": len({r["t"] for r in rs})}


def fmt(name, s, s_bid=None):
    if not s:
        return f"| {name} | < {MIN_N} | | | | | | | |"
    sb = f"{s_bid['bp']:+.1f}" if s_bid else ""
    return (f"| {name} | {s['n']:,} | {s['names']} | {s['weeks']} | {s['kept']:.1f} | {s['bp']:+.1f} | {sb} | {s['t']:+.1f} | "
            f"{s['w5']:+.0f} |")


HEAD = ["| Set | Puts | Names | Weeks | Kept % | bp/wk (fill bid+23 %) | bp/wk (bid only) | t (weeks) | Worst-5 % week bp |",
        "|---|---|---|---|---|---|---|---|---|"]


def main() -> int:
    with connect() as c:
        q, px = S109.load(c)
        iv = load_iv(c)
    rs = rows(q, px, iv, spy_rv(px))
    L = ["# A407 step 1 — put bid floor on real LSEG quotes (B13)", "",
         f"{len(rs):,} weekly puts, |Δ| 0.04–0.16, spot ≥ $5, {min(r['d'] for r in rs)} → {max(r['d'] for r in rs)}. "
         "Hold to expiry. bp = per strike per week. Method + pre-registered groups: script docstring.", ""]
    L += ["## All", ""] + HEAD
    for g, fn in GROUPS.items():
        sub = [r for r in rs if fn(r)]
        L.append(fmt(g, stats(sub), stats(sub, "r_bid")))
    for part, pf in (("before 2024-07", lambda r: r["d"] < SPLIT), ("2024-07 →", lambda r: r["d"] >= SPLIT)):
        L += ["", f"## {part}", ""] + HEAD
        for g, fn in GROUPS.items():
            sub = [r for r in rs if fn(r) and pf(r)]
            L.append(fmt(g, stats(sub), stats(sub, "r_bid")))
    L += ["", "## Cells: spot tier × SPY 20-day realized vol (fill bid + 23 %)", "",
          "| Group | Tier | RV20 | Puts | bp/wk | t | Worst-5 % wk |", "|---|---|---|---|---|---|---|"]
    rvb = lambda v: None if v is None else "< 12 %" if v < .12 else "12–20 %" if v < .20 else "> 20 %"
    for g, fn in GROUPS.items():
        for tier in ("$5–15", "> $15"):
            for b in ("< 12 %", "12–20 %", "> 20 %"):
                s = stats([r for r in rs if fn(r) and r["tier"] == tier and rvb(r["rv"]) == b])
                L.append(f"| {g} | {tier} | {b} | " + (f"{s['n']:,} | {s['bp']:+.1f} | {s['t']:+.1f} | {s['w5']:+.0f} |" if s
                                                         else f"< {MIN_N} | | | |"))
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    return 0


if __name__ == "__main__":
    sys.exit(main())
