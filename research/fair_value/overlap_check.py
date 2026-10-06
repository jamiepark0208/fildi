"""Do forward growth (FY1→FY2) and 3m price-target revision add anything beyond signals Fildi already uses?
Existing: fund engine ibes revision breadth + trailing epsgrow; Model List STREET (ARM, 30d EPS drift).
Point-in-time comparison on the lab panel: rank correlations + partial IC controlling for each existing signal.
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/overlap_check.py WORKDIR"""
import runpy, sys
import numpy as np
from pathlib import Path
sys.argv = [str(Path(__file__).parent / "factor_study.py"), sys.argv[1]]
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(sys.argv[0])
L, LAB, D, F = g["L"], g["LAB"], g["D"], g["F"]
existing = {"IBES revision breadth (fund)": D["fu.ibes_breadth"], "IBES 1m estimate drift (≈ STREET drift)": D["fu.ibes_drift"],
            "IBES 3m estimate drift": D["fu.ibes_drift_3m"], "trend dist_ma200": D["f.dist_ma200"], "momentum 12-1": D["f.mom_12_1"]}
for cand in ("g_short", "pt_rev_3m"):
    s = F[cand]
    print(f"\n{cand}: IC rel_126 {np.nanmean(LAB.ic_series(s, D['o.rel_126'])):+.3f}")
    for name, e in existing.items():
        ok = ~np.isnan(s) & ~np.isnan(e) & LAB.m
        rho = np.corrcoef(L.rankc(s[ok]), L.rankc(e[ok]))[0, 1] if ok.sum() > 100 else float("nan")
        part = LAB.ic_series(s, D["o.rel_126"], control=e)
        print(f"  vs {name:40s} rank corr {rho:+.2f}   partial IC {np.nanmean(part):+.3f} (t {L.nw_t(part, 6):+.1f})")
