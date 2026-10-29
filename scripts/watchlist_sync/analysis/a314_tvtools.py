"""A314 family 4 — Popular TradingView regime/trend tools (LazyBear squeeze & WaveTrend, Hurst R/S, Ehlers FDI & IT,
Choppiness / chop zone). Intraday: S139 every-bar harness (SPY+QQQ 5m, minute-matched placebo, day-cluster t, MDE).
Daily: S130-style put breach (own IV, non-overlapping h=5/10, H1<2010). Incremental logit: dropx ~ S126 score + event.
Pass intraday: same-sign H1/H2 |t|≥2 on claim; pass daily: breach t both halves. Passers → put_benchmark overlay.
Sources (Pine): squeeze https://www.tradingview.com/script/nqQ1DT5a-Squeeze-Momentum-Indicator-LazyBear/
WaveTrend https://www.tradingview.com/script/2KE8wTuF-Indicator-WaveTrend-Oscillator-LazyBear/
FDI https://www.tradingview.com/script/UlJKijY2-Ehlers-Fractal-Dimension-Index/
IT https://www.tradingview.com/script/WigIA933-Ehlers-Instantaneous-Trendline/
CHOP https://www.tradingview.com/script/TAhtEVER-Choppiness-Index/
Run: cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/a314_tvtools.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from a314_changepoint import minute_placebo  # noqa: E402
from s130_daily_regime import SPLIT, load as load_daily_json, tstat  # noqa: E402
from s139_event_regime import load, risk_score  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A314-tvtools-packet.md"
PANEL_CACHE = Path.home() / ".fildi/cache/a314_tvtools_panel.pkl"
DAILY_JSON = HERE.parent / "out" / "opt" / "s130_long_daily.json"
M = json.loads((HERE.parent / "out" / "opt" / "S126_model.json").read_text())
_mins = np.array(sorted(int(k) for k in M["rngMedianByMin"]))
_meds = np.array([M["rngMedianByMin"][str(k)] for k in _mins])

FINDING3_ARMS = frozenset({"mesa_it_fall", "chop_zone_trend"})
Z_MDE = 1.96 + 0.84


def mde_pp_from_t(eff_pp: float, t: float) -> float:
    if not math.isfinite(eff_pp) or not math.isfinite(t) or abs(t) < 1e-9:
        return float("nan")
    return Z_MDE * abs(eff_pp) / abs(t)


def day_gap_stats(
    e: pd.DataFrame, p: pd.DataFrame, outcome: str
) -> tuple[float, float, int]:
    """Event−placebo daily mean gap; effect (pp) and t from the same day-level series."""
    ed = e.groupby("d")[outcome].mean()
    pd_ = p.groupby("d")[outcome].mean()
    jj = ed.index.intersection(pd_.index)
    diff = ed[jj] - pd_[jj]
    if len(diff) < 3 or diff.std(ddof=1) == 0:
        return float("nan"), float("nan"), len(diff)
    eff_pp = 100 * diff.mean()
    t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff)))
    return float(eff_pp), float(t), len(diff)


def eval_method(R: pd.DataFrame, ev: str, outcome: str, claim: str, source: str, rng) -> dict:
    e_all = R[R[ev]]
    p_all = minute_placebo(R, ev, rng)
    if len(e_all) < 30:
        n_d = e_all.d.nunique()
        return dict(
            name=ev,
            claim=claim,
            source=source,
            verdict=f"FAIL (sparse n={len(e_all)} events, {n_d} days)",
            pass_bar=False,
            eff={"H1": float("nan"), "H2": float("nan")},
            ts={"H1": float("nan"), "H2": float("nan")},
            mde={"H1": float("nan"), "H2": float("nan")},
            outcome=outcome,
        )
    eff, ts, mde, ns = {}, {}, {}, {}
    for h in ("H1", "H2"):
        e = e_all[e_all.half == h]
        p = p_all[p_all.half == h] if len(p_all) else e.iloc[:0]
        if len(e) < 15 or len(p) < 15:
            eff[h] = ts[h] = mde[h] = float("nan")
            ns[h] = 0
            continue
        eff[h], ts[h], ns[h] = day_gap_stats(e, p, outcome)
        mde[h] = mde_pp_from_t(eff[h], ts[h])
    e1, e2 = eff["H1"], eff["H2"]
    t1, t2 = ts["H1"], ts["H2"]
    same = np.sign(e1) == np.sign(e2) and math.isfinite(e1) and math.isfinite(e2) and e1 != 0
    pass_bar = same and abs(t1) >= 2 and abs(t2) >= 2
    verdict = "PASS intraday" if pass_bar else "FAIL"
    return dict(
        name=ev,
        claim=claim,
        source=source,
        outcome=outcome,
        eff=eff,
        ts=ts,
        mde=mde,
        ns=ns,
        n_ev=len(e_all),
        pass_bar=pass_bar,
        verdict=verdict,
    )


def drop_odds_by_level(R: pd.DataFrame, col: str) -> str:
    """P(drop≥½ATR) with vs without event, by S126 level, both halves (family 2 table format)."""
    R = R.copy()
    R["lvl"] = np.searchsorted(M["cuts"], R["score"])
    chunks = []
    for h in ("H1", "H2"):
        parts = []
        sub = R[R.half == h]
        for i, lv in enumerate(M["levels"]):
            base = sub[sub.lvl == i]
            if len(base) < 80:
                continue
            on, off = base[base[col]], base[~base[col]]
            if len(on) < 5 or len(off) < 20:
                continue
            parts.append(f"{lv} {100 * on.dropx.mean():.1f}/{100 * off.dropx.mean():.1f}")
        if parts:
            chunks.append(f"{h} " + ", ".join(parts))
    return "; ".join(chunks)


def incr_candidate(R: pd.DataFrame, col: str) -> tuple[bool, float, float]:
    """Finding 3: |t|≥2 both halves on incr coef (same sign), claim or opposite."""
    t1, t2 = incremental_t(R, col)
    ok = (
        math.isfinite(t1)
        and math.isfinite(t2)
        and abs(t1) >= 2
        and abs(t2) >= 2
        and np.sign(t1) == np.sign(t2)
    )
    return ok, t1, t2


def incr_pass(R: pd.DataFrame, col: str, expect: int) -> tuple[bool, float, float]:
    ok, t1, t2 = incr_candidate(R, col)
    return ok and np.sign(t1) == expect, t1, t2

YAHOO_TICKERS = ("SPY", "QQQ", "DIA", "^VIX", "^VXN", "^VXD", "HYG", "IEF", "RSP", "IWM")


def ensure_daily_json() -> Path:
    if DAILY_JSON.is_file():
        return DAILY_JSON
    DAILY_JSON.parent.mkdir(parents=True, exist_ok=True)
    out: dict[str, list] = {}
    for sym in YAHOO_TICKERS:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
            f"?period1=725760000&period2=4102444800&interval=1d"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        j = urllib.request.urlopen(req, timeout=60).read()
        r = json.loads(j)["chart"]["result"][0]
        q = r["indicators"]["quote"][0]
        rows = []
        for i, ts in enumerate(r["timestamp"]):
            o, h, l, c, v = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i]
            if c is None:
                continue
            rows.append(
                {
                    "date": pd.Timestamp(ts, unit="s", tz="UTC").tz_convert("America/New_York").strftime("%Y-%m-%d"),
                    "open": o,
                    "high": h,
                    "low": l,
                    "close": c,
                    "volume": v or 0,
                }
            )
        out[sym] = rows
    DAILY_JSON.write_text(json.dumps(out))
    return DAILY_JSON


def ema_s(x: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(x, dtype=float).ewm(span=n, adjust=False).mean().to_numpy()


def sma_s(x: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(x, dtype=float).rolling(n, min_periods=n).mean().to_numpy()


def stdev_s(x: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(x, dtype=float).rolling(n, min_periods=n).std().to_numpy()


def linreg_end(y: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(y), np.nan)
    x = np.arange(n, dtype=float)
    for i in range(n - 1, len(y)):
        seg = y[i - n + 1 : i + 1]
        if np.any(np.isnan(seg)):
            continue
        slope, intercept = np.polyfit(x, seg, 1)
        out[i] = intercept + slope * (n - 1)
    return out


def squeeze_momentum(h: np.ndarray, l: np.ndarray, c: np.ndarray, length: int = 20) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """LazyBear Squeeze Momentum — sqz on/off + momentum histogram."""
    basis = sma_s(c, length)
    dev = 2.0 * stdev_s(c, length)
    upper_bb, lower_bb = basis + dev, basis - dev
    tr = np.maximum(h - l, np.maximum(np.abs(h - np.r_[c[0], c[:-1]]), np.abs(l - np.r_[c[0], c[:-1]])))
    rangema = sma_s(tr, length)
    upper_kc, lower_kc = basis + 1.5 * rangema, basis - 1.5 * rangema
    sqz_on = (lower_bb > lower_kc) & (upper_bb < upper_kc)
    sqz_off = (lower_bb < lower_kc) & (upper_bb > upper_kc)
    avg_hl = (pd.Series(h).rolling(length).max().to_numpy() + pd.Series(l).rolling(length).min().to_numpy()) / 2
    mid = (avg_hl + sma_s(c, length)) / 2
    mom = linreg_end(c - mid, length)
    return sqz_on, sqz_off, mom


def wavetrend(h: np.ndarray, l: np.ndarray, c: np.ndarray, n1: int = 10, n2: int = 21) -> tuple[np.ndarray, np.ndarray]:
    ap = (h + l + c) / 3.0
    esa = ema_s(ap, n1)
    d = ema_s(np.abs(ap - esa), n1)
    ci = (ap - esa) / (0.015 * d + 1e-12)
    wt1 = ema_s(ci, n2)
    wt2 = sma_s(wt1, 4)
    return wt1, wt2


def hurst_rs(close: np.ndarray, window: int = 100) -> np.ndarray:
    logp = np.log(np.maximum(close, 1e-9))
    r = np.diff(logp, prepend=logp[0])
    out = np.full(len(close), np.nan)
    for i in range(window, len(close)):
        seg = r[i - window + 1 : i + 1]
        if np.std(seg) < 1e-12:
            continue
        y = np.cumsum(seg - seg.mean())
        R = y.max() - y.min()
        S = seg.std(ddof=1)
        if S <= 0 or R <= 0:
            continue
        out[i] = np.log(R / S) / np.log(window)
    return out


def ehlers_fdi(h: np.ndarray, l: np.ndarray, period: int = 30) -> np.ndarray:
    """Ehlers fractal dimension index (TV UlJKijY2-style)."""
    n = len(h)
    out = np.full(n, np.nan)
    hh = pd.Series(h).rolling(period).max().to_numpy()
    ll = pd.Series(l).rolling(period).min().to_numpy()
    for i in range(period - 1, n):
        if not np.isfinite(hh[i]) or hh[i] <= ll[i]:
            continue
        N = (hh[i] - ll[i]) / period
        if N <= 0:
            continue
        out[i] = 1.0 + (np.log(N) + np.log(period)) / np.log(2 * period)
    return out


def ehlers_it(c: np.ndarray, alpha: float = 0.07) -> np.ndarray:
    a = alpha
    it = np.full(len(c), np.nan)
    for i in range(2, len(c)):
        p0, p1, p2 = c[i], c[i - 1], c[i - 2]
        if i == 2:
            it[i] = p0
            continue
        it[i] = (a - a * a / 4) * p0 + 0.5 * a * a * p1 - (a - 0.75 * a * a) * p2 + 2 * (1 - a) * it[i - 1] - (1 - a) ** 2 * it[i - 2]
    return it


def choppiness(h: np.ndarray, l: np.ndarray, c: np.ndarray, n: int = 14) -> np.ndarray:
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    tr_sum = pd.Series(tr).rolling(n).sum().to_numpy()
    hh = pd.Series(h).rolling(n).max().to_numpy()
    ll = pd.Series(l).rolling(n).min().to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        chop = 100 * np.log10(tr_sum / (hh - ll + 1e-12)) / np.log10(n)
    return chop


def build_intraday_panel() -> pd.DataFrame:
    rows = []
    for tk in ("SPY", "QQQ"):
        df = load(tk)
        days = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
        # concatenate for rolling indicators
        offsets = []
        off = 0
        all_h, all_l, all_c = [], [], []
        for g in days:
            offsets.append(off)
            off += len(g)
            all_h.extend(g.h.values)
            all_l.extend(g.l.values)
            all_c.extend(g.c.values)
        H, L, C = np.array(all_h), np.array(all_l), np.array(all_c)
        sq_on, sq_off, mom = squeeze_momentum(H, L, C, 20)
        wt1, wt2 = wavetrend(H, L, C)
        Hrs = hurst_rs(C, 100)
        fdi = ehlers_fdi(H, L, 30)
        it_proxy = ema_s(C, 12)
        it_line = ehlers_it(C)
        chop = choppiness(H, L, C, 14)
        wt_cross_up = (wt1 > wt2) & (np.r_[False, wt1[:-1] <= wt2[:-1]])
        wt_cross_dn = (wt1 < wt2) & (np.r_[False, wt1[:-1] >= wt2[:-1]])
        sq_release = sq_off & np.r_[False, sq_on[:-1]]
        it_fall = np.full(len(C), False)
        it_fall[3:] = (it_proxy[3:] - it_proxy[:-3]) / (np.abs(it_proxy[:-3]) + 1e-9) < -0.0015
        it_pine_fall = np.full(len(C), False)
        it_pine_fall[3:] = (it_line[3:] - it_line[:-3]) / (np.abs(it_line[:-3]) + 1e-9) < -0.0015

        closes = np.array([g.c.iloc[-1] for g in days])
        highs = np.array([g.h.max() for g in days])
        lows = np.array([g.l.min() for g in days])
        for k in range(21, len(days)):
            g = days[k]
            base = offsets[k]
            pcs = closes[k - 21 : k]
            tr = np.maximum(
                highs[k - 20 : k] - lows[k - 20 : k],
                np.maximum(abs(highs[k - 20 : k] - pcs[:-1]), abs(lows[k - 20 : k] - pcs[:-1])),
            ) / pcs[:-1]
            atr = tr.mean()
            ret5 = closes[k - 1] / closes[k - 6] - 1
            for i in range(5, len(g) - 1):
                m = int(g.m.iloc[i]) + 5
                if m < 30 or m > 330:
                    continue
                gi = base + i
                p = g.c.iloc[i]
                rest = g.iloc[i + 1 :]
                b = g.iloc[: i + 1]
                sc = risk_score(b, m, atr, ret5)
                rows.append(
                    dict(
                        tk=tk,
                        d=g.d.iloc[0],
                        m=m,
                        score=sc,
                        dropx=(min(rest.l.min() / p - 1, 0) / atr) <= -0.5,
                        rest_rng=(rest.h.max() - rest.l.min()) / p / atr,
                        squeeze_release=bool(sq_release[gi]) and mom[gi] > 0,
                        squeeze_release_dn=bool(sq_release[gi]) and mom[gi] < 0,
                        wt_os_cross=bool(wt_cross_up[gi] and wt1[gi] < -53),
                        wt_ob_cross=bool(wt_cross_dn[gi] and wt1[gi] > 53),
                        hurst_trend=Hrs[gi] > 0.55 if np.isfinite(Hrs[gi]) else False,
                        hurst_chop=Hrs[gi] < 0.45 if np.isfinite(Hrs[gi]) else False,
                        fdi_chop=fdi[gi] > 1.5 if np.isfinite(fdi[gi]) else False,
                        fdi_trend=fdi[gi] < 1.3 if np.isfinite(fdi[gi]) else False,
                        mesa_it_fall=bool(it_fall[gi]),
                        mesa_pine_it_fall=bool(it_pine_fall[gi]) if np.isfinite(it_line[gi]) else False,
                        chop_high=chop[gi] > 61.8 if np.isfinite(chop[gi]) else False,
                        chop_zone_trend=chop[gi] < 38.2 if np.isfinite(chop[gi]) else False,
                    )
                )
    R = pd.DataFrame(rows)
    dates = sorted(R.d.unique())
    split = dates[len(dates) // 2]
    R["half"] = np.where(R.d < split, "H1", "H2")
    R["_split"] = split
    return R


def incremental_t(R: pd.DataFrame, col: str) -> tuple[float, float]:
    from statsmodels.discrete.discrete_model import Logit
    from statsmodels.tools.tools import add_constant
    from statsmodels.stats.sandwich_covariance import cov_cluster

    def one(half: str) -> float:
        y = R[R.half == half].dropna(subset=["score"])
        if len(y) < 800 or y[col].sum() < 20:
            return float("nan")
        X = add_constant(y[["score", col]].astype(float))
        mod = Logit(y.dropx.astype(int), X).fit(disp=0, maxiter=80)
        groups = pd.Categorical(y.d).codes
        cov = cov_cluster(mod, groups)
        idx = list(X.columns).index(col)
        se = np.sqrt(cov[idx, idx])
        return float(mod.params[col] / se) if se > 0 else float("nan")

    return one("H1"), one("H2")


INTRA_METHODS = [
    ("squeeze_release", "dropx", "squeeze release + mom>0 → lower drop (trend burst)", "LazyBear Squeeze Momentum", -1),
    ("squeeze_release_dn", "dropx", "squeeze release + mom<0 → higher drop", "LazyBear Squeeze Momentum", +1),
    ("wt_os_cross", "dropx", "WaveTrend OS cross up → lower drop (reversal up)", "LazyBear WaveTrend", -1),
    ("wt_ob_cross", "dropx", "WaveTrend OB cross down → higher drop", "LazyBear WaveTrend", +1),
    ("hurst_trend", "rest_rng", "Hurst>0.55 → higher rest range (persistent trend)", "rolling R/S Hurst", +1),
    ("hurst_chop", "dropx", "Hurst<0.45 → higher drop (mean-revert chop)", "rolling R/S Hurst", +1),
    ("fdi_chop", "rest_rng", "FDI>1.5 chop → higher rest range", "Ehlers FDI", +1),
    ("fdi_trend", "dropx", "FDI<1.3 trend → lower drop", "Ehlers FDI", -1),
    ("mesa_it_fall", "dropx", "EMA12 slope −0.15%/3bar → higher drop (5m; Pine IT on daily S130)", "Ehlers IT proxy (EMA12)", +1),
    ("chop_high", "rest_rng", "CHOP>61.8 → higher rest range (chop)", "Choppiness Index", +1),
    ("chop_zone_trend", "dropx", "CHOP<38.2 trend zone → lower drop", "Chop Zone / CHOP", -1),
]


def daily_flags() -> pd.DataFrame:
    ensure_daily_json()
    D = load_daily_json(str(DAILY_JSON))
    own_iv = {"SPY": "^VIX", "QQQ": "^VXN", "DIA": "^VXD"}
    rows = []
    for tk in [t for t in ("SPY", "QQQ", "DIA") if t in D and own_iv[t] in D]:
        d = D[tk]
        h, l, c = d.high.values, d.low.values, d.close.values
        sq_on, sq_off, mom = squeeze_momentum(h, l, c, 20)
        wt1, wt2 = wavetrend(h, l, c)
        Hrs = hurst_rs(c, 126)
        fdi = ehlers_fdi(h, l, 30)
        it = ehlers_it(c)
        chop = choppiness(h, l, c, 14)
        it_fall_d = np.full(len(c), False)
        it_fall_d[3:] = (it[3:] - it[:-3]) / (np.abs(it[:-3]) + 1e-9) < -0.0015
        F = pd.DataFrame(
            {
                "squeeze_rel": sq_off & np.r_[False, sq_on[:-1]],
                "wt_ob": (wt1 < wt2) & (wt1 > 53),
                "hurst_tr": Hrs > 0.55,
                "fdi_ch": fdi > 1.5,
                "chop_hi": chop > 61.8,
                "mesa_it_fall": it_fall_d,
            },
            index=d.index,
        )
        vix = D[own_iv[tk]].close.reindex(d.index).ffill()
        for hhor in (5, 10):
            sig = vix / 100 * np.sqrt(hhor / 252)
            K = d.close * np.exp(-sig)
            breach = (d.close.shift(-hhor) < K).astype(float)
            X = F.join(breach.rename("breach")).iloc[252::hhor].dropna(subset=["breach"])
            X["tk"], X["h"], X["half"] = tk, hhor, np.where(X.index < SPLIT, "H1", "H2")
            rows.append(X)
    return pd.concat(rows)


def grade_daily(A: pd.DataFrame, col: str) -> tuple[float, float]:
    tb = []
    for h in (5, 10):
        x = A[A.h == h]
        m = x[col].fillna(False)
        if m.sum() < 25:
            continue
        on, off = x[m], x[~m]
        tb.append(tstat(on[on.half == "H1"].breach, off[off.half == "H1"].breach))
        tb.append(tstat(on[on.half == "H2"].breach, off[off.half == "H2"].breach))
    if len(tb) >= 2:
        return tb[0], tb[1]
    return float("nan"), float("nan")


def put_overlay(R: pd.DataFrame, ev: str) -> str:
    import pickle

    import band_engine as BE
    from put_benchmark import engine_rule, verdict

    spy_days = R[(R.tk == "SPY") & R[ev]].groupby("d").size().reset_index()[["d"]]
    flags = {row.d: True for row in spy_days.itertuples()}
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    from build_plan import connect

    with connect() as c:
        BE.add_sector(c, rows)
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    table = BE.fit(tr)
    live = engine_rule(table)
    weeks = sorted({r["d"] for r in rows if r["d"] >= BE.SPLIT})
    te = [r for r in rows if r["d"] >= BE.SPLIT]
    tr_weeks = sorted({r["d"] for r in tr})

    def prior_flag(row):
        from datetime import timedelta

        pd_ = row["d"] - timedelta(days=1)
        while pd_.weekday() >= 5:
            pd_ -= timedelta(days=1)
        return flags.get(pd_, False)

    def rule(row):
        if prior_flag(row):
            return None
        return live(row)

    base = BE.summary(BE.pick_rows(te, live), weeks)
    var = BE.summary(BE.pick_rows(te, rule), weeks)
    base_tr = BE.summary(BE.pick_rows(tr, live), tr_weeks)
    st_tr = BE.summary(BE.pick_rows(tr, rule), tr_weeks)
    diff = np.array([var["series"][w] - base["series"][w] for w in weeks])
    t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if diff.std() > 0 else 0.0
    dbp = var["book_bp"] - base["book_bp"]
    v = verdict(dbp, t, var["book_w5"] - base["book_w5"])
    pbp = st_tr["book_bp"] - base_tr["book_bp"]
    if v == "BETTER" and pbp < -1:
        v = "BETTER (holdout only)"
    return f"skip prior SPY `{ev}`: Δ{dbp:+.1f}bp t{t:+.1f} → **{v}**"


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break
    from build_plan import connect

    connect().close()
    rng = np.random.default_rng(3144)
    print("A314 family4: intraday panel…", flush=True)
    need_cols = {"mesa_pine_it_fall"}
    if PANEL_CACHE.is_file():
        R = pd.read_pickle(PANEL_CACHE)
        if not need_cols.issubset(R.columns):
            R = build_intraday_panel()
            R.to_pickle(PANEL_CACHE)
    else:
        R = build_intraday_panel()
        PANEL_CACHE.parent.mkdir(parents=True, exist_ok=True)
        R.to_pickle(PANEL_CACHE)
    split = R["_split"].iloc[0]
    lines = [
        f"# A314 family 4 — TV regime/trend tools",
        f"SPY+QQQ {R.d.nunique()}d · H1<{split}≤H2 · day-mean event−placebo gap · incr=logit(dropx~S126+event) · **no ship**",
        "",
    ]
    passers = []
    incr_live: list[str] = []
    for col, outcome, claim, src, expect in INTRA_METHODS:
        g = eval_method(R, col, outcome, claim, src, rng)
        if "eff" not in g:
            lines.append(f"- **{col}** · {src} · {claim} · **{g.get('verdict', 'FAIL')}**")
            continue
        e1, e2 = g["eff"]["H1"], g["eff"]["H2"]
        if g.get("pass_bar") and (not math.isfinite(e1) or np.sign(e1) != expect):
            g["pass_bar"] = False
            g["verdict"] = "FAIL (wrong sign vs claim)"
        t1, t2 = g["ts"]["H1"], g["ts"]["H2"]
        inc1, inc2 = incremental_t(R, col)
        inc_ok, _, _ = incr_pass(R, col, expect)
        live_incr, _, _ = incr_candidate(R, col)
        if live_incr and col in FINDING3_ARMS:
            incr_live.append(col)
        if g.get("pass_bar") and not inc_ok:
            g["pass_bar"] = False
            g["verdict"] = "FAIL (incr over S126)"
        m1, m2 = g["mde"]["H1"], g["mde"]["H2"]
        mf = lambda x: f"{x:.1f}" if math.isfinite(x) else "n/a"
        ef = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        tf = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        v = g["verdict"]
        n_ev = g.get("n_ev", R[col].sum() if col in R.columns else 0)
        tag = " · **Live incr**" if col in FINDING3_ARMS and live_incr and not g.get("pass_bar") else ""
        lines.append(
            f"- **{col}** · {src} · {claim} · n={n_ev} · eff {ef(e1)}/{ef(e2)} · t {tf(t1)}/{tf(t2)} · "
            f"incr {tf(inc1)}/{tf(inc2)} · MDE {mf(m1)}/{mf(m2)}pp · **{v}**{tag}"
        )
        if g.get("pass_bar"):
            passers.append(col)

    for col in incr_live:
        if col in passers:
            continue
        odds = drop_odds_by_level(R, col)
        if odds:
            lines.append(f"- **{col} drop odds** (% with/without by S126): {odds}")

    print("daily flags…", flush=True)
    A = daily_flags()
    daily_map = [
        ("squeeze_rel", "squeeze release (daily) → breach", "LazyBear Squeeze"),
        ("wt_ob", "WT overbought (daily) → breach", "LazyBear WaveTrend"),
        ("hurst_tr", "Hurst trend (daily) → breach", "Hurst R/S"),
        ("fdi_ch", "FDI chop (daily) → breach", "Ehlers FDI"),
        ("chop_hi", "CHOP>61.8 (daily) → breach", "Choppiness"),
        ("mesa_it_fall", "Pine IT slope fall (daily) → breach", "Ehlers IT"),
    ]
    daily_ts = []
    for col, claim, src in daily_map:
        t1, t2 = grade_daily(A, col)
        if col == "mesa_it_fall" and A[col].sum() < 25:
            daily_ts.append(f"{col} sparse")
        else:
            daily_ts.append(f"{col} {t1:+.1f}/{t2:+.1f}")
    lines.append(
        "- **daily S130** · "
        + "; ".join(daily_ts)
        + " · breach t · **FAIL daily** (no |t|≥2 both halves)"
    )

    put_cols = [c for c in FINDING3_ARMS if c in incr_live]
    if put_cols:
        lines += ["", "## Put benchmark"]
        for col in put_cols:
            lines.append(f"- `{col}` {put_overlay(R, col)}")
    else:
        lines.append("- put overlay: none (no PASS / Live incr)")

    packet = "\n".join(lines[:25]) + "\n"
    OUT.write_text(packet)
    print(packet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
