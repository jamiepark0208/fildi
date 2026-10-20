"""S057 — House view R1: calibrated forward S&P odds from market state (Claude 10-19, Jamie: "forward expectations based on
probabilities, with evals"). Pre-registered in research/studies/INDEX.md before the first run.

Question: given today's state, P(S&P higher in 21 trading days) and P(another −5 % leg: min close in the next 21 ≤ 0.95 × today).
Literature pulls both ways: "buy VIX spikes" (vol risk premium / mean reversion) vs trend-following (Faber: below 200d = worse).
Features (point-in-time, close of day t):
  vix_z      ln(VIX / trailing-252d median VIX)          (FRED VIXCLS)
  dd         1 − S&P / trailing-252d high
  below200   S&P < 200d SMA
  ret5_z     5-day log return / (60d daily σ · √5)
  credit     BAA10Y above its trailing-1y 80th pct (S028 rule)
Forecasters: base (train-period rate) · logit (numpy IRLS, the 5 features) · market (tail only: barrier odds from VIX,
2·N(ln 0.95 / (σ√T)), risk-neutral, zero drift).
Train 1990–2012, holdout 2013-01 → last label. Brier skill vs base; 90 % CI = month-block bootstrap (B = 2000).
Pass (pre-registered): skill > 0, CI low > 0, both holdout halves > 0.
Inputs: out/opt/s028_inputs/{GSPC,VIXCLS,BAA10Y}.csv (S028 cache).

    .venv/bin/python analysis/s057_market_view.py [--today]   # --today: print today's odds from the full-sample fit
"""
from __future__ import annotations

import math
import random
import sys
from bisect import bisect_right
from datetime import date
from pathlib import Path
from statistics import NormalDist, median

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from s028_macro_stress import series  # noqa: E402

H, TAIL = 21, 0.95
SPLIT = date(2013, 1, 1)
FEATS = ["vix_z", "dd", "below200", "ret5_z", "credit"]
N = NormalDist()


def refresh_gspc():
    """Append missing ^GSPC closes (Yahoo chart, free) so today's view isn't a stale day; the S028 cache is otherwise static."""
    import json
    import urllib.request
    from datetime import datetime, timezone
    f = HERE.parent / "out/opt/s028_inputs/GSPC.csv"
    last = date.fromisoformat(f.read_text().strip().splitlines()[-1].split(",")[0])
    req = urllib.request.Request("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=3mo&interval=1d", headers={"User-Agent": "Mozilla/5.0"})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))["chart"]["result"][0]
    except Exception as e:  # noqa: BLE001
        print(f"  GSPC refresh skipped ({str(e)[:60]})")
        return
    new = [(datetime.fromtimestamp(t, timezone.utc).date(), c) for t, c in zip(d["timestamp"], d["indicators"]["quote"][0]["close"]) if c]
    with open(f, "a") as fh:
        for dd, c in new:
            if dd > last and dd < date.today():   # today's bar isn't final until the close
                fh.write(f"{dd},{c}\n")


def panel():
    gd, gv = series("GSPC")
    vd, vv = series("VIXCLS")
    bd, bv = series("BAA10Y")
    out = []
    for i in range(260, len(gd)):
        d = gd[i]
        j = bisect_right(vd, d) - 1
        k = bisect_right(bd, d) - 1
        if j < 252 or k < 252 or (d - vd[j]).days > 5:
            continue
        p = gv[i]
        rets = [math.log(gv[x] / gv[x - 1]) for x in range(i - 59, i + 1)]
        sd = float(np.std(rets)) or 1e-9
        win = sorted(bv[k - 251:k + 1])
        f = {"vix_z": math.log(vv[j] / median(vv[j - 251:j + 1])), "dd": 1 - p / max(gv[i - 251:i + 1]),
             "below200": float(p < sum(gv[i - 199:i + 1]) / 200), "ret5_z": math.log(p / gv[i - 5]) / (sd * math.sqrt(5)),
             "credit": float(bv[k] > win[int(0.8 * (len(win) - 1))])}
        lab = None
        if i + H < len(gd):
            lab = {"up": float(gv[i + H] > p), "tail": float(min(gv[i + 1:i + H + 1]) <= TAIL * p)}
        out.append({"d": d, "vix": vv[j], **f, "y": lab})
    return out


def fit(X, y, l2=1e-3):
    X = np.c_[np.ones(len(X)), X]
    w = np.zeros(X.shape[1])
    for _ in range(50):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + l2 * w
        Hm = (X * (p * (1 - p))[:, None]).T @ X + l2 * np.eye(len(w))
        w -= np.linalg.solve(Hm, g)
    return w


def pred(w, X):
    return 1 / (1 + np.exp(-(np.c_[np.ones(len(X)), X] @ w)))


def skill(rows, pf, pb):
    """rows: list of (month, y, p_f, p_b) → Brier skill, CI, halves."""
    def bss(rs):
        bf = sum((r[2] - r[1]) ** 2 for r in rs); bb = sum((r[3] - r[1]) ** 2 for r in rs)
        return 1 - bf / bb if bb else 0.0
    by = {}
    for r in rows:
        by.setdefault(r[0], []).append(r)
    months = sorted(by)
    rnd = random.Random(57)
    boots = sorted(bss([r for _ in months for r in by[rnd.choice(months)]]) for _ in range(2000))
    h = len(months) // 2
    return bss(rows), boots[100], boots[1899], bss([r for m in months[:h] for r in by[m]]), bss([r for m in months[h:] for r in by[m]])


def main():
    refresh_gspc()
    vf = HERE.parent / "out/opt/s028_inputs/VIXCLS.csv"
    if date.fromtimestamp(vf.stat().st_mtime) < date.today():
        vf.unlink()   # series() re-fetches missing FRED files
    P = panel()
    lab = [r for r in P if r["y"]]
    tr = [r for r in lab if r["d"] < SPLIT]
    ho = [r for r in lab if r["d"] >= SPLIT]
    Xtr = np.array([[r[f] for f in FEATS] for r in tr]); Xho = np.array([[r[f] for f in FEATS] for r in ho])
    print(f"S057 · train {tr[0]['d']}→{tr[-1]['d']} n {len(tr)} · holdout {ho[0]['d']}→{ho[-1]['d']} n {len(ho)}")
    res = {}
    for tgt in ("up", "tail"):
        ytr = np.array([r["y"][tgt] for r in tr]); yho = np.array([r["y"][tgt] for r in ho])
        base = ytr.mean()
        w = fit(Xtr, ytr)
        pl = pred(w, Xho)
        rows = [(r["d"].strftime("%Y-%m"), y, p, base) for r, y, p in zip(ho, yho, pl)]
        s = skill(rows, None, None)
        coef = ", ".join(f"{f} {c:+.2f}" for f, c in zip(["const"] + FEATS, w))
        print(f"\n[{tgt}] base rate train {base:.3f} · holdout realized {yho.mean():.3f}")
        print(f"  logit coef: {coef}")
        print(f"  logit vs base: skill {s[0]:+.4f} (90% CI {s[1]:+.4f}..{s[2]:+.4f}) halves {s[3]:+.4f} / {s[4]:+.4f} → "
              f"{'PASS' if s[0] > 0 and s[1] > 0 and s[3] > 0 and s[4] > 0 else 'FAIL'}")
        if tgt == "tail":
            pm = [2 * N.cdf(math.log(TAIL) / (r["vix"] / 100 * math.sqrt(H / 252))) for r in ho]
            sm = skill([(r["d"].strftime("%Y-%m"), y, p, base) for r, y, p in zip(ho, yho, pm)], None, None)
            print(f"  market (VIX barrier) vs base: skill {sm[0]:+.4f} (CI {sm[1]:+.4f}..{sm[2]:+.4f}) mean p {np.mean(pm):.3f}")
            sl = skill([(r["d"].strftime("%Y-%m"), y, p, q) for r, y, p, q in zip(ho, yho, pl, pm)], None, None)
            print(f"  logit vs market: skill {sl[0]:+.4f} (CI {sl[1]:+.4f}..{sl[2]:+.4f})")
            # R2: forward-looking market odds, de-biased with history (Platt on the train period); + state features
            lm = lambda rs: np.array([[math.log(q / (1 - q))] for q in (2 * N.cdf(math.log(TAIL) / (r["vix"] / 100 * math.sqrt(H / 252))) for r in rs)])
            for name, Xa, Xb in (("calibrated market", lm(tr), lm(ho)),
                                 ("calibrated market + state", np.c_[lm(tr), Xtr], np.c_[lm(ho), Xho])):
                wc = fit(Xa, ytr); pc = pred(wc, Xb)
                sc = skill([(r["d"].strftime("%Y-%m"), y, p, base) for r, y, p in zip(ho, yho, pc)], None, None)
                print(f"  R2 {name} vs base: skill {sc[0]:+.4f} (CI {sc[1]:+.4f}..{sc[2]:+.4f}) halves {sc[3]:+.4f} / {sc[4]:+.4f} → "
                      f"{'PASS' if sc[0] > 0 and sc[1] > 0 and sc[3] > 0 and sc[4] > 0 else 'FAIL'}")
        # calibration in quintiles of the forecast
        qs = np.quantile(pl, [0.2, 0.4, 0.6, 0.8])
        b = np.digitize(pl, qs)
        print("  calibration (pred → realized, n): " + " · ".join(f"{pl[b == k].mean():.2f}→{yho[b == k].mean():.2f} ({(b == k).sum()})" for k in range(5)))
        res[tgt] = (w, base)
    if "--today" in sys.argv:
        Xall = np.array([[r[f] for f in FEATS] for r in lab])
        t = P[-1]
        print(f"\nToday {t['d']}: " + ", ".join(f"{f} {t[f]:+.2f}" for f in FEATS) + f", VIX {t['vix']:.1f}")
        for tgt in ("up", "tail"):
            w = fit(Xall, np.array([r["y"][tgt] for r in lab]))
            print(f"  P({tgt}) = {pred(w, np.array([[t[f] for f in FEATS]]))[0]:.3f} (full-sample fit; base {np.mean([r['y'][tgt] for r in lab]):.3f})")
        print(f"  market-implied P(tail) = {2 * N.cdf(math.log(TAIL) / (t['vix'] / 100 * math.sqrt(H / 252))):.3f}")


if __name__ == "__main__":
    main()
