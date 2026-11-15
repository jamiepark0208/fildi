"""A370 full comparison: put-timing filters inside the top-IV tercile, matched on delta.

Question: one OTM put per name-week, does a daily filter raise premium kept versus
same-week peers in the same |delta| bucket?

Pre-registered (S161, before this run):
- Universe: entry day in the cross-sectional top third of iv30_put.
- Contract: local optlab.lseg_opt_daily. First quote with 3–9 calendar days to
  expiry (same entry rule as a370_put_timing_smoke.py). OTM puts only.
  |delta| in [0.05, 0.45], Black-Scholes r=0 q=0 using the option's own IV
  (percent/100; iv30_put if the quote IV is missing). One contract per
  name-week: closest |delta| to 0.20.
- Buckets: [0.05,0.15), [0.15,0.25), [0.25,0.35), [0.35,0.45].
- Fill: bid + 23% of the spread. Hold to expiry. Premium kept =
  (fill − intrinsic) / strike × 7 / calendar days, in bp.
- Comparator: same week and same bucket, filter off. A filter-on trade with
  no off-filter peer in that cell is dropped.
- t: week-clustered mean/SE, same estimator as the smoke. Halves split on
  entry date 2023-01-01. Pass = t ≥ 2 in both halves.
- Tail: 5th percentile of the filter's weekly mean pnl no worse than the
  matched off-filter book.
- (a) horizon check: iv30 − realised vol of daily log returns over the
  option's own life (day after entry through last close on or before expiry).
  Stop: if no filter passes (a), do not price the intraday set.
- Local minute bars start 2024-10-21, so a pre-2023 intraday half does not
  exist without a new download. This script does not download.
- arg1 = signal shift in bars (1 = leak check). Filters use bars ≤ entry.

Run:
  scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/analysis/a370_matched_delta.py
  scripts/watchlist_sync/.venv/bin/python scripts/watchlist_sync/analysis/a370_matched_delta.py 1
"""
from __future__ import annotations

import math
import sys
from datetime import date

import numpy as np
import pandas as pd

sys.path.insert(0, "/Users/jamiepark/Cursor/fildi/scripts/watchlist_sync")
from build_plan import connect

SHIFT = int(sys.argv[1]) if (__name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1].lstrip("-").isdigit()) else 0
EVAL0, EVAL1 = date(2018, 7, 1), date(2026, 11, 1)
SPLIT = pd.Timestamp("2023-01-01")
FLAGS = [
    "rsi_lo", "rsi_hi", "st_bear", "st_bull", "squeeze", "below200",
    "drop5", "relvol", "triple_rsi",
]
BUCKETS = [0.05, 0.15, 0.25, 0.35, 0.45]


def ncdf(x: np.ndarray) -> np.ndarray:
    ax = np.abs(x)
    t = 1.0 / (1.0 + 0.2316419 * ax)
    d = 0.3989422804 * np.exp(-0.5 * x * x)
    p = d * t * (
        0.319381530
        + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
    )
    return np.where(x >= 0.0, 1.0 - p, p)


def wt(x, g) -> float:
    x = np.asarray(x, float)
    g = np.asarray(g)
    ok = np.isfinite(x)
    x, g = x[ok], g[ok]
    if len(x) < 20:
        return float("nan")
    m = float(x.mean())
    s = pd.Series(x - m).groupby(g).sum().to_numpy()
    se = math.sqrt(float((s ** 2).sum())) / len(x)
    return m / se if se > 0 else float("nan")


def indicators(g: pd.DataFrame) -> pd.DataFrame:
    g = g.copy()
    c_ = g.c
    h = g.h.fillna(g.c)
    l = g.l.fillna(g.c)
    dlt = c_.diff()
    up = dlt.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    dn = (-dlt.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rsi = (
        (100 - 100 / (1 + up / dn.replace(0, np.nan)))
        .where(~(up.notna() & (dn == 0) & (up > 0)), 100.0)
        .where(~(up.notna() & (dn == 0) & (up == 0)), 50.0)
    )
    up5 = dlt.clip(lower=0).ewm(alpha=1 / 5, adjust=False, min_periods=5).mean()
    dn5 = (-dlt.clip(upper=0)).ewm(alpha=1 / 5, adjust=False, min_periods=5).mean()
    rsi5 = (
        (100 - 100 / (1 + up5 / dn5.replace(0, np.nan)))
        .where(~(up5.notna() & (dn5 == 0) & (up5 > 0)), 100.0)
        .where(~(up5.notna() & (dn5 == 0) & (up5 == 0)), 50.0)
    )
    tr = pd.concat([h - l, (h - c_.shift()).abs(), (l - c_.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 10, adjust=False, min_periods=10).mean()
    hl2 = (h + l) / 2
    ub = (hl2 + 3 * atr).to_numpy()
    lb = (hl2 - 3 * atr).to_numpy()
    cc = c_.to_numpy()
    n = len(g)
    dirn = np.ones(n)
    fu, fl = ub.copy(), lb.copy()
    for i in range(1, n):
        fu[i] = ub[i] if (ub[i] < fu[i - 1] or cc[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = lb[i] if (lb[i] > fl[i - 1] or cc[i - 1] < fl[i - 1]) else fl[i - 1]
        dirn[i] = 1 if cc[i] > fu[i - 1] else (-1 if cc[i] < fl[i - 1] else dirn[i - 1])
    m20, s20 = c_.rolling(20).mean(), c_.rolling(20).std()
    bw = 4 * s20 / m20
    decl = (rsi5 < rsi5.shift(1)) & (rsi5.shift(1) < rsi5.shift(2)) & (rsi5.shift(2) < rsi5.shift(3))
    sma200 = c_.rolling(200).mean()
    f = pd.DataFrame(
        {
            "rsi_lo": rsi < 30,
            "rsi_hi": rsi > 70,
            "st_bear": dirn < 0,
            "st_bull": dirn > 0,
            "squeeze": bw <= bw.rolling(120).quantile(0.2),
            "below200": c_ < sma200,
            "drop5": c_ / c_.shift(5) - 1 <= -0.05,
            "relvol": g.v / g.v.rolling(20).mean().shift() >= 1.5,
            "triple_rsi": (rsi5 < 30) & decl & (rsi5.shift(3) < 60) & (c_ > sma200),
            "drop15": c_ / c_.shift(5) - 1 <= -0.15,
        },
        index=g.index,
    )
    if SHIFT:
        f = f.shift(SHIFT).fillna(False).astype(bool)
    g[FLAGS + ["drop15"]] = f
    lr = np.log(c_).diff()
    g["lr"] = lr
    g["ok"] = g.c.notna() & (np.arange(n) >= 200)
    return g


def clustered_table(sub: pd.DataFrame, y: str, scale: float) -> list[dict]:
    """Lift of filter-on vs off-filter mean in the same week and delta bucket."""
    rows = []
    half = pd.to_datetime(sub.d) >= SPLIT
    for f in FLAGS:
        on = sub[f].astype(bool)
        peers = sub.loc[~on].groupby(["wk", "bucket"], observed=True)[y]
        mu = peers.mean()
        n_off = peers.size()
        key = pd.MultiIndex.from_frame(sub.loc[on, ["wk", "bucket"]])
        base = mu.reindex(key).to_numpy()
        npeer = n_off.reindex(key).to_numpy()
        x = sub.loc[on, y].to_numpy() - base
        keep = np.isfinite(x) & np.isfinite(npeer) & (npeer >= 1)
        xk = x[keep]
        wk = sub.loc[on, "wk"].to_numpy()[keep]
        hh = half.loc[on].to_numpy()[keep]
        pre, post = ~hh, hh
        wmean = pd.Series(sub.loc[on, y].to_numpy()[keep]).groupby(wk).mean()
        # matched off weekly book: off trades sharing a cell with a kept on trade
        cells = pd.DataFrame({
            "wk": sub.loc[on, "wk"].to_numpy()[keep],
            "bucket": sub.loc[on, "bucket"].to_numpy()[keep],
        }).drop_duplicates()
        off_m = sub.loc[~on, ["wk", "bucket", y]].merge(cells, on=["wk", "bucket"])
        off_w = off_m.groupby("wk")[y].mean() if len(off_m) else pd.Series(dtype=float)
        def p5(s: pd.Series) -> float:
            return float(np.nanpercentile(s.to_numpy(), 5)) if len(s) >= 20 else float("nan")
        rows.append({
            "filter": f,
            "n": int(keep.sum()),
            "n_pre": int(pre.sum()),
            "n_post": int(post.sum()),
            "names": int(pd.unique(sub.loc[on, "t"].to_numpy()[keep]).size) if keep.sum() else 0,
            "lift": float(np.nanmean(xk)) * scale if keep.sum() else float("nan"),
            "t": wt(xk, wk),
            "t_pre": wt(xk[pre], wk[pre]),
            "t_post": wt(xk[post], wk[post]),
            "p5_on": p5(wmean) * scale,
            "p5_off": p5(off_w) * scale,
            "breach_on": float(sub.loc[on, "breach"].to_numpy()[keep].mean()) if "breach" in sub and keep.sum() else float("nan"),
            "breach_off": float(off_m["breach"].mean()) if "breach" in off_m and len(off_m) else (
                float(sub.loc[~on, "breach"].mean()) if "breach" in sub else float("nan")
            ),
        })
    return rows


def holm(rows: list[dict]) -> None:
    scored = []
    for r in rows:
        ts = [r["t_pre"], r["t_post"]]
        if not all(np.isfinite(ts)):
            r["p_holm"] = 1.0
            r["pass_t"] = False
            continue
        p = 0.5 * math.erfc(min(ts) / math.sqrt(2))
        scored.append((p, r))
        r["pass_t"] = r["t_pre"] >= 2 and r["t_post"] >= 2
        r["tail_ok"] = np.isfinite(r["p5_on"]) and np.isfinite(r["p5_off"]) and r["p5_on"] >= r["p5_off"]
    scored.sort(key=lambda z: z[0])
    m = len(rows)
    running = 0.0
    for i, (p, r) in enumerate(scored):
        running = max(running, (m - i) * p)
        r["p_holm"] = min(1.0, running)
    for r in rows:
        r.setdefault("p_holm", 1.0)
        r.setdefault("pass_t", False)
        r.setdefault("tail_ok", False)


def show(title: str, rows: list[dict], scale_unit: str) -> None:
    print(f"\n{title}")
    print(f"{'filter':12} {'N':>6} {'pre':>5} {'post':>5} {'lift':>8} {'t':>6} {'t_pre':>7} {'t_post':>7} {'p5on':>8} {'p5off':>8} {'holm':>7} {'pass':>5}")
    for r in rows:
        print(
            f"{r['filter']:12} {r['n']:6} {r['n_pre']:5} {r['n_post']:5} {r['lift']:8.2f} {r['t']:6.2f} {r['t_pre']:7.2f} {r['t_post']:7.2f} "
            f"{r['p5_on']:8.2f} {r['p5_off']:8.2f} {r['p_holm']:7.3f} {str(bool(r['pass_t'])):>5}  {scale_unit}"
        )


def main() -> None:
    z0 = float(ncdf(np.array([0.0]))[0])
    z95 = float(ncdf(np.array([1.64485362695]))[0])
    if abs(z0 - 0.5) > 1e-3 or abs(z95 - 0.95) > 2e-3:
        raise SystemExit(f"ncdf off: {z0} {z95}")
    c = connect()
    print(f"shift={SHIFT} loading daily history", flush=True)
    daily = pd.DataFrame(
        c.execute(
            "SELECT ticker, date, high::float8, low::float8, close::float8, volume::float8, iv30_put::float8 "
            "FROM lseg_research.daily_history WHERE close > 0 ORDER BY ticker, date"
        ).fetchall(),
        columns=["t", "d", "h", "l", "c", "v", "iv"],
    )
    daily = pd.concat([indicators(g) for _, g in daily.groupby("t", sort=False)], ignore_index=True)
    daily = daily[daily.ok & (daily.d >= EVAL0) & (daily.d < EVAL1)].copy()
    daily["iv_raw"] = daily.iv
    ranked = daily[daily.iv > 0].copy()
    ranked["iv"] = ranked.iv / 100.0
    ranked["ivx"] = ranked.groupby("d").iv.rank(pct=True)
    ranked["wk"] = pd.to_datetime(ranked.d).dt.to_period("W").astype(str)
    print(f"ranked days {ranked.d.nunique()} names {ranked.t.nunique()}", flush=True)

    spy = pd.DataFrame(
        c.execute(
            "SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' ORDER BY date"
        ).fetchall(),
        columns=["d", "spy"],
    )
    spy["spy_up"] = spy.spy > spy.spy.rolling(200).mean()
    breadth = daily.groupby("d").below200.mean().rename("breadth")
    vix = pd.DataFrame(
        c.execute(
            "SELECT date, close::float8 FROM lseg_research.daily_history "
            "WHERE ticker IN ('VIX','^VIX','.VIX') ORDER BY date"
        ).fetchall(),
        columns=["d", "vix"],
    )

    print("loading quotes", flush=True)
    q = pd.DataFrame(
        c.execute(
            "SELECT ric, date, bid::float8, ask::float8, iv::float8 "
            "FROM optlab.lseg_opt_daily WHERE bid > 0 AND ask >= bid"
        ).fetchall(),
        columns=["ric", "d", "bid", "ask", "opt_iv"],
    )
    parts = q.ric.str.extract(r"^(.+?)([A-X])(\d\d)(\d\d)(\d{5})\.U(?:\^.*)?$")
    q["root"] = parts[0]
    L = parts[1]
    put = L >= "M"
    mon = L.map(lambda ch: ord(ch) if isinstance(ch, str) else np.nan) - np.where(put.fillna(False), ord("M"), ord("A")) + 1
    exp = pd.to_datetime(
        {"year": pd.to_numeric(parts[3], errors="coerce") + 2000,
         "month": mon,
         "day": pd.to_numeric(parts[2], errors="coerce")},
        errors="coerce",
    )
    q["put"] = put.fillna(False).to_numpy()
    q["exp"] = exp.dt.date
    q["k"] = pd.to_numeric(parts[4], errors="coerce") / 100.0
    q = q[q.put & q.exp.notna() & q.root.notna() & q.k.notna()].copy()
    q["dte"] = (pd.to_datetime(q.exp) - pd.to_datetime(q.d)).dt.days
    q = q[(q.dte >= 3) & (q.dte <= 9)]
    q = q.sort_values(["ric", "d"]).groupby("ric", sort=False).head(1)
    print(f"put contracts in 3-9 DTE window {len(q)}", flush=True)

    px = {(t, d): cl for t, d, cl in zip(daily.t, daily.d, daily.c)}
    # daily includes pre-eval history (ok filter dropped early bars). Reload closes for settlement
    # from the unfiltered frame already held: indicators() kept every row, then we filtered ok.
    # Settlement can fall before the 200-bar mark; pull closes from a slim query instead.
    closes = pd.DataFrame(
        c.execute("SELECT ticker, date, close::float8 FROM lseg_research.daily_history WHERE close > 0").fetchall(),
        columns=["t", "d", "c"],
    )
    px = {(t, d): cl for t, d, cl in zip(closes.t, closes.d, closes.c)}
    lr_map: dict[tuple, float] = {}
    closes = closes.sort_values(["t", "d"])
    for t, g in closes.groupby("t", sort=False):
        lr = np.log(g.c.to_numpy()).copy()
        lr[1:] = np.diff(lr)
        lr[0] = np.nan
        for d, r in zip(g.d, lr):
            if np.isfinite(r):
                lr_map[(t, d)] = float(r)

    def settle(root, exp):
        for n in range(4):
            hit = px.get((root, exp - pd.Timedelta(days=n).to_pytimedelta() if False else _sub(exp, n)))
            if hit is not None:
                return hit
        return None

    def _sub(exp, n):
        return exp - __import__("datetime").timedelta(days=n)

    S, ST = [], []
    for root, d, exp in zip(q.root, q.d, q.exp):
        S.append(px.get((root, d)))
        ST.append(settle(root, exp))
    q["S"] = S
    q["ST"] = ST
    q = q[q.S.notna() & q.ST.notna()].copy()
    q = q[(q.k / q.S > 0.3) & (q.k / q.S < 2) & (q.k < q.S)].copy()
    iv_opt = q.opt_iv.to_numpy()
    iv_opt = np.where(np.isfinite(iv_opt) & (iv_opt > 3) & (iv_opt < 400), iv_opt / 100.0, np.nan)
    q["iv_opt"] = iv_opt
    q = q.merge(ranked[["t", "d", "iv", "ivx"]].rename(columns={"t": "root", "iv": "iv30"}), on=["root", "d"], how="inner")
    iv = np.where(np.isfinite(q.iv_opt.to_numpy()), q.iv_opt.to_numpy(), q.iv30.to_numpy())
    q["iv_used"] = iv
    q["iv_fallback"] = ~np.isfinite(q.iv_opt.to_numpy())
    sig = iv * np.sqrt(q.dte.to_numpy() / 365.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        d1 = (np.log(q.S.to_numpy() / q.k.to_numpy()) + 0.5 * sig * sig) / sig
    q["abs_d"] = np.where(np.isfinite(d1) & np.isfinite(sig) & (sig > 0), 1.0 - ncdf(d1), np.nan)
    q = q[q.abs_d.between(0.05, 0.45)].copy()
    q["dist"] = (q.abs_d - 0.20).abs()
    q["wk"] = pd.to_datetime(q.d).dt.to_period("W").astype(str)
    q = q.sort_values("dist").groupby(["root", "wk"], sort=False).head(1)
    print(
        f"one put per name-week in |d| 0.05-0.45: {len(q)} names {q.root.nunique()} "
        f"median |d| {q.abs_d.median():.3f}",
        flush=True,
    )

    panel = ranked[["t", "d", "wk"] + FLAGS + ["drop15"]].rename(columns={"t": "root"})
    tr = q.merge(panel, on=["root", "d", "wk"], how="inner")
    tr = tr[(tr.d >= EVAL0) & (tr.d < EVAL1) & (tr.ivx >= 2 / 3)].copy()
    tr["bucket"] = pd.cut(tr.abs_d, BUCKETS, right=False)
    days = tr.dte.to_numpy().astype(float)
    sell = tr.bid.to_numpy() + 0.23 * (tr.ask.to_numpy() - tr.bid.to_numpy())
    intr = np.maximum(tr.k.to_numpy() - tr.ST.to_numpy(), 0.0)
    tr["prem"] = (sell - intr) / tr.k.to_numpy() * 7.0 / days
    tr["breach"] = intr > 0
    # realised vol over the hold
    rv = []
    for root, d, exp in zip(tr.root, tr.d, tr.exp):
        rets = []
        cur = d
        while cur <= exp:
            r = lr_map.get((root, cur))
            if r is not None and cur > d:
                rets.append(r)
            cur = _sub(cur, -1)
        rv.append(float(np.std(rets, ddof=1) * math.sqrt(252)) if len(rets) >= 3 else np.nan)
    tr["rv_life"] = rv
    tr["vrp_life"] = tr.iv30 - tr.rv_life
    earn = pd.DataFrame(
        c.execute("SELECT ticker, report_date FROM public.earnings_calendar").fetchall(),
        columns=["root", "ed"],
    )
    earn_sets: dict[str, set] = {}
    for root, ed in zip(earn.root, earn.ed):
        earn_sets.setdefault(root, set()).add(ed)
    has_earn = []
    for root, d, exp in zip(tr.root, tr.d, tr.exp):
        days_e = earn_sets.get(root, ())
        has_earn.append(any(d < ed <= exp for ed in days_e))
    tr["earn_in"] = has_earn
    tr = tr.merge(spy[["d", "spy_up"]], on="d", how="left")
    tr = tr.merge(breadth, left_on="d", right_index=True, how="left")
    if len(vix):
        tr = tr.merge(vix, on="d", how="left")
    tr["t"] = tr.root
    print(
        f"top-IV matched trades {len(tr)} names {tr.root.nunique()} "
        f"dates {tr.d.min()}→{tr.d.max()} "
        f"pre {(pd.to_datetime(tr.d) < SPLIT).sum()} post {(pd.to_datetime(tr.d) >= SPLIT).sum()} "
        f"weeks {tr.wk.nunique()} iv_fallback {tr.iv_fallback.mean():.1%} earn_in {tr.earn_in.mean():.2%} "
        f"vix_rows {int(tr.vix.notna().sum()) if 'vix' in tr else 0} "
        f"buckets {tr.bucket.value_counts().to_dict()}",
        flush=True,
    )

    def run(frame: pd.DataFrame, y: str, title: str, scale: float, unit: str) -> list[dict]:
        use = frame.dropna(subset=[y, "bucket"]).copy()
        rows = clustered_table(use, y, scale)
        holm(rows)
        show(title + f"  N={len(use)}", rows, unit)
        return rows

    prem_rows = run(tr, "prem", "B premium kept bp/wk, matched delta, top-IV", 1e4, "bp")
    vrp_rows = run(tr, "vrp_life", "A iv30 - RV over option life, vol pts", 100, "vol")
    run(tr[~tr.earn_in], "prem", "TAIL no earnings inside expiry, premium bp/wk", 1e4, "bp")
    run(tr[~tr.drop15.astype(bool)], "prem", "TAIL skip 5d drop > 15%, premium bp/wk", 1e4, "bp")
    up = tr[tr.spy_up == True]  # noqa: E712
    dn = tr[tr.spy_up == False]  # noqa: E712
    run(up, "prem", "REGIME SPY > 200d, premium bp/wk", 1e4, "bp")
    run(dn, "prem", "REGIME SPY < 200d, premium bp/wk", 1e4, "bp")
    run(tr[tr.breadth < 0.4], "prem", "REGIME breadth < 40% below 200d", 1e4, "bp")
    run(tr[tr.breadth >= 0.4], "prem", "REGIME breadth >= 40% below 200d", 1e4, "bp")
    if "vix" in tr.columns and tr.vix.notna().any():
        run(tr[tr.vix < 20], "prem", "REGIME VIX < 20", 1e4, "bp")
        run(tr[tr.vix >= 20], "prem", "REGIME VIX >= 20", 1e4, "bp")
    else:
        print("\nVIX not in the daily panel — regime cut skipped")

    n_pass = sum(1 for r in prem_rows if r["pass_t"])
    best = max(prem_rows, key=lambda r: np.nan_to_num(min(r["t_pre"], r["t_post"]), nan=-999))
    a_pass = sum(1 for r in vrp_rows if r["pass_t"])
    print(
        f"\nSUMMARY shift={SHIFT} premium_pass {n_pass}/{len(prem_rows)} "
        f"best {best['filter']} t_pre {best['t_pre']:.2f} t_post {best['t_post']:.2f} "
        f"life_vrp_pass {a_pass}/{len(vrp_rows)}"
    )
    if a_pass == 0:
        print("STOP intraday set not priced: no filter passed iv30-RV over the option life in both halves.")
    print("INTRADAY local optlab.minute_bars start 2024-10-21 (no pre-2023 half without a download). Not fetched.")


if __name__ == "__main__":
    main()
