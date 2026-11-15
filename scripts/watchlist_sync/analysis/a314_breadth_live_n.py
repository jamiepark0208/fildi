"""A314 live gate — smallest N (20/40/80 × 3 seeds) for breadth VWAP drop event vs S126 score (Claude 10-29 spec).

Rebuilds optlab.breadth_5m-style above_vwap from optlab.bars_5m subsets; incremental logit dropx ~ score + event,
day-clustered t on the event coef (both halves). Writes subset table + ticker list for the API poller.

Run: cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/a314_breadth_live_n.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.stats.sandwich_covariance import cov_cluster
from statsmodels.discrete.discrete_model import Logit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s126_intraday_regime import load  # noqa: E402
from a314_breadth import build_rows  # noqa: E402

OUT_PACKET = HERE.parent / "out" / "opt" / "A314-breadth-packet.md"
OUT_TICKERS = HERE.parent / "out" / "opt" / "A314-breadth-live-tickers.json"
S126 = json.loads((HERE.parent / "out" / "opt" / "S126_model.json").read_text())
_mins = np.array(sorted(int(k) for k in S126["rngMedianByMin"]))
_meds = np.array([S126["rngMedianByMin"][str(k)] for k in _mins])


def risk_score(b: pd.DataFrame, m: int, atr: float, ret5: float) -> float:
    o, last = b.o.iloc[0], b.c.iloc[-1]
    hh, ll = b.h.max(), b.l.min()
    path = abs(b.c.iloc[0] - o) + b.c.diff().abs().sum()
    er = abs(last - o) / path if path > 0 else 0
    pc = b.c.shift()
    tr = np.maximum(b.h - b.l, np.maximum((b.h - pc).abs(), (b.l - pc).abs())).fillna(b.h - b.l)
    chop = 100 * np.log10(tr.sum() / (hh - ll)) / np.log10(len(b)) if hh > ll else 100
    rng_rel = (hh - ll) / o / atr / np.interp(m, _mins, _meds)
    x = {"rng_rel": rng_rel, "ret5d": ret5, "er": er, "chop": chop}
    mu, sd, w = S126["mu"], S126["sd"], S126["weights"]
    feats = S126["features"]
    return w[0] + sum(w[i + 1] * (x[k] - mu[k]) / sd[k] for i, k in enumerate(feats))


BAR_CACHE: dict[str, pd.DataFrame] = {}


def load_ticker_bars(conn, t: str) -> pd.DataFrame:
    if t in BAR_CACHE:
        return BAR_CACHE[t]
    from quantcore.bars import load_intraday  # one loader (Jamie 11-15)

    df = load_intraday(conn, [t]).get(t)
    if df is None:
        df = pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v", "session_date"])
    df = df[["ts", "o", "c", "v"]].copy()
    df["d"] = df.ts.dt.date
    df["sess_open"] = df.groupby("d")["o"].transform("first")
    df["cum_pv"] = (df.c * df.v).groupby(df.d, sort=False).cumsum()
    df["cum_v"] = df.groupby("d", sort=False)["v"].cumsum()
    df["vwap"] = df["cum_pv"] / df["cum_v"].replace(0, np.nan)
    df["above_open"] = (df.c >= df.sess_open).astype(float)
    df["above_vwap"] = (df.c >= df.vwap).astype(float)
    df["ret"] = df.c / df.sess_open - 1
    BAR_CACHE[t] = df
    return df


def build_breadth(conn, tickers: list[str]) -> pd.DataFrame:
    """Aggregate % above open / above session VWAP at each 5m bar (ET)."""
    parts: list[pd.DataFrame] = []
    for t in tickers:
        df = load_ticker_bars(conn, t)
        if df.empty:
            continue
        parts.append(
            df.assign(ticker=t)[["ts", "d", "ticker", "above_open", "above_vwap", "ret"]].rename(columns={"ts": "bar_ts"})
        )
    if not parts:
        return pd.DataFrame()
    all_b = pd.concat(parts, ignore_index=True)
    g = all_b.groupby(["d", "bar_ts"], as_index=False).agg(
        n=("ticker", "count"),
        up_open=("above_open", "mean"),
        above_vwap=("above_vwap", "mean"),
        mean_ret=("ret", "mean"),
    )
    g["ts"] = g["bar_ts"]
    g["m"] = g["ts"].dt.hour * 60 + g["ts"].dt.minute - 570
    return g.set_index(["d", "m"]).sort_index()


def logit_event_t(rows: pd.DataFrame, half: str) -> float:
    y = rows[rows.half == half]
    if len(y) < 500:
        return float("nan")
    X = sm.add_constant(y[["score", "vwap_roc_fall"]].astype(float))
    mod = Logit(y.dropx.astype(int), X).fit(disp=0, maxiter=100)
    groups = pd.Categorical(y.d).codes
    cov = cov_cluster(mod, groups)
    idx = list(X.columns).index("vwap_roc_fall")
    se = np.sqrt(cov[idx, idx])
    return float(mod.params["vwap_roc_fall"] / se) if se > 0 else float("nan")


from s126_intraday_regime import load as load_bars  # noqa: E402

_LOADED: dict[str, pd.DataFrame] = {}


def load(tk: str) -> pd.DataFrame:
    if tk not in _LOADED:
        _LOADED[tk] = load_bars(tk)
    return _LOADED[tk]


def rows_with_score(br: pd.DataFrame, uvr: pd.DataFrame) -> pd.DataFrame:
    R = build_rows(br, uvr)
    scores: list[float] = []
    for _, r in R.iterrows():
        tk = r.tk
        df = load(tk)
        day_list = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
        k = next((j for j, dd in enumerate(day_list) if dd.d.iloc[0] == r.d), None)
        if k is None or k < 21:
            scores.append(np.nan)
            continue
        g = day_list[k]
        bar_i = g.index[g.m + 5 == r.m]
        if len(bar_i) == 0:
            scores.append(np.nan)
            continue
        i = int(bar_i[0])
        sub = g.iloc[: i + 1]
        m = int(r.m)
        closes = np.array([x.c.iloc[-1] for x in day_list])
        highs = np.array([x.h.max() for x in day_list])
        lows = np.array([x.l.min() for x in day_list])
        pcs21 = closes[k - 21 : k]
        tr = np.maximum(
            highs[k - 20 : k] - lows[k - 20 : k],
            np.maximum(abs(highs[k - 20 : k] - pcs21[:-1]), abs(lows[k - 20 : k] - pcs21[:-1])),
        ) / pcs21[:-1]
        atr = tr.mean()
        ret5 = closes[k - 1] / closes[k - 6] - 1 if k >= 6 else 0.0
        scores.append(risk_score(sub, m, atr, ret5))
    R["score"] = scores
    return R.dropna(subset=["score"])


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break

    with connect() as c:
        liquid = pd.read_sql(
            """select ticker, avg(v) av from optlab.bars_5m
               group by 1 having count(*)>5000 order by av desc""",
            c,
        )
        pool = liquid.ticker.tolist()
        uvr = __import__("a314_breadth", fromlist=["load_uvr"]).load_uvr(c)
        for t in pool[:120]:
            load_ticker_bars(c, t)

    results = []
    chosen: tuple[int, int, list[str]] | None = None
    for n in (20, 40, 80):
        ok_all = True
        for seed in (0, 1, 2):
            rng = np.random.default_rng(seed)
            pick = list(rng.choice(pool[: max(n * 3, n)], size=n, replace=False))
            with connect() as c:
                br = build_breadth(c, pick)
            R = rows_with_score(br, uvr)
            t1, t2 = logit_event_t(R, "H1"), logit_event_t(R, "H2")
            pass_seed = t1 == t1 and t2 == t2 and abs(t1) >= 2 and abs(t2) >= 2
            results.append((n, seed, t1, t2, pass_seed, pick))
            if not pass_seed:
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
        lines.append(f"\n**Live N={n}** (seed {seed}, liquid pool) · {len(tickers)} names → `A314-breadth-live-tickers.json`.")
        OUT_TICKERS.write_text(json.dumps({"n": n, "seed": seed, "tickers": tickers}, indent=2) + "\n")
    else:
        # fallback: top-20 liquid for Schwab lane
        tickers = pool[:20]
        lines.append(f"\n**Live fallback** top-20 liquid (no N passed all seeds).")
        OUT_TICKERS.write_text(json.dumps({"n": 20, "seed": -1, "tickers": tickers}, indent=2) + "\n")

    text = OUT_PACKET.read_text() if OUT_PACKET.is_file() else "# A314 family 2 — breadth & internals intraday\n"
    if "## Live subset gate" in text:
        text = text.split("## Live subset gate")[0].rstrip() + "\n"
    OUT_PACKET.write_text(text + "\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
