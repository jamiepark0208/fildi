#!/usr/bin/env python3
"""TradingView-style daily indicators, one home (A279, Jamie 10-26). Methods from the authors' published descriptions; Pine
source not copied. Every value at bar i uses bars ≤ i only (pivots count from the bar they are confirmed, not the pivot bar).

  UT Bot (Luxy UT God Mode)      ATR(14) × 2 ratcheting trail, Kaufman ER(10) chop widening; direction, bars since flip,
                                 distance in ATR; trend-duration survival = share of this name's past same-side trends that
                                 lasted longer than the current one (EW-weighted, recent trends heavier)
  UT confidence (0–100)          the seven engines fused: UT side, SuperTrend side + distance, place in the 20-day range,
                                 ADX(14) ≥ 15, weekly EMA 9/21 agreement, volume ≥ 20-day average, RSI divergence that agrees
  SuperTrend weighted by div.    SuperTrend(10, 3) whose multiplier drops 30 % for ≤ 200 bars after a confirmed RSI divergence
                                 against the trend (cancelled by a flip or a trend-aligned divergence); MPO4 → RSI(14)
  SuperTrend cluster (Zeiierman) author defaults: EMA3/ATR7/1.5/w1 · EMA5/10/2/1 · SMA8/14/2.5/1.2 · WMA13/21/3/1.4 · HMA21/34/4/1.6;
                                 bull share of weight 0–1; regime flips only when share ≥ 0.6 and the base member (3rd) agrees
  SMC (Liquidity Hunter PRO)     5/5 swing pivots; sweep = wick through the last swing low/high and close back inside; BOS =
                                 close through the last swing high/low; MSS = BOS within 10 bars after a sweep on a candle in that
                                 direction (body ≥ 0.15 ATR vs the open; no open → close > prior close); nearest unfilled bullish FVG and
                                 last bullish order block (last down candle, close < open) below price (ATR units)
  Fear & Greed (BigBeluga)       mean of RSI(14), percentile of close ÷ SMA(50) over 252 days, 20-day up-volume share (× 100);
                                 without volume → mean of the first two

    .venv/bin/python indicators.py                 # today's values for every LSEG name + sector ETFs → watchlist_sync.indicators_daily
    .venv/bin/python indicators.py --tickers=NVDA  # print, no write
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

import numpy as np

PIV = 5


def rma(x, n):
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = np.nanmean(x[:n])
    for i in range(n, len(x)):
        out[i] = out[i - 1] + (x[i] - out[i - 1]) / n
    return out


def ema(x, n):
    out = np.empty(len(x))
    a = 2 / (n + 1)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = out[i - 1] + a * (x[i] - out[i - 1])
    return out


def sma(x, n):
    out = np.full(len(x), np.nan)
    cs = np.cumsum(np.r_[0.0, x])
    out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return np.where(np.isnan(out), x, out)   # warm-up bars = the raw source


def wma(x, n):
    w = np.arange(1, n + 1, dtype=float)
    out = np.array([x[i - n + 1:i + 1] @ w / w.sum() if i >= n - 1 else x[i] for i in range(len(x))])
    return out


def hma(x, n):
    return wma(2 * wma(x, max(n // 2, 1)) - wma(x, n), max(int(round(n ** 0.5)), 1))


def atr(h, l, c, n):
    pc = np.r_[c[0], c[:-1]]
    return rma(np.maximum.reduce([h - l, np.abs(h - pc), np.abs(l - pc)]), n)


def rsi(c, n=14):
    d = np.diff(c, prepend=c[0])
    up, dn = rma(np.maximum(d, 0), n), rma(np.maximum(-d, 0), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(dn == 0, 100.0, 100 - 100 / (1 + up / dn))


def eff_ratio(c, n=10):
    out = np.full(len(c), np.nan)
    for i in range(n, len(c)):
        path = np.abs(np.diff(c[i - n:i + 1])).sum()
        out[i] = abs(c[i] - c[i - n]) / path if path > 0 else 0.0
    return out


def adx(h, l, c, n=14):
    up, dn = np.diff(h, prepend=h[0]), -np.diff(l, prepend=l[0])
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    a = atr(h, l, c, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi, mdi = 100 * rma(pdm, n) / a, 100 * rma(mdm, n) / a
        dx = 100 * np.abs(pdi - mdi) / (pdi + mdi)
    return rma(np.nan_to_num(dx), n)


def supertrend(src, h, l, c, n, f, mult_scale=None):
    """(direction ±1, line). src = band centre (hl2 or a smoothed source); mult_scale[i] multiplies f (divergence weighting)."""
    a = atr(h, l, c, n)
    N = len(c)
    d, line = np.ones(N), np.full(N, np.nan)
    ub, lb = np.full(N, np.nan), np.full(N, np.nan)
    for i in range(N):
        if np.isnan(a[i]):
            continue
        ff = f * (mult_scale[i] if mult_scale is not None else 1.0)
        u, lo = src[i] + ff * a[i], src[i] - ff * a[i]
        if i and not np.isnan(ub[i - 1]):
            u = u if u < ub[i - 1] or c[i - 1] > ub[i - 1] else ub[i - 1]
            lo = lo if lo > lb[i - 1] or c[i - 1] < lb[i - 1] else lb[i - 1]
            d[i] = 1 if c[i] > ub[i - 1] else -1 if c[i] < lb[i - 1] else d[i - 1]
        ub[i], lb[i] = u, lo
        line[i] = lo if d[i] > 0 else u
    return d, line


def pivots(x, kind, piv=PIV):
    """Confirmed pivot list per bar: at bar i, the pivots (index, value) confirmed by bar i (pivot bar = i − piv)."""
    conf = {}
    for p in range(piv, len(x) - piv):
        w = x[p - piv:p + piv + 1]
        if (kind == "low" and x[p] == w.min()) or (kind == "high" and x[p] == w.max()):
            conf[p + piv] = (p, x[p])
    return conf


def divergences(c, r, piv=PIV):
    """(+1 bullish / −1 bearish / 0) at the bar a divergence is confirmed: price lower low + RSI higher low (and mirror)."""
    out = np.zeros(len(c))
    for kind, sgn in (("low", 1), ("high", -1)):
        prev = None
        for i, (p, v) in sorted(pivots(c, kind, piv).items()):
            if prev is not None and p - prev[0] <= 60:
                if sgn > 0 and v < prev[1] and r[p] > r[prev[0]]:
                    out[i] = 1
                if sgn < 0 and v > prev[1] and r[p] < r[prev[0]]:
                    out[i] = -1
            prev = (p, v)
    return out


def ut_bot(h, l, c, key=2.0, n=14):
    a, er = atr(h, l, c, n), eff_ratio(c)
    N = len(c)
    tr, pos = np.full(N, np.nan), np.zeros(N)
    for i in range(1, N):
        if np.isnan(a[i]):
            continue
        loss = key * (1.5 - (er[i] if not np.isnan(er[i]) else 0.5)) * a[i]   # chop (ER→0) widens 1.5×, clean trend tightens 0.5×
        p = tr[i - 1] if not np.isnan(tr[i - 1]) else c[i] - loss
        if c[i] > p and c[i - 1] > p:
            tr[i] = max(p, c[i] - loss)
        elif c[i] < p and c[i - 1] < p:
            tr[i] = min(p, c[i] + loss)
        else:
            tr[i] = c[i] - loss if c[i] > p else c[i] + loss
        pos[i] = 1 if c[i] > tr[i] else -1
    return pos, tr, a


def run_lengths(pos):
    """bars since the last flip, and a survival estimate: EW share of past same-side completed trends longer than that."""
    N = len(pos)
    since, surv = np.zeros(N), np.full(N, np.nan)
    done = {1: [], -1: []}
    start = 0
    for i in range(1, N):
        if pos[i] != pos[i - 1]:
            if pos[i - 1] != 0:
                done[int(pos[i - 1])].append(i - start)
            start = i
        since[i] = i - start
        past = done.get(int(pos[i]), [])
        if len(past) >= 5:
            w = 0.9 ** np.arange(len(past))[::-1]
            surv[i] = float((w * (np.array(past) > since[i])).sum() / w.sum())
    return since, surv


def compute(d, h, l, c, v=None, o=None) -> dict[str, np.ndarray]:
    """Every indicator series for one name (arrays aligned to the bars)."""
    c, h, l = np.asarray(c, float), np.asarray(h, float), np.asarray(l, float)
    N = len(c)
    out = {}
    r = rsi(c)
    # UT Bot + duration
    ut, trail, a = ut_bot(h, l, c)
    since, surv = run_lengths(ut)
    out.update(ut_dir=ut, ut_bars=since, ut_surv=surv, ut_dist=(c - trail) / a)
    # SuperTrend weighted by divergence (author defaults: ATR 10, ×3, pivot 2, sensitivity 0.3, 200 bars)
    dv5 = divergences(c, r)        # Luxy confidence engine: RSI 14 / pivot 5
    dv = divergences(c, r, piv=2)
    st0, st0_line = supertrend((h + l) / 2, h, l, c, 10, 3.0)
    scale, left, side = np.ones(N), 0, 0
    for i in range(N):   # one pass: track the active against-trend divergence (uses st direction as of i − 1)
        tdir = st0[i - 1] if i else 1
        if dv[i] and dv[i] == -tdir:
            left, side = 200, dv[i]
        elif dv[i] and dv[i] == tdir:
            left = 0
        if i and st0[i] != st0[i - 1]:
            left = 0
        scale[i] = 0.7 if left > 0 else 1.0
        left = max(left - 1, 0)
    stw, _ = supertrend((h + l) / 2, h, l, c, 10, 3.0, scale)
    out.update(stdiv_dir=stw, div_against=(scale < 1).astype(float), rsi_div=dv5)
    # SuperTrend cluster — author defaults (Zeiierman, page metadata 10-26): smoothing, length, ATR, factor, weight
    members = [(ema, 3, 7, 1.5, 1.0), (ema, 5, 10, 2.0, 1.0), (sma, 8, 14, 2.5, 1.2), (wma, 13, 21, 3.0, 1.4), (hma, 21, 34, 4.0, 1.6)]
    dirs = [supertrend(fn(c, ln), h, l, c, n, f)[0] for fn, ln, n, f, _ in members]
    wts = np.array([m[4] for m in members])
    bull = (np.array([(x > 0) for x in dirs]).T * wts).sum(1) / wts.sum()
    reg = np.zeros(N)
    for i in range(N):
        prev = reg[i - 1] if i else 0
        reg[i] = 1 if bull[i] >= 0.6 and dirs[2][i] > 0 else -1 if bull[i] <= 0.4 and dirs[2][i] < 0 else prev
    out.update(stc_bull=bull, stc_regime=reg)
    # SMC
    op = np.asarray(o, float) if o is not None else np.full(N, np.nan)

    def bull_body(i):   # open known → close − open ≥ 0.15 ATR (Liquidity Hunter default); else close above the prior close
        if not np.isnan(op[i]) and not np.isnan(a[i]):
            return c[i] - op[i] >= 0.15 * a[i]
        return i > 0 and c[i] > c[i - 1]

    def down(j):
        return c[j] < op[j] if not np.isnan(op[j]) else (j > 0 and c[j] < c[j - 1])

    lows, highs = pivots(l, "low"), pivots(h, "high")
    sl = sh = None
    last_sweep = last_mss = last_bos = None
    bos_dir = np.zeros(N)
    swept_low, sweep_low = np.full(N, np.nan), np.full(N, np.nan)
    mss_age, sweep_age = np.full(N, np.nan), np.full(N, np.nan)
    fvg_dist, ob_dist = np.full(N, np.nan), np.full(N, np.nan)
    fvgs, ob = [], None
    for i in range(N):
        if i in lows:
            sl = lows[i][1]
        if i in highs:
            sh = highs[i][1]
        if sl is not None and l[i] < sl and c[i] > sl:
            last_sweep, swept_low[i] = i, sl
        if sh is not None and c[i] > sh and (i == 0 or c[i - 1] <= sh):
            last_bos = 1
            if last_sweep is not None and i - last_sweep <= 10 and bull_body(i):   # author: reversal body ≥ 0.15 ATR
                last_mss = i
            k = next((j for j in range(i - 1, max(i - 15, -1), -1) if down(j)), None)   # last down candle = bullish order block
            ob = l[k] if k is not None else ob
            sh = None
        if sl is not None and c[i] < sl:
            last_bos, sl = -1, None
        if i >= 2 and l[i] > h[i - 2]:
            fvgs.append((h[i - 2], l[i]))
        fvgs = [(lo, hi) for lo, hi in fvgs if l[i] > lo][-20:]   # filled once price trades through the gap's bottom
        bos_dir[i] = last_bos or 0
        sweep_age[i] = i - last_sweep if last_sweep is not None else np.nan
        sweep_low[i] = swept_low[last_sweep] if last_sweep is not None else np.nan   # the swept swing low (SMC stop level)
        mss_age[i] = i - last_mss if last_mss is not None else np.nan
        below = [hi for lo, hi in fvgs if hi <= c[i]]
        if below and a[i] > 0:
            fvg_dist[i] = (c[i] - max(below)) / a[i]
        if ob is not None and ob <= c[i] and a[i] > 0:
            ob_dist[i] = (c[i] - ob) / a[i]
    out.update(bos_dir=bos_dir, sweep_age=sweep_age, sweep_low=sweep_low, mss_age=mss_age, fvg_dist=fvg_dist, ob_dist=ob_dist)
    # Fear & Greed
    sma50 = np.convolve(c, np.ones(50) / 50, "full")[:N]
    sma50[:49] = np.nan
    dev = c / sma50 - 1
    pct = np.full(N, np.nan)
    for i in range(300, N):
        w = dev[i - 251:i + 1]
        pct[i] = 100 * (w < dev[i]).mean()
    parts = [r, pct]
    if v is not None and np.nansum(np.asarray(v, float)) > 0:
        v = np.nan_to_num(np.asarray(v, float))
        upv = np.where(np.diff(c, prepend=c[0]) > 0, v, 0.0)
        s_up = np.convolve(upv, np.ones(20), "full")[:N]
        s_all = np.convolve(v, np.ones(20), "full")[:N]
        with np.errstate(divide="ignore", invalid="ignore"):
            parts.append(np.where(s_all > 0, 100 * s_up / s_all, np.nan))
    with np.errstate(all="ignore"), __import__("warnings").catch_warnings():
        __import__("warnings").simplefilter("ignore", RuntimeWarning)   # all-NaN warm-up bars
        out["fear_greed"] = np.nanmean(np.vstack(parts), 0)
    # UT confidence: share of the seven engines agreeing with the UT side (0–100)
    ax = adx(h, l, c)
    hi20 = np.array([h[max(0, i - 19):i + 1].max() for i in range(N)])
    lo20 = np.array([l[max(0, i - 19):i + 1].min() for i in range(N)])
    place = (c - lo20) / np.where(hi20 > lo20, hi20 - lo20, np.nan)
    wk = ema(c, 45) > ema(c, 105)   # weekly EMA 9/21 ≈ daily 45/105
    volok = np.ones(N, bool)
    if v is not None and np.nansum(v) > 0:
        va = np.convolve(v, np.ones(20) / 20, "full")[:N]
        volok = v >= va
    recent_div = np.array([dv5[max(0, i - 10):i + 1][np.nonzero(dv[max(0, i - 10):i + 1])][-1:].sum() for i in range(N)])
    sd = st0
    eng = np.vstack([np.ones(N),                                             # UT side itself
                     (sd == ut) * (0.5 + 0.5 * np.clip(np.abs(c - st0_line) / a, 0, 1)),
                     np.where(ut > 0, place >= 0.5, place < 0.5),
                     ax >= 15, np.where(ut > 0, wk, ~wk), volok, (recent_div == ut)])
    out["ut_conf"] = 100 * np.nanmean(eng.astype(float), 0)
    out["d"] = np.asarray(d)
    return out


FIELDS = ["ut_dir", "ut_bars", "ut_surv", "ut_dist", "ut_conf", "stdiv_dir", "div_against", "stc_bull", "stc_regime",
          "bos_dir", "sweep_age", "sweep_low", "mss_age", "fvg_dist", "ob_dist", "fear_greed"]


def load_bars(conn, tickers=None):
    q = """SELECT ticker, date, close::float8, COALESCE(high, close)::float8, COALESCE(low, close)::float8, volume::float8, open::float8
           FROM lseg_research.daily_history WHERE close > 0""" + (" AND ticker = ANY(%s)" if tickers else "") + " ORDER BY ticker, date"
    by = defaultdict(lambda: ([], [], [], [], [], []))
    for t, d, c, h, l, v, o in conn.execute(q, (list(tickers),) if tickers else ()):
        b = by[t]
        b[0].append(d); b[1].append(h); b[2].append(l); b[3].append(c); b[4].append(v if v is not None else np.nan)
        b[5].append(o if o is not None else np.nan)
    return by


def today(conn, tickers=None) -> dict[str, dict]:
    out = {}
    for t, (d, h, l, c, v, o) in load_bars(conn, tickers).items():
        if len(c) < 320:
            continue
        s = compute(d, h, l, c, v, o)
        out[t] = {"date": str(d[-1]), **{k: (None if np.isnan(s[k][-1]) else round(float(s[k][-1]), 4)) for k in FIELDS}}
    return out


def main():
    from build_plan import connect
    args = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    tick = args["--tickers"].split(",") if "--tickers" in args else None
    with connect() as conn:
        vals = today(conn, tick)
        if tick:
            for t, x in vals.items():
                print(t, json.dumps(x))
            return
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.indicators_daily (as_of date, ticker text, payload jsonb,
                        computed_at timestamptz DEFAULT now(), PRIMARY KEY (as_of, ticker))""")
        for t, x in vals.items():
            conn.execute("""INSERT INTO watchlist_sync.indicators_daily (as_of, ticker, payload) VALUES (%s, %s, %s)
                            ON CONFLICT (as_of, ticker) DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()""",
                         (x["date"], t, json.dumps(x)))
        conn.commit()
        print(f"indicators: {len(vals)} names → watchlist_sync.indicators_daily")


if __name__ == "__main__":
    main()
