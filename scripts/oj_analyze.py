"""oj analyze — heavier analysis by decomposition (A150 §3). A spec breaks one judgment into several typed OpenJev questions
per item, aggregates the answers into features, and LEARNS how to combine them from real outcomes (logistic fit on the
earlier dates, graded on the later dates). Output: calibrated probability + per-question weights, vs the best single question
and the base rate. Weights are never hand-set. Specs: .agents/openjev/specs/*.json.

Spec keys: id, title, source{path (jsonl of rows with cached OpenJev answers under "a"), filter{field: value}, group_by[...]},
features[{name, from ("a.<q>.<key>" or "a.<q>.choice=<option>" or a row field), agg (max|mean|min|count_log)}],
label{field, op ("<" | ">" | "abs>"), value}, label_derive{name: "num/den"}, date_field, split (ISO date).
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _get(row: dict, path: str):
    if "=" in path:
        p, want = path.split("=", 1)
        return 1.0 if _get(row, p) == want else 0.0
    cur = row
    for k in path.split("."):
        cur = cur.get(k) if isinstance(cur, dict) else None
    return cur


def _agg(vals: list, how: str) -> float:
    if how == "count_log":
        return math.log1p(len(vals))
    vals = [float(v) for v in vals if v is not None]
    if not vals:
        return 0.0
    return {"max": max, "min": min, "mean": lambda v: sum(v) / len(v)}[how](vals)


def _fit(X: list[list[float]], y: list[int], l2: float = 1.0, iters: int = 2000, lr: float = 0.2) -> list[float]:
    n, k = len(X), len(X[0])
    w = [0.0] * (k + 1)
    for _ in range(iters):
        g = [0.0] * (k + 1)
        for xi, yi in zip(X, y):
            z = w[0] + sum(a * b for a, b in zip(w[1:], xi))
            p = 1 / (1 + math.exp(-max(min(z, 30), -30)))
            g[0] += p - yi
            for j in range(k):
                g[j + 1] += (p - yi) * xi[j]
        for j in range(k + 1):
            w[j] -= lr * (g[j] / n + (l2 * w[j] / n if j else 0))
    return w


def _pred(w: list[float], x: list[float]) -> float:
    z = w[0] + sum(a * b for a, b in zip(w[1:], x))
    return 1 / (1 + math.exp(-max(min(z, 30), -30)))


def auc(s: list[float], y: list[int]) -> float:
    pos = [a for a, b in zip(s, y) if b]
    neg = [a for a, b in zip(s, y) if not b]
    if not pos or not neg:
        return float("nan")
    wins = sum((p > q) + 0.5 * (p == q) for p in pos for q in neg)
    return wins / (len(pos) * len(neg))


def _boot_auc_ci(s, y, n=300, seed=17):
    rnd = random.Random(seed)
    idx = list(range(len(s)))
    vals = []
    for _ in range(n):
        b = [rnd.choice(idx) for _ in idx]
        v = auc([s[i] for i in b], [y[i] for i in b])
        if v == v:
            vals.append(v)
    vals.sort()
    return round(vals[int(.05 * len(vals))], 3), round(vals[int(.95 * len(vals)) - 1], 3)


def run(spec_path: Path, quiet: bool = False) -> dict:
    spec = json.loads(spec_path.read_text())
    src = spec["source"]
    rows = [json.loads(x) for x in (ROOT / src["path"]).open()]
    rows = [r for r in rows if all(r.get(k) == v for k, v in src.get("filter", {}).items())]
    for name, expr in spec.get("label_derive", {}).items():
        num, den = expr.split("/")
        for r in rows:
            r[name] = r[num] / r[den] if r.get(den) else None
    groups: dict = {}
    for r in rows:
        groups.setdefault(tuple(r[k] for k in src["group_by"]), []).append(r)
    lab = spec["label"]
    test_op = {"<": lambda v: v < lab["value"], ">": lambda v: v > lab["value"], "abs>": lambda v: abs(v) > lab["value"]}[lab["op"]]
    data = []
    for key, g in groups.items():
        lv = g[0].get(lab["field"])
        if lv is None:
            continue
        x = [_agg([_get(r, f["from"]) for r in g] if f["agg"] != "count_log" else g, f["agg"]) for f in spec["features"]]
        data.append((g[0][spec["date_field"]], x, int(test_op(lv))))
    data.sort(key=lambda d: d[0])
    tr = [d for d in data if d[0] < spec["split"]]
    te = [d for d in data if d[0] >= spec["split"]]
    k = len(spec["features"])
    mu = [sum(d[1][j] for d in tr) / len(tr) for j in range(k)]
    sd = [math.sqrt(sum((d[1][j] - mu[j]) ** 2 for d in tr) / len(tr)) or 1.0 for j in range(k)]
    z = lambda x: [(x[j] - mu[j]) / sd[j] for j in range(k)]
    w = _fit([z(d[1]) for d in tr], [d[2] for d in tr])
    p = [_pred(w, z(d[1])) for d in te]
    y = [d[2] for d in te]
    single = {f["name"]: round(auc([d[1][j] for d in te], y), 3) for j, f in enumerate(spec["features"])}
    best = max(single.items(), key=lambda kv: kv[1] if kv[1] == kv[1] else 0)
    base = sum(d[2] for d in tr) / len(tr)
    brier = sum((a - b) ** 2 for a, b in zip(p, y)) / len(y)
    brier0 = sum((base - b) ** 2 for b in y) / len(y)
    a = auc(p, y)
    lo, hi = _boot_auc_ci(p, y)
    bins = []
    for blo, bhi in ((0, .05), (.05, .1), (.1, .2), (.2, .4), (.4, 1.01)):
        b = [(pp, yy) for pp, yy in zip(p, y) if blo <= pp < bhi]
        if b:
            bins.append(f"P {blo:.2f}–{min(bhi, 1):.2f}: n={len(b)} predicted {sum(x for x, _ in b) / len(b):.2f} realized {sum(v for _, v in b) / len(b):.2f}")
    res = {"value": round(a, 4), "lo": lo, "hi": hi, "n": len(te), "train_n": len(tr), "positives_test": sum(y),
           "brier": round(brier, 4), "brier_base": round(brier0, 4), "best_single": {"name": best[0], "auc": best[1]},
           "weights": {f["name"]: round(w[j + 1], 3) for j, f in enumerate(spec["features"])}, "single_auc": single, "calibration": bins}
    if not quiet:
        print(f"{spec['id']} {spec['title']}: test AUC {a:.3f} [{lo}, {hi}] on {len(te)} items ({sum(y)} positives); "
              f"best single question {best[0]} {best[1]}; Brier {brier:.4f} vs base rate {brier0:.4f}")
        print("  learned weights (standardized):", ", ".join(f"{k}={v:+.2f}" for k, v in res["weights"].items()))
        for b in bins:
            print("  " + b)
    return res
