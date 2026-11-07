"""A341 P4 — re-grade S151 Phase 4 sell-put PASS cells under AFML gates (DSR, PBO, purged CV, placebo).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s151_regrade.py
"""
from __future__ import annotations

import random
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import s151_phase4_excess as P4X  # noqa: E402
from s151_phase4_excess import (  # noqa: E402
    HIST_END,
    HIST_START,
    monthly_excess_series,
    run_window_fixed,
)
import s151_phase4_trades as P4  # noqa: E402
from build_plan import connect  # noqa: E402
import pattern_lab as PL  # noqa: E402
import s080_long_options as S80  # noqa: E402
from fast_screen import deflated_sharpe, pbo_cscv  # noqa: E402

ROOT = HERE.parents[2]
OUT_MD = ROOT / "research" / "studies" / "out" / "opt" / "S151-regrade.md"
WIN_2326_END = date(2026, 11, 2)
MIN_MONTHS_CORR = 12
CORR_CUT = 0.5

TARGETS = [
    {
        "label": "SPY RSI-14 Q1 + up_climax",
        "signal": "pair:month:low:spy_rsi14+up_climax",
        "delta": 0.08,
        "entry": "next_open",
        "exit": "half_dte",
    },
    {
        "label": "IV÷RV Q1 + up_climax",
        "signal": "pair:month:low:iv_rv+up_climax",
        "delta": 0.08,
        "entry": "next_open",
        "exit": "stop50",
    },
]

WINDOWS = [
    ("2023-26", P4.TRADE_START, WIN_2326_END, "check"),
    ("2018-22", HIST_START, HIST_END, "hist"),
]

PLACEBO_SEEDS = 20
DSR_GATE = 0.95
PBO_GATE = 0.5
FOLD_GATE = 4


def load_runtime(smoke: bool = False):
    tickers = P4.SMOKE5 if smoke else None
    p_full = PL.s151_panel(tickers, rebuild=False)
    p2 = PL.s151_phase2_separation(p_full[p_full.date <= PL.S151_FIT_END])
    geom = P4.geometry_pair_survivors(p_full, p2)
    sigs = P4.build_signals(p_full, p2, geom)
    edges = P4.fit_edges(p_full)
    scores = P4.model_scores(p_full)
    masks = {s["id"]: P4.signal_mask(p_full, s, edges, scores) for s in sigs}
    conn = connect()
    sector_map = P4X.load_sectors(conn)
    px, rep, tb, _ = S80.load(conn, set(p_full.ticker.unique()) if tickers else None, None)
    if not smoke:
        active: set[str] = set()
        for m in masks.values():
            active.update(p_full.loc[m, "ticker"].unique())
        px = {t: rows for t, rows in px.items() if t in active}
    from s076_structures_backtest import Pricer

    pricer = Pricer(conn)
    tb_dates = [d for d, _ in tb]
    tb_rates = [r for _, r in tb]
    base_cache = P4X.build_base_cache(
        px, rep, pricer, tb_dates, tb_rates, sector_map, sigs, HIST_START
    )
    return p_full, sigs, masks, base_cache, sector_map


def sig_dates_for_window(p_full, sigs, masks, trade_start: date, trade_end: date | None, period_tag: str):
    sig_dates = {}
    for s in sigs:
        if period_tag == "hist" and s["horizon"] == "bars_5m":
            continue
        sub = p_full[masks[s["id"]] & (p_full.date >= pd.Timestamp(trade_start))]
        if trade_end:
            sub = sub[sub.date <= pd.Timestamp(trade_end)]
        sig_dates[s["id"]] = sub.groupby("ticker")["date"].apply(lambda x: set(x.dt.date)).to_dict()
    return sig_dates


def iter_cells(
    sigs,
    sig_dates,
    base_cache,
    trade_start: date,
    trade_end: date | None,
    period_tag: str,
    win_start: date,
    win_end: date,
):
    """Yield one row per S151 P4 grid cell (pre-BH), with trades + monthly excess for win range."""
    check_start = trade_start if period_tag == "hist" else P4.TRADE_START
    check_end = trade_end if period_tag == "hist" else P4X.CHECK_END

    pool_ctx_cache: dict = {}

    def pool_ctx_for(pool, start: date, end: date | None):
        end_eff = end or date(2099, 12, 31)
        key = (id(pool), start, end_eff)
        if key not in pool_ctx_cache:
            base = [x for x in pool if start <= x["d"] <= end_eff]
            sm_means = P4X.sector_month_means(base, {})
            sm_index: dict[tuple[str, int, int], list] = defaultdict(list)
            for b in base:
                sec = b.get("sector", "?")
                sm_index[(sec, b["d"].year, b["d"].month)].append(b)
            pool_ctx_cache[key] = {"base": base, "sm_means": sm_means, "sm_index": sm_index}
        return pool_ctx_cache[key]

    for sig in sigs:
        if period_tag == "hist" and sig["horizon"] == "bars_5m":
            continue
        sd = sig_dates.get(sig["id"], {})
        if not sd:
            continue
        sig_set = {(t, d) for t, days in sd.items() for d in days}
        for inst, opt_side, direction, deltas in P4.INSTRUMENTS[sig["side"]]:
            for delta in deltas:
                dte = P4.dte_for(sig, direction)
                for entry in P4.ENTRIES:
                    bkey = (inst, delta, dte, entry)
                    if bkey not in base_cache:
                        continue
                    for exit_m in P4.EXITS:
                        pool = base_cache[bkey][exit_m]
                        sig_tr = [x for x in pool if (x["ticker"], x["d"]) in sig_set]
                        if len(sig_tr) < 30:
                            continue
                        ex_series = monthly_excess_series(sig_tr, pool, win_start, win_end)
                        cell_id = f"{sig['id']}|{inst}|{delta}|{entry}|{exit_m}|{sig['tier']}"
                        yield {
                            "cell_id": cell_id,
                            "horizon": sig["horizon"],
                            "signal": sig["id"],
                            "instrument": inst,
                            "delta": delta,
                            "entry": entry,
                            "exit": exit_m,
                            "tier": sig["tier"],
                            "n_sig": len(sig_tr),
                            "sig_tr": sig_tr,
                            "base_tr": pool,
                            "excess_series": ex_series,
                            "sig_set": sig_set,
                            "check_start": check_start,
                            "check_end": check_end,
                        }


def excess_matrix(cells: list[dict]) -> tuple[np.ndarray, list[date]]:
    """Align monthly excess across cells → (n_cells, n_months)."""
    month_vals: dict[date, list[float | None]] = defaultdict(lambda: [None] * len(cells))
    for ci, c in enumerate(cells):
        for d, v in c["excess_series"]:
            month_vals[d][ci] = v
    months = sorted(month_vals.keys())
    mat = np.full((len(cells), len(months)), np.nan, dtype=float)
    for ti, mo in enumerate(months):
        for ci, v in enumerate(month_vals[mo]):
            if v is not None and v == v:
                mat[ci, ti] = v
    return mat, months


def trim_matrix_min_months(mat: np.ndarray, min_months: int) -> tuple[np.ndarray, int]:
    """Drop rows with fewer than min_months finite monthly excess values."""
    keep = np.array([np.sum(np.isfinite(row)) >= min_months for row in mat], dtype=bool)
    dropped = int((~keep).sum())
    return mat[keep, :], dropped


def participation_ratio_eigen(corr: np.ndarray) -> float:
    """N_eff = (Σλ)² / Σλ² on the correlation spectrum (λ from symmetric PSD matrix)."""
    w = np.linalg.eigvalsh(corr)
    w = np.clip(w, 0.0, None)
    s = w.sum()
    s2 = (w**2).sum()
    if s2 <= 0 or not np.isfinite(s2):
        return float("nan")
    return float((s**2) / s2)


def cluster_count_corr_cut(corr: np.ndarray, corr_cut: float) -> int:
    """Average linkage on distance 1−r; flat clusters at linkage distance (1−corr_cut)."""
    c = np.asarray(corr, dtype=float)
    np.fill_diagonal(c, 1.0)
    d = 1.0 - c
    np.fill_diagonal(d, 0.0)
    d = (d + d.T) / 2.0
    d = np.clip(d, 0.0, 2.0)
    n = d.shape[0]
    if n <= 1:
        return n
    condensed = squareform(d, checks=False)
    Z = linkage(condensed, method="average")
    t_cut = 1.0 - corr_cut
    labs = fcluster(Z, t=t_cut, criterion="distance")
    return int(len(set(labs)))


def n_eff_and_clusters_from_cells(cells: list[dict]) -> tuple[float, int, int, int]:
    """PBO-window correlation: trim rows with fewer than MIN_MONTHS_CORR months; return N_eff, K, n_all, n_dropped."""
    mat_all, _ = excess_matrix(cells)
    n_all = mat_all.shape[0]
    mat, dropped = trim_matrix_min_months(mat_all, MIN_MONTHS_CORR)
    if mat.shape[0] < 2:
        return float(max(1, mat.shape[0])), max(1, mat.shape[0]), n_all, dropped
    df = pd.DataFrame(mat)
    corr = df.T.corr().to_numpy()
    corr = np.nan_to_num(corr, nan=0.0)
    np.fill_diagonal(corr, 1.0)
    neff = participation_ratio_eigen(corr)
    kcl = cluster_count_corr_cut(corr, CORR_CUT)
    return neff, kcl, n_all, dropped


def purged_kfold_metrics(sig_tr, base_tr, win_start: date, win_end: date, k: int = 5, embargo: int = 1) -> dict:
    ex_series = monthly_excess_series(sig_tr, base_tr, win_start, win_end)
    ex_by_ym = {(d.year, d.month): v for d, v in ex_series}
    ym_sorted = sorted(ex_by_ym.keys())
    n = len(ym_sorted)
    if n < k:
        return {"n_months": n, "same_sign": 0, "folds": [], "underpowered": n < 24}
    fold_size = max(1, n // k)
    folds_detail = []
    same_sign = 0
    for fi in range(k):
        lo = fi * fold_size
        hi = (fi + 1) * fold_size if fi < k - 1 else n
        test_ym = set(ym_sorted[lo:hi])
        fold_ex = [ex_by_ym[ym] for ym in test_ym if ym in ex_by_ym]
        sig_oos = [x for x in sig_tr if (x["d"].year, x["d"].month) in test_ym]
        base_oos = [x for x in base_tr if (x["d"].year, x["d"].month) in test_ym]
        if not fold_ex or not sig_oos or not base_oos:
            folds_detail.append({"fold": fi + 1, "excess": float("nan"), "br_sig": float("nan"), "br_base": float("nan")})
            continue
        ex = float(np.mean(fold_ex))
        br_s = float(np.nanmean([x.get("breach") for x in sig_oos if x.get("breach") == x.get("breach")]))
        br_b = float(np.nanmean([x.get("breach") for x in base_oos if x.get("breach") == x.get("breach")]))
        folds_detail.append({"fold": fi + 1, "excess": ex, "br_sig": br_s, "br_base": br_b})
        if ex > 0:
            same_sign += 1
        _ = embargo  # contiguous month folds; 1-mo embargo applies between IS/OOS in full AFML CV
    return {"n_months": n, "same_sign": same_sign, "folds": folds_detail, "underpowered": n < 24}


def shuffle_sig_within_month(sig_set: set[tuple[str, date]], pool: list[dict], rng: random.Random) -> set[tuple[str, date]]:
    pool_by = defaultdict(list)
    for x in pool:
        pool_by[(x["ticker"], x["d"].year, x["d"].month)].append(x["d"])
    sig_by = defaultdict(list)
    for t, d in sig_set:
        sig_by[(t, d.year, d.month)].append(d)
    out: set[tuple[str, date]] = set()
    for key, days in sig_by.items():
        cands = pool_by.get(key, [])
        if len(cands) < len(days):
            out.update((key[0], d) for d in days)
            continue
        pick = rng.sample(cands, len(days))
        out.update((key[0], d) for d in pick)
    return out


def placebo_dsr_passes(cell: dict, win_start: date, win_end: date, n_trials: int) -> int:
    pool = cell["base_tr"]
    base_sig = cell["sig_set"]
    ok = 0
    for seed in range(PLACEBO_SEEDS):
        rng = random.Random(seed)
        shuf = shuffle_sig_within_month(base_sig, pool, rng)
        sig_tr = [x for x in pool if (x["ticker"], x["d"]) in shuf]
        if len(sig_tr) < 30:
            continue
        ex = monthly_excess_series(sig_tr, pool, win_start, win_end)
        xs = np.array([v for _, v in ex], dtype=float)
        if xs.size < 10:
            continue
        dsr = deflated_sharpe(xs, max(1, int(n_trials)))
        if dsr == dsr and dsr >= DSR_GATE:
            ok += 1
    return ok


def gate_verdict(dsr, pbo, fold_same: int, n_months: int) -> str:
    if n_months < 24:
        return "underpowered"
    fails = []
    if not (dsr == dsr and dsr >= DSR_GATE):
        fails.append("DSR")
    if not (pbo == pbo and pbo < PBO_GATE):
        fails.append("PBO")
    if fold_same < FOLD_GATE:
        fails.append(f"purged({fold_same}/5)")
    if not fails:
        return "survives"
    return "downgraded:" + "+".join(fails)


def find_target_cell(cells: list[dict], spec: dict) -> dict | None:
    for c in cells:
        if (
            c["signal"] == spec["signal"]
            and c["delta"] == spec["delta"]
            and c["entry"] == spec["entry"]
            and c["exit"] == spec["exit"]
            and c["instrument"] == "sell_put"
        ):
            return c
    return None


def count_n_formula(check_df: pd.DataFrame) -> str:
    ns = check_df["signal"].nunique() if not check_df.empty else 0
    return (
        f"N={len(check_df)} cells = evaluated grid on 2023–24 check window "
        f"(signal×instrument Δ×entry×exit×tier; {ns} signal ids; bars_5m excluded; n_sig≥30)"
    )


def main():
    t0 = time.time()
    smoke = "--smoke" in sys.argv
    p_full, sigs, masks, base_cache, sector_map = load_runtime(smoke)

    check_df = run_window_fixed(p_full, sigs, masks, base_cache, sector_map, P4.TRADE_START, None, "check")
    n_trials = len(check_df)
    n_formula = count_n_formula(check_df)

    pbo_val = float("nan")
    all_check_cells: list[dict] = []
    n_eff = float("nan")
    n_clust = 0
    n_corr_full = 0
    n_corr_drop = 0
    n_trials_neff_i = max(1, 1)

    results = []
    placebo_lines = []

    for win_label, win_start, win_end, period_tag in WINDOWS:
        sig_d = sig_dates_for_window(p_full, sigs, masks, win_start, win_end if period_tag == "hist" else None, period_tag)
        cells = list(
            iter_cells(sigs, sig_d, base_cache, win_start, win_end if period_tag == "hist" else None, period_tag, win_start, win_end)
        )
        if win_label == "2023-26":
            all_check_cells = cells
            mat, _ = excess_matrix(cells)
            pbo_val = pbo_cscv(mat)
            n_eff, n_clust, n_corr_full, n_corr_drop = n_eff_and_clusters_from_cells(cells)
            n_trials_neff_i = max(1, int(round(n_eff))) if n_eff == n_eff else max(1, n_corr_full - n_corr_drop)

        for spec in TARGETS:
            cell = find_target_cell(cells, spec)
            if not cell:
                results.append(
                    {
                        "signal": spec["label"],
                        "window": win_label,
                        "N": n_trials,
                        "DSR_1050": float("nan"),
                        "DSR_neff": float("nan"),
                        "DSR_K": float("nan"),
                        "PBO": pbo_val,
                        "folds_same": 0,
                        "n_months": 0,
                        "old_verdict": "PASS",
                        "new_verdict": "missing cell",
                    }
                )
                continue
            ex = monthly_excess_series(cell["sig_tr"], cell["base_tr"], win_start, win_end)
            xs = np.array([v for _, v in ex], dtype=float)
            dsr_1050 = deflated_sharpe(xs, n_trials) if xs.size >= 10 else float("nan")
            dsr_neff = deflated_sharpe(xs, n_trials_neff_i) if xs.size >= 10 else float("nan")
            dsr_k = deflated_sharpe(xs, max(1, n_clust)) if xs.size >= 10 else float("nan")
            pk = purged_kfold_metrics(cell["sig_tr"], cell["base_tr"], win_start, win_end)
            new_v = gate_verdict(dsr_neff, pbo_val, pk["same_sign"], pk["n_months"])
            results.append(
                {
                    "signal": spec["label"],
                    "window": win_label,
                    "N": n_trials,
                    "DSR_1050": dsr_1050,
                    "DSR_neff": dsr_neff,
                    "DSR_K": dsr_k,
                    "PBO": pbo_val,
                    "folds_same": pk["same_sign"],
                    "n_months": pk["n_months"],
                    "old_verdict": "PASS",
                    "new_verdict": new_v,
                    "folds": pk["folds"],
                }
            )
            if win_label == "2023-26":
                n_pl = placebo_dsr_passes(cell, win_start, win_end, n_trials_neff_i)
                placebo_lines.append(f"{spec['label']}: {n_pl}/{PLACEBO_SEEDS} seeds DSR≥{DSR_GATE} (n_trials=N_eff round)")

    # Overall per signal: both windows must pass
    overall = {}
    for spec in TARGETS:
        rows = [r for r in results if r["signal"] == spec["label"]]
        surv = all(r["new_verdict"] == "survives" for r in rows) and len(rows) == 2
        if any(r["new_verdict"] == "underpowered" for r in rows):
            by_win = {r["window"]: r for r in rows}
            n26 = by_win.get("2023-26", {}).get("n_months", "—")
            n18 = by_win.get("2018-22", {}).get("n_months", "—")
            overall[spec["label"]] = f"underpowered (window; n_months 2023-26={n26}, 2018-22={n18})"
        elif surv:
            overall[spec["label"]] = "survives"
        else:
            reasons = sorted({r["new_verdict"] for r in rows if r["new_verdict"] not in ("survives", "underpowered")})
            overall[spec["label"]] = "downgraded (" + "; ".join(reasons) + ")"

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    neff_s = f"{n_eff:.2f}" if n_eff == n_eff else "—"
    lines = [
        "# S151 Phase 4 — AFML re-grade (A341 P4)",
        "",
        n_formula,
        "",
        f"PBO matrix (2023–26 monthly excess): **N={n_corr_full}** cells in grid; **{n_corr_drop}** dropped (fewer than {MIN_MONTHS_CORR} finite months).",
        f"N_eff (participation ratio on cell correlation): **{neff_s}** (DSR n_trials = round N_eff = {n_trials_neff_i}).",
        f"Cross-check: average linkage on 1−r, cut at correlation {CORR_CUT:g} → **{n_clust}** clusters.",
        "",
        f"Study-level PBO (CSCV-16, all N cells monthly excess, 2023–26 window): **{pbo_val:.3f}**",
        "",
        "Pass bar (verdict uses DSR@N_eff): DSR≥0.95 AND PBO<0.5 AND ≥4/5 purged month-folds same-sign excess **in both windows**; n_months<24 → underpowered (n_months shown per row).",
        "",
        "Caveat: universe = current LSEG names; survivorship biases put breach rates upward.",
        "",
        "| signal | window | n_months | N | DSR@1050 | DSR@N_eff | DSR@K | PBO | folds same-sign | old | new |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|",
    ]
    for r in sorted(
        results,
        key=lambda x: (-(x["DSR_neff"] if x["DSR_neff"] == x["DSR_neff"] else -1), x["signal"]),
    ):
        d1050 = f"{r['DSR_1050']:.3f}" if r["DSR_1050"] == r["DSR_1050"] else "—"
        dneff = f"{r['DSR_neff']:.3f}" if r["DSR_neff"] == r["DSR_neff"] else "—"
        dk = f"{r['DSR_K']:.3f}" if r["DSR_K"] == r["DSR_K"] else "—"
        pbo_s = f"{r['PBO']:.3f}" if r["PBO"] == r["PBO"] else "—"
        nm = r.get("n_months", 0)
        lines.append(
            f"| {r['signal']} | {r['window']} | {nm} | {r['N']} | {d1050} | {dneff} | {dk} | {pbo_s} | {r['folds_same']}/5 | {r['old_verdict']} | {r['new_verdict']} |"
        )
    lines += ["", "**Overall (both windows):**"]
    for spec in TARGETS:
        lines.append(f"- {spec['label']}: **{overall[spec['label']]}**")
    lines += ["", "**Placebo** (shuffle signal dates within ticker-month, 2023–26):"]
    lines.extend(f"- {ln}" for ln in placebo_lines)
    lines += [f"", f"Runtime: {time.time() - t0:.1f}s · Agent: cursor · Refs: A341"]
    OUT_MD.write_text("\n".join(lines) + "\n")
    print(n_formula)
    print(f"PBO={pbo_val:.4f} wrote {OUT_MD}")
    for spec in TARGETS:
        print(f"  {spec['label']}: {overall[spec['label']]}")


if __name__ == "__main__":
    main()
