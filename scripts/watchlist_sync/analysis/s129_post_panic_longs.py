#!/usr/bin/env python3
"""S129 / A298 — long SPY/QQQ calls when VIX÷VIX3M falls back below 1 after ≥2 sessions ≥1.

INDEX remap: A298 asked for S125 (taken by Muravyev A276) → S129.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s129_post_panic_longs.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S129.md"
START = date(2018, 10, 1)
HALF = date(2023, 1, 1)
DTES = (7, 30, 60)
DELTAS = (0.30, 0.50)


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_call(S, K, T, r, sig):
    if T <= 0 or sig <= 0 or S <= 0 or K <= 0:
        return max(S - K, 0.0)
    v = sig * math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sig * sig) * T) / v
    d2 = d1 - v
    return S * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2)


def strike_for_delta(S, T, r, sig, delta):
    # approx: K such that call delta ≈ N(d1) = delta
    # d1 = N^{-1}(delta); K = S * exp(-(d1*sig*sqrt(T) - (r+0.5sig^2)T))
    from statistics import NormalDist
    d1 = NormalDist().inv_cdf(delta)
    return S * math.exp(-(d1 * sig * math.sqrt(T) - (r + 0.5 * sig * sig) * T))


def episodes(conn):
    vix = defaultdict(dict)
    for d, idx, c in conn.execute(
        "SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')"
    ):
        vix[idx][d] = c
    days = sorted(set(vix["VIX"]) & set(vix["VIX3M"]))
    days = [d for d in days if d >= START]
    flips, run = [], 0
    for d in days:
        r = vix["VIX"][d] / vix["VIX3M"][d]
        if r >= 1:
            run += 1
        else:
            if run >= 2:
                flips.append(d)
            run = 0
    # cluster within 10 sessions ≈ 14 calendar days
    eps, last = [], None
    for d in flips:
        if last is None or (d - last).days > 14:
            eps.append(d)
        last = d
    return eps, vix


def px_series(conn, ticker):
    rows = conn.execute(
        "SELECT date::date, close::float8, iv30_call::float8 FROM lseg_research.daily_history "
        "WHERE ticker=%s AND close>0 AND date>=%s ORDER BY date",
        (ticker, START),
    ).fetchall()
    return {d: (c, iv) for d, c, iv in rows}


def trade_call(px, d0, dte, delta, r=0.04):
    if d0 not in px:
        return None
    S, iv_raw = px[d0]
    if not iv_raw or iv_raw <= 0:
        return None
    iv = iv_raw / 100.0 if iv_raw > 3 else float(iv_raw)  # lseg stores percent
    T = dte / 365.0
    K = strike_for_delta(S, T, r, iv, delta)
    debit = bs_call(S, K, T, r, iv)
    if debit <= 0:
        return None
    # find exit date ≈ d0+dte trading approx calendar
    d1 = d0 + timedelta(days=int(dte * 1.4))
    # walk forward to first available close on/after d0+dte calendar
    target = d0 + timedelta(days=dte)
    exit_S = None
    for dd in sorted(px):
        if dd >= target:
            exit_S = px[dd][0]
            break
    if exit_S is None:
        return None
    exit_val = max(exit_S - K, 0.0)
    pnl = (exit_val - debit) / debit  # per $
    # same-risk stock: buy S*debit/S = debit dollars of stock → return (exit_S/S - 1)
    stock = exit_S / S - 1
    return {"pnl": pnl, "stock": stock, "debit": debit, "S": S, "K": K, "iv": iv}


def main() -> int:
    conn = connect()
    eps, _ = episodes(conn)
    spy, qqq = px_series(conn, "SPY"), px_series(conn, "QQQ")
    lines = [
        "# S129 — post-panic long calls (A298; remap from S125)",
        "",
        f"Episodes (VIX÷VIX3M <1 after ≥2 sessions ≥1, clustered): **{len(eps)}** "
        f"(h1<{HALF}: {sum(d<HALF for d in eps)}, h2: {sum(d>=HALF for d in eps)}).",
        "",
        "Pricing: BS at iv30_call, fill = mid (no spread haircut in round 1 — label MODEL).",
        "Pass bar needs real/haircut later; this packet = episode EV vs same-risk stock.",
        "",
        "| ticker | Δ | DTE | n | mean pnl/$ | mean stock | beat stock? | h1 pnl | h2 pnl |",
        "|---|---:|---:|---:|---:|---:|---|---:|---:|",
    ]
    cells = []
    for ticker, px in (("SPY", spy), ("QQQ", qqq)):
        for delta in DELTAS:
            for dte in DTES:
                rows = []
                for d0 in eps:
                    tr = trade_call(px, d0, dte, delta)
                    if tr:
                        tr["d"] = d0
                        rows.append(tr)
                if len(rows) < 3:
                    lines.append(f"| {ticker} | {delta:.2f} | {dte} | {len(rows)} | thin | | | | |")
                    continue
                pnls = [r["pnl"] for r in rows]
                stocks = [r["stock"] for r in rows]
                h1 = [r["pnl"] for r in rows if r["d"] < HALF]
                h2 = [r["pnl"] for r in rows if r["d"] >= HALF]
                mp, ms = float(np.mean(pnls)), float(np.mean(stocks))
                beat = mp > ms
                cells.append((ticker, delta, dte, len(rows), mp, ms, beat,
                              float(np.mean(h1)) if h1 else float("nan"),
                              float(np.mean(h2)) if h2 else float("nan")))
                lines.append(
                    f"| {ticker} | {delta:.2f} | {dte} | {len(rows)} | {mp:+.2%} | {ms:+.2%} | "
                    f"{'Y' if beat else 'N'} | "
                    f"{(float(np.mean(h1)) if h1 else float('nan')):+.2%} | "
                    f"{(float(np.mean(h2)) if h2 else float('nan')):+.2%} |"
                )

    # Pass: beat stock both halves on profit/$ — option bar vs S101 put deferred (needs put book)
    both = [c for c in cells if c[6] and c[7] > 0 and c[8] > 0 and c[3] >= 8]
    # stricter: beat stock in both halves separately
    strict = []
    for ticker, px in (("SPY", spy), ("QQQ", qqq)):
        for delta in DELTAS:
            for dte in DTES:
                rows = []
                for d0 in eps:
                    tr = trade_call(px, d0, dte, delta)
                    if tr:
                        tr["d"] = d0
                        rows.append(tr)
                for half, pred in (("h1", lambda d: d < HALF), ("h2", lambda d: d >= HALF)):
                    rs = [r for r in rows if pred(r["d"])]
                    if len(rs) < 4:
                        continue
                h1r = [r for r in rows if r["d"] < HALF]
                h2r = [r for r in rows if r["d"] >= HALF]
                if len(h1r) >= 4 and len(h2r) >= 4:
                    if (np.mean([r["pnl"] for r in h1r]) > np.mean([r["stock"] for r in h1r]) and
                        np.mean([r["pnl"] for r in h2r]) > np.mean([r["stock"] for r in h2r]) and
                        np.mean([r["pnl"] for r in h1r]) > 0 and np.mean([r["pnl"] for r in h2r]) > 0):
                        strict.append((ticker, delta, dte))

    # S101-ish sold put comparator: short 0.15Δ 30 DTE put, hold to expiry, pnl per $ credit
    def trade_short_put(px, d0, dte=30, delta=0.15, r=0.04):
        if d0 not in px:
            return None
        S, iv_raw = px[d0]
        if not iv_raw or iv_raw <= 0:
            return None
        iv = iv_raw / 100.0 if iv_raw > 3 else float(iv_raw)
        T = dte / 365.0
        # put delta ≈ -N(-d1) ≈ -(1-call_delta) for approx; use call_delta = 1-0.15 = 0.85 for put 0.15
        K = strike_for_delta(S, T, r, iv, 1.0 - delta)
        # put mid ≈ call - S + K e^{-rT} (put-call parity approx) or BS put
        from statistics import NormalDist
        v = iv * math.sqrt(T)
        d1 = (math.log(S / K) + (r + 0.5 * iv * iv) * T) / v
        d2 = d1 - v
        put = K * math.exp(-r * T) * NormalDist().cdf(-d2) - S * NormalDist().cdf(-d1)
        if put <= 0:
            return None
        target = d0 + timedelta(days=dte)
        exit_S = None
        for dd in sorted(px):
            if dd >= target:
                exit_S = px[dd][0]
                break
        if exit_S is None:
            return None
        exit_val = max(K - exit_S, 0.0)
        # seller pnl / credit
        return (put - exit_val) / put

    put_pnls = []
    for d0 in eps:
        pp = trade_short_put(spy, d0)
        if pp is not None:
            put_pnls.append((d0, pp))
    put_mean = float(np.mean([p for _, p in put_pnls])) if put_pnls else float("nan")
    put_h1 = float(np.mean([p for d, p in put_pnls if d < HALF])) if any(d < HALF for d, _ in put_pnls) else float("nan")
    put_h2 = float(np.mean([p for d, p in put_pnls if d >= HALF])) if any(d >= HALF for d, _ in put_pnls) else float("nan")

    # Full bar: best call cell beats put in both halves
    full_pass = []
    for ticker, delta, dte in strict:
        px = spy if ticker == "SPY" else qqq
        rows = []
        for d0 in eps:
            tr = trade_call(px, d0, dte, delta)
            if tr:
                tr["d"] = d0
                rows.append(tr)
        h1r = [r for r in rows if r["d"] < HALF]
        h2r = [r for r in rows if r["d"] >= HALF]
        p1 = [p for d, p in put_pnls if d < HALF]
        p2 = [p for d, p in put_pnls if d >= HALF]
        if len(h1r) >= 4 and len(h2r) >= 4 and len(p1) >= 4 and len(p2) >= 4:
            if (np.mean([r["pnl"] for r in h1r]) > np.mean(p1) and
                np.mean([r["pnl"] for r in h2r]) > np.mean(p2)):
                full_pass.append((ticker, delta, dte))

    lines += [
        "",
        f"Episodes: {', '.join(str(d) for d in eps)}",
        "",
        f"Cells beating stock with +pnl both halves: {strict or 'none'}",
        f"S101-proxy short put 0.15Δ 30 DTE mean pnl/$: {put_mean:+.2%} (h1 {put_h1:+.2%}, h2 {put_h2:+.2%}, n={len(put_pnls)})",
        f"Cells also beating short put both halves: {full_pass or 'none'}",
        "",
        f"**Verdict: {'PASS' if full_pass else 'FAIL'}** "
        f"(stock-cleared cells={len(strict)}; put-cleared={len(full_pass)}; episodes={len(eps)}; MODEL mid fill).",
        "",
        "Refs: A298",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
