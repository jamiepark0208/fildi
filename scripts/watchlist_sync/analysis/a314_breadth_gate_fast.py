"""Fast A314 live-N gate — logit event t for breadth subsets (cached SPY/QQQ paths)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.discrete.discrete_model import Logit
from statsmodels.stats.sandwich_covariance import cov_cluster

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from a314_breadth import build_rows, load_uvr  # noqa: E402
from a314_breadth_live_n import build_breadth, risk_score  # noqa: E402
from s126_intraday_regime import load  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A314-breadth-packet.md"
TICK = HERE.parent / "out" / "opt" / "A314-breadth-live-tickers.json"


def prep(tk: str):
    df = load(tk)
    days = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
    by_d = {g.d.iloc[0]: (k, g) for k, g in enumerate(days) if len(g) >= 70}
    return days, by_d


def score_row(tk: str, r, days, by_d) -> float:
    hit = by_d.get(r.d)
    if hit is None:
        return np.nan
    k, g = hit
    if k < 21:
        return np.nan
    bar_i = g.index[g.m + 5 == r.m]
    if len(bar_i) == 0:
        return np.nan
    i = int(bar_i[0])
    sub = g.iloc[: i + 1]
    closes = np.array([x.c.iloc[-1] for x in days])
    highs = np.array([x.h.max() for x in days])
    lows = np.array([x.l.min() for x in days])
    pcs21 = closes[k - 21 : k]
    tr = np.maximum(
        highs[k - 20 : k] - lows[k - 20 : k],
        np.maximum(abs(highs[k - 20 : k] - pcs21[:-1]), abs(lows[k - 20 : k] - pcs21[:-1])),
    ) / pcs21[:-1]
    return risk_score(sub, int(r.m), tr.mean(), closes[k - 1] / closes[k - 6] - 1 if k >= 6 else 0.0)


def logit_t(R: pd.DataFrame, half: str) -> float:
    y = R[R.half == half]
    X = sm.add_constant(y[["score", "vwap_roc_fall"]].astype(float))
    mod = Logit(y.dropx.astype(int), X).fit(disp=0, maxiter=80)
    cov = cov_cluster(mod, pd.Categorical(y.d).codes)
    i = list(X.columns).index("vwap_roc_fall")
    se = np.sqrt(cov[i, i])
    return float(mod.params["vwap_roc_fall"] / se) if se > 0 else float("nan")


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env", HERE.parents[3] / ".env.local", HERE.parents[3] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break
    prep_cache = {tk: prep(tk) for tk in ("SPY", "QQQ")}
    with connect() as c:
        pool = pd.read_sql(
            "select ticker from optlab.bars_5m group by 1 having count(*)>5000 order by avg(v) desc",
            c,
        ).ticker.tolist()
        uvr = load_uvr(c)

    results = []
    chosen = None
    for n in (20, 40, 80):
        ok_all = True
        for seed in (0, 1, 2):
            rng = np.random.default_rng(seed)
            pick = list(rng.choice(pool[: max(n * 3, n)], size=n, replace=False))
            with connect() as c:
                br = build_breadth(c, pick)
            R = build_rows(br, uvr)
            scores = []
            for _, row in R.iterrows():
                days, by_d = prep_cache[row.tk]
                scores.append(score_row(row.tk, row, days, by_d))
            R["score"] = scores
            R = R.dropna(subset=["score"])
            t1, t2 = logit_t(R, "H1"), logit_t(R, "H2")
            ok = t1 == t1 and t2 == t2 and abs(t1) >= 2 and abs(t2) >= 2
            results.append((n, seed, t1, t2, ok, pick))
            if not ok:
                ok_all = False
        if ok_all and chosen is None:
            chosen = (n, 0, results[-3][5])

    lines = [
        "",
        "## Live subset gate (VWAP drop ≥8pp / 30m, logit dropx ~ S126 score + event, day-clustered t)",
        "",
        "| N | seed | H1 t | H2 t | pass |",
        "|---:|---:|---:|---:|---|",
    ]
    for n, seed, t1, t2, ok, _ in results:
        lines.append(f"| {n} | {seed} | {t1:+.1f} | {t2:+.1f} | {'yes' if ok else 'no'} |")

    if chosen:
        n, seed, tickers = chosen
        lines.append(f"\n**Live N={n}** (seed {seed}) → `A314-breadth-live-tickers.json`.")
        TICK.write_text(json.dumps({"n": n, "seed": seed, "tickers": tickers}, indent=2) + "\n")
    else:
        tickers = pool[:20]
        lines.append("\n**Live N=20** top liquid (no subset passed all seeds; ship Schwab lane cap).")
        TICK.write_text(json.dumps({"n": 20, "seed": -1, "tickers": tickers}, indent=2) + "\n")

    text = OUT.read_text()
    if "## Live subset gate" in text:
        text = text.split("## Live subset gate")[0].rstrip() + "\n"
    OUT.write_text(text + "\n".join(lines) + "\n")
    print("\n".join(lines[-8:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
