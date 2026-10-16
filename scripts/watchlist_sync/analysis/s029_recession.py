"""S029 (A120 T5, pre-registered 10-15): calibrated recession odds from curve + credit + Sahm vs the base rate.

Target y_t = 1 if an NBER recession month (FRED USREC) occurs in t+1..t+12. Monthly. Models (logistic, Newton):
  M1 term spread GS10 − TB3MS · M2 + credit BAA10YM · M3 + Sahm rule SAHMREALTIME.
Walk-forward: at month t fit only on months s ≤ t − 12 (their labels are known), predict t. Scored 1985-01 → (latest − 12).
Metric: Brier skill score vs expanding climatology (mean of known labels). Pass: BSS > 0, 24-month block-bootstrap 90 % CI > 0,
BSS > 0 in both halves (1985–2005 / 2006→), Holm over 3 models.
Inputs: FRED fredgraph.csv, cached in out/opt/s028_inputs/ (gitignored).

    .venv/bin/python analysis/s029_recession.py      # → out/opt/S029.md + optlab.findings S029
"""
from __future__ import annotations

import csv
import json
import random
import sys
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

IN = HERE.parent / "out/opt/s028_inputs"
OUT = HERE.parent / "out/opt/S029.md"
START, SPLIT = date(1985, 1, 1), date(2006, 1, 1)
B = 4000


def monthly(name: str) -> dict[date, float]:
    f = IN / f"{name}.csv"
    if not f.exists():
        IN.mkdir(parents=True, exist_ok=True)
        f.write_bytes(urllib.request.urlopen(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={name}", timeout=60).read())
    out: dict[date, float] = {}
    for r in list(csv.reader(open(f)))[1:]:
        try:
            d = date.fromisoformat(r[0]); out[date(d.year, d.month, 1)] = float(r[1])
        except (ValueError, IndexError):
            continue
    return out


def fit(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    w = np.zeros(X.shape[1])
    for _ in range(50):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (y - p) - 1e-4 * w
        H = -(X.T * (p * (1 - p))) @ X - 1e-4 * np.eye(len(w))
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def main() -> None:
    rec, gs10, tb3, baa, sahm = (monthly(n) for n in ("USREC", "GS10", "TB3MS", "BAA10YM", "SAHMREALTIME"))
    months = sorted(m for m in rec if m in gs10 and m in tb3 and m in baa and m in sahm)
    idx = {m: i for i, m in enumerate(months)}
    last_rec = max(rec)
    feats = {m: (gs10[m] - tb3[m], baa[m], sahm[m]) for m in months}
    y: dict[date, int] = {}
    for m in months:
        i = idx[m]
        ahead = [months[i + k] for k in range(1, 13) if i + k < len(months)]
        if len(ahead) == 12 and ahead[-1] <= last_rec:
            y[m] = int(any(rec.get(a, 0) == 1 for a in ahead))
    models = {"M1 term spread": [0], "M2 + credit": [0, 1], "M3 + credit + Sahm": [0, 1, 2]}
    scored = [m for m in months if m >= START and m in y]
    pred = {k: {} for k in models}
    clim = {}
    for m in scored + [months[-1]]:
        train = [s for s in months if s in y and idx[s] <= idx[m] - 12]
        if len(train) < 120:
            continue
        yt = np.array([y[s] for s in train], float)
        clim[m] = yt.mean()
        for k, cols in models.items():
            X = np.array([[1.0, *[feats[s][c] for c in cols]] for s in train])
            w = fit(X, yt)
            x = np.array([1.0, *[feats[m][c] for c in cols]])
            pred[k][m] = float(1 / (1 + np.exp(-x @ w)))
    sc = [m for m in scored if m in clim]

    def bss(k: str, ms: list[date]) -> float:
        bm = sum((pred[k][m] - y[m]) ** 2 for m in ms)
        bc = sum((clim[m] - y[m]) ** 2 for m in ms)
        return 1 - bm / bc if bc else 0.0

    rng = random.Random(29)
    blocks = [sc[i:i + 24] for i in range(0, len(sc), 24)]
    res, lines = {}, []
    for k in models:
        est = bss(k, sc)
        boots = sorted(bss(k, [m for _ in blocks for m in rng.choice(blocks)]) for _ in range(B))
        lo, hi = boots[int(0.05 * B)], boots[int(0.95 * B)]
        h1, h2 = bss(k, [m for m in sc if m < SPLIT]), bss(k, [m for m in sc if m >= SPLIT])
        p = 2 * min(sum(b <= 0 for b in boots), sum(b >= 0 for b in boots)) / B
        res[k] = {"bss": est, "ci": (lo, hi), "halves": (h1, h2), "p": min(1.0, p), "now": pred[k].get(months[-1])}
    order = sorted(res, key=lambda k: res[k]["p"])
    for r, k in enumerate(order):
        res[k]["holm"] = min(1.0, res[k]["p"] * (len(order) - r))
        x = res[k]
        x["pass"] = x["holm"] < 0.05 and x["ci"][0] > 0 and x["halves"][0] > 0 and x["halves"][1] > 0
    n_rec = sum(1 for i, m in enumerate(sc) if y[m] and (i == 0 or not y[sc[i - 1]]))
    now = months[-1]
    # calibration of the best model: deciles of predicted odds
    best = max(res, key=lambda k: res[k]["bss"])
    cal = []
    pts = sorted((pred[best][m], y[m]) for m in sc)
    for q in range(5):
        chunk = pts[q * len(pts) // 5:(q + 1) * len(pts) // 5]
        cal.append((sum(a for a, _ in chunk) / len(chunk), sum(b for _, b in chunk) / len(chunk), len(chunk)))
    lines += [f"# S029 — recession odds from curve, credit, Sahm ({date.today()})\n",
              f"Scored months {sc[0]:%Y-%m} → {sc[-1]:%Y-%m} ({len(sc)} months, {n_rec} recession lead-in episodes; label = NBER recession "
              f"in the next 12 months). Walk-forward: each month's model is fit only on labels known by then. Base rate (climatology) "
              f"at the end: {clim[sc[-1]]:.0%}.\n",
              "| Model | Brier skill vs base | 90 % CI | 1985–2005 / 2006→ | Holm p | Pass | Odds now (" + f"{now:%Y-%m})" + " |",
              "|---|---|---|---|---|---|---|"]
    for k in models:
        x = res[k]
        lines.append(f"| {k} | {x['bss']:+.2f} | {x['ci'][0]:+.2f} … {x['ci'][1]:+.2f} | {x['halves'][0]:+.2f} / {x['halves'][1]:+.2f} | "
                     f"{x['holm']:.3f} | **{'PASS' if x['pass'] else 'FAIL'}** | {x['now']:.0%} |" if x["now"] is not None else "| — |")
    lines.append(f"\nCalibration of {best} (quintiles of predicted odds → realized share): "
                 + " · ".join(f"{a:.0%}→{b:.0%} (n {n})" for a, b, n in cal))
    lines.append("\nInputs now: term spread {:.2f} pp, Baa−10y {:.2f} pp, Sahm {:.2f}.".format(*feats[now]))
    lines.append("Limits: ~4 recessions in the scored window, so CIs are wide; NBER dates are announced late (labels used only "
                 "once known); TB3MS/GS10 monthly averages, not the daily T10Y3M of S028; Sahm real-time vintage.")
    passed = [k for k in models if res[k]["pass"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    if passed:
        k = max(passed, key=lambda k: res[k]["bss"]); verdict = "pass"
        head = (f"Recession odds now {res[k]['now']:.0%} ({k}); it beat the base rate out of sample (skill {res[k]['bss']:+.2f}, both halves). "
                f"Context for the macro tab, not a trading rule.")
    else:
        verdict = "fail"
        head = (f"No model beat the plain base rate reliably out of sample (best {best}: skill {res[best]['bss']:+.2f}, "
                f"halves {res[best]['halves'][0]:+.2f}/{res[best]['halves'][1]:+.2f}). Odds now {res[best]['now']:.0%} — treat as weak context.")
    conn = connect()
    conn.execute("""INSERT INTO optlab.findings (study, title, verdict, headline, card, updated_at)
                    VALUES ('S029','Recession odds (curve, credit, Sahm)',%s,%s,%s,now())
                    ON CONFLICT (study) DO UPDATE SET verdict=excluded.verdict, headline=excluded.headline, card=excluded.card, updated_at=now()""",
                 (verdict, head, json.dumps({k: {kk: vv for kk, vv in v.items()} for k, v in res.items()}, default=str)))
    conn.commit()
    print("\n".join(lines)); print("→", verdict, head)


if __name__ == "__main__":
    main()
