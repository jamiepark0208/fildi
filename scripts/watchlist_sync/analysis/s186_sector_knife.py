#!/usr/bin/env python3
"""S186 (rec scoreboard 11-10: engine −1.16 % of strike vs Jamie +0.35 %; semis 63 picks −3.16 %, rest −0.09 %).

Live cause: S101/S102 sector_drop (sector ETF ≥ 15 % off its 52w high, SPY not in panic/drop) upgrades the band to
0.15–0.20Δ and re-fired every day while SMH slid −16 % → −25 % (MRVL strikes 205 → 195 → 172.5 → 120).
Jamie 10-29: no sector cap / diversification gate — a sector-only crash SHOULD bias the list. So the question is timing,
not exposure: inside sector_drop, is selling while the sector is STILL FALLING worse than after it turns?

Pre-registered (11-10, before running):
  population  S101 1-week put candidates (h == 1), market_state == sector_drop, bands 0.12–0.20Δ (live upgrade band) and 0.06–0.10Δ
  splits      A  sector ETF 5-day return < 0            (expected sign −: still falling worse)
              B  sector ETF close at its 20-day low      (expected −)
              C  sector ETF 5d < 0 AND stock 5d < −5 %   (expected −)
              D  sector ETF 5d ≥ +3 % (bounce under way) (expected +)
  regime      the state is fixed (sector_drop); cells = period 2019-12→2022 / 2023→ (S102 halves)
  PASS        S102 bar: same sign both periods, |Δ| ≥ 5 bp/wk each, week-cluster |t| ≥ 2.5, IV/RV-controlled Δ keeps sign
  n floor     ≥ 30 distinct entry weeks in the split cell per period, else "can't answer at this n"
  also        week-level tail: mean of the worst 5 % entry-weeks (equal-weight book that week) in vs out of each split
Only a PASS changes put_recs (sector_drop band upgrade suppressed in the failing cell).

    .venv/bin/python analysis/s186_sector_knife.py
"""
from __future__ import annotations

import pickle
import sys
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import band_engine as BE  # noqa: E402
from build_plan import connect  # noqa: E402
from s102_tv_indicators import SPLIT, compare, verdict  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S186.md"
BANDS = {"0.12–0.20Δ": (0.12, 0.20), "0.06–0.10Δ": (0.06, 0.10)}


def ret(px, t, d, k):
    s = px.get(t)
    if not s:
        return None
    ds = s["_d"]
    i = bisect_right(ds, d) - 1
    if i - k < 0:
        return None
    return s[ds[i]] / s[ds[i - k]] - 1


def at_low(px, t, d, k=20):
    s = px.get(t)
    if not s:
        return None
    ds = s["_d"]
    i = bisect_right(ds, d) - 1
    if i - k < 0:
        return None
    return s[ds[i]] <= min(s[x] for x in ds[i - k + 1:i + 1]) * 1.0001


def week_tail(rs, pred):
    wa, wb = defaultdict(list), defaultdict(list)
    for r in rs:
        (wa if pred(r) else wb)[r["d"]].append(r["hc"])
    def t5(w):
        m = sorted(np.mean(v) for v in w.values())
        k = max(1, len(m) // 20)
        return np.mean(m[:k]) * 1e4 if m else float("nan"), len(m)
    return t5(wa), t5(wb)


def main():
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
        for r in rows:
            r["ms"] = BE.market_state(r)
        rows = [r for r in rows if r["ms"] == "sector_drop" and r.get("sec")]
        px = BE._closes(c, sorted({r["t"] for r in rows} | {r["sec"] for r in rows}))
    for t in px:
        px[t]["_d"] = sorted(k for k in px[t] if k != "_d")
    for r in rows:
        r["s5"] = ret(px, r["sec"], r["d"], 5)
        r["slow"] = at_low(px, r["sec"], r["d"], 20)
        r["k5"] = ret(px, r["t"], r["d"], 5)
    rows = [r for r in rows if r["s5"] is not None and r["k5"] is not None and r.get("iv_rv") is not None]
    tests = [
        ("A sector 5d < 0 (still falling)", lambda r: r["s5"] < 0, "−"),
        ("B sector at 20d low", lambda r: bool(r["slow"]), "−"),
        ("C sector 5d < 0 and stock 5d < −5 %", lambda r: r["s5"] < 0 and r["k5"] < -0.05, "−"),
        ("D sector 5d ≥ +3 % (bounce)", lambda r: r["s5"] >= 0.03, "+"),
    ]
    L = [f"# S186 — sector_drop: selling into a still-falling sector vs after it turns", "",
         f"{len(rows):,} S101 1-week put candidates in market_state sector_drop. Cells: net bp/wk · worst 5 % · kept. "
         "PASS = S102 bar. n floor = 30 entry weeks per cell per period.", ""]
    for bname, (lo, hi) in BANDS.items():
        xs = [r for r in rows if lo <= r["dlt"] < hi]
        L += [f"## {bname} ({len(xs):,} puts, {len({r['d'] for r in xs})} entry weeks)", "",
              "| split (exp.) | weeks in 19–22 / 23–26 | 19–22 in vs rest | Δ (ctrl) | 23–26 in vs rest | Δ (ctrl) | t | worst-5 % week in / rest | verdict |",
              "|---|---|---|---|---|---|---|---|---|"]
        for name, p, exp in tests:
            wk = [len({r["d"] for r in xs if p(r) and f(r)}) for f in (lambda r: r["d"] < SPLIT, lambda r: r["d"] >= SPLIT)]
            res, t = compare(xs, p)
            (ta, na), (tb, nb) = week_tail(xs, p)
            def fmt(x):
                return f"{x[0]['bp']:+.0f}/{x[0]['w5']:+.0f}/{x[0]['kept']:.0f}% (n {x[0]['n']:,}) vs {x[1]['bp']:+.0f}" if x else "—"
            def dl(x):
                return f"{x[2]:+.1f} ({x[3]:+.1f})" if x else "—"
            v = verdict(res, t) if min(wk) >= 30 else "can't answer at this n"
            L.append(f"| {name} ({exp}) | {wk[0]} / {wk[1]} | {fmt(res.get('19–22'))} | {dl(res.get('19–22'))} | {fmt(res.get('23–26'))} | "
                     f"{dl(res.get('23–26'))} | {t:.1f} | {ta:+.0f} ({na}) / {tb:+.0f} ({nb}) | {v} |")
        L.append("")
    # Winner pass (contract 11): train = 2019-12→2022, 0.12–0.20Δ; losers = net < 0 (strike breached past premium)
    tr = [r for r in rows if 0.12 <= r["dlt"] < 0.20 and r["d"] < SPLIT]
    win, lose = [r for r in tr if r["hc"] > 0], [r for r in tr if r["hc"] < 0]
    feats = [("sector ETF 5d ret %", lambda r: r["s5"] * 100), ("stock 5d ret %", lambda r: r["k5"] * 100),
             ("sector off 52w high %", lambda r: (r.get("sec_dd52") or 0) * 100), ("stock off 52w high %", lambda r: r.get("stk_dd52", np.nan) * 100),
             ("IV/RV", lambda r: r["iv_rv"]), ("|Δ|", lambda r: r["dlt"]), ("VIX÷VIX3M", lambda r: r["vix_ratio"])]
    L += ["## Winner pass", "", f"Train 2019-12→2022, 0.12–0.20Δ in sector_drop: winners (net > 0) n {len(win):,} vs losers (net < 0) n {len(lose):,} "
          f"(entry weeks {len({r['d'] for r in win})} / {len({r['d'] for r in lose})}). Median pre-entry features:", "",
          "| feature | winners | losers |", "|---|---|---|"]
    for nm, f in feats:
        L.append(f"| {nm} | {np.nanmedian([f(r) for r in win]):+.2f} | {np.nanmedian([f(r) for r in lose]):+.2f} |")
    L += ["", "Read: losers were sold AFTER a bounce (sector +0.8 %, stock +1.1 % over 5 d vs −1.0 / −1.4 % for winners) and deeper "
          "in the drawdown (sector −23 % vs −19 % off high); IV/RV, Δ, VIX÷VIX3M identical. Same direction as Jamie's entry-candle rule "
          "(sell puts into weakness, not after the pop). Next rule to test (pre-register first, real-time entry per contract 13): "
          "in sector_drop, sell the upgraded band only on a sector down-day/5d < 0; sector ≥ 22 % off high → base band.", "",
          f"n_indep: {len({r['d'] for r in rows})} distinct entry weeks in sector_drop; split cells 30 / 39 weeks (A), others < 30 → UNDERPOWERED.", "",
          "**RULE NO-LIFT: sell 1-week 0.12–0.20Δ put in sector_drop × hold to expiry × skip while sector ETF 5d < 0** — "
          "the skipped entries earned more (+95/+79 vs +42/+46 bp/wk), so the guard would cut the better half; week-cluster t −0.7."]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
