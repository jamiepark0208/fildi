"""S160 — does a per-stock RSI14 oversold threshold beat one global threshold? (Jamie 11-07)

Pre-registered (written before the run):
  Universe  = public.watchlist tickers in the LSE 2003 panel, plus SPY/QQQ.
  Event     = RSI14 (Wilder) closes below th; one event per name per 10 trading days.
  Entry     = next day's open (no look-ahead); exit = close h days after entry (h 5 primary, 10 secondary).
  Outcome   = return minus the stock's own mean return over the same span (train era), i.e. lift vs own base.
  Split     = train 2003-09..2018-12 picks thresholds; test 2019-01..now scores them (walk-forward, no refit).
  Methods   = G global th (best pooled train mean, n >= 300)
              R raw per-stock th (argmax own train mean, >= 5 events; else G)
              S shrunk per-stock th (empirical-Bayes: own mean shrunk toward pooled mean at that th; argmax; else G)
  Pass      = S beats G on test by >= 0.3 pp per event AND stock-bootstrap 90% CI of (S - G) > 0.
              Otherwise the global threshold stays and per-stock numbers are display-only notes.
Run: cd scripts/watchlist_sync && .venv/bin/python analysis/s160_rsi_per_stock.py [--h 5]
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
PANEL = Path.home() / ".fildi/cache/fast_screen_bars_2003.pkl"
OUT = HERE.parent.parent.parent / "research/studies/out/S160"
THS = [10, 15, 20, 25, 30, 35]
SPLIT = pd.Timestamp("2019-01-01")
MIN_EV = 5


def rsi(c: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    from quantcore.ta import rsi_frame  # one home (Jamie 11-15)
    return rsi_frame(c, n)


def watchlist() -> list[str]:
    from build_plan import connect
    with connect() as conn:
        return [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM public.watchlist")]


def events(r: np.ndarray, th: float) -> np.ndarray:
    """Indices where RSI < th, one per 10 bars (vectorized mask, then a light cooldown pass)."""
    idx = np.flatnonzero(r < th)
    keep, last = [], -99
    for i in idx:
        if i - last >= 10:
            keep.append(i)
            last = i
    return np.asarray(keep, dtype=int)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--h", type=int, default=5)
    ap.add_argument("--gth", type=int, default=0, help="sensitivity: force the global th")
    a = ap.parse_args()
    h = a.h
    d = pickle.load(open(PANEL, "rb"))
    o, c = d["o"], d["c"]
    tick = sorted((set(watchlist()) | {"SPY", "QQQ"}) & set(c.columns))
    o, c = o[tick], c[tick]
    R = rsi(c).to_numpy()
    O, C = o.to_numpy(), c.to_numpy()
    dates = c.index
    n = len(dates)
    test_mask = dates >= SPLIT
    # forward return entering next open, exiting close h days later
    fwd = np.full_like(C, np.nan)
    fwd[: n - h - 1] = C[h + 1:] / O[1: n - h] - 1
    base_tr = np.nanmean(np.where(~test_mask[:, None], fwd, np.nan), axis=0)
    # A369 fix2a review: names listed after SPLIT have no train-era base → excluded (reported), never NaN rows
    no_base = [t for j, t in enumerate(tick) if np.isnan(base_tr[j])]

    rows = []  # ticker, th, era, excess
    for j, t in enumerate(tick):
        if t in no_base:
            continue
        for th in THS:
            for i in events(R[:, j], th):
                x = fwd[i, j]
                if np.isnan(x):
                    continue
                te = bool(test_mask[i])
                rows.append((t, th, te, x - base_tr[j], str(dates[i].date())))
    ev = pd.DataFrame(rows, columns=["t", "th", "test", "ex", "date"])
    tr, te = ev[~ev.test], ev[ev.test]

    pooled = tr.groupby("th").ex.agg(["mean", "count", "var"])
    g_th = a.gth or int(pooled[pooled["count"] >= 300]["mean"].idxmax())
    st = tr.groupby(["t", "th"]).ex.agg(["mean", "count"]).reset_index()
    # empirical-Bayes shrink: tau2 = between-stock variance of means at each th (minus noise)
    shr = []
    for th, g in st.groupby("th"):
        noise = pooled.loc[th, "var"]
        m = g[g["count"] >= MIN_EV]
        tau2 = max(np.var(m["mean"]) - np.mean(noise / m["count"]), 1e-8) if len(m) > 3 else 1e-8
        w = tau2 / (tau2 + noise / g["count"])
        shr.append(g.assign(shr=w * g["mean"] + (1 - w) * pooled.loc[th, "mean"]))
    st = pd.concat(shr)
    ok = st[st["count"] >= MIN_EV]
    raw_th = ok.loc[ok.groupby("t")["mean"].idxmax()].set_index("t")["th"]
    shr_th = ok.loc[ok.groupby("t")["shr"].idxmax()].set_index("t")["th"]

    def score(pick: dict) -> pd.DataFrame:
        sel = te[te.apply(lambda r: pick.get(r.t, g_th) == r.th, axis=1)]
        return sel.groupby("t").ex.agg(["mean", "count"])

    G = score({})
    Rw = score(raw_th.to_dict())
    S = score(shr_th.to_dict())
    common = G.index.intersection(S.index).intersection(Rw.index)

    def boot(a: pd.DataFrame, b: pd.DataFrame) -> tuple[float, float, float]:
        rng = np.random.default_rng(0)
        names = np.array(common)
        diffs = []
        for _ in range(2000):
            s = rng.choice(names, len(names))
            da = (a.loc[s, "mean"] * a.loc[s, "count"]).sum() / a.loc[s, "count"].sum()
            db = (b.loc[s, "mean"] * b.loc[s, "count"]).sum() / b.loc[s, "count"].sum()
            diffs.append(da - db)
        pt = ((a.loc[common, "mean"] * a.loc[common, "count"]).sum() / a.loc[common, "count"].sum()
              - (b.loc[common, "mean"] * b.loc[common, "count"]).sum() / b.loc[common, "count"].sum())
        return pt, float(np.percentile(diffs, 5)), float(np.percentile(diffs, 95))

    def agg(x: pd.DataFrame) -> dict:
        x = x.loc[common]
        return {"mean_ex_pp": round(100 * (x["mean"] * x["count"]).sum() / x["count"].sum(), 3),
                "events": int(x["count"].sum())}

    res = {
        "h": h, "names": len(tick), "names_scored": len(common), "global_th": g_th,
        "excluded_no_train_base": len(no_base),
        "pooled_train": {int(k): {"mean_pp": round(100 * v["mean"], 3), "n": int(v["count"])}
                         for k, v in pooled.iterrows()},
        "pooled_test": {int(k): {"mean_pp": round(100 * v["mean"], 3), "n": int(v["count"]),
                                 "hit": round(float((g.ex > 0).mean()), 3)}
                        for k, g in te.groupby("th") for v in [g.ex.agg(["mean", "count"])]},
        "test_G": agg(G), "test_R": agg(Rw), "test_S": agg(S),
        "S_minus_G_pp": [round(100 * v, 3) for v in boot(S, G)],
        "R_minus_G_pp": [round(100 * v, 3) for v in boot(Rw, G)],
        "shrunk_th_counts": shr_th.value_counts().sort_index().to_dict(),
        "shrunk_th_moved_from_global": int((shr_th != g_th).sum()),
    }
    pt, lo, hi = res["S_minus_G_pp"]
    res["verdict"] = "PASS" if (pt >= 0.3 and lo > 0) else "FAIL (global threshold stays)"
    # per-stock table for notes: test-era lift at that stock's shrunk th
    per = []
    for t in common:
        th = int(shr_th.get(t, g_th))
        x = te[(te.t == t) & (te.th == th)].ex
        trn = st[(st.t == t) & (st.th == th)]
        per.append({"t": t, "th": th, "train_n": int(trn["count"].sum()), "train_pp": round(100 * float(trn["mean"].sum()), 2),
                    "test_n": int(len(x)), "test_pp": round(100 * float(x.mean()), 2) if len(x) else None,
                    "test_hit": round(float((x > 0).mean()), 2) if len(x) else None})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"result_h{h}_g{g_th}.json").write_text(json.dumps(res, indent=1, default=int))
    pd.DataFrame(per).sort_values("test_pp", ascending=False).to_csv(OUT / f"per_stock_h{h}.csv", index=False)
    print(json.dumps({k: v for k, v in res.items() if k not in ("pooled_train",)}, default=int))


if __name__ == "__main__":
    main()
