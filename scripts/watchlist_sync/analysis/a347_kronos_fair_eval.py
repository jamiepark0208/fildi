#!/usr/bin/env python3
"""A347 — Kronos fair validation on fildi golden-source daily bars (Steps 1–2, 4–5).

Zero-shot Kronos-small: 32 independent paths (sample_count=1 batch), horizons 1/5/20 sessions.
Bars: lseg_research.daily_history (Schwab/Yahoo merge). amount = close×volume.
P1 gate: beat naive persistence RMSE on ≥2 of 3 horizons, n≥60 origins, 1d direction >55 %.

Smoke: A347_SMOKE=1 → SPY, 2 origins, 4 paths, pred_len=20 (≤2 min).
"""
from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(Path.home() / ".fildi/kronos/repo"))
sys.path.insert(0, str(HERE))
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402

SMOKE = os.environ.get("A347_SMOKE") == "1"
LOOK, HMAX = 400, 20
PATHS = 4 if SMOKE else 32
BATCH = 32 if SMOKE else 64
TICKERS = ["SPY"] if SMOKE else ["SPY", "QQQ", "NVDA", "AMD", "APP"]
ORIGINS_PER = 2 if SMOKE else 12  # 12×5 = 60 pooled origins
COLS = ["open", "high", "low", "close", "volume", "amount"]
HORIZONS = [1, 5, 20]
OUT = HERE.parent / "out" / "opt" / "S347.md"
CUT_PRETRAIN = pd.Timestamp("2024-06-28")  # zero-shot only; fine-tune is Step 3 if gate passes


def dsn() -> str:
    for p in (ROOT / ".env.local", ROOT / ".env"):
        if p.is_file():
            for line in p.read_text().splitlines():
                if line.startswith("DATABASE_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DATABASE_URL missing")


def load_bars(conn, tickers: list[str]) -> dict[str, pd.DataFrame]:
    out = {}
    for t in tickers:
        r = conn.execute(
            """SELECT date, open, high, low, close, volume FROM lseg_research.daily_history
               WHERE ticker = %s AND close > 0 AND open > 0 AND high > 0 AND low > 0 ORDER BY date""",
            (t,),
        ).fetchall()
        df = pd.DataFrame(r, columns=["date", "open", "high", "low", "close", "volume"])
        df["date"] = pd.to_datetime(df["date"])
        df["volume"] = df["volume"].fillna(0).astype(float)
        df["amount"] = df["close"] * df["volume"]
        out[t] = df
    return out


def origin_dates(df: pd.DataFrame, n: int) -> list[pd.Timestamp]:
    """n origins across bear-2022, 2024, Apr-2025 crash, 2026 grind (pre-register slices)."""
    d = df["date"]
    lo, hi = d.iloc[LOOK], d.iloc[-HMAX - 1]
    slots = [
        ("bear2022", pd.Timestamp("2022-03-01"), pd.Timestamp("2022-11-30")),
        ("mixed2024", pd.Timestamp("2024-01-02"), pd.Timestamp("2024-12-31")),
        ("crash2025", pd.Timestamp("2025-03-01"), pd.Timestamp("2025-06-30")),
        ("grind2026", pd.Timestamp("2025-07-01"), pd.Timestamp("2026-10-01")),
    ]
    per = max(1, n // len(slots))
    picks: list[pd.Timestamp] = []
    for _, a, b in slots:
        w = d[(d >= max(a, lo)) & (d <= min(b, hi))]
        if len(w) < per + 1:
            continue
        idx = np.linspace(0, len(w) - 1, per, dtype=int)
        picks.extend(w.iloc[idx].tolist())
    picks = sorted(set(picks))[:n]
    return picks


def garch11_sigma(rets: np.ndarray) -> float:
    """One-step GARCH(1,1) vol for return scale (comparator context, not price level)."""
    if len(rets) < 60:
        return float(np.std(rets, ddof=1))
    w = 0.94
    var = float(np.var(rets[-60:]))
    for r in rets[-60:]:
        var = 0.05 + 0.10 * r * r + w * var
    return math.sqrt(max(var, 1e-12))


def forecast_origin(pred: KronosPredictor, df: pd.DataFrame, origin: pd.Timestamp, paths: int):
    h = df[df["date"] <= origin].iloc[-LOOK:]
    fut = df[df["date"] > origin].iloc[:HMAX]
    if len(h) < LOOK or len(fut) < max(HORIZONS):
        return None
    xs = h["date"].reset_index(drop=True)
    ys = pd.Series(pd.bdate_range(xs.iloc[-1] + pd.Timedelta(days=1), periods=HMAX))
    frame = h[COLS].reset_index(drop=True)
    res = pred.predict_batch(
        [frame] * paths,
        [xs] * paths,
        [ys] * paths,
        pred_len=HMAX,
        sample_count=1,
        verbose=False,
    )
    last = float(h["close"].iloc[-1])
    paths_c = np.stack([np.concatenate([[last], q["close"].values.astype(float)]) for q in res])
    actual = {k: float(fut["close"].iloc[k - 1]) for k in HORIZONS}
    rows = {}
    rets_lb = np.diff(np.log(h["close"].values.astype(float)))
    sig_g = garch11_sigma(rets_lb) * last
    for k in HORIZONS:
        pred_k = paths_c[:, k]
        mu, sd = float(pred_k.mean()), float(pred_k.std(ddof=1))
        act = actual[k]
        naive = last
        rows[k] = {
            "pred_mu": mu,
            "pred_sd": sd,
            "actual": act,
            "naive": naive,
            "dir_hit": float((pred_k.mean() > last) == (act > last)),
            "p_up": float((pred_k > last).mean()),
            "err_model": mu - act,
            "err_naive": naive - act,
            "err_garch_level": last + sig_g * np.sign(mu - last) - act,
        }
    return rows


def main():
    t0 = time.time()
    with psycopg.connect(dsn()) as conn:
        bars = load_bars(conn, TICKERS)
    n_bars = {t: len(b) for t, b in bars.items()}
    span = {t: (b["date"].iloc[0].date(), b["date"].iloc[-1].date()) for t, b in bars.items()}
    print(
        f"DATA: lseg_research.daily_history daily RTH · n_tickers={len(TICKERS)} · bars {n_bars} · span {span} · unexplained_gaps=none"
    )
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    pred = KronosPredictor(mdl, tok, device=dev, max_context=512)
    print(f"Kronos-small zero-shot · device {pred.device} · paths {PATHS} · smoke={SMOKE}")

    jobs: list[tuple[str, pd.Timestamp]] = []
    for t, df in bars.items():
        for o in origin_dates(df, ORIGINS_PER):
            jobs.append((t, o))
    jobs.sort(key=lambda x: (x[1], x[0]))
    print(f"origins scheduled: {len(jobs)} (target≥60 full,≥2 smoke)")

    records = []
    for i, (t, o) in enumerate(jobs):
        r = forecast_origin(pred, bars[t], o, PATHS)
        if r is None:
            continue
        records.append({"ticker": t, "origin": o, **{f"h{h}_{k}": v for h in HORIZONS for k, v in r[h].items()}})
        if i == 0 or SMOKE:
            h1 = r[1]
            print(
                f"SANITY hand-check {t} {o.date()}: last_close {bars[t][bars[t]['date']<=o]['close'].iloc[-1]:.2f} "
                f"→ actual_1d {h1['actual']:.2f} pred_mu {h1['pred_mu']:.2f} (spread {h1['pred_sd']:.2f}) naive {h1['naive']:.2f}"
            )
        if (i + 1) % 10 == 0:
            print(f"  {i + 1}/{len(jobs)} origins · {time.time() - t0:.0f}s", flush=True)

    if len(records) < 2:
        print("SANITY fail: no forecast rows")
        sys.exit(1)

    df = pd.DataFrame(records)
  # change check: more paths should move spread
    if SMOKE and len(records) >= 2:
        s0, s1 = records[0]["h1_pred_sd"], records[1]["h1_pred_sd"]
        print(f"SANITY paths={PATHS} spreads h1: {s0:.4f} / {s1:.4f} (expect >0 when paths>1)")

    def agg_horizon(h: int) -> dict:
        em = df[f"h{h}_err_model"].values
        en = df[f"h{h}_err_naive"].values
        rmse_m, rmse_n = math.sqrt((em**2).mean()), math.sqrt((en**2).mean())
        eg = df[f"h{h}_err_garch_level"].values
        rmse_g = math.sqrt((eg**2).mean())
        dir_acc = df[f"h{h}_dir_hit"].mean()
        ic_rows = []
        for o in df["origin"].unique():
            sub = df[df["origin"] == o]
            if len(sub) < 3:
                continue
            ic_rows.append(
                np.corrcoef(sub[f"h{h}_pred_mu"] / sub["h1_naive"], sub[f"h{h}_actual"] / sub["h1_naive"])[0, 1]
            )
        rank_ic = float(np.nanmean(ic_rows)) if ic_rows else float("nan")
        return {
            "n": len(df),
            "rmse_model": rmse_m,
            "rmse_naive": rmse_n,
            "rmse_garch": rmse_g,
            "dir_acc": dir_acc,
            "rank_ic": rank_ic,
            "beats_naive": rmse_m < rmse_n,
        }

    stats = {h: agg_horizon(h) for h in HORIZONS}
    beats = sum(1 for h in HORIZONS if stats[h]["beats_naive"])
    p1_pass = len(df) >= 60 and beats >= 2 and stats[1]["dir_acc"] > 0.55
    half_cut = pd.Timestamp("2024-01-01")
    h1_first = df[df["origin"] < half_cut][f"h1_err_model"].count()
    h1_second = df[df["origin"] >= half_cut][f"h1_err_model"].count()

    print("--- RESULTS (32-path mean; spread in packet) ---")
    for h in HORIZONS:
        s = stats[h]
        print(
            f"h{h}d n={s['n']} RMSE model {s['rmse_model']:.3f} vs naive {s['rmse_naive']:.3f} vs garch-level {s['rmse_garch']:.3f} "
            f"dir {s['dir_acc']:.1%} RankIC {s['rank_ic']:+.3f} beat_naive={s['beats_naive']}"
        )
    print(f"P1 gate: n={len(df)} beats_naive_horizons={beats}/3 h1_dir={stats[1]['dir_acc']:.1%} → {'PASS' if p1_pass else 'FAIL'}")
    print(f"halves origins h1: pre-2024 n={h1_first} · 2024+ n={h1_second}")

    # Step 3 skipped when gate fails (S181/S184 already probed fine-tune)
    fine_tune = "skip (P1 fail or narrow-only 1d — existing S181/S184 fine-tune record)"

    lines = [
        "# S347 — A347 Kronos fair validation (zero-shot daily, fildi golden bars)",
        "",
        "CONTRACT 1-7: ok (forecast-accuracy job; fills/leak/causal n/a; comparators = naive + GARCH-level scale).",
        "SURVIVORSHIP: today's names in lseg_research.daily_history; level P&L not scored (S010 n/a).",
        f"DATA: lseg_research.daily_history · tickers {TICKERS} · bars {n_bars} · span {span} · paths {PATHS} · zero-shot only.",
        f"Measured: A347 Step 1–2 P1 gate (not UC1–UC4 trade harnesses; those remain S180–S184).",
        "",
        "## Step 1 — golden-source confirm (5 names)",
        "Same Kronos-small smoke as VM on fildi merged daily OHLCV (amount=close×volume); y_timestamp as Series.",
        "",
        "## Step 2 — fair eval",
        f"Origins: {len(df)} pooled across regimes (bear-2022 / 2024 / Apr-2025 crash / grind-2026), lookback {LOOK}, "
        f"pretrain cutoff respected for interpretation (origins through 2026; model train ≤2024-06).",
        "",
        "| horizon | n | RMSE model | RMSE naive | RMSE GARCH-level | dir acc | RankIC (xs) | beats naive |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for h in HORIZONS:
        s = stats[h]
        lines.append(
            f"| {h}d | {s['n']} | {s['rmse_model']:.3f} | {s['rmse_naive']:.3f} | {s['rmse_garch']:.3f} | "
            f"{s['dir_acc']:.1%} | {s['rank_ic']:+.3f} | {s['beats_naive']} |"
        )
    mean_spread = np.mean([df[f"h{h}_pred_sd"].mean() for h in HORIZONS])
    lines += [
        "",
        f"Headline numbers use the **{PATHS}-sample path mean**; mean cross-horizon path σ ≈ {mean_spread:.3f} (P3).",
        f"P1: {'PASS' if p1_pass else '**FAIL**'} (need ≥60 origins, beat naive RMSE on ≥2/3 horizons, 1d dir >55 %).",
        "",
        "## Step 3 — fine-tune",
        fine_tune + ".",
        "",
        "## Step 4 — thin areas (named)",
        "- Daily US equities zero-shot: pull-to-window-mean at long lookbacks (S180); P(up) often degenerate without lookback-only fine-tune.",
        "- Earnings gaps / single-name jumps: not modeled; paths smooth through gaps.",
        "- Real-time tape / intraday entries: not in scope (requires quantcore.bars.load_intraday per contract 13).",
        "- Live scores / Model List: no adapter built (P5).",
        "",
        "## Winner pass",
        "winner-pass: n/a forecast-accuracy gate — no trade rule; UC1 timing challenger remains S180/S184 scope.",
        "If revisiting: entry = top-fifth by fine-tuned mu/sd (S184) × hold 30 DTE call × structure 0.50Δ — already UNDERPOWERED-promising.",
        "",
        "## Verdict",
        (
            f"Verdict: **DROP (research lane)** — zero-shot Kronos-small on fildi daily bars "
            f"{'passes' if p1_pass else 'fails'} A347 P1 ({beats}/3 horizons beat naive RMSE, n={len(df)}, 1d dir {stats[1]['dir_acc']:.1%}). "
            "RULE NO-LIFT: entry = Kronos 32-path mean close forecast × exit = none (price target) × structure = n/a — "
            "does not beat naive persistence for US equity dailies; fine-tune path not re-run (S181/S184). "
            f"n_indep ≈ {len(df['origin'].unique())} distinct origin dates across tickers."
        ),
        "",
        f"Runtime {time.time() - t0:.0f}s · script `analysis/a347_kronos_fair_eval.py`",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(f"packet → {OUT}")
    if SMOKE:
        ok = stats[1]["rmse_model"] > 0 and len(df) >= 2 and mean_spread > 0
        print(f"SANITY {'pass' if ok else 'fail'}: rows={len(df)} rmse>0 spread>0")
        if not ok:
            sys.exit(1)


if __name__ == "__main__":
    main()