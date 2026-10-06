"""Two follow-up hypotheses from the factor study, graded with the lab (lab.py) machinery.
 H1 value trap: is cheapness (Graham gap, forward earnings yield vs peers) significantly NEGATIVE among bottom-half
    12-1 momentum names and positive among top-half? (interaction, NW t per half + difference)
 H2 method disagreement: does the cross-method spread of fair-value votes (bt_V.pkl, 6 internal methods) forecast
    future risk (21-day realized vol, |126-day peer-relative return|) beyond the stock's current idio vol?
Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/hypothesis_tests.py WORKDIR"""
import contextlib, io, math, pickle, runpy, sys
from pathlib import Path
import numpy as np
W = sys.argv[1]
sys.argv = [str(Path(__file__).parent / "factor_study.py"), W]
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(sys.argv[0])
L, LAB, D, F = g["L"], g["LAB"], g["D"], g["F"]
N = len(D["as_of"])

print("H1 value trap (target rel_126, monthly rank IC, NW t lag 6)")
mom = D["f.mom_12_1"]
hi = np.zeros(N, bool)
for d, idx in g["by_date"].items():
    idx = np.array(idx); m = mom[idx]
    if np.sum(~np.isnan(m)) > 10: hi[idx] = m >= np.nanmedian(m)
for name in ("graham_gap", "ey_fwd_vs_peer", "growth_adj_value"):
    s = F[name]
    sh, sl = s.copy(), s.copy(); sh[~hi] = np.nan; sl[hi] = np.nan
    ih, il = LAB.ic_series(sh, D["o.rel_126"]), LAB.ic_series(sl, D["o.rel_126"])
    ok = ~np.isnan(ih) & ~np.isnan(il)
    diff = ih[ok] - il[ok]
    print(f"  {name:18s} top-half mom IC {np.nanmean(ih):+.3f} (t {L.nw_t(ih, 6):+.1f}) · bottom-half {np.nanmean(il):+.3f} (t {L.nw_t(il, 6):+.1f})"
          f" · difference {diff.mean():+.3f} (t {L.nw_t(diff, 6):+.1f}, {ok.sum()} months)")

print("\nH2 method disagreement (6 internal fair-value methods, backtest panel)")
V = pickle.load(open(f"{W}/bt_V.pkl", "rb"))["V"]
METH = ["peer_pe_median", "peer_pe_harmonic", "warranted_pe", "graham_fwd", "ohlson_juettner", "lynch"]
spread = np.full(N, np.nan)
key = {(t, d): i for i, (t, d) in enumerate(zip(D["ticker"], D["as_of"]))}
for (t, d), v in V.items():
    xs = [v[m] for m in METH if m in v]
    i = key.get((t, d.isoformat()))
    if i is not None and len(xs) >= 3: spread[i] = float(np.std(xs))
absrel = np.abs(D["o.rel_126"])
for tgt_name, tgt in (("future 21d realized vol", D["o.rv_fwd_21"]), ("|126d peer-relative return|", absrel)):
    raw = LAB.ic_series(spread, tgt); part = LAB.ic_series(spread, tgt, control=D["f.idio_vol"])
    print(f"  spread vs {tgt_name:28s} IC {np.nanmean(raw):+.3f} (t {L.nw_t(raw, 6):+.1f}) · controlling for current idio vol {np.nanmean(part):+.3f} (t {L.nw_t(part, 6):+.1f})")
