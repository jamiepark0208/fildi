#!/usr/bin/env python3
"""S191 — entry-signal screen for buying AND selling puts (Jamie 11-15).

Pre-registration: research/studies/S191-entry-signals.md (signals, regime, expected signs, pass bar).
Screen only: fast_screen trade pools are model-priced (own IV30), next-open entry, daily bars.

  .venv/bin/python analysis/s191_entry_signals.py preflight   # counts per signal × regime
  .venv/bin/python analysis/s191_entry_signals.py run
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import fast_screen as FS  # noqa: E402
from build_plan import connect  # noqa: E402
from quantcore.causal import assert_causal  # noqa: E402

REPO = HERE.parents[2]
OUT = REPO / "research" / "studies" / "out" / "S191"
SPLIT = pd.Timestamp("2025-01-01")
DEDUP = 10
BULL = ("sweep_low_reclaim", "at_support", "double_bottom", "val_cheap")
BEAR = ("sweep_high_reject", "at_resistance", "double_top", "breakdown50", "val_stretch")
POOLS = (  # (label, inst, delta, dte, exit, metric)
    ("sp08_14", "sell_put", 0.08, 14, "expiry", "bp_wk"),
    ("sp12_25", "sell_put", 0.12, 25, "expiry", "bp_wk"),
    ("lp30_30", "long_put", 0.3, 30, "half_dte", "ret"),
)


# ── helpers ──────────────────────────────────────────────────────────────────
def roll(x: np.ndarray, fn: str, w: int, shift: int) -> np.ndarray:
    """Rolling fn over rows t-shift-w+1 … t-shift (strictly past when shift ≥ 1)."""
    r = getattr(pd.DataFrame(x).rolling(w, min_periods=w), fn)()
    return r.shift(shift).to_numpy()


def lag(x: np.ndarray, k: int = 1) -> np.ndarray:
    out = np.full(x.shape, np.nan)
    out[k:] = x[:-k]
    return out


def price_signals(o, h, l, c) -> dict[str, np.ndarray]:
    atr = FS.atr14_mat(h, l, c)
    ret10 = c / lag(c, 10) - 1.0
    s = {}
    pl, ph = roll(l, "min", 20, 1), roll(h, "max", 20, 1)
    s["sweep_low_reclaim"] = (l < pl) & (c > pl)
    s["sweep_high_reject"] = (h > ph) & (c < ph)
    sl, rh = roll(l, "min", 55, 6), roll(h, "max", 55, 6)
    s["at_support"] = (c > sl) & (c - sl < 0.5 * atr) & (ret10 < 0)
    s["at_resistance"] = (c < rh) & (rh - c < 0.5 * atr) & (ret10 > 0)
    l1, l2, neck_hi = roll(l, "min", 20, 21), roll(l, "min", 18, 3), roll(h, "max", 28, 3)
    db = (np.abs(l1 - l2) < atr) & (neck_hi - np.maximum(l1, l2) > 2 * atr)
    s["double_bottom"] = db & (c > neck_hi) & (lag(c) <= lag(neck_hi))
    h1, h2, neck_lo = roll(h, "max", 20, 21), roll(h, "max", 18, 3), roll(l, "min", 28, 3)
    dt = (np.abs(h1 - h2) < atr) & (np.minimum(h1, h2) - neck_lo > 2 * atr)
    s["double_top"] = dt & (c < neck_lo) & (lag(c) >= lag(neck_lo))
    pl50 = roll(l, "min", 50, 1)
    s["breakdown50"] = (c < pl50) & (lag(c) >= lag(pl50))
    return s


def load_fwd_pe_z(dates: pd.DatetimeIndex, tickers: list[str], c: np.ndarray) -> np.ndarray:
    """z of log forward P/E (IBES FY1 mean EPS, statpers + 3 bdays) vs own trailing 3 y."""
    with connect() as conn:
        df = pd.read_sql(
            "SELECT ticker, statpers, meanest FROM wrds_research.ibes_statsum "
            "WHERE measure='EPS' AND fpi='1' AND meanest IS NOT NULL", conn)
    df["avail"] = pd.to_datetime(df.statpers) + pd.offsets.BDay(3)
    eps = (df.drop_duplicates(["ticker", "avail"], keep="last")
             .pivot(index="avail", columns="ticker", values="meanest")
             .reindex(columns=tickers))
    eps = eps.reindex(eps.index.union(dates)).sort_index().ffill(limit=60).reindex(dates)
    e = eps.to_numpy(dtype=float)
    lpe = np.where((e > 0) & (c > 0), np.log(np.where(c > 0, c, np.nan) / np.where(e > 0, e, np.nan)), np.nan)
    d = pd.DataFrame(lpe)
    mu = d.rolling(756, min_periods=252).mean()
    sd = d.rolling(756, min_periods=252).std()
    return ((d - mu) / sd).to_numpy()


def all_signals(pack: dict) -> tuple[dict[str, np.ndarray], dict]:
    dates, tickers, o, c, h = FS._align(pack)
    l = pack["l"].to_numpy(dtype=float)
    s = price_signals(o, h, l, c)
    z = load_fwd_pe_z(dates, tickers, c)
    s["val_cheap"] = z < -2
    s["val_stretch"] = z > 2
    out = {}
    for k, m in s.items():
        m = np.where(np.isfinite(c), m, False).astype(bool)
        prior = roll(m.astype(float), "sum", DEDUP, 1)
        out[k] = m & (prior == 0)
    return out, {"dates": dates, "tickers": tickers, "o": o, "h": h, "l": l, "c": c}


def causal_check(px: dict) -> None:
    """contract 19: price signals at bar < t unchanged when data is cut at t (3 liquid names)."""
    for t in ("AAPL", "NVDA", "JPM"):
        if t not in px["tickers"]:
            continue
        j = px["tickers"].index(t)
        data = np.column_stack([px["o"][:, j], px["h"][:, j], px["l"][:, j], px["c"][:, j]])

        def f(d):
            s = price_signals(*(d[:, [i]] for i in range(4)))
            return np.column_stack([s[k][:, 0].astype(float) for k in sorted(s)])
        assert_causal(f, data, n_cuts=8)


def regimes(px: dict) -> dict[str, np.ndarray]:
    j = px["tickers"].index("SPY")
    spy = px["c"][:, j]
    sma = pd.Series(spy).rolling(200, min_periods=200).mean().to_numpy()
    ok = np.isfinite(sma)
    return {"bull": ok & (spy > sma), "bear": ok & (spy <= sma)}


def cell(dates, ex: np.ndarray, ent: np.ndarray, reg: np.ndarray, sign: int) -> dict:
    mask = ent & reg[:, None] & np.isfinite(ex)
    sel = (sign * ex)[mask]
    if sel.size == 0:
        return {"n": 0}
    rows, cols = np.nonzero(mask)
    wk = pd.DatetimeIndex(dates[rows]).to_period("W").astype(str)
    n_indep = len(set(zip(wk, cols)))
    fit = mask & (np.asarray(dates < SPLIT))[:, None]
    ho = mask & (np.asarray(dates >= SPLIT))[:, None]
    dly = lag(ent.astype(float)) == 1
    dmask = dly & reg[:, None] & np.isfinite(ex)
    return {
        "n": int(sel.size), "n_indep": n_indep, "months": int(pd.DatetimeIndex(dates[rows]).to_period("M").nunique()),
        "ex": float(sel.mean()), "t": FS.month_cluster_t(dates, sign * ex, mask),
        "ex_fit": float((sign * ex)[fit].mean()) if fit.any() else np.nan,
        "ex_ho": float((sign * ex)[ho].mean()) if ho.any() else np.nan,
        "ex_delay": float((sign * ex)[dmask].mean()) if dmask.any() else np.nan,
    }


def pool_matrix(lab, inst, delta, dte, exit_m, metric, dates, tickers):
    """Trade metric + breach at the SIGNAL row (pool entry date = signal day + 1)."""
    pool = lab._load_trade_pool(inst, delta, dte, "next_open", exit_m)
    di = {pd.Timestamp(d).date(): i for i, d in enumerate(dates)}
    ti = {t: i for i, t in enumerate(tickers)}
    M = np.full((len(dates), len(tickers)), np.nan)
    B = np.full_like(M, np.nan)
    for x in pool:
        d = x["d"].date() if hasattr(x["d"], "date") else x["d"]
        i, j = di.get(d), ti.get(x["ticker"])
        if i is None or j is None or i == 0:
            continue
        v = FS._pnl_coll_bp_wk(x, dte) if metric == "bp_wk" else float(x["pnl"])
        M[i - 1, j] = v
        B[i - 1, j] = float(bool(x.get("breach")))
    return M, B, len(pool)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "run"
    pack = FS.load_bars(None, rebuild=False)
    sig, px = all_signals(pack)
    dates, tickers = px["dates"], px["tickers"]
    reg = regimes(px)
    print(f"data: {len(tickers)} tickers, {dates[0].date()} → {dates[-1].date()}, {len(dates)} days; "
          f"bull days {int(reg['bull'].sum())}, bear days {int(reg['bear'].sum())}")
    causal_check(px)
    print("causal check: pass (AAPL/NVDA/JPM, 8 cuts)")
    if mode == "preflight":
        for k, m in sig.items():
            print(k, {r: int((m & v[:, None]).sum()) for r, v in reg.items()})
        return 0

    dec = FS.vol_decile_mat(FS.realized_vol20(px["c"]))
    res = []
    for H in (5, 10, 21):
        r = FS.fwd_returns(px["o"], px["c"], H)
        ex = r - FS.leave_one_out_decile_means(r, dec)
        for k, m in sig.items():
            sign = 1 if k in BULL else -1          # bear signal = stock should lag peers
            for rn, rv in reg.items():
                res.append({"signal": k, "outcome": f"stock_h{H}", "regime": rn, **cell(dates, ex, m, rv, sign)})
    lab = FS._import_lab()
    for lab_name, inst, delta, dte, exit_m, metric in POOLS:
        M, B, npool = pool_matrix(lab, inst, delta, dte, exit_m, metric, dates, tickers)
        exM = M - FS.leave_one_out_decile_means(M, dec)
        exB = B - FS.leave_one_out_decile_means(B, dec)
        print(f"pool {lab_name}: {npool} trades")
        for k, m in sig.items():
            for rn, rv in reg.items():
                c1 = cell(dates, exM, m, rv, 1)
                cb = cell(dates, exB, m, rv, 1)
                res.append({"signal": k, "outcome": lab_name, "regime": rn, **c1,
                            "breach_ex": cb.get("ex", np.nan)})
    OUT.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(res)
    df.to_csv(OUT / "cells.csv", index=False)
    (OUT / "meta.json").write_text(json.dumps({"dates": [str(dates[0].date()), str(dates[-1].date())],
                                               "tickers": len(tickers)}))
    pd.set_option("display.width", 220)
    show = df[["signal", "outcome", "regime", "n_indep", "ex", "t", "ex_fit", "ex_ho", "ex_delay"]].copy()
    for col in ("ex", "ex_fit", "ex_ho", "ex_delay"):
        show[col] = np.where(show.outcome.str.startswith("stock"), show[col] * 1e4, show[col])
    print(show.round(3).to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
