#!/usr/bin/env python3
"""S191 placebo (contract 4): each candidate cell vs 100 within-ticker circular date shifts + pool baselines."""
from __future__ import annotations
import sys, warnings
from pathlib import Path
import numpy as np
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import s191_entry_signals as S  # noqa: E402
FS = S.FS
CANDS = [("sweep_low_reclaim", "sp12_25", "bull"), ("sweep_low_reclaim", "sp12_25", "bear"),
         ("sweep_low_reclaim", "sp08_14", "bear"), ("val_cheap", "sp12_25", "bull"),
         ("double_top", "lp30_30", "bull"), ("double_bottom", "lp30_30", "bear"),
         ("at_support", "stock_h21", "bull"), ("at_resistance", "stock_h21", "bull"),
         ("sweep_high_reject", "stock_h10", "bull")]
pack = FS.load_bars(None, rebuild=False)
sig, px = S.all_signals(pack)
dates, tickers = px["dates"], px["tickers"]
reg = S.regimes(px)
dec = FS.vol_decile_mat(FS.realized_vol20(px["c"]))
lab = FS._import_lab()
ex, base = {}, {}
for lab_name, inst, delta, dte, exit_m, metric in S.POOLS:
    M, _, _ = S.pool_matrix(lab, inst, delta, dte, exit_m, metric, dates, tickers)
    ex[lab_name] = M - FS.leave_one_out_decile_means(M, dec)
    for rn, rv in reg.items():
        v = M[rv]
        base[(lab_name, rn)] = float(np.nanmean(v))
for H in (10, 21):
    r = FS.fwd_returns(px["o"], px["c"], H)
    ex[f"stock_h{H}"] = r - FS.leave_one_out_decile_means(r, dec)
print("pool baselines (mean per trade):", {f"{k[0]}/{k[1]}": round(v, 3) for k, v in base.items()})
rng = np.random.default_rng(7)
def mmean(e, m, rv, sign):
    mask = m & rv[:, None] & np.isfinite(e)
    return FS.month_cluster_t(dates, sign * e, mask), float((sign * e)[mask].mean())
for s, o, rn in CANDS:
    sign = 1 if (o.startswith("stock") and s in S.BULL) or not o.startswith("stock") else -1
    t0, m0 = mmean(ex[o], sig[s], reg[rn], sign)
    ts = []
    for _ in range(100):
        sh = np.empty_like(sig[s])
        for j in range(sig[s].shape[1]):
            sh[:, j] = np.roll(sig[s][:, j], rng.integers(60, len(dates) - 60))
        ts.append(mmean(ex[o], sh, reg[rn], sign)[0])
    ts = np.array([x for x in ts if np.isfinite(x)])
    p = float(np.mean(np.abs(ts) >= abs(t0))) if ts.size else float("nan")
    print(f"{s:18s} {o:9s} {rn}: t {t0:+.2f}  mean {m0:+.4f}  placebo |t|≥ share {p:.2f}  (placebo t sd {ts.std():.2f})")
