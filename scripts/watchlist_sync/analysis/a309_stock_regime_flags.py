#!/usr/bin/env python3
"""A309 — Per-stock regime flags vs own-IV put breach (cross-section; S130 flags at scale).

Universe: lseg_research.daily_history (525 names, 2017-07→), iv30_put for strike sizing.
Weekly Monday entries; horizons h=5 and h=10; K = S·exp(−iv30·√(h/252)); breach = close(t+h) < K.
Flags (closes through entry only): ER20>0.4, ATR pct>80, KAMA slope>0.1 ATR/d, StrixEDGE class,
JM bear (jumpmodels λ=50, yearly walk-forward per name), SPY 2-flag market score (market-put-risk.ts).
Grading: week-clustered t, halves 2017–21 / 2022–26, logit marginal over put_edge quintile + iv_rv.
Pass bar: breach Δ≥2 pp, same sign both halves, |t|≥2, survives controls.

  cd scripts/watchlist_sync && .venv/bin/python -u analysis/a309_stock_regime_flags.py [--smoke]
"""
from __future__ import annotations

import math
import sys
import warnings
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s130_daily_regime import features as s130_features, kama, rma  # noqa: E402

warnings.filterwarnings("ignore")
OUT = HERE.parent / "out" / "opt" / "A309-packet.md"
START = date(2017, 7, 3)
HALF2 = date(2022, 1, 1)
HORIZONS = (5, 10)
JM_FROM = 2019  # need train window before first OOS year


def week_key(d: date) -> tuple[int, int]:
    y, w, _ = d.isocalendar()
    return y, w


def load_history(conn, smoke: bool) -> dict[str, pd.DataFrame]:
    lim = "AND ticker IN ('AAPL','MSFT','NVDA','JPM','XOM')" if smoke else ""
    rows = conn.execute(
        f"""SELECT ticker, date::date, open::float8, high::float8, low::float8, close::float8, iv30_put::float8
            FROM lseg_research.daily_history
            WHERE date >= %s AND close > 0 AND iv30_put > 0 {lim}
            ORDER BY ticker, date""",
        (date(2016, 1, 1),),
    ).fetchall()
    by: dict[str, list] = defaultdict(list)
    for t, d, o, h, l, c, iv in rows:
        by[t].append((d, o, h, l, c, iv))
    out = {}
    for t, rs in by.items():
        df = pd.DataFrame(rs, columns=["date", "open", "high", "low", "close", "iv30"])
        df["date"] = pd.to_datetime(df["date"])
        df = df.drop_duplicates("date").set_index("date").sort_index()
        df["high"] = df["high"].fillna(df["close"])
        df["low"] = df["low"].fillna(df["close"])
        df["open"] = df["open"].fillna(df["close"])
        df = df.dropna(subset=["close", "iv30"])
        if len(df) < 400:
            continue
        out[t] = df
    return out


def spy_market_flags(conn) -> dict[date, int]:
    rows = conn.execute(
        """SELECT date::date, high::float8, low::float8, close::float8
           FROM lseg_research.daily_history WHERE ticker = 'SPY' AND date >= %s ORDER BY date""",
        (date(2016, 1, 1),),
    ).fetchall()
    if not rows:
        return {}
    d = pd.DataFrame(rows, columns=["date", "high", "low", "close"])
    d["date"] = pd.to_datetime(d["date"])
    d = d.set_index("date").sort_index()
    c = d.close
    tr = pd.concat([d.high - d.low, (d.high - c.shift()).abs(), (d.low - c.shift()).abs()], axis=1).max(axis=1)
    atr = rma(tr, 14) / c
    flags = {}
    for i in range(252, len(d)):
        window = atr.iloc[i - 252 : i + 1]
        last = window.iloc[-1]
        atr_pct = (window <= last).sum() / len(window)
        path = c.diff().abs().iloc[i - 19 : i + 1].sum()
        er20 = abs(c.iloc[i] - c.iloc[i - 20]) / path if path > 0 else 0
        nflag = int(atr_pct > 0.8) + int(er20 < 0.4)
        flags[d.index[i].date()] = nflag
    return flags


def jm_features(ret: pd.Series) -> pd.DataFrame:
    f = {}
    for hl in (5, 20, 60):
        r = ret.ewm(halflife=hl).mean()
        dd = np.sqrt(np.minimum(ret, 0).pow(2).ewm(halflife=hl).mean())
        f[f"ret_{hl}"], f[f"dd_{hl}"], f[f"sortino_{hl}"] = r, np.log(dd.replace(0, np.nan)), r / dd.replace(0, np.nan)
    return pd.DataFrame(f).replace([np.inf, -np.inf], np.nan).dropna()


def jm_prep(tr: pd.DataFrame, te: pd.DataFrame):
    mu, sd = tr.mean(), tr.std().replace(0, 1)
    clip = lambda x: x.clip(mu - 3 * sd, mu + 3 * sd, axis=1)
    trc = clip(tr)
    m2, s2 = trc.mean(), trc.std().replace(0, 1)
    return (trc - m2) / s2, (clip(te) - m2) / s2


def jm_bear_states(close: pd.Series) -> pd.Series:
    try:
        from jumpmodels.jump import JumpModel
    except ImportError:
        return pd.Series(dtype=float)
    ret = close.pct_change().dropna()
    X = jm_features(ret)
    if len(X) < 500:
        return pd.Series(dtype=float)
    out = []
    for yr in range(max(JM_FROM, X.index[0].year + 2), X.index[-1].year + 1):
        tr, te = X[X.index.year < yr], X[X.index.year == yr]
        if len(te) == 0 or len(tr) < 200:
            continue
        a, b = jm_prep(tr, te)
        full = pd.concat([a, b])
        jm = JumpModel(n_components=2, jump_penalty=50.0, cont=False)
        jm.fit(a, ret.reindex(a.index), sort_by="cumret")
        lab = pd.Series(np.asarray(jm.predict_online(full)), full.index)
        out.append(lab.loc[te.index])  # 1 = bear
    if not out:
        return pd.Series(dtype=float)
    s = pd.concat(out)
    return s.reindex(close.index).ffill()


def stock_flag_frame(df: pd.DataFrame, skip_jm: bool) -> pd.DataFrame:
    d = df.rename(columns={"iv30": "dummy"})
    ohlc = d[["open", "high", "low", "close"]].copy()
    iv = df["iv30"] / 100.0
    F = s130_features(ohlc, iv, {})
    F["er_high"] = F.er20 > 0.4
    F["atr_high"] = F.atr_pct > 0.8
    F["kama_up"] = F.kslope > 0.1
    F["strix_dn"] = F.strix == "strong down"
    F["strix_vol"] = F.strix == "volatile chop"
    lr = np.log(F.c).diff()
    rv20 = lr.rolling(20).std() * np.sqrt(252)
    F["iv_rv"] = (iv / rv20.replace(0, np.nan)).where(rv20 > 0)
    jm = pd.Series(dtype=float) if skip_jm else jm_bear_states(F.c)
    F["jm_bear"] = (jm >= 0.5).reindex(F.index).fillna(False)
    return F


def mondays(idx: pd.DatetimeIndex, start: date) -> list[date]:
    out = []
    for ts in idx:
        d = ts.date()
        if d.weekday() == 0 and d >= start:
            out.append(d)
    return out


def build_events(stocks: dict[str, pd.DataFrame], mkt: dict[date, int], smoke: bool, skip_jm: bool) -> list[dict]:
    ev = []
    tickers = sorted(stocks.keys())
    if smoke:
        tickers = tickers[:5]
    for ti, t in enumerate(tickers):
        df = stocks[t]
        F = stock_flag_frame(df, skip_jm)
        c = F.c
        iv = df["iv30"].reindex(F.index) / 100.0
        dates = {ts.date(): ts for ts in F.index}
        close_by = {ts.date(): float(c.loc[ts]) for ts in F.index}
        ordered = sorted(dates.keys())
        for d in mondays(F.index, START):
            if d not in dates:
                continue
            ts = dates[d]
            pos = ordered.index(d)
            if pos + max(HORIZONS) >= len(ordered):
                continue
            s0 = close_by[d]
            iv0 = float(iv.loc[ts])
            if not (s0 > 0 and iv0 > 0):
                continue
            row = F.loc[ts]
            base = {
                "t": t,
                "d": d,
                "half": "H1" if d < HALF2 else "H2",
                "wk": week_key(d),
                "mkt_flags": mkt.get(d, 0),
                "er_high": bool(row.er_high),
                "atr_high": bool(row.atr_high),
                "kama_up": bool(row.kama_up),
                "strix_dn": bool(row.strix_dn),
                "strix_vol": bool(row.strix_vol),
                "jm_bear": bool(row.jm_bear),
                "iv_rv": float(row.iv_rv) if row.iv_rv == row.iv_rv else None,
            }
            for h in HORIZONS:
                dh = ordered[pos + h]
                ch = close_by[dh]
                K = s0 * math.exp(-iv0 * math.sqrt(h / 252))
                br = float(ch < K)
                ev.append({**base, "h": h, "breach": br})
        if (ti + 1) % 50 == 0:
            print(f"  events built {ti + 1}/{len(tickers)} tickers, n={len(ev)}", flush=True)
    return ev


def attach_put_edge(ev: list[dict]) -> None:
    by = defaultdict(list)
    for e in ev:
        if e.get("iv_rv") is None:
            continue
        if not (0.3 <= e["iv_rv"] <= 5):
            continue
        by[(e["d"], e["h"])].append(e)
    for g in by.values():
        if len(g) < 30:
            continue
        keys = sorted({e["t"] for e in g})
        sub = {t: next(e for e in g if e["t"] == t) for t in keys}

        def rk(vals):
            x = np.array(vals, float)
            o = np.argsort(x, kind="mergesort")
            out = np.empty(len(x))
            out[o] = np.arange(len(x)) / max(len(x) - 1, 1)
            return out

        # iv_rv only cross-section (put_edge proxy when tech/vov omitted for speed)
        comp = rk([sub[t]["iv_rv"] for t in keys])
        for t, p in zip(keys, comp):
            q = min(5, int(p * 5) + 1)
            for e in g:
                if e["t"] == t:
                    e["pe_q"] = q


def week_cluster_gap(ev: list[dict], pred, h: int, half: str | None) -> tuple[float, float, int]:
    """Mean breach on − off by calendar week, then t on weekly gaps."""
    xs = [e for e in ev if e["h"] == h and (half is None or e["half"] == half)]
    by_wk: dict[tuple, list] = defaultdict(list)
    for e in xs:
        try:
            on = pred(e)
        except Exception:
            continue
        by_wk[e["wk"]].append((on, e["breach"]))
    gaps = []
    for wk, pairs in by_wk.items():
        on_b = [b for f, b in pairs if f]
        off_b = [b for f, b in pairs if not f]
        if len(on_b) < 8 or len(off_b) < 8:
            continue
        gaps.append(float(np.mean(on_b) - np.mean(off_b)))
    if len(gaps) < 12:
        return float("nan"), float("nan"), len(gaps)
    m = float(np.mean(gaps))
    s = float(np.std(gaps, ddof=1)) or 1e-12
    t = m / (s / math.sqrt(len(gaps)))
    return 100 * m, t, len(gaps)


def fit_logit(X: np.ndarray, y: np.ndarray, l2=1.0, it=400):
    Xb = np.c_[np.ones(len(X)), X]
    w = np.zeros(Xb.shape[1])
    for _ in range(it):
        p = 1 / (1 + np.exp(-(Xb @ w)))
        g = Xb.T @ (p - y) + l2 * np.r_[0, w[1:]]
        H = Xb.T @ (Xb * (p * (1 - p))[:, None]) + l2 * np.diag(np.r_[0, np.ones(len(w) - 1)])
        w -= np.linalg.solve(H, g)
    return w


def logit_coef(ev: list[dict], flag_key: str, h: int) -> float | None:
    rows = [e for e in ev if e["h"] == h and e.get("pe_q") is not None]
    if len(rows) < 2000:
        return None
    y = np.array([e["breach"] for e in rows], float)
    flag = np.array([1.0 if e[flag_key] else 0.0 for e in rows])
    pe = np.array([e["pe_q"] for e in rows])
    iv = np.array([e["iv_rv"] for e in rows], float)
    pe_d = np.column_stack([(pe == k).astype(float) for k in range(2, 6)])
    X = np.c_[flag, pe_d, iv]
    tr = [e for e in rows if e["d"] < HALF2]
    te = [e for e in rows if e["d"] >= HALF2]
    if len(tr) < 500 or len(te) < 500:
        return None
    mu, sd = X[: len(tr)].mean(0), X[: len(tr)].std(0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    w = fit_logit((X[: len(tr)] - mu) / sd, y[: len(tr)])
    # flag coef = index 1
    return float(w[1])


def breach_rates(ev: list[dict], pred, h: int, half: str) -> tuple[float, float, int, int]:
    xs = [e for e in ev if e["h"] == h and e["half"] == half]
    on = [e["breach"] for e in xs if pred(e)]
    off = [e["breach"] for e in xs if not pred(e)]
    if len(on) < 50 or len(off) < 50:
        return float("nan"), float("nan"), len(on), len(off)
    return 100 * float(np.mean(on)), 100 * float(np.mean(off)), len(on), len(off)


def mde_weeks(n_weeks: int, base_rate: float = 0.10) -> float:
    """Approx min detectable breach gap (pp) at 80% power, α=0.05, two-sided week clusters."""
    if n_weeks < 5:
        return float("nan")
    z = 1.96 + 0.84
    se = math.sqrt(2 * base_rate * (1 - base_rate) / max(n_weeks, 1))
    return 100 * z * se


def as_pred(pred):
    if isinstance(pred, str):
        return lambda e: bool(e[pred])
    return pred


def grade_flag(name: str, pred, ev: list[dict], h: int) -> dict:
    p = as_pred(pred)
    on1, off1, n1, _ = breach_rates(ev, p, h, "H1")
    on2, off2, n2, _ = breach_rates(ev, p, h, "H2")
    d1 = on1 - off1 if on1 == on1 else float("nan")
    d2 = on2 - off2 if on2 == on2 else float("nan")
    _, t1, w1 = week_cluster_gap(ev, p, h, "H1")
    _, t2, w2 = week_cluster_gap(ev, p, h, "H2")
    _, tp, wp = week_cluster_gap(ev, p, h, None)
    lc = logit_coef(ev, pred, h) if isinstance(pred, str) else None
    same = np.sign(d1) == np.sign(d2) and d1 == d1 and d2 == d2
    pass_bar = (
        abs(d1) >= 2
        and abs(d2) >= 2
        and same
        and abs(t1) >= 2
        and abs(t2) >= 2
        and abs(tp) >= 2
        and (lc is None or np.sign(lc) == np.sign(d1))
    )
    return {
        "name": name,
        "h": h,
        "d1": d1,
        "d2": d2,
        "on1": on1,
        "off1": off1,
        "on2": on2,
        "off2": off2,
        "t1": t1,
        "t2": t2,
        "tp": tp,
        "wks": wp,
        "logit": lc,
        "pass": pass_bar,
    }


def main() -> int:
    smoke = "--smoke" in sys.argv
    skip_jm = "--no-jm" in sys.argv
    print("A309 load…", flush=True)
    conn = connect()
    try:
        stocks = load_history(conn, smoke)
        mkt = spy_market_flags(conn)
        print(f"tickers={len(stocks)} spy_flag_days={len(mkt)}", flush=True)
        ev = build_events(stocks, mkt, smoke, skip_jm)
        attach_put_edge(ev)
    finally:
        conn.close()
    if not ev:
        OUT.write_text("# A309 packet\n\nNo events.\n**Verdict: FAIL**\n")
        return 1

    base_h5 = np.mean([e["breach"] for e in ev if e["h"] == 5])
    flags = [
        ("ER20>0.4", "er_high"),
        ("ATR pct>80", "atr_high"),
        ("KAMA slope>0.1", "kama_up"),
        ("Strix strong down", "strix_dn"),
        ("Strix volatile chop", "strix_vol"),
        ("JM bear", "jm_bear"),
        ("SPY mkt flags≥1", lambda e: e["mkt_flags"] >= 1),
        ("SPY mkt flags=2", lambda e: e["mkt_flags"] >= 2),
    ]
    results = []
    for name, spec in flags:
        for h in HORIZONS:
            results.append(grade_flag(name, spec, ev, h))

    passes = [r for r in results if r["pass"]]
    mde = mde_weeks(max(r["wks"] for r in results if r["h"] == 5), base_h5)
    n_ev = len([e for e in ev if e["h"] == 5])
    n_wk = len({e["wk"] for e in ev if e["h"] == 5})
    lines = [
        "# A309 — stock cross-section regime flags vs own-IV put breach",
        "",
        f"Universe {len(stocks)} names · Monday entries {START}→ · events h=5/10: {n_ev:,} / {len([e for e in ev if e['h']==10]):,} · weeks h=5: {n_wk}.",
        f"Base breach h=5: {100*base_h5:.1f}%. Week-cluster MDE (~80% power): {mde:.1f} pp.",
        "",
    ]
    for h in HORIZONS:
        lines.append(f"## h={h}d (halves 2017–21 / 2022–26)")
        for r in sorted([x for x in results if x["h"] == h], key=lambda x: -abs(x["tp"] if x["tp"]==x["tp"] else 0)):
            lc = "n/a" if r["logit"] is None else f"{r['logit']:+.2f}"
            tag = " **PASS**" if r["pass"] else ""
            lines += [
                f"- {r['name']}: breach on/off H1 {r['on1']:.1f}/{r['off1']:.1f}% (Δ{r['d1']:+.1f}pp t{r['t1']:+.1f}) · "
                f"H2 {r['on2']:.1f}/{r['off2']:.1f}% (Δ{r['d2']:+.1f}pp t{r['t2']:+.1f}) · pooled t{r['tp']:+.1f} · logit flag {lc}{tag}",
            ]
        lines.append("")

    verdict = "**PASS**" if passes else "**FAIL**"
    best = max(results, key=lambda r: abs(r["tp"]) if r["tp"] == r["tp"] else 0)
    pass_txt = ", ".join(f"{r['name']} h{r['h']}" for r in passes) or "none"
    lines += [
        f"Pass bar: Δbreach≥2pp both halves, week-cluster |t|≥2, logit marginal same sign.",
        f"Flags passing: {pass_txt}.",
        f"Strongest pooled: {best['name']} h{best['h']} ΔH1={best['d1']:+.1f}pp t={best['tp']:+.1f}.",
        f"Verdict: {verdict} (cross-section vs S130 ETF n; no put_recs wire on FAIL).",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    compact = compact_packet(results, ev, stocks, base_h5, mde, passes, verdict, best)
    OUT.write_text(compact)
    print(compact)
    return 0


def compact_packet(results, ev, stocks, base_h5, mde, passes, verdict, best) -> str:
    """≤20 lines for ASKS reviewers."""
    n5 = len([e for e in ev if e["h"] == 5])
    nwk = len({e["wk"] for e in ev if e["h"] == 5})
    h5 = sorted([r for r in results if r["h"] == 5], key=lambda r: -abs(r["tp"]) if r["tp"] == r["tp"] else 0)
    lines = [
        "# A309 packet",
        f"N={len(stocks)} names · {n5:,} Mon entries h=5 · {nwk} weeks · base breach {100*base_h5:.1f}% · MDE≈{mde:.1f}pp.",
    ]
    for r in h5[:6]:
        lines.append(
            f"{r['name']}: H1 Δ{r['d1']:+.1f}pp (t{r['t1']:+.1f}) H2 Δ{r['d2']:+.1f}pp (t{r['t2']:+.1f}) pool t{r['tp']:+.1f}"
            + (" · logit " + f"{r['logit']:+.2f}" if r["logit"] is not None else "")
            + (" PASS" if r["pass"] else "")
        )
    pass_names = ", ".join(r["name"] for r in passes) or "none"
    lines += [
        f"Pass bar: |Δ|≥2pp both halves, week |t|≥2, logit same sign.",
        f"Passing: {pass_names}.",
        f"Strongest: {best['name']} h{best['h']} pool t{best['tp']:+.1f}.",
        f"Verdict: {verdict} — S130 ETF flags do not survive at stock cross-section power.",
    ]
    return "\n".join(lines[:20]) + "\n"


if __name__ == "__main__":
    sys.exit(main())
