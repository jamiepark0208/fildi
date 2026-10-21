"""S075 — skew + fill calibration for multi-leg option backtests (A192 Phase 1, Jamie 10-20: "Structures tab: so many untested").

Every structure backtest prices legs away from the money (wings, spreads, strangles). Black-Scholes at the stock's ATM iv30 misses
skew: real OTM puts trade richer, OTM calls cheaper (S074: even near the money real fills are 0.80–0.86× the harness). This fits
real ÷ model ratios by side, |Δ| bucket and DTE bucket, then checks them before any structure is backtested.

Data (0 vendor requests):
  puts   optlab.lseg_opt_daily — real LSEG daily mid/bid/ask, 2021 →, ~490k rows (cached by S049/S064/S066/S071)
  both   optlab.skew_survey — real Schwab ladders (puts + calls, ~120 names, one day so far)
Model  BS(spot, K, iv30_<side> from lseg_research.daily_history, T = calendar days / 365); Δ from the same model.
Ratio  median(real mid ÷ model) per cell; spread = median((ask − bid) ÷ mid).

Pre-registered checks (the backtest uses the ratios only if both hold):
  1. Stability: LSEG put ratios, 2021–23 vs 2024 →, differ < 0.10 in every |Δ| cell with n ≥ 200.
  2. Cross-source: one-day Schwab put ratios within 0.15 of the LSEG put ratios (same cells) → the one-day call ratios are usable.
Out: out/opt/S075.md + out/opt/s075_ratios.json  {side: {dte_bucket: {delta_bucket: {"ratio", "spread", "n"}}}}

    cd scripts/watchlist_sync && .venv/bin/python analysis/s075_skew_calibration.py
"""
from __future__ import annotations

import json
import math
import re
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s045_put_retest import bs_put, ncdf  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S075.md"
JSON = HERE.parent / "out" / "opt" / "s075_ratios.json"
DELTA_B = [(0.02, 0.07), (0.07, 0.125), (0.125, 0.175), (0.175, 0.225), (0.225, 0.30), (0.30, 0.40), (0.40, 0.60)]
DTE_B = [(1, 10), (10, 21), (21, 50)]
SPLIT = date(2024, 1, 1)
RIC = re.compile(r"^([A-Z.]+?)([A-X])(\d\d)(\d\d)(\d{5})\.U")


def bs_call(S, K, v, t):
    return bs_put(S, K, v, t) + S - K   # put-call parity, zero rates (as the harness)


def delta(S, K, v, t, side):
    sd = v * math.sqrt(t)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return ncdf(d1) if side == "call" else ncdf(d1) - 1


def bucket(x, bs):
    return next((b for b in bs if b[0] <= x < b[1]), None)


def main():
    conn = connect()
    hist = defaultdict(list)
    for t, d, c, ivp, ivc in conn.execute("SELECT ticker, date, close::float, iv30_put::float, iv30_call::float "
                                          "FROM lseg_research.daily_history WHERE close > 0 ORDER BY ticker, date"):
        hist[t].append((d, c, ivp, ivc))
    keys = {t: [r[0] for r in v] for t, v in hist.items()}

    def at(t, d):
        if t not in hist:
            return None
        i = bisect_right(keys[t], d) - 1
        return hist[t][i] if i >= 0 and hist[t][i][0] == d else None

    cells = defaultdict(list)   # (source, side, dte_b, delta_b, era) → [(ratio, spread)]
    n_raw = 0
    for ric, d, bid, ask, mid in conn.execute("SELECT ric, date, bid::float, ask::float, mid::float FROM optlab.lseg_opt_daily "
                                              "WHERE bid > 0 AND ask >= bid"):
        n_raw += 1
        m = RIC.match(ric)
        if not m:
            continue
        root, let, dd, yy, k = m.groups()
        side = "call" if let <= "L" else "put"
        mon = (ord(let) - ord("A")) % 12 + 1
        try:
            exp = date(2000 + int(yy), mon, int(dd))
        except ValueError:
            continue
        dte = (exp - d).days
        h = at(root, d)
        if not h or dte < 1 or not bucket(dte, DTE_B):
            continue
        S, iv = h[1], (h[3] if side == "call" else h[2])
        if not iv:
            continue
        iv = iv / 100 if iv > 3 else iv
        K, T = int(k) / 100, dte / 365
        if K / S < 0.4 or K / S > 1.6:      # unadjusted split mismatch guard
            continue
        model = (bs_call if side == "call" else bs_put)(S, K, iv, T)
        realmid = mid if mid and mid > 0 else (bid + ask) / 2
        if model < 0.01 or realmid <= 0:
            continue
        db = bucket(abs(delta(S, K, iv, T, side)), DELTA_B)
        if not db:
            continue
        cells[("lseg", side, bucket(dte, DTE_B), db, "pre" if d < SPLIT else "post")].append((realmid / model, (ask - bid) / realmid))
    n_sv = 0
    for t, d, side, K, S, bid, ask, mark, exp in conn.execute(
            "SELECT ticker, as_of, side, strike::float, spot::float, bid::float, ask::float, mark::float, expiry FROM optlab.skew_survey "
            "WHERE bid > 0 AND ask >= bid AND spot > 0"):
        side = "call" if str(side).lower().startswith("c") else "put"
        # LSEG iv30 for the newest day lands a day late → latest row on/before the quote date that has IV
        h = next((r for r in reversed(hist.get(t, [])) if r[0] <= d and r[2] and r[3]), None)
        dte = (exp - d).days
        if not h or not bucket(dte, DTE_B):
            continue
        iv = h[3] if side == "call" else h[2]
        if not iv:
            continue
        iv = iv / 100 if iv > 3 else iv
        T = dte / 365
        model = (bs_call if side == "call" else bs_put)(S, K, iv, T)
        realmid = mark if mark and mark > 0 else (bid + ask) / 2
        if model < 0.01:
            continue
        db = bucket(abs(delta(S, K, iv, T, side)), DELTA_B)
        if not db:
            continue
        n_sv += 1
        cells[("schwab", side, bucket(dte, DTE_B), db, "all")].append((realmid / model, (ask - bid) / realmid))

    med = lambda xs, i: statistics.median(x[i] for x in xs)
    L = ["# S075 — skew + fill calibration: real option mid ÷ Black-Scholes at ATM iv30, by side · DTE · |Δ|", "",
         f"LSEG put rows read {n_raw:,} · Schwab ladder quotes used {n_sv:,}. Ratio = median real mid ÷ model; spread = median (ask − bid) ÷ mid.", "",
         "| source | side | DTE | |Δ| | n | ratio | spread | 2021–23 | 2024 → |", "|---|---|---|---|---|---|---|---|---|"]
    out = {}
    stab_ok, cross_ok, cross_n = True, True, 0
    for side in ("put", "call"):
        for dtb in DTE_B:
            for db in DELTA_B:
                lp, lq = cells.get(("lseg", side, dtb, db, "pre"), []), cells.get(("lseg", side, dtb, db, "post"), [])
                la = lp + lq
                sv = cells.get(("schwab", side, dtb, db, "all"), [])
                use = la if len(la) >= 200 else sv
                if len(use) >= 30:
                    out.setdefault(side, {}).setdefault(f"{dtb[0]}-{dtb[1]}", {})[f"{db[0]}-{db[1]}"] = {
                        "ratio": round(med(use, 0), 3), "spread": round(med(use, 1), 3), "n": len(use),
                        "source": "lseg" if use is la else "schwab"}
                if len(la) >= 30:
                    a, b = (med(lp, 0) if len(lp) >= 30 else float("nan")), (med(lq, 0) if len(lq) >= 30 else float("nan"))
                    if len(lp) >= 200 and len(lq) >= 200 and abs(a - b) >= 0.10:
                        stab_ok = False
                    L.append(f"| LSEG | {side} | {dtb[0]}–{dtb[1]} | {db[0]:.3f}–{db[1]:.3f} | {len(la)} | {med(la, 0):.2f} | {med(la, 1):.0%} | "
                             f"{a:.2f} | {b:.2f} |")
                if len(sv) >= 30:
                    L.append(f"| Schwab | {side} | {dtb[0]}–{dtb[1]} | {db[0]:.3f}–{db[1]:.3f} | {len(sv)} | {med(sv, 0):.2f} | {med(sv, 1):.0%} | | |")
                    if side == "put" and len(la) >= 200:
                        cross_n += 1
                        if abs(med(sv, 0) - med(la, 0)) >= 0.15:
                            cross_ok = False
    L += ["", f"**Check 1 (stability, LSEG puts, |Δ|-cell ratio 2021–23 vs 2024→ < 0.10):** {'PASS' if stab_ok else 'FAIL'}",
          f"**Check 2 (one-day Schwab puts within 0.15 of LSEG, {cross_n} cells):** {'PASS' if cross_ok and cross_n else 'FAIL / not enough overlap'}",
          "Ratios feed the S076 structure backtest only if both pass; otherwise S076 reports model-only results labelled as such."]
    JSON.write_text(json.dumps({"checks": {"stability": stab_ok, "cross_source": bool(cross_ok and cross_n)}, "cells": out}, indent=1))
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
