#!/usr/bin/env python3
"""S039 L1 — can we 'train' OpenJev with our own labels? (Jamie 10-17)

OpenJev's weights stay frozen; we train a small head on top of its typed answers (+ cheap non-LLM features) using the
S037 graded headlines. Time split: train on headlines graded before 2026-09-01, test on later ones (no peeking).
Targets: (1) big move |z| > 2 on a pre-open ticker-day (materiality), (2) abnormal return > 0 (direction).
Compares: single raw OpenJev answer · calibrated (Platt) · trained head on OpenJev answers · non-LLM baseline · both.
"""
from __future__ import annotations

import collections
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import openjev_news as N  # noqa: E402

SPLIT = "2026-09-01"


def logreg(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 3000, lr: float = 0.1) -> np.ndarray:
    X1 = np.c_[np.ones(len(X)), X]
    w = np.zeros(X1.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X1 @ w))
        g = X1.T @ (p - y) / len(y) + l2 * np.r_[0, w[1:]] / len(y)
        w -= lr * g
    return w


def predict(w: np.ndarray, X: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.c_[np.ones(len(X)), X] @ w))


def auc(s, y) -> float:
    return N.auc(list(map(float, s)), list(map(bool, y)))


def brier(p, y) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def main() -> None:
    rows = []
    for r in map(json.loads, (N.DATA / "answers_v0.jsonl").open()):
        f = N.feats(r)
        if f and r["pre"]:
            rows.append({**r, **f, "z": r["abn"] / r["sd"], "kw": N.kw_dir(r["headline"])})
    meta = json.loads((N.DATA / "tickers.json").read_text())
    cats = list(N.CATS)
    # ---- ticker-day table (materiality) ----
    agg = collections.defaultdict(list)
    for r in rows:
        agg[(r["t"], r["day"])].append(r)
    td = []
    for (t, d), v in agg.items():
        rel = [x for x in v if x["rel"] > .5] or v
        cat_share = [sum(x["cat"] == c for x in rel) / len(rel) for c in cats]
        td.append({"day": d, "big": abs(v[0]["z"]) > 2, "up": v[0]["abn"] > 0,
                   "oj": [max(x["mat"] for x in rel), statistics_mean([x["rel"] for x in v]), statistics_mean([x["dir"] for x in rel]),
                          max(x["bad"] for x in rel), max(x["good"] for x in rel)] + cat_share,
                   "base": [math.log1p(len(v)), float(meta[t]["tier"]), abs(statistics_mean([x["kw"] for x in v])),
                            float(any(k in x["headline"].lower() for x in v for k in ("earnings", "results", "guidance", "quarter")))],
                   "kw": statistics_mean([x["kw"] for x in v])})
    tr = [x for x in td if x["day"] < SPLIT]
    te = [x for x in td if x["day"] >= SPLIT]
    print(f"S039 L1: {len(td)} pre-open ticker-days ({len(tr)} train Jul–Aug, {len(te)} test Sep–Oct); big-move base rate test {np.mean([x['big'] for x in te]):.3f}")

    def fit_eval(key_fn, target):
        Xtr = np.array([key_fn(x) for x in tr], float)
        Xte = np.array([key_fn(x) for x in te], float)
        mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-9
        w = logreg((Xtr - mu) / sd, np.array([x[target] for x in tr], float))
        p = predict(w, (Xte - mu) / sd)
        y = np.array([x[target] for x in te], float)
        return auc(p, y), brier(p, y), p

    print("\n## Materiality (|z| > 2): test-period AUC / Brier")
    y = np.array([x["big"] for x in te], float)
    print(f"  raw OpenJev P(material) alone      AUC {auc([x['oj'][0] for x in te], y):.3f}  Brier {brier([x['oj'][0] for x in te], y):.3f}  (uncalibrated)")
    for lab, fn in (("Platt-calibrated P(material)", lambda x: [x["oj"][0]]),
                    ("trained head on OpenJev answers", lambda x: x["oj"]),
                    ("non-LLM baseline (news count, size, kw, 'earnings')", lambda x: x["base"]),
                    ("both", lambda x: x["oj"] + x["base"])):
        a, b, _ = fit_eval(fn, "big")
        print(f"  {lab:50s} AUC {a:.3f}  Brier {b:.4f}")
    print(f"  (always base rate Brier {brier(np.full(len(y), np.mean([x['big'] for x in tr])), y):.4f})")

    print("\n## Direction (abnormal return > 0 on the ticker-day): test AUC / Brier")
    y = np.array([x["up"] for x in te], float)
    raw = [(x["oj"][4] + 1 - x["oj"][3]) / 2 for x in te]
    print(f"  raw OpenJev (P(good) + 1 − P(bad)) / 2    AUC {auc(raw, y):.3f}  Brier {brier(raw, y):.4f}")
    for lab, fn in (("Platt-calibrated OpenJev direction", lambda x: [x["oj"][2]]),
                    ("trained head on OpenJev answers", lambda x: x["oj"]),
                    ("keyword baseline", lambda x: [x["kw"]]),
                    ("both", lambda x: x["oj"] + [x["kw"]])):
        a, b, _ = fit_eval(fn, "up")
        print(f"  {lab:50s} AUC {a:.3f}  Brier {b:.4f}")
    print(f"  (always 50/50 Brier {brier(np.full(len(y), np.mean([x['up'] for x in tr])), y):.4f})")


def statistics_mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


if __name__ == "__main__":
    main()
