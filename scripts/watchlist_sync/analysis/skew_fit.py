#!/usr/bin/env python3
"""A192 Phase 0 — skew model fit on optlab.skew_survey (read-only).

  .venv/bin/python analysis/skew_fit.py --smoke   # mandatory gate (≤2 min)
  .venv/bin/python analysis/skew_fit.py           # full holdout eval
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from build_plan import connect, rows  # noqa: E402

TRAIN_END = date(2026, 10, 30)
TEST_START = date(2026, 10, 31)
PASS_MAE_VOL = 2.0  # percentage points on absolute IV

SQL_ALL = """
SELECT as_of, ticker, expiry, side, strike, spot, bid, ask, iv, delta, oi
FROM optlab.skew_survey
WHERE as_of >= '2026-10-19' AND as_of <= '2026-10-31'
"""

SQL_SMOKE = """
SELECT as_of, ticker, expiry, side, strike, spot, bid, ask, iv, delta, oi
FROM optlab.skew_survey
WHERE ticker = ANY(%s) AND as_of = %s
"""


def _load(conn, smoke: bool, as_of: date | None) -> pd.DataFrame:
    if smoke:
        tickers = ["SPY", "QQQ", "AAPL"]
        if as_of is None:
            r = rows(
                conn,
                """SELECT as_of FROM optlab.skew_survey
                   WHERE ticker = ANY(%s) GROUP BY as_of
                   HAVING COUNT(DISTINCT ticker) = %s ORDER BY as_of DESC LIMIT 1""",
                (tickers, len(tickers)),
            )
            if not r:
                return pd.DataFrame()
            as_of = r[0]["as_of"]
            as_of = as_of if isinstance(as_of, date) else date.fromisoformat(str(as_of)[:10])
        print(f"smoke slice as_of={as_of} tickers={tickers}")
        raw = rows(conn, SQL_SMOKE, (tickers, as_of))
    else:
        raw = rows(conn, """
            SELECT as_of, ticker, expiry, side, strike, spot, bid, ask, iv, delta, oi
            FROM optlab.skew_survey
            WHERE as_of >= '2026-10-19' AND as_of <= '2026-11-06'
        """)
    if not raw:
        return pd.DataFrame()
    df = pd.DataFrame(raw)
    for c in ("as_of", "expiry"):
        df[c] = pd.to_datetime(df[c]).dt.date
    return df


def _clean(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    n0 = len(df)
    df = df.copy()
    df["mid"] = (df["bid"].astype(float) + df["ask"].astype(float)) / 2
    df["dte"] = df.apply(lambda r: (r["expiry"] - r["as_of"]).days, axis=1)
    m = (
        (df["bid"] > 0)
        & (df["ask"] > df["bid"])
        & (df["iv"] > 0.01)
        & (df["iv"] < 3.0)
        & (df["dte"] >= 7)
        & (df["dte"] <= 45)
        & (df["mid"] >= 0.05)
    )
    df = df[m]
    otm = (
        ((df["side"] == "put") & (df["strike"] < df["spot"]))
        | ((df["side"] == "call") & (df["strike"] > df["spot"]))
    )
    df = df[otm]
    stats = {"n_before": n0, "n_after_filters": len(df)}
    return df, stats


def _atm_iv(group: pd.DataFrame) -> float | None:
    g = group.copy()
    g["lm"] = np.log(g["strike"].astype(float) / g["spot"].astype(float))
    g = g.sort_values("lm")
    below = g[g["lm"] <= 0]
    above = g[g["lm"] >= 0]
    if below.empty or above.empty:
        return None
    lo = below.iloc[-1]
    hi = above.iloc[0]
    if lo["lm"] == hi["lm"]:
        return float(lo["iv"])
    w = -lo["lm"] / (hi["lm"] - lo["lm"])
    return float(lo["iv"] * (1 - w) + hi["iv"] * w)


def _add_atm_and_features(df: pd.DataFrame) -> pd.DataFrame:
    keys = ["as_of", "ticker", "expiry"]
    atms = []
    for k, g in df.groupby(keys, sort=False):
        a = _atm_iv(g)
        if a is None or a <= 0:
            continue
        atms.append({**dict(zip(keys, k)), "atm_iv": a})
    atm = pd.DataFrame(atms)
    if atm.empty:
        return pd.DataFrame()
    out = df.merge(atm, on=keys, how="inner")
    out["rel_skew"] = out["iv"] / out["atm_iv"] - 1.0
    out["sqrt_t"] = np.sqrt(out["dte"].astype(float) / 365.0)
    out["k"] = np.log(out["strike"].astype(float) / out["spot"].astype(float)) / (
        out["atm_iv"] * out["sqrt_t"] + 1e-9
    )
    out["abs_delta"] = out["delta"].abs()
    out["rel_spread"] = (out["ask"] - out["bid"]) / out["mid"]
    return out


def _design_quad_k(side_df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Pooled quadratic in k; coeffs = linear in atm_iv and sqrt_t (9 cols per row)."""
    ai = side_df["atm_iv"].to_numpy(float)
    st = side_df["sqrt_t"].to_numpy(float)
    kk = side_df["k"].to_numpy(float)
    x = np.column_stack(
        [
            np.ones(len(side_df)),
            ai,
            st,
            kk,
            ai * kk,
            st * kk,
            kk**2,
            ai * kk**2,
            st * kk**2,
        ]
    )
    y = side_df["rel_skew"].to_numpy(float)
    return x, y


def _ridge_solve(x: np.ndarray, y: np.ndarray, lam: float) -> np.ndarray:
    xt = x.T
    return np.linalg.solve(xt @ x + lam * np.eye(x.shape[1]), xt @ y)


def _fit_pooled(df: pd.DataFrame) -> dict:
    coef = {}
    for side in ("put", "call"):
        sub = df[df["side"] == side]
        if len(sub) < 30:
            coef[side] = None
            continue
        x, y = _design_quad_k(sub)
        coef[side] = _ridge_solve(x, y, lam=1e-4)
    return coef


def _pred_pooled(row: pd.Series, coef: dict) -> float:
    c = coef.get(row["side"])
    if c is None:
        return 0.0
    ai, st, kk = float(row["atm_iv"]), float(row["sqrt_t"]), float(row["k"])
    x = np.array([1, ai, st, kk, ai * kk, st * kk, kk**2, ai * kk**2, st * kk**2])
    rel = float(x @ c)
    return float(row["atm_iv"] * (1 + rel))


def _fit_shrink(df: pd.DataFrame, coef: dict, lam: float = 50.0) -> dict:
    """Per-ticker intercept + slope on k, ridge-shrunk toward 0."""
    ticker_adj: dict[str, tuple[float, float]] = {}
    for t, g in df.groupby("ticker"):
        if len(g) < 15:
            ticker_adj[t] = (0.0, 0.0)
            continue
        base = g.apply(lambda r: _pred_pooled(r, coef) / r["atm_iv"] - 1, axis=1)
        resid = g["rel_skew"].to_numpy(float) - base.to_numpy(float)
        kk = g["k"].to_numpy(float)
        x = np.column_stack([np.ones(len(g)), kk])
        w = len(g) / (len(g) + lam)
        beta = _ridge_solve(x, resid, lam=lam)
        ticker_adj[t] = (float(beta[0] * w), float(beta[1] * w))
    return ticker_adj


def _pred_shrink(row: pd.Series, coef: dict, adj: dict) -> float:
    base_rel = _pred_pooled(row, coef) / row["atm_iv"] - 1
    a, b = adj.get(row["ticker"], (0.0, 0.0))
    rel = base_rel + a + b * row["k"]
    return float(row["atm_iv"] * (1 + rel))


def _build_naive_lookup(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["k_bin"] = (df["k"] * 20).round() / 20
    return (
        df.groupby(["ticker", "as_of", "side", "k_bin"], as_index=False)["rel_skew"].mean()
    )


def _pred_naive(row: pd.Series, hist: pd.DataFrame, all_dates: list[date]) -> float:
    target = row["as_of"] - timedelta(days=7)
    cands = [d for d in all_dates if d <= target]
    if not cands:
        return float(row["atm_iv"])
    lag = max(cands)
    k_bin = round(float(row["k"]) * 20) / 20
    m = (
        (hist["ticker"] == row["ticker"])
        & (hist["as_of"] == lag)
        & (hist["side"] == row["side"])
        & (hist["k_bin"] == k_bin)
    )
    sub = hist[m]
    if sub.empty:
        m2 = (
            (hist["ticker"] == row["ticker"])
            & (hist["as_of"] == lag)
            & (hist["side"] == row["side"])
        )
        sub = hist[m2]
    if sub.empty:
        return float(row["atm_iv"])
    rel = float(sub["rel_skew"].median())
    return float(row["atm_iv"] * (1 + rel))


def _vol_mae(pred: np.ndarray, actual: np.ndarray) -> float:
    return float(np.mean(np.abs(pred - actual)) * 100.0)


def _delta_bucket(d: float) -> str:
    ad = abs(d)
    if 0.05 <= ad < 0.15:
        return "d05_15"
    if 0.15 <= ad < 0.30:
        return "d15_30"
    if 0.30 <= ad < 0.45:
        return "d30_45"
    return "other"


def _dte_bucket(dte: int) -> str:
    if 7 <= dte <= 14:
        return "dte7_14"
    if 15 <= dte <= 30:
        return "dte15_30"
    if 31 <= dte <= 45:
        return "dte31_45"
    return "other"


def _mae_table(test: pd.DataFrame, pred_col: str) -> dict[str, float]:
    pred = test[pred_col].to_numpy(float)
    act = test["iv"].to_numpy(float)
    out = {"overall": _vol_mae(pred, act)}
    for name, mask in [
        ("d05_15", test["abs_delta"].between(0.05, 0.15, inclusive="left")),
        ("d15_30", test["abs_delta"].between(0.15, 0.30, inclusive="left")),
        ("d30_45", test["abs_delta"].between(0.30, 0.45, inclusive="left")),
    ]:
        if mask.sum() == 0:
            out[name] = float("nan")
        else:
            out[name] = _vol_mae(pred[mask.to_numpy()], act[mask.to_numpy()])
    return out


def _spread_table(df: pd.DataFrame) -> pd.DataFrame:
    rows_out = []
    for db in ("d05_15", "d15_30", "d30_45"):
        for tb in ("dte7_14", "dte15_30", "dte31_45"):
            m = (df["delta_bucket"] == db) & (df["dte_bucket"] == tb)
            if m.sum() == 0:
                med = float("nan")
            else:
                med = float(df.loc[m, "rel_spread"].median())
            rows_out.append({"delta_bucket": db, "dte_bucket": tb, "median_rel_spread": med})
    return pd.DataFrame(rows_out)


def run_smoke(df: pd.DataFrame, stats: dict) -> bool:
    ok = True
    spy = df[df["ticker"] == "SPY"]
    if spy.empty:
        print("SANITY FAIL: no SPY rows after clean+ATM")
        return False
    atm_by_exp = (
        spy.groupby("expiry", as_index=False)["atm_iv"].first().sort_values("expiry")
    )
    print("SANITY SPY ATM IV by expiry (decimal):")
    prev = None
    for _, r in atm_by_exp.iterrows():
        ivp = r["atm_iv"] * 100
        print(f"  {r['expiry']}: {ivp:.1f}%")
        if not (0.10 <= r["atm_iv"] <= 0.30):
            print(f"SANITY FAIL: ATM {ivp:.1f}% outside 10–30%")
            ok = False
        if prev is not None and abs(r["atm_iv"] - prev) > 0.05:
            print(f"SANITY FAIL: ATM jump {abs(r['atm_iv']-prev)*100:.1f} vol pts between expiries")
            ok = False
        prev = r["atm_iv"]

    puts = spy[spy["side"] == "put"].copy()
    puts["dd"] = (puts["abs_delta"] - 0.15).abs()
    if puts.empty:
        print("SANITY FAIL: no SPY puts")
        ok = False
    else:
        row = puts.loc[puts["dd"].idxmin()]
        atm = float(row["atm_iv"])
        piv = float(row["iv"])
        print(f"SANITY put skew: 0.15Δ-ish put IV={piv*100:.2f}% ATM={atm*100:.2f}% delta={row['delta']:.3f}")
        if piv <= atm:
            print("SANITY FAIL: put wing IV not > ATM")
            ok = False

    kept = stats.get("n_after_atm", len(df))
    before = stats["n_before"]
    pct = 100.0 * kept / before if before else 0
    print(f"SANITY rows: {before} → {stats['n_after_filters']} filtered → {kept} with ATM ({pct:.1f}% of raw)")
    if pct < 30:
        print("SANITY FAIL: <30% rows kept after clean+ATM")
        ok = False

    if not spy.empty:
        sample = spy.iloc[0]
        print(
            f"SANITY hand-check: {sample['ticker']} {sample['expiry']} {sample['side']} "
            f"K={sample['strike']} S={sample['spot']:.2f} raw_iv={sample['iv']*100:.2f}% "
            f"atm={sample['atm_iv']*100:.2f}% bid={sample['bid']:.2f} ask={sample['ask']:.2f}"
        )
    print(f"SANITY smoke {'PASS' if ok else 'FAIL'}")
    return ok


def run_full(df: pd.DataFrame) -> None:
    train = df[df["as_of"] <= TRAIN_END].copy()
    test = df[df["as_of"] >= TEST_START].copy()
    print(f"train rows={len(train)} test rows={len(test)}")
    if test.empty or train.empty:
        print("FAIL: empty train or test")
        return

    coef = _fit_pooled(train)
    adj = _fit_shrink(train, coef)
    hist = _build_naive_lookup(pd.concat([train, test]))
    all_dates = sorted(df["as_of"].unique())

    for name, fn in [
        ("naive_7d", lambda r: _pred_naive(r, hist, all_dates)),
        ("pooled_quad", lambda r: _pred_pooled(r, coef)),
        ("pooled+shrink", lambda r: _pred_shrink(r, coef, adj)),
    ]:
        test[f"pred_{name}"] = test.apply(fn, axis=1)

    print("\n=== MAE vol pts (holdout) — rows=models, cols=delta buckets ===")
    hdr = "model\td05_15\td15_30\td30_45\toverall"
    print(hdr)
    for name in ("naive_7d", "pooled_quad", "pooled+shrink"):
        m = _mae_table(test, f"pred_{name}")
        print(f"{name}\t{m['d05_15']:.2f}\t{m['d15_30']:.2f}\t{m['d30_45']:.2f}\t{m['overall']:.2f}")

    best = _mae_table(test, "pred_pooled+shrink")
    fail = [k for k, v in best.items() if np.isfinite(v) and v > PASS_MAE_VOL]
    print(f"\nPASS bar {PASS_MAE_VOL} vol pts — best model pooled+shrink fails buckets: {fail or 'none'}")

    for seg, mask in [
        ("liquid_oi500", test["oi"] >= 500),
        ("illiquid", test["oi"] < 500),
        ("SPY", test["ticker"] == "SPY"),
        ("QQQ", test["ticker"] == "QQQ"),
    ]:
        sub = test[mask]
        if len(sub) < 5:
            continue
        m = _vol_mae(sub["pred_pooled+shrink"].to_numpy(), sub["iv"].to_numpy())
        print(f"  {seg} n={len(sub)} MAE={m:.2f}")

    test["delta_bucket"] = test["delta"].apply(_delta_bucket)
    test["dte_bucket"] = test["dte"].apply(_dte_bucket)
    spread = _spread_table(test)
    print("\n=== median rel spread (ask-bid)/mid by delta×DTE ===")
    print(spread.to_string(index=False))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--as-of", type=str, default=None)
    args = ap.parse_args()
    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    t0 = time.perf_counter()

    with connect() as conn:
        raw = _load(conn, args.smoke, as_of)

    if raw.empty:
        print("no data")
        return 1

    cleaned, stats = _clean(raw)
    df = _add_atm_and_features(cleaned)
    stats["n_after_atm"] = len(df)
    print(f"loaded {len(raw)} rows · cleaned {stats['n_after_filters']} · atm groups {len(df)}")

    if args.smoke:
        if not run_smoke(df, stats):
            return 2
        elapsed = time.perf_counter() - t0
        print(f"smoke elapsed {elapsed:.1f}s")
        return 0

    run_full(df)
    print(f"full elapsed {time.perf_counter() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
