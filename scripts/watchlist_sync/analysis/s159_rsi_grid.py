"""S159 — RSI extreme grid (Jamie 11-06: rare = opportunity; test many combinations).
Entry: first close where RSI(p) < th (cross), long next open, hold h days, 5 bp/side.
Day-clustered stats (N_eff = signal days): each signal day = mean of its trades.
Lift = trade return − same ticker's every-day return over the same hold.
Win CI = Wilson on day-level wins. BH-FDR over all cells on day-level lift t.
Also: SPY RSI(p) < th as a market condition → buy every stock that day (and SPY alone).
2003→ panel: --panel ~/.fildi/cache/fast_screen_bars_2003.pkl (LSE, split-adjusted).

Usage: .venv/bin/python -I analysis/s159_rsi_grid.py [--panel PATH] [--min-days N]
"""
from __future__ import annotations

import argparse
import math
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from analysis.s045_put_retest import bs_put  # noqa: E402
from analysis.a352_score_rank import put_delta  # noqa: E402

DEFAULT_PANEL = Path.home() / ".fildi/cache/fast_screen_bars.pkl"
PANEL_2003 = Path.home() / ".fildi/cache/fast_screen_bars_2003.pkl"
COST = 0.001
HOLDS = [1, 2, 3, 5, 10, 20]
TH = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 35]
MKT_RSI_TH = [20, 22.5, 25, 27.5, 30]
STOCK_RSI_TH = [5, 7.5, 10, 12.5, 15]
ERAS = (
    ("03-07", np.datetime64("2003-01-01"), np.datetime64("2008-01-01")),
    ("08-12", np.datetime64("2008-01-01"), np.datetime64("2013-01-01")),
    ("13-19", np.datetime64("2013-01-01"), np.datetime64("2020-01-01")),
    ("20-26", np.datetime64("2020-01-01"), np.datetime64("2031-01-01")),
)
PUT_DTE = 10
PUT_DELTAS = (0.20, 0.30)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--panel", type=Path, default=DEFAULT_PANEL)
    ap.add_argument("--min-days", type=int, default=8)
    return ap.parse_args()


def rsi(c, n):
    from quantcore.ta import rsi_frame  # one home (Jamie 11-15)
    return rsi_frame(c, n)


def wilson_lo(k, n, z=1.96):
    if n == 0:
        return float("nan")
    p = k / n
    return (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def rv20_iv_proxy(c: pd.Series) -> pd.Series:
    lr = np.log(c / c.shift(1))
    rv = lr.rolling(20).std() * math.sqrt(252)
    return (rv * 1.2).clip(lower=0.05)


def strike_for_put_delta(spot: float, iv: float, dte: int, target: float) -> float:
    if spot <= 0 or iv <= 0:
        return spot * 0.9
    t = dte / 365.0
    lo, hi = spot * 0.5, spot
    for _ in range(48):
        k = (lo + hi) / 2
        dlt = put_delta(spot, k, iv, t)
        if dlt is None:
            break
        if dlt > -target:
            lo, hi = k, hi
        else:
            lo, hi = lo, k
    return (lo + hi) / 2


def cross_mask(series: np.ndarray, th: float, *, gt: bool = False) -> np.ndarray:
    prv = np.r_[np.nan, series[:-1]]
    if gt:
        return (series > th) & ~(prv > th)
    return (series < th) & ~(prv < th)


def era_lifts(g: pd.DataFrame, dates: pd.DatetimeIndex) -> dict:
    out = {}
    day_dates = dates.values[g.index.to_numpy()]
    for tag, d0, d1 in ERAS:
        m = (day_dates >= d0) & (day_dates < d1)
        sub = g[m]
        out[f"era_{tag}"] = sub["lift"].mean() if len(sub) else np.nan
        out[f"eraN_{tag}"] = len(sub)
    return out


def make_cell_fn(FWD, TBASE, dates, SPLIT_LEGACY):
    def cell(mask, h, *, extra=None):
        f = FWD[h]
        ok = mask & np.isfinite(f)
        rows, cols = np.nonzero(ok)
        if len(rows) == 0:
            return None
        ret = f[rows, cols]
        lift = ret - TBASE[h][cols]
        df = pd.DataFrame({"d": rows, "ret": ret, "lift": lift})
        g = df.groupby("d").mean()
        nd = len(g)
        if nd < 2:
            return None
        wins = int((g["ret"] > 0).sum())
        lt = g["lift"].mean() / (g["lift"].std(ddof=1) / math.sqrt(nd)) if g["lift"].std(ddof=1) > 0 else 0.0
        pre, post = g[g.index < SPLIT_LEGACY], g[g.index >= SPLIT_LEGACY]
        row = dict(
            n=len(ret), days=nd, win_trade=(ret > 0).mean(), win_day=wins / nd, win_lo=wilson_lo(wins, nd),
            mean=g["ret"].mean(), lift=g["lift"].mean(), t=lt,
            p5=np.percentile(ret, 5), pre=pre["lift"].mean() if len(pre) else np.nan,
            post=post["lift"].mean() if len(post) else np.nan, npre=len(pre), npost=len(post),
        )
        row.update(era_lifts(g, dates))
        if extra:
            row.update(extra)
        return row

    return cell


def put_grid(C, O, tickers: list[str], dlt: float) -> dict[str, dict[int, np.ndarray]]:
    put_by_t: dict[str, dict[int, np.ndarray]] = {}
    for t in tickers:
        if t not in C.columns:
            continue
        o_np = O[t].to_numpy()
        c_np_t = C[t].to_numpy()
        n = len(c_np_t)
        iv_s = rv20_iv_proxy(C[t]).to_numpy()
        mats = {h: np.full(n, np.nan) for h in HOLDS}
        for i in range(20, n - max(HOLDS) - 2):
            spot_e = o_np[i + 1]
            iv_e = iv_s[i]
            if not (np.isfinite(spot_e) and spot_e > 0 and iv_e > 0):
                continue
            K = strike_for_put_delta(spot_e, iv_e, PUT_DTE, dlt)
            cred = bs_put(spot_e, K, iv_e, PUT_DTE / 365.0)
            for h in HOLDS:
                # Same exit as the stock leg: open[i+1] → close[i+h]. Elapsed sessions = h-1.
                spot_x = c_np_t[i + h]
                elapsed = h - 1
                if np.isfinite(spot_x) and cred > 0:
                    if elapsed >= PUT_DTE:
                        mark = max(K - spot_x, 0.0)
                    else:
                        rem = max(PUT_DTE - elapsed, 1) / 365.0
                        mark = bs_put(spot_x, K, iv_e, rem)
                    mats[h][i] = (cred - mark) / K - COST
        put_by_t[t] = mats
    return put_by_t


def stress_put_rows(day: np.ndarray, put_by_t, tickers, valid, C, dates, h, label: str) -> dict | None:
    di = np.where(day)[0]
    if len(di) < 2:
        return None
    base_put = {t: float(np.nanmean(put_by_t[t][h])) for t in tickers if t in put_by_t}
    day_ids, day_rets, day_lifts = [], [], []
    all_rets = []
    for i in di:
        rs, lifts = [], []
        for t in tickers:
            if t not in put_by_t:
                continue
            j = C.columns.get_loc(t)
            if not valid[i, j]:
                continue
            r = put_by_t[t][h][i]
            if np.isfinite(r):
                rs.append(r)
                all_rets.append(r)
                lifts.append(r - base_put[t])
        if rs:
            day_ids.append(i)
            day_rets.append(np.mean(rs))
            day_lifts.append(np.mean(lifts))
    if len(day_rets) < 2:
        return None
    nd = len(day_rets)
    dm = np.array(day_rets)
    dl = np.array(day_lifts)
    wins = int((dm > 0).sum())
    lt = dm.mean() / (dm.std(ddof=1) / math.sqrt(nd)) if dm.std(ddof=1) > 0 else 0.0
    row = dict(
        cond=label, h=h, n=len(all_rets), days=nd, win_trade=(np.array(all_rets) > 0).mean(), win_day=wins / nd,
        win_lo=wilson_lo(wins, nd), mean=dm.mean(), lift=dl.mean(), t=lt, p5=np.percentile(all_rets, 5),
        pre=np.nan, post=np.nan, npre=0, npost=0,
    )
    for tag, d0, d1 in ERAS:
        era_idx = [k for k, i in enumerate(day_ids) if d0 <= dates.values[i] < d1]
        if era_idx:
            row[f"era_{tag}"] = float(np.mean([day_lifts[k] for k in era_idx]))
            row[f"eraN_{tag}"] = len(era_idx)
        else:
            row[f"era_{tag}"] = np.nan
            row[f"eraN_{tag}"] = 0
    return row


def main():
    args = parse_args()
    pack = pickle.load(open(args.panel, "rb"))
    O, C = pack["o"], pack["c"]
    dates = C.index
    SPLIT_LEGACY = np.searchsorted(dates.values, np.datetime64("2022-01-01"))
    FWD = {h: (C.shift(-h) / O.shift(-1) - 1 - COST).to_numpy() for h in HOLDS}
    TBASE = {h: np.nanmean(FWD[h], axis=0) for h in HOLDS}
    c_np = C.to_numpy()
    valid = np.isfinite(c_np) & (c_np > 1.0)
    if "VIX" in C.columns:
        valid[:, C.columns.get_loc("VIX")] = False
    cell = make_cell_fn(FWD, TBASE, dates, SPLIT_LEGACY)
    MIN_DAYS = args.min_days
    out = []

    for p in [2, 3, 5, 7, 14]:
        R = C.apply(lambda s: rsi(s, p)).to_numpy()
        prev = np.vstack([np.full((1, R.shape[1]), np.nan), R[:-1]])
        for th in TH:
            cross = (R < th) & ~(prev < th) & valid
            for h in HOLDS:
                s = cell(cross, h)
                if s and s["days"] >= MIN_DAYS:
                    out.append(dict(cond=f"stock RSI{p}<{th}", h=h, **s))

    spy_r14 = rsi(C["SPY"], 14).to_numpy() if "SPY" in C.columns else None
    for sym in [s for s in ("SPY", "QQQ") if s in C.columns]:
        rs = rsi(C[sym], 14).to_numpy()
        for th in MKT_RSI_TH:
            day = cross_mask(rs, th)
            if day.sum() < 2:
                continue
            m_all = np.zeros_like(valid)
            m_all[day, :] = True
            m_all &= valid
            ci = C.columns.get_loc(sym)
            m_idx = np.zeros_like(valid)
            m_idx[day, ci] = True
            for h in HOLDS:
                for tag, m in ((f"{sym} RSI14<{th} → all stocks", m_all), (f"{sym} RSI14<{th} → {sym}", m_idx)):
                    s = cell(m, h)
                    if s and s["days"] >= 3:
                        out.append(dict(cond=tag, h=h, **s))

    if "VIX" in C.columns:
        vx = C["VIX"].to_numpy()
        for th in (30, 40):
            day = cross_mask(vx, th, gt=True)
            if day.sum() < 2:
                continue
            m_all = np.zeros_like(valid)
            m_all[day, :] = True
            m_all &= valid
            for h in HOLDS:
                s = cell(m_all, h)
                if s and s["days"] >= 3:
                    out.append(dict(cond=f"VIX>{th} → all stocks", h=h, **s))

    R14 = C.apply(lambda s: rsi(s, 14)).to_numpy()
    prev14 = np.vstack([np.full((1, R14.shape[1]), np.nan), R14[:-1]])
    stock_os = R14 < 20
    stock_not_os = ~stock_os
    for sym in [s for s in ("SPY", "QQQ") if s in C.columns]:
        mrs = rsi(C[sym], 14).to_numpy()
        for mth in MKT_RSI_TH:
            mkt_day = cross_mask(mrs, mth)
            if mkt_day.sum() < 2:
                continue
            for tag, stk_mask in (
                (f"{sym} RSI14<{mth} & stock RSI14<20", stock_os),
                (f"{sym} RSI14<{mth} & stock RSI14≥20", stock_not_os),
            ):
                m = mkt_day[:, None] & stk_mask & valid
                for h in HOLDS:
                    s = cell(m, h)
                    if s and s["days"] >= MIN_DAYS:
                        out.append(dict(cond=tag, h=h, **s))

    # Original SPY RSI grid (periods 2,5,14)
    if "SPY" in C.columns:
        for p in [2, 5, 14]:
            rs = rsi(C["SPY"], p).to_numpy()
            prv = np.r_[np.nan, rs[:-1]]
            for th in TH:
                day = (rs < th) & ~(prv < th)
                if day.sum() < 2:
                    continue
                m_all = np.zeros_like(valid)
                m_all[day, :] = True
                m_all &= valid
                m_spy = np.zeros_like(valid)
                m_spy[day, C.columns.get_loc("SPY")] = True
                for h in HOLDS:
                    for tag, m in (("SPY RSI{}<{} → all stocks", m_all), ("SPY RSI{}<{} → SPY", m_spy)):
                        s = cell(m, h)
                        if s and s["days"] >= 3:
                            out.append(dict(cond=tag.format(p, th), h=h, **s))

    tickers = [t for t in C.columns if t != "VIX"]
    stress_days: dict[str, np.ndarray] = {}
    for sym in [s for s in ("SPY", "QQQ") if s in C.columns]:
        rs = rsi(C[sym], 14).to_numpy()
        for th in MKT_RSI_TH:
            stress_days[f"{sym} RSI14<{th}"] = cross_mask(rs, th)
    if "VIX" in C.columns:
        vx = C["VIX"].to_numpy()
        for th in (30, 40):
            stress_days[f"VIX>{th}"] = cross_mask(vx, th, gt=True)

    for dlt in PUT_DELTAS:
        put_by_t = put_grid(C, O, tickers, dlt)
        for base, day in stress_days.items():
            for h in HOLDS:
                row = stress_put_rows(
                    day, put_by_t, tickers, valid, C, dates, h,
                    f"{base} → short {dlt:.2f}Δ put (BS RV20×1.2 IV, {PUT_DTE}d)",
                )
                if row and row["days"] >= 3:
                    out.append(row)

    df = pd.DataFrame(out)
    df["p"] = 2 * (1 - norm.cdf(df["t"].abs()))
    df = df.sort_values("p").reset_index(drop=True)
    m = len(df)
    df["q"] = (df["p"] * m / (np.arange(m) + 1))[::-1].cummin()[::-1].clip(upper=1)
    out_path = ROOT / "research/studies/out/s159_rsi_grid.csv"
    df.to_csv(out_path, index=False)

    print(f"panel {args.panel.name} window {dates[0].date()}→{dates[-1].date()} tickers {C.shape[1]} cells {m} (min {MIN_DAYS} signal days)")
    cols = ["cond", "h", "n", "days", "win_trade", "win_day", "win_lo", "mean", "lift", "t", "q", "p5", "pre", "post"]
    pd.set_option("display.width", 250, "display.max_columns", 30, "display.max_rows", 200)
    fmt = lambda d: d[cols].round({"win_trade": 2, "win_day": 2, "win_lo": 2, "mean": 4, "lift": 4, "t": 2, "q": 3, "p5": 3, "pre": 4, "post": 4})
    print("\n== FDR q < 0.10, lift > 0, win_lo ≥ 10 events, by win_lo ==")
    top = df[(df.days >= 10) & (df.lift > 0)].sort_values("win_lo", ascending=False).head(25)
    print(fmt(top).to_string(index=False))
    print("\n== Era-positive (03-07…20-26) market RSI14<25 hold 5 ==")
    era_cols = [c for c in df.columns if c.startswith("era_")]
    if era_cols:
        sub = df[df.cond.str.contains("RSI14<25", na=False) & df.h.eq(5)]
        print(fmt(sub.head(15)).to_string(index=False))
    r14 = C.apply(lambda s: rsi(s, 14)).iloc[-1]
    print(f"\nToday {dates[-1].date()}: SPY RSI14 {r14.get('SPY', float('nan')):.1f}; stocks RSI14<25: {(r14 < 25).sum()}")


if __name__ == "__main__":
    main()
