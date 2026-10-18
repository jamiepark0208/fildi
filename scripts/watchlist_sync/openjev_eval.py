"""OpenJev calibration eval — pure stdlib.

For Claude's A129 re-score protocol: reads per-question records (raw logits +
correct index, or chosen prob + correct flag), fits temperature scaling
(Guo et al. 2017) on a fit split, and reports ECE before/after plus
coverage-at-error on the held-out split.

Record format (JSON list, one dict per question):
    {"logits": [..], "correct_idx": int}          # preferred
or  {"probs": [..],  "correct_idx": int}
or  {"p": float, "correct": bool}                  # binary / already-collapsed

Usage:
    python3 openjev_eval.py records.json [--fit-frac 0.5] [--seed 17]
"""
import json
import math
import random
import sys


def softmax(logits):
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    s = sum(exps)
    return [e / s for e in exps]


def nll(probs_list, labels):
    total = 0.0
    for probs, lab in zip(probs_list, labels):
        p = min(max(probs[lab], 1e-12), 1.0)
        total += -math.log(p)
    return total / len(labels)


def apply_temperature(logits, T):
    return softmax([x / T for x in logits])


def fit_temperature(logits_list, labels, lo=0.05, hi=10.0, iters=60):
    """Golden-section search on NLL (temperature > 0)."""
    gr = (math.sqrt(5) - 1) / 2
    a, b = lo, hi
    c = b - gr * (b - a)
    d = a + gr * (b - a)

    def f(T):
        return nll([apply_temperature(lg, T) for lg in logits_list], labels)

    fc, fd = f(c), f(d)
    for _ in range(iters):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - gr * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + gr * (b - a)
            fd = f(d)
    return (a + b) / 2


def ece(probs_list, labels, n_bins=15):
    """Expected Calibration Error on the chosen-class probability."""
    bins = [[] for _ in range(n_bins)]
    for probs, lab in zip(probs_list, labels):
        p = max(probs)
        bins[min(int(p * n_bins), n_bins - 1)].append((p, lab == probs.index(p)))
    total, err = 0, 0.0
    for b in bins:
        if not b:
            continue
        acc = sum(1 for _, ok in b if ok) / len(b)
        conf = sum(p for p, _ in b) / len(b)
        err += len(b) * abs(acc - conf)
        total += len(b)
    return err / total if total else 0.0


def coverage_at_error(probs_list, labels, error_rate):
    """Max fraction answerable while holding error <= error_rate.

    Sort by confidence desc; walk down; largest k with errors/k <= error_rate.
    Returns (coverage, threshold_prob). Coverage 0 means abstain everywhere.
    """
    conf = [(max(p), lab == p.index(max(p))) for p, lab in zip(probs_list, labels)]
    conf.sort(key=lambda x: -x[0])
    best_k, errors = 0, 0
    for k, (_, ok) in enumerate(conf, 1):
        if not ok:
            errors += 1
        if errors / k <= error_rate:
            best_k = k
    n = len(conf)
    thresh = conf[best_k - 1][0] if best_k else 1.0
    return best_k / n if n else 0.0, thresh


def error_rank_auroc(probs_list, labels):
    """AUROC of confidence ranking correct (1) vs wrong (0) answers."""
    scores = [(max(p), 1 if lab == p.index(max(p)) else 0)
              for p, lab in zip(probs_list, labels)]
    pos = sorted(s for s, y in scores if y == 1)
    neg = sorted(s for s, y in scores if y == 0)
    if not pos or not neg:
        return float("nan")
    # Mann-Whitney U
    wins = sum(1 for s in pos for t in neg if s > t) + \
        0.5 * sum(1 for s in pos for t in neg if s == t)
    return wins / (len(pos) * len(neg))


def to_logits_labels(records):
    logits_list, labels = [], []
    for r in records:
        if "logits" in r:
            logits_list.append(list(r["logits"]))
            labels.append(int(r["correct_idx"]))
        elif "probs" in r:
            p = list(r["probs"])
            # invert: pseudo-logits from probs (for temperature refit)
            logits_list.append([math.log(max(x, 1e-12)) for x in p])
            labels.append(int(r["correct_idx"]))
        elif "p" in r:
            p = float(r["p"])
            logits_list.append([math.log(max(p, 1e-12)), math.log(max(1 - p, 1e-12))])
            labels.append(0 if r["correct"] else 1)
        else:
            raise ValueError(f"unrecognized record: {r}")
    return logits_list, labels


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    records = json.load(open(sys.argv[1]))
    fit_frac = 0.5
    seed = 17
    for a in sys.argv[2:]:
        if a.startswith("--fit-frac"):
            fit_frac = float(a.split("=")[1])
        elif a.startswith("--seed"):
            seed = int(a.split("=")[1])
    rnd = random.Random(seed)
    idx = list(range(len(records)))
    rnd.shuffle(idx)
    n_fit = int(len(idx) * fit_frac)
    fit_recs = [records[i] for i in idx[:n_fit]]
    held_recs = [records[i] for i in idx[n_fit:]]

    fit_logits, fit_lab = to_logits_labels(fit_recs)
    held_logits, held_lab = to_logits_labels(held_recs)

    T = fit_temperature(fit_logits, fit_lab)
    p_raw = [softmax(lg) for lg in held_logits]
    p_cal = [apply_temperature(lg, T) for lg in held_logits]

    out = {
        "n_fit": len(fit_recs),
        "n_held": len(held_recs),
        "temperature": round(T, 4),
        "ece_before": round(ece(p_raw, held_lab), 4),
        "ece_after": round(ece(p_cal, held_lab), 4),
        "error_rank_auroc": round(error_rank_auroc(p_raw, held_lab), 4),
    }
    for er in (0.05, 0.01):
        cov_b, _ = coverage_at_error(p_raw, held_lab, er)
        cov_a, th = coverage_at_error(p_cal, held_lab, er)
        out[f"coverage_at_{int(er*100)}pct_before"] = round(cov_b, 4)
        out[f"coverage_at_{int(er*100)}pct_after"] = round(cov_a, 4)
        out[f"coverage_at_{int(er*100)}pct_threshold"] = round(th, 4)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
