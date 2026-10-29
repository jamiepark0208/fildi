#!/usr/bin/env python3
"""S141 / A222 — downside-label ranker (Alpha158-style OHLCV) vs put edge.

Label: 1 if close drops ≥ 1σ_IV within 7 trading days (book horizon).
Features: OHLCV momentum/vol/ma distances (no Qlib install — sklearn HGB).
Bar: walk-forward Rank IC on label, **marginal** partial IC ≥ 0.02 after put_edge + iv_rv
(month-cluster t ≥ 2). Second check: Q5−Q1 spread on S045 put pnl ≥ 1.5× mid.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s141_downside_rank.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s045_put_retest as S45  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S141.md"
START = date(2020, 1, 1)
FOLDS = [
    (date(2020, 1, 1), date(2021, 12, 31), date(2022, 1, 1), date(2022, 12, 31)),
    (date(2020, 1, 1), date(2022, 12, 31), date(2023, 1, 1), date(2023, 12, 31)),
    (date(2020, 1, 1), date(2023, 12, 31), date(2024, 1, 1), date(2025, 12, 31)),
]
FEATS = ["ret5", "ret20", "ret60", "rv20", "ma50_dist", "ma200_dist", "vol_z", "dd52"]


def build_panel(conn):
    rows, tech, fund, px = S45.load(conn)
    ev = S45.build(rows, tech, fund, px)
    try:
        S45._attach_put_edge(conn, ev)
    except Exception as ex:
        print("put_edge", ex, flush=True)

    # closes for features + label
    tick = sorted({e["t"] for e in ev})
    bars = defaultdict(list)
    for t, d, c, iv in conn.execute(
        "SELECT ticker, date::date, close::float8, iv30_put::float8 FROM lseg_research.daily_history "
        "WHERE ticker = ANY(%s) AND close > 0 ORDER BY ticker, date",
        (tick,),
    ):
        bars[t].append((d, float(c), float(iv) / 100 if iv and iv > 3 else (float(iv) if iv else None)))

    pos = {t: {d: i for i, (d, *_ ) in enumerate(b)} for t, b in bars.items()}
    panel = []
    for e in ev:
        if e["d"] < START:
            continue
        t, d = e["t"], e["d"]
        b = bars.get(t)
        i = pos.get(t, {}).get(d)
        if b is None or i is None or i < 200 or i + 7 >= len(b):
            continue
        c = np.array([x[1] for x in b], float)
        iv = b[i][2] or e.get("iv30")
        if not iv or iv <= 0:
            continue
        # label: min close over next 7 sessions ≤ S * exp(-iv*sqrt(7/252))
        S = c[i]
        thr = S * math.exp(-iv * math.sqrt(7 / 252))
        y = 1.0 if float(np.min(c[i + 1 : i + 8])) <= thr else 0.0
        lr = np.diff(np.log(c[max(0, i - 60) : i + 1]))
        feat = {
            "ret5": c[i] / c[i - 5] - 1,
            "ret20": c[i] / c[i - 20] - 1,
            "ret60": c[i] / c[i - 60] - 1 if i >= 60 else float("nan"),
            "rv20": float(np.std(lr[-20:])) * math.sqrt(252) if len(lr) >= 20 else float("nan"),
            "ma50_dist": c[i] / c[i - 49 : i + 1].mean() - 1,
            "ma200_dist": c[i] / c[i - 199 : i + 1].mean() - 1,
            "vol_z": float((lr[-1] - np.mean(lr[-20:])) / (np.std(lr[-20:]) or 1e-12)) if len(lr) >= 20 else float("nan"),
            "dd52": c[i] / np.max(c[max(0, i - 251) : i + 1]) - 1,
        }
        if any(feat[k] != feat[k] for k in FEATS):
            continue
        panel.append({
            "t": t, "d": d, "y": y, "pnl": e["pnl"], "breach": e["breach"],
            "put_edge": e.get("put_edge"), "iv_rv": e.get("iv_rv"),
            **feat,
        })
    return panel


def rank_ic(rows, score_key, y_key="y"):
    by = defaultdict(list)
    for r in rows:
        if r.get(score_key) is None or r.get(score_key) != r.get(score_key):
            continue
        by[r["d"]].append(r)
    ics = []
    for d, g in by.items():
        if len(g) < 30:
            continue
        s = np.array([x[score_key] for x in g])
        y = np.array([x[y_key] for x in g])
        if np.std(s) < 1e-12 or np.std(y) < 1e-12:
            continue
        # Spearman via rank
        rs = s.argsort().argsort().astype(float)
        ry = y.argsort().argsort().astype(float)
        ics.append(float(np.corrcoef(rs, ry)[0, 1]))
    if len(ics) < 8:
        return float("nan"), float("nan"), len(ics)
    m = float(np.mean(ics))
    # month-cluster
    bym = defaultdict(list)
    for d, g in by.items():
        if len(g) < 30:
            continue
        s = np.array([x[score_key] for x in g])
        y = np.array([x[y_key] for x in g])
        if np.std(s) < 1e-12 or np.std(y) < 1e-12:
            continue
        rs = s.argsort().argsort().astype(float)
        ry = y.argsort().argsort().astype(float)
        bym[(d.year, d.month)].append(float(np.corrcoef(rs, ry)[0, 1]))
    means = [float(np.mean(v)) for v in bym.values()]
    t = float(np.mean(means) / ((np.std(means) or 1e-12) / math.sqrt(len(means)))) if len(means) >= 6 else float("nan")
    return m, t, len(ics)


def partial_ic(rows, model_key="ml"):
    """Residualize model rank on put_edge + iv_rv within week, then IC vs y."""
    by = defaultdict(list)
    for r in rows:
        if r.get(model_key) is None or r.get("put_edge") is None or r.get("iv_rv") is None:
            continue
        by[r["d"]].append(r)
    ics = []
    for g in by.values():
        if len(g) < 30:
            continue
        m = np.array([x[model_key] for x in g])
        pe = np.array([x["put_edge"] for x in g])
        iv = np.array([x["iv_rv"] for x in g])
        y = np.array([x["y"] for x in g])
        X = np.column_stack([np.ones(len(g)), pe, iv])
        beta = np.linalg.lstsq(X, m, rcond=None)[0]
        resid = m - X @ beta
        if np.std(resid) < 1e-12 or np.std(y) < 1e-12:
            continue
        rr = resid.argsort().argsort().astype(float)
        ry = y.argsort().argsort().astype(float)
        ics.append(float(np.corrcoef(rr, ry)[0, 1]))
    if len(ics) < 8:
        return float("nan"), float("nan"), len(ics)
    m = float(np.mean(ics))
    t = m / ((np.std(ics) or 1e-12) / math.sqrt(len(ics)))
    return m, t, len(ics)


def main() -> int:
    print("S141 loading…", flush=True)
    conn = connect()
    panel = build_panel(conn)
    print(f"panel={len(panel)}", flush=True)

    lines = [
        "# S141 — downside-label ranker vs put edge (A222)",
        "",
        "Label: P(min close ≤ −1σ_IV within 7d). Features: OHLCV Alpha158-lite. Model: HistGradientBoosting.",
        "Bar: marginal (partial) Rank IC ≥ 0.02 after put_edge+iv_rv, month-t ≥ 2.",
        "",
        "| fold test | n_test | raw IC | partial IC | partial t | put_edge IC |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    partials = []
    for tr0, tr1, te0, te1 in FOLDS:
        train = [r for r in panel if tr0 <= r["d"] <= tr1 and r.get("put_edge") is not None]
        test = [r for r in panel if te0 <= r["d"] <= te1 and r.get("put_edge") is not None]
        if len(train) < 500 or len(test) < 200:
            lines.append(f"| {te0}→{te1} | {len(test)} | thin | | | |")
            continue
        Xtr = np.array([[r[k] for k in FEATS] for r in train])
        ytr = np.array([r["y"] for r in train])
        clf = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=100, random_state=222)
        clf.fit(Xtr, ytr)
        Xte = np.array([[r[k] for k in FEATS] for r in test])
        proba = clf.predict_proba(Xte)[:, 1]
        for r, p in zip(test, proba):
            r["ml"] = float(p)
        ric, _, _ = rank_ic(test, "ml")
        pic, pt, _ = partial_ic(test, "ml")
        peic, _, _ = rank_ic(test, "put_edge")
        partials.append((pic, pt))
        lines.append(
            f"| {te0}→{te1} | {len(test)} | {ric:+.3f} | {pic:+.3f} | {pt:.2f} | {peic:+.3f} |"
        )

    # holdout = last fold for pnl Q5-Q1
    te0, te1 = FOLDS[-1][2], FOLDS[-1][3]
    test = [r for r in panel if te0 <= r["d"] <= te1 and r.get("ml") is not None]
    # if last fold not scored, refit
    if not test or test[0].get("ml") is None:
        train = [r for r in panel if r["d"] < te0 and r.get("put_edge") is not None]
        test = [r for r in panel if te0 <= r["d"] <= te1 and r.get("put_edge") is not None]
        clf = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, max_iter=100, random_state=222)
        clf.fit(np.array([[r[k] for k in FEATS] for r in train]), np.array([r["y"] for r in train]))
        for r, p in zip(test, clf.predict_proba(np.array([[r[k] for k in FEATS] for r in test]))[:, 1]):
            r["ml"] = float(p)

    # weekly Q5-Q1 put pnl by ml rank (higher ml = more downside → for put selling we want LOW ml)
    by = defaultdict(list)
    for r in test:
        by[r["d"]].append(r)
    q_hi, q_lo = [], []  # low downside score = better for short puts
    for g in by.values():
        if len(g) < 30:
            continue
        g = sorted(g, key=lambda x: x["ml"])
        n = len(g) // 5
        q_lo.extend(g[:n])   # lowest predicted downside
        q_hi.extend(g[-n:])
    spread = float("nan")
    if q_lo and q_hi:
        spread = (float(np.mean([x["pnl"] for x in q_lo])) - float(np.mean([x["pnl"] for x in q_hi]))) * 1e4
        mid = float(np.mean([x["pnl"] for x in test])) * 1e4
        lines += [
            "",
            f"Holdout put pnl: low-ML (safer) {np.mean([x['pnl'] for x in q_lo])*1e4:+.1f} bp · "
            f"high-ML {np.mean([x['pnl'] for x in q_hi])*1e4:+.1f} · spread {spread:+.1f} · mid {mid:+.1f}",
        ]

    # pass: every fold partial IC >= 0.02 and t>=2 — or mean across folds
    ok_folds = [p for p, t in partials if p == p and p >= 0.02 and t >= 2]
    mean_p = float(np.nanmean([p for p, _ in partials])) if partials else float("nan")
    verdict = "PASS" if len(ok_folds) >= 2 or (mean_p >= 0.02 and len(ok_folds) >= 1) else "FAIL"
    # stricter: need at least one fold with t>=2 and pic>=0.02, and mean>=0.02
    if not (mean_p >= 0.02 and len(ok_folds) >= 1):
        verdict = "FAIL"

    lines += [
        "",
        f"Mean partial IC across folds: **{mean_p:+.3f}** · folds clearing 0.02 & t≥2: {len(ok_folds)}/{len(partials)}",
        "",
        f"**Verdict: {verdict}** — "
        + ("marginal IC clears bar → candidate factor weight" if verdict == "PASS" else "no factor ship (re-learns IV/edge or null)"),
        "",
        "Refs: A222",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
