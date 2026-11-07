"""A369 per-stock threshold lens — generalised S160 walk-forward (global / raw / shrunk)."""
from __future__ import annotations

import json
import pickle
import subprocess
import sys
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
REPO = WATCH.parent.parent
PANEL_2003 = Path.home() / ".fildi/cache/fast_screen_bars_2003.pkl"
SPLIT = pd.Timestamp("2019-01-01")
DEFAULT_THS = (10, 15, 20, 25, 30, 35)
MIN_EV = 5
COOLDOWN = 10


def cooldown_events(level: np.ndarray, th: float, cooldown: int = COOLDOWN) -> np.ndarray:
    idx = np.flatnonzero(level < th)
    keep, last = [], -99
    for i in idx:
        if i - last >= cooldown:
            keep.append(i)
            last = i
    return np.asarray(keep, dtype=int)


def fwd_open_close(o: np.ndarray, c: np.ndarray, h: int) -> np.ndarray:
    n = o.shape[0]
    out = np.full_like(c, np.nan)
    out[: n - h - 1] = c[h + 1 :] / o[1 : n - h] - 1.0
    return out


def watchlist_tickers() -> list[str]:
    from build_plan import connect

    with connect() as conn:
        return [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM public.watchlist")]


def run_threshold_lens(
    signal: np.ndarray,
    o: np.ndarray,
    c: np.ndarray,
    dates: pd.DatetimeIndex,
    tickers: list[str],
    *,
    ths: tuple[float, ...] = DEFAULT_THS,
    h: int = 5,
    force_g_th: int | None = None,
    min_ev: int = MIN_EV,
    cooldown: int = COOLDOWN,
) -> dict:
    """Walk-forward per-stock threshold pick (S160 logic). signal shape T×N."""
    test_mask = dates >= SPLIT
    fwd = fwd_open_close(o, c, h)
    base_tr = np.nanmean(np.where(~test_mask[:, None], fwd, np.nan), axis=0)
    base_te = np.nanmean(np.where(test_mask[:, None], fwd, np.nan), axis=0)

    rows: list[tuple] = []
    for j, _t in enumerate(tickers):
        for th in ths:
            for i in cooldown_events(signal[:, j], th, cooldown):
                x = fwd[i, j]
                if np.isnan(x):
                    continue
                te = bool(test_mask[i])
                base = base_te[j] if te else base_tr[j]
                rows.append((_t, th, te, x - base, str(dates[i].date())))
    ev = pd.DataFrame(rows, columns=["t", "th", "test", "ex", "date"])
    tr, te = ev[~ev.test], ev[ev.test]

    pooled = tr.groupby("th").ex.agg(["mean", "count", "var"])
    if pooled.empty:
        return {"error": "no train events"}
    g_th = force_g_th or int(pooled[pooled["count"] >= 300]["mean"].idxmax())
    st = tr.groupby(["t", "th"]).ex.agg(["mean", "count"]).reset_index()
    shr_parts = []
    for th, g in st.groupby("th"):
        noise = float(pooled.loc[th, "var"])
        m = g[g["count"] >= min_ev]
        tau2 = max(np.var(m["mean"]) - np.mean(noise / m["count"]), 1e-8) if len(m) > 3 else 1e-8
        w = tau2 / (tau2 + noise / g["count"])
        shr_parts.append(g.assign(shr=w * g["mean"] + (1 - w) * pooled.loc[th, "mean"]))
    st = pd.concat(shr_parts)
    ok = st[st["count"] >= min_ev]
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
        "h": h,
        "names": len(tickers),
        "names_scored": len(common),
        "global_th": g_th,
        "pooled_test": {
            int(k): {"mean_pp": round(100 * v["mean"], 3), "n": int(v["count"])}
            for k, v in te.groupby("th").ex.agg(["mean", "count"]).iterrows()
        },
        "test_G": agg(G),
        "test_R": agg(Rw),
        "test_S": agg(S),
        "S_minus_G_pp": [round(100 * v, 3) for v in boot(S, G)],
        "R_minus_G_pp": [round(100 * v, 3) for v in boot(Rw, G)],
        "shrunk_th_counts": shr_th.value_counts().sort_index().to_dict(),
        "verdict": "",
        "per_stock": [],
    }
    pt, lo, hi = res["S_minus_G_pp"]
    res["verdict"] = "PASS" if (pt >= 0.3 and lo > 0) else "FAIL (global threshold stays)"
    for t in common:
        th = int(shr_th.get(t, g_th))
        x = te[(te.t == t) & (te.th == th)].ex
        trn = st[(st.t == t) & (st.th == th)]
        res["per_stock"].append({
            "t": t, "th": th,
            "train_n": int(trn["count"].sum()),
            "test_n": int(len(x)),
            "test_pp": round(100 * float(x.mean()), 2) if len(x) else None,
        })
    return res


def load_panel_2003(tickers: list[str] | None = None) -> tuple[pd.DatetimeIndex, list[str], np.ndarray, np.ndarray, np.ndarray]:
    raw = pickle.loads(PANEL_2003.read_bytes())
    o, c = raw["o"], raw["c"]
    wl = sorted((set(watchlist_tickers()) | {"SPY", "QQQ"}) & set(c.columns))
    if tickers:
        wl = [t for t in tickers if t in c.columns]
    o, c = o[wl], c[wl]
    return c.index, wl, o.to_numpy(), c.to_numpy(), wl


def rsi_wilder(close: np.ndarray, n: int = 14) -> np.ndarray:
    d = pd.DataFrame(close).diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return (100 - 100 / (1 + up / dn)).to_numpy()


def lens_from_signal_builder(
    builder: Callable[[np.ndarray], np.ndarray],
    *,
    h: int = 5,
    force_g_th: int | None = None,
    tickers: list[str] | None = None,
) -> dict:
    dates, tickers_out, o, c, _ = load_panel_2003(tickers)
    sig = builder(c)
    return run_threshold_lens(sig, o, c, dates, tickers_out, h=h, force_g_th=force_g_th)


def lens_rsi14_h5(force_g_th: int = 25) -> dict:
    return lens_from_signal_builder(lambda c: rsi_wilder(c, 14), h=5, force_g_th=force_g_th)


def write_stock_notes(per: list[dict], *, src: str = "S160", author: str = "cursor") -> int:
    script = REPO / "scripts" / "stock_notes.py"
    n = 0
    for row in per:
        if row.get("test_n", 0) < 3 or row.get("test_pp") is None:
            continue
        body = (
            f"RSI lens h5 th{row['th']}: test-era lift {row['test_pp']:+.2f}pp "
            f"(n={row['test_n']}, train_n={row['train_n']})"
        )
        if len(body) > 280:
            body = body[:277] + "..."
        cmd = [sys.executable, str(script), "add", row["t"], "backtest", body, "--src", src, "--author", author]
        try:
            subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=30)
            n += 1
        except Exception:
            pass
    return n


def s160_acceptance_ok(res: dict, *, g_th: int = 25) -> tuple[bool, str]:
    """Acceptance (a): global 25 +1.98pp n242; S−G −0.74pp ±0.05."""
    if res.get("global_th") != g_th:
        return False, f"global_th={res.get('global_th')}"
    pt = res["pooled_test"].get(g_th, {})
    g_pp, g_n = pt.get("mean_pp"), pt.get("n")
    ok_g = g_pp is not None and abs(g_pp - 1.983) <= 0.05 and g_n == 242
    sg = res["S_minus_G_pp"][0]
    ok_s = abs(sg - (-0.737)) <= 0.05
    return ok_g and ok_s, f"G25={g_pp}pp n={g_n} S-G={sg}pp"
