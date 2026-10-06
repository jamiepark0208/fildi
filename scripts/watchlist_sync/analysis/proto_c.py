#!/usr/bin/env python3
"""Gate 1c: the "wins historically" lookup the Model List would show. Read-only. Writes out/proto/winrates.json (the candidate table).

Pre-registered (written before the first run):
  C1 table     win rate per (put | covered call) × delta (0.15 / 0.20 / 0.30) × expiry (7 / 14 / 30 calendar days). Built on entries
               2020-03 → 2023-12, checked on 2024-01 →. Pass: every cell within 5 pts. Win = put P&L > 0; call = beats holding (cc_kept > 0).
  C2 per stock blend each stock's own record with its cell's rate: (wins + k·p) / (n + k), k estimated on training data by method of
               moments (between-stock variance net of binomial noise). Adopt only if test Brier beats the plain cell rate overall AND in
               both halves of the test period.
  C3 payout   (pre-registered 2026-10-05, before E2 "expected $ per contract" is shown) average payout at expiry per cell in volatility
               units: put max(0, K − S_T) / K ÷ σ√T, covered call max(0, S_T − K) / S ÷ σ√T (upside given up). Expected $ for a live
               contract = (its premium − payout · σ√T · K or S) × 100, so only the payout comes from history. Built on 2020–23; pass if
               every cell's 2024–26 payout is within ±30% of the training value OR lower (the estimate is then conservative).
Caveats: weekly options are priced with the 30-day ATM IV (no 7-day IV history), and fills use the same 0.85 haircut.
The shipped table is rebuilt on all history (2020 →) with the same code; `--final` writes it.

Usage: .venv/bin/python analysis/proto_c.py [--final]   → out/proto/gate1c.md, out/proto/winrates.json
"""
from __future__ import annotations

import argparse
import json
import math
import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import mean, pvariance

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import backtest_puts as BP  # noqa: E402
from build_plan import connect, rows  # noqa: E402
from factor_pca import call_strike, enrich  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "proto"
DELTAS = (0.15, 0.20, 0.30)
DTES = (7, 14, 30)
SPLIT = date(2024, 1, 1)


def trades():
    OUT.mkdir(parents=True, exist_ok=True)
    pk = OUT / "trades_dte.pkl"
    if pk.exists():
        return pickle.loads(pk.read_bytes())
    with connect() as conn:
        H, peer, er, sm = BP.load(conn)
        extra = {(r["ticker"], r["date"]): {"iv30": r["iv30_put"], "iv30c": r["iv30_call"], "iv90": r["iv90_put"]}
                 for r in rows(conn, "SELECT ticker, date, iv30_put, iv30_call, iv90_put FROM lseg_research.daily_history WHERE iv30_put IS NOT NULL")}
    out = []
    for dte in DTES:
        BP.DTE = dte
        for dl in DELTAS:
            for t in enrich(BP.build_trades(H, peer, er, sm, 0.85, dl), H, extra, 0.85, dl):
                sig, T = t["iv"] / 100, max((t["exit"] - t["entry"]).days, 1) / 365
                ss = sig * math.sqrt(T)
                kc = call_strike(t["S"], T, BP.RF.get(t["entry"].year, 0.03), sig, dl)
                out.append({"ticker": t["ticker"], "entry": t["entry"], "delta": dl, "dte": dte,
                            "put": t["ret"] > 0, "call": None if t.get("cc_kept") is None else t["cc_kept"] > 0,
                            "put_pay": max(0.0, t["K"] - t["ST"]) / t["K"] / ss,
                            "call_pay": None if t.get("cc_kept") is None else max(0.0, t["ST"] - kc) / t["S"] / ss})
        print(f"  DTE {dte}: done")
    pk.write_bytes(pickle.dumps(out))
    return out


def cell_rates(ts, side):
    g = defaultdict(list)
    for t in ts:
        if t[side] is not None:
            g[(t["delta"], t["dte"])].append(t[side])
    return {k: (mean(v), len(v)) for k, v in g.items()}


def cell_pay(ts, side):
    g = defaultdict(list)
    for t in ts:
        if t[side + "_pay"] is not None:
            g[(t["delta"], t["dte"])].append(t[side + "_pay"])
    return {k: mean(v) for k, v in g.items()}


def shrink_k(ts, side, p):
    """Method of moments: between-stock variance of win rates minus the binomial noise → prior strength k."""
    g = defaultdict(list)
    for t in ts:
        if t[side] is not None:
            g[t["ticker"]].append(t[side])
    rs = [(mean(v), len(v)) for v in g.values() if len(v) >= 10]
    obs = pvariance([r for r, _ in rs])
    noise = mean(p * (1 - p) / n for _, n in rs)
    tau2 = max(obs - noise, 1e-6)
    return p * (1 - p) / tau2 - 1, tau2 ** 0.5


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--final", action="store_true", help="also write the all-history table (out/proto/winrates.json + watchlist_sync.win_rates)")
    ap.add_argument("--fresh", action="store_true", help="rebuild the trade cache from the latest daily_history (monthly refresh)")
    a = ap.parse_args()
    if a.fresh:
        (OUT / "trades_dte.pkl").unlink(missing_ok=True)
    T = trades()
    tr = [t for t in T if t["entry"] < SPLIT]
    te = [t for t in T if t["entry"] >= SPLIT]
    months = sorted({t["entry"] for t in te})
    halves = (set(months[:len(months) // 2]), set(months[len(months) // 2:]))
    L = [f"# Gate 1c: \"wins historically\" lookup ({date.today()})", "",
         f"{len(T):,} reconstructed trades (puts + covered calls × Δ {DELTAS} × {DTES}-day expiries), monthly entries 2020-03 →.", ""]
    verdict = {}
    for side in ("put", "call"):
        a_, b_ = cell_rates(tr, side), cell_rates(te, side)
        L += [f"## {side.title()}s", "", "| delta | expiry | 2020–23 | 2024–26 | gap | n test |", "|---|---|---|---|---|---|"]
        worst = 0.0
        for k in sorted(a_):
            gap = b_[k][0] - a_[k][0]
            worst = max(worst, abs(gap))
            L.append(f"| {k[0]:.2f} | {k[1]}d | {100 * a_[k][0]:.1f}% | {100 * b_[k][0]:.1f}% | {100 * gap:+.1f} | {b_[k][1]:,} |")
        # C2 per-stock shrinkage, per cell
        own = defaultdict(lambda: [0, 0])
        for t in tr:
            if t[side] is not None:
                o = own[(t["ticker"], t["delta"], t["dte"])]; o[0] += t[side]; o[1] += 1
        ks = {k: shrink_k([t for t in tr if (t["delta"], t["dte"]) == k], side, a_[k][0]) for k in a_}
        sq = {"cell": defaultdict(list), "stock": defaultdict(list)}
        for t in te:
            if t[side] is None:
                continue
            c = (t["delta"], t["dte"])
            p = a_[c][0]
            w, n = own.get((t["ticker"], *c), (0, 0))
            k = ks[c][0]
            ps = (w + k * p) / (n + k)
            h = 0 if t["entry"] in halves[0] else 1
            sq["cell"][h].append((p - t[side]) ** 2)
            sq["stock"][h].append((ps - t[side]) ** 2)
        bc = [mean(sq["cell"][h]) for h in (0, 1)]
        bs = [mean(sq["stock"][h]) for h in (0, 1)]
        allc, alls = mean(sq["cell"][0] + sq["cell"][1]), mean(sq["stock"][0] + sq["stock"][1])
        adopt = alls < allc and all(s < c for s, c in zip(bs, bc))
        kmed = float(np.median([v[0] for v in ks.values()]))
        tau = float(np.median([v[1] for v in ks.values()]))
        verdict[side] = {"c1_pass": worst <= 0.05, "c1_worst": worst, "c2_adopt": adopt}
        L += ["", f"C1: largest gap {100 * worst:.1f} pts → **{'pass' if worst <= 0.05 else 'fail'}** (rule ≤ 5)", "",
              f"C2 per-stock blend: real between-stock spread ≈ ±{100 * tau:.1f} pts (sd); prior strength k ≈ {kmed:.0f} trades "
              f"(a stock with {kmed:.0f} trades counts half its own record). Test Brier cell {allc:.4f} vs per-stock {alls:.4f}; halves "
              f"{bc[0]:.4f}/{bs[0]:.4f} · {bc[1]:.4f}/{bs[1]:.4f} → **{'adopt' if adopt else 'reject'}**", ""]
        pa, pb = cell_pay(tr, side), cell_pay(te, side)
        ok3 = all(pb[k] <= pa[k] * 1.3 for k in pa)
        L += [f"C3 average payout (σ units; × σ√T × strike = $ at risk): " + " · ".join(
            f"Δ{k[0]:.2f}/{k[1]}d {pa[k]:.3f}→{pb[k]:.3f}" for k in sorted(pa)), "",
              f"C3: **{'pass' if ok3 else 'fail'}** (2024–26 within +30% of 2020–23 or lower in every cell)", ""]
        verdict[side]["c3_pass"] = ok3
    if a.final:
        tab = {}
        for side in ("put", "call"):
            allr = cell_rates(T, side)
            yr = defaultdict(lambda: defaultdict(list))
            py = defaultdict(lambda: defaultdict(list))
            for t in T:
                if t[side] is not None:
                    yr[(t["delta"], t["dte"])][t["entry"].year].append(t[side])
                    py[(t["delta"], t["dte"])][t["entry"].year].append(t[side + "_pay"])
            pay = cell_pay(T, side)
            for k, (r, n) in allr.items():
                ys = [mean(v) for y, v in yr[k].items() if len(v) >= 200]
                pys = [mean(v) for y, v in py[k].items() if len(v) >= 200]
                tab[f"{side}|{k[0]:.2f}|{k[1]}"] = {"rate": round(r, 4), "n": n, "worst_year": round(min(ys), 4), "best_year": round(max(ys), 4),
                                                     "payout": round(pay[k], 4), "payout_worst_year": round(max(pys), 4),
                                                     "payout_best_year": round(min(pys), 4)}
        ver = f"winrates-{date.today()}"
        (OUT / "winrates.json").write_text(json.dumps({"version": ver, "built_from": "2020-03 →", "verdict": verdict, "cells": tab}, indent=1))
        import winrates as W
        with connect() as conn:
            W.save(conn, ver, tab, verdict, f"{min(t['entry'] for t in T)} → {max(t['entry'] for t in T)}")
        L.append("Shipped table (all history): `out/proto/winrates.json`.")
    (OUT / "gate1c.md").write_text("\n".join(L) + "\n")
    print(json.dumps(verdict))


if __name__ == "__main__":
    main()
