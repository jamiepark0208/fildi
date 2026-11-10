"""S182 — Kronos as a COMPONENT for proven short puts (Jamie 11-10: 'find a use case, break the ask down').

Not "does Kronos predict returns" (S180/S181: no). The paper's own claim is volatility (9 % lower MAE). The put edge here
is IV vs how the stock actually moves (S003/S004), so test whether Kronos path dispersion is a better "how it moves"
input than RV20 / HAR, and whether its path tails help a meta-label (skip/keep) on the proven put entries.

Data: s182_dump_trades.py (S003 grain, monthly 30-DTE 0.20Δ puts, 49 names = Jamie's 11 + 40 richest IV/RV).
Entries ≥ 2024-07-01 only (Kronos pretrain cutoff → no memorised prices). Kronos-small zero-shot, 400-bar daily OHLCV
lookback, 32 sampled paths per trade, horizon = trade's own sessions to exit.
Features: k_rv (mean path realized vol), k_pitm (share of paths ending < K, drift removed — S181 bias), k_q05.
Comparators: RV20, HAR (log-HAR pooled fit on these names, target window ended before 2024-07), IV.

Pre-registered (written before the run):
 A vol: k_rv QLIKE ≤ 0.95 × HAR QLIKE, month-cluster bootstrap CI of the difference < 0. Also blend (√(HAR·k_rv)).
 B rank: within-month Spearman IC of IV/k_rv on ret_ra beats IV/RV20 by ≥ 0.02, t ≥ 2 over months (S033 bar).
 C meta-label: walk-forward logistic on 'tail_ra' (loss > 1σ): base feats vs base + Kronos feats; skip the worst
   predicted fifth; pass = kept-trade mean ret_ra lift over base model's kept set, month t ≥ 2; and Brier(k_pitm) <
   Brier(BS-implied P(ITM)).
Small n (~28 months) → any pass = UNDERPOWERED-promising, not a ship.
"""
from __future__ import annotations

import math
import pickle
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import torch

sys.path.insert(0, str(Path.home() / ".fildi/kronos/repo"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402
from s180_kronos_calls import dsn  # noqa: E402

CUT = pd.Timestamp("2024-07-01")
LOOK = int(sys.argv[sys.argv.index("--look") + 1]) if "--look" in sys.argv else 400
PATHS, BATCH = 16, 128
COLS = ["open", "high", "low", "close", "volume", "amount"]
CACHE = Path.home() / f".fildi/cache/s182_kronos_feats_L{LOOK}.pkl"
SMOKE = "--smoke" in sys.argv


def ohlcv(conn, t):
    r = conn.execute("""SELECT date, open, high, low, close, volume FROM lseg_research.daily_history WHERE ticker = %s
                        AND close > 0 AND open > 0 AND high > 0 AND low > 0 ORDER BY date""", (t,)).fetchall()
    df = pd.DataFrame(r, columns=["date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df["volume"] = df["volume"].fillna(0)
    df["amount"] = df["close"] * df["volume"]
    return df


def run_kronos(trades, dfs):
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    pred = KronosPredictor(mdl, tok, device=dev, max_context=512)
    jobs = []
    for k, tr in enumerate(trades):
        df = dfs[tr["ticker"]]
        e, x = pd.Timestamp(tr["entry"]), pd.Timestamp(tr["exit"])
        h = df[df["date"] <= e].iloc[-LOOK:]
        n = int(((df["date"] > e) & (df["date"] <= x)).sum())
        if len(h) < LOOK or n < 5:
            continue
        jobs.append((k, h, n))
    by_n = defaultdict(list)                      # predict_batch needs one pred_len per call
    for j in jobs:
        by_n[j[2]].append(j)
    out, t0, done = {}, time.time(), 0
    for n, js in by_n.items():
        flat = [(k, h) for k, h, _ in js for _ in range(PATHS)]
        for i in range(0, len(flat), BATCH):
            chunk = flat[i:i + BATCH]
            xs = [h["date"].reset_index(drop=True) for _, h in chunk]
            ys = [pd.Series(pd.bdate_range(x.iloc[-1] + pd.Timedelta(days=1), periods=n)) for x in xs]
            res = pred.predict_batch([h[COLS].reset_index(drop=True) for _, h in chunk], xs, ys,
                                     pred_len=n, sample_count=1, verbose=False)
            for (k, h), q in zip(chunk, res):
                c = np.concatenate([[h["close"].iloc[-1]], q["close"].values.astype(float)])
                out.setdefault(k, []).append(c)
            done += len(chunk)
            print(f"  {done}/{len(jobs) * PATHS} paths · {time.time() - t0:.0f}s", flush=True)
    return out


def feats(tr, paths):
    P = np.array(paths)                           # PATHS × (n+1)
    lr = np.diff(np.log(np.maximum(P, 1e-6)), axis=1)
    rv = lr[:, 1:].std(1, ddof=1) * math.sqrt(252)       # skip step 1 (gap from last real close)
    term = lr.sum(1)
    term_dm = term - term.mean()                  # drift removed (S181: zero-shot drift bias)
    thr = math.log(tr["K"] / tr["S"])
    return {"k_rv": float(rv.mean()), "k_pitm": float((term_dm < thr).mean()), "k_pitm_raw": float((term < thr).mean()),
            "k_q05": float(np.quantile(term_dm, 0.05)), "k_drift": float(term.mean()), "k_gap": float(np.abs(lr[:, 0]).mean())}


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def spearman(a, b):
    ra, rb = pd.Series(a).rank().values, pd.Series(b).rank().values
    return float(np.corrcoef(ra, rb)[0, 1])


def boot_ci(diff_by_month, reps=2000, seed=0):
    rng = np.random.default_rng(seed); ms = list(diff_by_month)
    v = [np.mean([x for m in rng.choice(ms, len(ms)) for x in diff_by_month[m]]) for _ in range(reps)]
    return float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))


def har_fit(hist, names):
    X, Y = [], []
    for t in names:
        s = hist[t]; ds = [d for d, *_ in s]; cl = np.array([x[1] for x in s], float)
        lr = np.concatenate([[np.nan], np.diff(np.log(cl))])
        for i in range(23, len(cl) - 21, 5):
            if pd.Timestamp(ds[i + 21]) >= CUT:
                break
            X.append(har_x(lr, i)); Y.append(math.log(np.std(lr[i + 1:i + 22], ddof=1) * math.sqrt(252) + 1e-4))
    X, Y = np.array(X), np.array(Y)
    return np.linalg.lstsq(X, Y, rcond=None)[0], float(np.var(Y - X @ np.linalg.lstsq(X, Y, rcond=None)[0]))


def har_x(lr, i):
    rd = abs(lr[i]) * math.sqrt(252) + 1e-4
    r5 = np.std(lr[i - 4:i + 1], ddof=1) * math.sqrt(252) + 1e-4
    r22 = np.std(lr[i - 21:i + 1], ddof=1) * math.sqrt(252) + 1e-4
    return (1.0, math.log(rd), math.log(r5), math.log(r22))


def main():
    D = pickle.load(open(Path.home() / ".fildi/cache/s182_trades.pkl", "rb"))
    trades = [t for t in D["trades"] if pd.Timestamp(t["entry"]) >= CUT and t.get("iv_rv")]
    if SMOKE:
        trades = [t for t in trades if t["ticker"] in ("HOOD", "NVDA")][:8]
    print(f"{len(trades)} trades ≥ {CUT.date()} on {len({t['ticker'] for t in trades})} names")
    with psycopg.connect(dsn()) as c:
        dfs = {t: ohlcv(c, t) for t in {t["ticker"] for t in trades}}
    key = (len(trades), PATHS, SMOKE)
    cached = pickle.load(open(CACHE, "rb")) if CACHE.exists() else None
    if cached and cached["key"] == key:
        paths = cached["paths"]
    else:
        paths = run_kronos(trades, dfs)
        if not SMOKE:
            pickle.dump({"key": key, "paths": paths}, open(CACHE, "wb"))

    beta, s2 = har_fit(D["hist"], D["names"])
    rows = []
    for k, tr in enumerate(trades):
        if k not in paths:
            continue
        df = dfs[tr["ticker"]]; e, x = pd.Timestamp(tr["entry"]), pd.Timestamp(tr["exit"])
        cl = df["close"].values; ds = df["date"]
        i = int((ds <= e).sum()) - 1; j = int((ds <= x).sum()) - 1
        lr = np.concatenate([[np.nan], np.diff(np.log(cl))])
        if j - i < 5 or i < 23:
            continue
        rv_real = float(np.std(lr[i + 1:j + 1], ddof=1) * math.sqrt(252))
        ivd = tr["iv"] / 100 if tr["iv"] > 3 else tr["iv"]   # trades store IV in percent
        rv20 = ivd / tr["iv_rv"]
        har = math.exp(float(np.dot(beta, har_x(lr, i))) + s2 / 2)
        T = (j - i) / 252; iv = ivd
        d2 = (math.log(tr["S"] / tr["K"]) - 0.5 * iv * iv * T) / (iv * math.sqrt(T))
        rows.append({**{k2: tr[k2] for k2 in ("ticker", "entry", "ret_ra", "ret", "tail_ra", "assigned", "iv", "iv_rv",
                                              "mom20", "dist_ma50", "rsi14", "earnings_in_window", "iv_rank_1y")},
                     "month": str(tr["entry"])[:7], "rv_real": rv_real, "rv20": rv20, "har": har,
                     "p_impl": ncdf(-d2), "iv": ivd, **feats(tr, paths[k])})
    R = pd.DataFrame(rows)
    print(f"scored {len(R)} trades · {R['month'].nunique()} months · Jamie names {R['ticker'].isin(D['jamie']).sum()}")
    if SMOKE:
        print(R[["ticker", "entry", "rv_real", "rv20", "har", "iv", "k_rv", "k_pitm", "p_impl", "k_drift", "k_gap"]].to_string()); return

    # A — vol accuracy
    print("\nA. realized-vol forecast (QLIKE = rv²/f² − ln(rv²/f²) − 1, lower better; log-RMSE)")
    R["blend"] = np.sqrt(R["har"] * R["k_rv"])
    R["k_rv_cal"] = R["k_rv"] * np.exp(np.mean(np.log(R["rv_real"] / R["k_rv"])))   # in-sample scale (upper bound)
    q = {}
    for f in ["rv20", "har", "iv", "k_rv", "k_rv_cal", "blend"]:
        z = (R["rv_real"] / R[f]) ** 2
        R["q_" + f] = z - np.log(z) - 1
        q[f] = R["q_" + f].mean()
        print(f"  {f:9s} QLIKE {q[f]:.3f} · log-RMSE {np.sqrt((np.log(R['rv_real'] / R[f]) ** 2).mean()):.3f} · "
              f"corr(log) {np.corrcoef(np.log(R[f]), np.log(R['rv_real']))[0, 1]:+.2f}")
    for f in ["k_rv", "blend"]:
        dm = defaultdict(list)
        for m, a, b in zip(R["month"], R["q_" + f], R["q_har"]):
            dm[m].append(a - b)
        lo, hi = boot_ci(dm)
        print(f"  {f} − HAR QLIKE {q[f] - q['har']:+.3f} (ratio {q[f] / q['har']:.2f}) CI [{lo:+.3f}, {hi:+.3f}]")

    # B — put ranking within month
    print("\nB. within-month Spearman IC on ret_ra (higher = better put picker)")
    for name, f in [("IV/RV20", R["iv"] / R["rv20"]), ("IV/HAR", R["iv"] / R["har"]), ("IV/k_rv", R["iv"] / R["k_rv"]),
                    ("IV/blend", R["iv"] / R["blend"]), ("−k_pitm", -R["k_pitm"]), ("−k_drift", -R["k_drift"])]:
        R["_f"] = f
        ics = [spearman(g["_f"], g["ret_ra"]) for _, g in R.groupby("month") if len(g) >= 10]
        R.attrs[name] = ics
        print(f"  {name:9s} IC {np.mean(ics):+.3f} (t {np.mean(ics) / (np.std(ics, ddof=1) / math.sqrt(len(ics))):+.2f}, {len(ics)} mo)")
    for name in ["IV/k_rv", "IV/blend"]:
        d = np.array(R.attrs[name]) - np.array(R.attrs["IV/RV20"])
        print(f"  {name} − IV/RV20 ΔIC {d.mean():+.3f} t {d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.2f}")

    # C — tail probability + meta-label
    y = R["assigned"].astype(float)
    print(f"\nC. P(ITM at expiry): base rate {y.mean():.3f} · Brier implied {((R['p_impl'] - y) ** 2).mean():.4f} · "
          f"k_pitm {((R['k_pitm'] - y) ** 2).mean():.4f} · k_pitm_raw {((R['k_pitm_raw'] - y) ** 2).mean():.4f} · "
          f"climatology {((y.mean() - y) ** 2).mean():.4f}")
    metalabel(R)
    jam = R[R["ticker"].isin(D["jamie"])]
    print(f"\nJamie names only (n {len(jam)}): QLIKE har {jam['q_har'].mean():.3f} vs k_rv {jam['q_k_rv'].mean():.3f} vs "
          f"blend {jam['q_blend'].mean():.3f}")
    R.to_pickle(Path.home() / ".fildi/cache/s182_scored.pkl")


def metalabel(R):
    from sklearn.linear_model import LogisticRegression
    base = ["iv_rv", "mom20", "dist_ma50", "rsi14", "earnings_in_window", "iv_rank_1y"]
    kron = base + ["k_rv_ratio", "k_pitm", "k_q05"]
    R = R.copy(); R["k_rv_ratio"] = R["iv"] / R["k_rv"]
    for c in kron:
        R[c] = R[c].astype(float).fillna(R[c].astype(float).median())
    months = sorted(R["month"].unique())
    res = defaultdict(list)
    for m in months[10:]:
        tr, te = R[R["month"] < m], R[R["month"] == m]
        if len(te) < 10:
            continue
        for name, cols in [("base", base), ("+kronos", kron)]:
            X = tr[cols].values; mu, sd = X.mean(0), X.std(0) + 1e-9
            clf = LogisticRegression(C=0.5, max_iter=500).fit((X - mu) / sd, tr["tail_ra"].astype(int))
            p = clf.predict_proba((te[cols].values - mu) / sd)[:, 1]
            keep = p <= np.quantile(p, 0.8)
            res[name].append(te["ret_ra"].values[keep].mean())
        res["all"].append(te["ret_ra"].mean())
    a, b, k = (np.array(res[n]) for n in ("all", "base", "+kronos"))
    t = lambda d: d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))
    print(f"  meta-label skip worst fifth ({len(a)} test months): all {a.mean():+.3f} · base kept {b.mean():+.3f} "
          f"(vs all t {t(b - a):+.2f}) · +kronos kept {k.mean():+.3f} (vs base t {t(k - b):+.2f})")


if __name__ == "__main__":
    main()
