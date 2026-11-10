"""S178 step 1 — generic IV surface from real LSEG option quotes (optlab.lseg_opt_daily, 2018→, ~770k quotes, 397 roots).

Why: S177 / S076 priced long calls at 30 DTE only, from iv30 × a one-day Schwab call ladder. Jamie 11-09: "maybe you did not choose
the right strike or expiry (longer the better), take advantage of skews, pair with sell puts". To test 60–360 DTE calls and
risk reversals we need term structure + call wing from real quotes, not iv30 alone.

Method: every quote → implied vol (vectorized bisection, European BS, T-bill r, no dividends) → ratio = IV ÷ the stock's LSEG
iv30 on that side at the quote date. Cell = (side, DTE bucket, |Δ| bucket at the real IV, iv30 percentile tercile).
Call IV is also estimated by parity from puts at the same strike (put |Δ| = 1 − call Δ) → we keep both and validate
against the real call quotes (the gate: median model/real price within ±10 % per DTE bucket for 0.25–0.75Δ calls).

Out: out/opt/s178_surface.json {cells: {side|dteb|dlb|ivpb: [median ratio, n, median rel spread]}} + validation lines.
    cd scripts/watchlist_sync && .venv/bin/python analysis/s178_surface_calib.py
"""
from __future__ import annotations

import json
import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from scipy.special import ndtr

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s075_skew_calibration import RIC  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "s178_surface.json"
DTE_B = [(5, 21), (21, 50), (50, 100), (100, 200), (200, 420)]
DL_B = [(round(x, 2), round(x + 0.05, 2)) for x in np.arange(0.05, 0.95, 0.05)]
IVP_B = [(0, 1 / 3), (1 / 3, 2 / 3), (2 / 3, 1.01)]


def bkt(x, B):
    for b in B:
        if b[0] <= x < b[1]:
            return b
    return None


def bs(S, K, v, T, r, call):
    sd = v * np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * v * v) * T) / sd
    d2 = d1 - sd
    if call:
        return S * ndtr(d1) - K * np.exp(-r * T) * ndtr(d2), ndtr(d1)
    return K * np.exp(-r * T) * ndtr(-d2) - S * ndtr(-d1), ndtr(-d1)


def implied(S, K, P, T, r, call):
    lo, hi = np.full_like(S, 0.01), np.full_like(S, 5.0)
    for _ in range(45):
        m = (lo + hi) / 2
        px, _ = bs(S, K, m, T, r, call)
        hi = np.where(px > P, m, hi); lo = np.where(px > P, lo, m)
    iv = (lo + hi) / 2
    iv[(iv < 0.02) | (iv > 4.9)] = np.nan
    return iv


def load_tb():
    tb = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            tb[date.fromisoformat(dd)] = float(v) / 100
    k = sorted(tb)
    return lambda d: tb[k[max(bisect_right(k, d) - 1, 0)]]


def main():
    rat = load_tb()
    with connect() as conn:
        H = defaultdict(dict)   # ticker → date → (close, ivp, ivc)
        for t, d, c, ip, ic in conn.execute("SELECT ticker, date, close::float8, iv30_put::float8, iv30_call::float8 "
                                            "FROM lseg_research.daily_history WHERE close > 0 AND date >= '2017-06-01'"):
            f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
            H[t][d] = (c, f(ip), f(ic))
        Q = conn.execute("SELECT ric, date, bid::float8, ask::float8 FROM optlab.lseg_opt_daily WHERE bid > 0 AND ask >= bid").fetchall()
    # iv30 percentile (trailing 252 of the avg of put/call iv30) per ticker-date
    ivpct = {}
    for t, h in H.items():
        ds = sorted(h); vals = []
        for d in ds:
            c, ip, ic = h[d]
            v = (ip + ic) / 2 if (ip and ic) else None
            if v:
                vals.append(v); w = vals[-252:]
                ivpct[(t, d)] = sum(x <= v for x in w) / len(w) if len(w) >= 60 else None
    rec = []
    for ric, d, bid, ask in Q:
        m = RIC.match(ric)
        if not m:
            continue
        root, let, dd, yy, k = m.groups()
        try:
            exp = date(2000 + int(yy), (ord(let) - ord("A")) % 12 + 1, int(dd))
        except ValueError:
            continue
        h = H.get(root, {}).get(d)
        dte = (exp - d).days
        if not h or not (5 <= dte < 420):
            continue
        S, ip, ic = h
        call = let <= "L"
        base = (ip + ic) / 2 if (ip and ic) else None   # one blended iv30: side gaps are data noise (S178 artifact)
        K = int(k) / 100
        mid = (bid + ask) / 2
        if not base or not 0.3 < K / S < 2.0 or (ask - bid) / mid > 0.6:
            continue
        rec.append((root, d, call, S, K, mid, dte / 365, rat(d), base, (ask - bid) / mid, ivpct.get((root, d)), ip, ic))
    print(f"quotes usable {len(rec)}")
    A = {k: np.array([r[i] for r in rec], dtype=float) for i, k in [(3, "S"), (4, "K"), (5, "P"), (6, "T"), (7, "r"), (8, "base"), (9, "spr")]}
    call = np.array([r[2] for r in rec])
    iv = np.full(len(rec), np.nan); dl = np.full(len(rec), np.nan)
    for side in (True, False):
        ix = call == side
        iv[ix] = implied(A["S"][ix], A["K"][ix], A["P"][ix], A["T"][ix], A["r"][ix], side)
        _, dl[ix] = bs(A["S"][ix], A["K"][ix], np.nan_to_num(iv[ix], nan=0.3), A["T"][ix], A["r"][ix], side)
    cells = defaultdict(list)
    for i, r in enumerate(rec):
        if np.isnan(iv[i]):
            continue
        db, lb = bkt(r[6] * 365, DTE_B), bkt(dl[i], DL_B)
        pb = bkt(r[10], IVP_B) if r[10] is not None else None
        if not db or not lb:
            continue
        for p in (pb, "all"):
            if p is None:
                continue
            cells[("C" if r[2] else "P", db, lb, p)].append((iv[i] / r[8], r[9]))
    out = {}
    for (s, db, lb, p), v in cells.items():
        if len(v) >= 30:
            out[f"{s}|{db[0]}-{db[1]}|{lb[0]:.2f}-{lb[1]:.2f}|{p if p == 'all' else f'{p[0]:.2f}'}"] = [
                float(np.median([x for x, _ in v])), len(v), float(np.median([y for _, y in v]))]
    OUT.write_text(json.dumps({"cells": out, "dte_b": DTE_B, "dl_b": DL_B}, indent=0))
    print(f"cells {len(out)} → {OUT}")
    # quick view: put ratio by DTE (ATM 0.45-0.55) and by Δ at 50-100; call ratio from calls
    for s in ("P", "C"):
        print(f"\n{s}: median IV ÷ iv30_{'call' if s == 'C' else 'put'} (all regimes), rows = |Δ|, cols = DTE")
        print("  Δ      " + " ".join(f"{a:>3}-{b:<4}" for a, b in DTE_B))
        for lb in DL_B:
            row = []
            for db in DTE_B:
                c = out.get(f"{s}|{db[0]}-{db[1]}|{lb[0]:.2f}-{lb[1]:.2f}|all")
                row.append(f"{c[0]:.2f}/{min(c[1], 99999):<5d}"[:9] if c else "   -     ")
            print(f"  {lb[0]:.2f}  " + " ".join(row))
    # parity validation: call priced at the put cell (put |Δ| = 1 − call Δ at the put's IV) vs real call
    ok = []
    for i, r in enumerate(rec):
        if not r[2] or np.isnan(iv[i]) or r[11] is None:
            continue
        db = bkt(r[6] * 365, DTE_B); cdl = dl[i]
        if not db or not 0.25 <= cdl <= 0.75:
            continue
        lb = bkt(1 - cdl, DL_B)
        c = out.get(f"P|{db[0]}-{db[1]}|{lb[0]:.2f}-{lb[1]:.2f}|all") if lb else None
        c2 = out.get(f"C|{db[0]}-{db[1]}|{bkt(cdl, DL_B)[0]:.2f}-{bkt(cdl, DL_B)[1]:.2f}|all")
        if not c:
            continue
        mp, _ = bs(np.array([r[3]]), np.array([r[4]]), np.array([r[11] * c[0]]), np.array([r[6]]), np.array([r[7]]), True)
        mc = None
        if c2 and r[12]:
            mc, _ = bs(np.array([r[3]]), np.array([r[4]]), np.array([r[12] * c2[0]]), np.array([r[6]]), np.array([r[7]]), True)
            mc = float(mc[0]) / r[5]
        ok.append((db, float(mp[0]) / r[5], mc))
    print("\nvalidation on real calls 0.25–0.75Δ: model ÷ real mid (median) — parity-from-puts | own call cells (in-sample)")
    for db in DTE_B:
        v = [x for x in ok if x[0] == db]
        if v:
            print(f"  DTE {db}: n {len(v):5d}  parity {np.median([x[1] for x in v]):.3f}  call-cells "
                  f"{np.median([x[2] for x in v if x[2]]) if any(x[2] for x in v) else float('nan'):.3f}")


if __name__ == "__main__":
    main()
