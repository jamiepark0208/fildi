"""DCF v2 calibration (A283): which generic assumption makes the engine value the market at ~1× price?
Deterministic median path per name (all percentiles 0.5), toggling one convention at a time, cumulative.
Universe = dcf_valuations names (non-financial, SEC base OK, not stale), price ≥ $10B market cap.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/dcf_calibration.py"""
import sys
from pathlib import Path
import numpy as np
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/watchlist_sync/dcf"))
from build_plan import connect, rows
from engine import BaseRates, inputs, simulate

br = BaseRates()
with connect() as c:
    names = rows(c, """SELECT v.ticker, b.base FROM watchlist_sync.dcf_valuations v
      JOIN LATERAL (SELECT base FROM watchlist_sync.dcf_ttm_base t WHERE t.ticker = v.ticker ORDER BY as_of DESC LIMIT 1) b ON true
      WHERE v.as_of = (SELECT max(as_of) FROM watchlist_sync.dcf_valuations)""")
    X = []
    for r in names:
        x = inputs(c, r["ticker"], r["base"])
        if x["price"] * x["shares"] >= 1e10 and x["sector"] != "55":
            X.append(x)
cma = X[0]["cma"]
rf, g_mode = cma["pairs"]["base"]["rf"], cma["pairs"]["base"]["g_dist"]["mode"]
erp_base, erp_imp = cma["pairs"]["base"]["erp"], cma["pairs"]["implied"]["erp"]
steps = [
    ("C0 base (ERP 4.25, g 4.3, base-rate growth/margin, ROIC_T base rate)", {}),
    ("C1 + terminal g = rf (Damodaran implied-ERP convention)", {"g_T": rf - 0.0001}),
    ("C2 + implied ERP 3.7", {"g_T": rf - 0.0001, "erp": erp_imp}),
    ("C3 + margins held (no fade)", {"g_T": rf - 0.0001, "erp": erp_imp, "hold_margin": True}),
    ("C4 + terminal ROIC 25 % (less reinvestment)", {"g_T": rf - 0.0001, "erp": erp_imp, "hold_margin": True, "roicT": 0.25}),
    ("C5 + growth at P75 of base rate", {"g_T": rf - 0.0001, "erp": erp_imp, "hold_margin": True, "roicT": 0.25, "u_g": 0.75}),
    ("only: g = rf", {"g_T": rf - 0.0001}),
    ("only: margins held", {"hold_margin": True}),
    ("only: ROIC_T 25 %", {"roicT": 0.25}),
    ("only: growth P75", {"u_g": 0.75}),
]
print(f"{len(X)} names ≥ $10B cap (non-financial, ex-utilities); rf {rf:.2%}, base g {g_mode:.2%}, ERP base {erp_base:.2%} / implied {erp_imp:.2%}")
for name, fx in steps:
    base = {"u_g": 0.5, "u_m": 0.5, "u_r": 0.5, "u_s": 0.5, "erp": erp_base, "g_T": g_mode}
    base.update(fx)
    vp = []
    for x in X:
        v = float(simulate(x, br, n=1, fixed=base)["vps"][0])
        vp.append(v / x["price"])
    vp = np.array(vp)
    print(f"  {name:72s} median V/P {np.median(vp):.2f}  P25–P75 {np.percentile(vp,25):.2f}–{np.percentile(vp,75):.2f}  share V>P {np.mean(vp>1):.0%}")
