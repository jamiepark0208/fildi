#!/usr/bin/env python3
"""S041 — S/R v2: do volume-profile zones hold when touched? (A159 / P22)

Zones = high volume-at-price nodes (POC + secondary peaks) from daily bars *before* the touch.
Touch = low within 0.25 ATR of zone. Hold = no close below zone − 0.5 ATR in next 5 sessions.
Arms: (1) touch-count rule, (2) logistic on pre-touch features. OpenJev P22 skipped if (2) decides.

    .venv/bin/python analysis/s041_sr_v2.py [--tickers N] [--write]
"""
from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

OUT = HERE / "out" / "opt" / "S041.md"
LOOKBACK = 60
BINS = 24
FWD = 5
ATR_N = 14


def atr(h, l, c, i, n=ATR_N):
    if i < n:
        return None
    trs = []
    for j in range(i - n + 1, i + 1):
        tr = max(h[j] - l[j], abs(h[j] - c[j - 1]), abs(l[j] - c[j - 1]))
        trs.append(tr)
    return sum(trs) / n


def volume_zones(closes, highs, lows, vols, end_i, lookback=LOOKBACK, bins=BINS):
    """Zones from bars [end_i-lookback, end_i) — no look-ahead into end_i."""
    a = max(0, end_i - lookback)
    if end_i - a < 30:
        return []
    lo = min(lows[a:end_i])
    hi = max(highs[a:end_i])
    if hi <= lo or hi - lo < 1e-9:
        return []
    edges = np.linspace(lo, hi, bins + 1)
    vac = np.zeros(bins)
    for j in range(a, end_i):
        # distribute bar volume uniformly across bins the range covers
        i0 = int(np.searchsorted(edges, lows[j], side="right") - 1)
        i1 = int(np.searchsorted(edges, highs[j], side="right") - 1)
        i0, i1 = max(0, i0), min(bins - 1, max(i0, i1))
        span = i1 - i0 + 1
        vac[i0 : i1 + 1] += vols[j] / span
    if vac.sum() <= 0:
        return []
    # peaks: local max above median
    med = float(np.median(vac[vac > 0])) if (vac > 0).any() else 0
    peaks = []
    for i in range(1, bins - 1):
        if vac[i] >= vac[i - 1] and vac[i] >= vac[i + 1] and vac[i] >= med:
            mid = 0.5 * (edges[i] + edges[i + 1])
            peaks.append((mid, float(vac[i] / vac.sum()), i))
    if not peaks:
        poc = int(np.argmax(vac))
        peaks = [(0.5 * (edges[poc] + edges[poc + 1]), float(vac[poc] / vac.sum()), poc)]
    peaks.sort(key=lambda x: -x[1])
    return peaks[:4]  # top nodes


def logistic_fit(X, y):
    """Simple L2 logistic via Newton / IRLS; returns weights, intercept."""
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    n, p = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    w = np.zeros(p + 1)
    for _ in range(40):
        z = Xb @ w
        p_hat = 1 / (1 + np.exp(-np.clip(z, -20, 20)))
        W = p_hat * (1 - p_hat) + 1e-6
        grad = Xb.T @ (y - p_hat) - 0.01 * w
        H = -(Xb.T * W) @ Xb - 0.01 * np.eye(p + 1)
        try:
            step = np.linalg.solve(H, grad)
        except np.linalg.LinAlgError:
            break
        w = w - step
        if np.max(np.abs(step)) < 1e-6:
            break
    return w


def predict_proba(w, X):
    X = np.asarray(X, dtype=float)
    Xb = np.hstack([np.ones((X.shape[0], 1)), X])
    z = Xb @ w
    return 1 / (1 + np.exp(-np.clip(z, -20, 20)))


def auc(y, s):
    y = np.asarray(y)
    s = np.asarray(s)
    pos = s[y == 1]
    neg = s[y == 0]
    if len(pos) < 5 or len(neg) < 5:
        return float("nan")
    # Mann–Whitney
    order = np.argsort(s)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(s) + 1)
    return (ranks[y == 1].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tickers", type=int, default=120)
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    conn = connect()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT ticker FROM (
                 SELECT ticker, count(*) n, sum(volume) v FROM prices_historical
                 WHERE volume > 0 GROUP BY 1 HAVING count(*) >= 200
                 ORDER BY v DESC NULLS LAST LIMIT %s
               ) t""",
            (args.tickers,),
        )
        tickers = [r[0] for r in cur.fetchall()]

    events = []  # feature rows
    for ti, ticker in enumerate(tickers):
        with conn.cursor() as cur:
            cur.execute(
                """SELECT date, open::float8, high::float8, low::float8, close::float8, coalesce(volume,0)::float8
                   FROM prices_historical WHERE ticker=%s AND close>0 ORDER BY date""",
                (ticker,),
            )
            rows = cur.fetchall()
        if len(rows) < 120:
            continue
        dates = [r[0] for r in rows]
        o = [float(r[1]) for r in rows]
        h = [float(r[2]) for r in rows]
        l = [float(r[3]) for r in rows]
        c = [float(r[4]) for r in rows]
        v = [float(r[5]) for r in rows]

        # precompute ATR
        atrs = [atr(h, l, c, i) for i in range(len(c))]

        # walk days; build zones from past; detect first touch of each zone in a window
        seen = set()  # (zone_bin, touch_i) approx
        for i in range(LOOKBACK + ATR_N, len(c) - FWD - 1):
            a = atrs[i]
            if a is None or a <= 0:
                continue
            zones = volume_zones(c, h, l, v, i)
            for z_price, z_share, z_bin in zones:
                # touch today?
                if abs(l[i] - z_price) > 0.25 * a:
                    continue
                key = (ticker, z_bin, i // 5)  # debounce
                if key in seen:
                    continue
                seen.add(key)
                # prior touches in lookback
                touches = 0
                last_touch = None
                reactions = []
                for j in range(max(0, i - LOOKBACK), i):
                    aj = atrs[j]
                    if aj and abs(l[j] - z_price) <= 0.25 * aj:
                        touches += 1
                        last_touch = j
                        # reaction: next 3d return from close
                        if j + 3 < i:
                            reactions.append((c[min(j + 3, i - 1)] / c[j] - 1))
                # hold label
                floor = z_price - 0.5 * a
                held = 1
                for k in range(1, FWD + 1):
                    if c[i + k] < floor:
                        held = 0
                        break
                recency = (i - last_touch) if last_touch is not None else LOOKBACK
                dist_atr = (c[i] - z_price) / a
                react = float(np.mean(reactions)) if reactions else 0.0
                events.append({
                    "ticker": ticker,
                    "date": dates[i],
                    "held": held,
                    "touches": touches,
                    "recency": recency,
                    "dist_atr": dist_atr,
                    "react": react,
                    "vol_share": z_share,
                })
        if (ti + 1) % 20 == 0:
            print(f"… {ti + 1}/{len(tickers)} tickers · {len(events)} events", file=sys.stderr)

    if len(events) < 200:
        print(f"too few events ({len(events)}); abort", file=sys.stderr)
        sys.exit(1)

    # time split
    events.sort(key=lambda e: e["date"])
    cut = int(0.70 * len(events))
    train, test = events[:cut], events[cut:]
    half = cut + (len(test) // 2)
    test_a, test_b = events[cut:half], events[half:]

    def pack(evs):
        X = [[e["touches"], e["recency"], e["dist_atr"], e["react"], e["vol_share"]] for e in evs]
        y = [e["held"] for e in evs]
        # standardize on train stats later
        return np.array(X, float), np.array(y, float)

    Xtr, ytr = pack(train)
    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-9
    Xtr_n = (Xtr - mu) / sd
    w = logistic_fit(Xtr_n, ytr)

    def scores(evs):
        X, y = pack(evs)
        Xn = (X - mu) / sd
        return y, predict_proba(w, Xn), X[:, 0]  # logistic, touch-count

    lines = []
    lines.append(f"# S041 — S/R v2 volume-profile zones\n")
    lines.append(f"**Date:** {date.today()} · **Refs:** A159 · **n events:** {len(events)} · **tickers:** {len(tickers)}\n")
    lines.append(f"Lookback {LOOKBACK}d · bins {BINS} · touch ≤0.25 ATR · hold 5d above zone−0.5 ATR · train 70%/test 30%\n")

    def report(name, evs):
        y, p_log, p_touch = scores(evs)
        a_log = auc(y, p_log)
        a_tch = auc(y, p_touch)
        base = float(y.mean())
        lines.append(f"- **{name}** n={len(y)} hold_rate={base:.3f} · logistic AUC {a_log:.3f} · touch-count AUC {a_tch:.3f} · Δ {a_log - a_tch:+.3f}")
        return a_log, a_tch

    a_te, t_te = report("test (full)", test)
    a_a, t_a = report("test half A", test_a)
    a_b, t_b = report("test half B", test_b)

    pass_auc = a_te >= 0.60 and (a_te - t_te) >= 0.04 and a_a >= 0.60 and a_b >= 0.60 and (a_a - t_a) >= 0.0 and (a_b - t_b) >= 0.0
    # both halves: AUC≥0.60 and beat touch-count (Δ≥0 on each half; overall Δ≥0.04)
    pass_strict = (
        a_te >= 0.60 and (a_te - t_te) >= 0.04
        and a_a >= 0.60 and a_b >= 0.60
        and (a_a - t_a) >= 0.04 and (a_b - t_b) >= 0.04
    )
    verdict = "PASS" if pass_strict else "FAIL"
    lines.append("")
    lines.append(f"**Verdict: {verdict}** — pass needs test AUC ≥ 0.60, beats touch-count by ≥ 0.04, both test halves.")
    lines.append(f"OpenJev P22 arm: **skipped** (Muse 10-18: only if logistic fails to decide; here logistic {'passed' if pass_strict else 'failed'}).")
    lines.append("")
    lines.append("Look-ahead: zones from bars strictly before touch index; ATR at touch bar.")
    text = "\n".join(lines) + "\n"
    print(text)
    if args.write:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(text)
        print(f"wrote {OUT}", file=sys.stderr)
    conn.close()
    sys.exit(0 if pass_strict else 2)


if __name__ == "__main__":
    main()
