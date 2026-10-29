"""A314 family 5 — cross-asset leads (TLT, HYG/IEF, UUP/DXY, USDJPY, BTC).

Intraday: SPY+QQQ 5m panel (S139); no cross-asset 5m in optlab → prior-close→open shock flags the session
(credit/rates/dollar/yen/BTC), minute-matched placebo, day-clustered t on P(drop ≥½ ATR).
Daily: Yahoo 1d in vendor_raw → S130-style 5/10d put breach (own VIX), non-overlapping windows.
Incremental: day-clustered logit t on event coef with S126 risk score (intraday dropx; daily breach).
Pass → put_benchmark skip-week overlay. Run: cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/a314_crossasset.py
"""
from __future__ import annotations

import hashlib
import json
import math
import pickle
import sys
import urllib.request
from datetime import date, datetime, timezone
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
from s126_intraday_regime import load  # noqa: E402
from s130_daily_regime import features, outcomes, tstat  # noqa: E402
from a314_breadth_live_n import risk_score  # noqa: E402
from a314_changepoint import put_overlay  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A314-crossasset-packet.md"
Z_MDE = 1.96 + 0.84


def mde_se_pp(a: pd.Series, b: pd.Series) -> float:
    """MDE (pp) = (z.975 + z.80) × SE of event−placebo mean (same units as breach/dropx t)."""
    if len(a) < 3 or len(b) < 3:
        return float("nan")
    va, vb = a.var(ddof=1), b.var(ddof=1)
    if not math.isfinite(va) or not math.isfinite(vb):
        return float("nan")
    se = math.sqrt(va / len(a) + vb / len(b))
    return 100 * Z_MDE * se if se > 0 else float("nan")


def arm_half(R: pd.DataFrame, ev: str) -> pd.DataFrame:
    """Split at midpoint of event session dates (per arm)."""
    days = sorted(R.loc[R[ev], "d"].unique())
    if len(days) < 4:
        R = R.copy()
        R["half"] = "H1"
        return R
    split = days[len(days) // 2]
    R = R.copy()
    R["half"] = np.where(R.d < split, "H1", "H2")
    return R


def cross_placebo(R: pd.DataFrame, ev: str) -> pd.DataFrame:
    """All non-event sessions at the same checkpoint minute(s) as events."""
    return R[~R[ev]]


def day_t_indep(e: pd.DataFrame, p: pd.DataFrame, col: str) -> tuple[float, int]:
    a = e.groupby("d")[col].mean()
    b = p.groupby("d")[col].mean()
    if len(a) < 3 or len(b) < 3:
        return float("nan"), len(a) + len(b)
    t = (a.mean() - b.mean()) / math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    return float(t), len(a) + len(b)


def eval_cross(R: pd.DataFrame, ev: str, outcome: str, claim: str, source: str) -> dict:
    Ra = arm_half(R, ev)
    e_all = Ra[Ra[ev]]
    p_all = cross_placebo(Ra, ev)
    if len(e_all) < 8:
        return dict(
            name=ev,
            claim=claim,
            source=source,
            verdict=f"FAIL (sparse n={len(e_all)} events)",
            pass_bar=False,
            eff={"H1": float("nan"), "H2": float("nan")},
            ts={"H1": float("nan"), "H2": float("nan")},
            mde={"H1": float("nan"), "H2": float("nan")},
            n_half={"H1": int((e_all.half == "H1").sum()), "H2": int((e_all.half == "H2").sum())},
            n_ev=len(e_all),
            opp_sign=False,
        )
    eff, ts, ns, mde, n_half = {}, {}, {}, {}, {}
    for h in ("H1", "H2"):
        e = e_all[e_all.half == h]
        p = p_all[p_all.half == h]
        n_half[h] = len(e)
        if len(e) < 4 or len(p) < 8:
            eff[h] = ts[h] = mde[h] = float("nan")
            ns[h] = 0
            continue
        eff[h] = 100 * (e[outcome].mean() - p[outcome].mean())
        ts[h], ns[h] = day_t_indep(e, p, outcome)
        ed = e.groupby("d")[outcome].mean()
        pd_ = p.groupby("d")[outcome].mean()
        mde[h] = mde_se_pp(ed, pd_)
    e1, e2 = eff["H1"], eff["H2"]
    t1, t2 = ts["H1"], ts["H2"]
    same = np.sign(e1) == np.sign(e2) and math.isfinite(e1) and math.isfinite(e2) and e1 != 0
    opp_sign = same and e1 < 0 and ev == "usdjpy_yen"
    pass_bar = same and abs(t1) >= 2 and abs(t2) >= 2 and e1 > 0
    return dict(
        name=ev,
        claim=claim,
        source=source,
        outcome=outcome,
        eff=eff,
        ts=ts,
        ns=ns,
        mde=mde,
        n_half=n_half,
        n_ev=len(e_all),
        pass_bar=pass_bar,
        opp_sign=opp_sign,
        verdict="PASS intraday" if pass_bar else "FAIL",
    )

YAHOO_D = "chart/1d/1993"
PERIOD1 = 725811600  # 1993-01-01
PERIOD2 = 4102444800
SYMS = {
    "HYG": "HYG",
    "IEF": "IEF",
    "TLT": "TLT",
    "UUP": "UUP (DXY proxy)",
    "JPY=X": "USD/JPY (Yahoo JPY=X)",
    "BTC-USD": "BTC-USD",
    "SPY": "SPY",
    "QQQ": "QQQ",
    "^VIX": "VIX",
    "^VXN": "VXN",
    "^VXD": "VXD",
}


def fetch_yahoo(conn, sym: str) -> None:
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM vendor_raw WHERE source='yahoo' AND endpoint=%s AND key=%s LIMIT 1",
        (YAHOO_D, sym),
    )
    if cur.fetchone():
        return
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
        f"?period1={PERIOD1}&period2={PERIOD2}&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = json.load(urllib.request.urlopen(req, timeout=60))
    payload = json.dumps(raw)
    sha = hashlib.sha256(payload.encode()).hexdigest()
    today = date.today()
    cur.execute(
        """INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
           VALUES ('yahoo', %s, %s, %s, %s::jsonb, %s)
           ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE
           SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
        (YAHOO_D, sym, today, payload, sha),
    )
    conn.commit()


def quotes_df(conn, sym: str) -> pd.DataFrame:
    cur = conn.cursor()
    cur.execute(
        """SELECT payload FROM vendor_raw
           WHERE source='yahoo' AND endpoint=%s AND key=%s
           ORDER BY fetched_on DESC LIMIT 1""",
        (YAHOO_D, sym),
    )
    row = cur.fetchone()
    if not row:
        raise KeyError(sym)
    p = row[0]
    if "quotes" in p:
        q = p["quotes"]
    else:
        r = p["chart"]["result"][0]
        ts = r["timestamp"]
        qd = r["indicators"]["quote"][0]
        q = [
            {
                "date": datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"),
                "open": qd["open"][i],
                "high": qd["high"][i],
                "low": qd["low"][i],
                "close": qd["close"][i],
                "volume": qd["volume"][i],
            }
            for i, t in enumerate(ts)
            if qd["close"][i] is not None
        ]
    d = pd.DataFrame(q)
    d["date"] = pd.to_datetime(d["date"], utc=True).dt.tz_convert("America/New_York").dt.normalize().dt.tz_localize(None)
    d = d.dropna(subset=["close"]).drop_duplicates("date").set_index("date").sort_index()
    return d[["open", "high", "low", "close", "volume"]].astype(float)


def overnight_map(dfs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Prior close → today's open return per symbol; HYG/IEF ratio change."""
    rows = []
    syms = [s for s in dfs if s not in ("^VIX", "^VXN", "^VXD")]
    dates = sorted(set.intersection(*[set(dfs[s].index) for s in syms if s in dfs]))
    for i in range(1, len(dates)):
        d = dates[i]
        pd_ = dates[i - 1]
        row = {"date": d}
        for s in syms:
            if s not in dfs or d not in dfs[s].index or pd_ not in dfs[s].index:
                continue
            pc = dfs[s].loc[pd_, "close"]
            op = dfs[s].loc[d, "open"]
            if pc > 0:
                row[f"on_{s}"] = op / pc - 1
        if "HYG" in dfs and "IEF" in dfs and d in dfs["HYG"].index and pd_ in dfs["IEF"].index:
            r0 = dfs["HYG"].loc[pd_, "close"] / dfs["IEF"].loc[pd_, "close"]
            r1 = dfs["HYG"].loc[d, "open"] / dfs["IEF"].loc[d, "open"]
            row["on_hyg_ie"] = r1 / r0 - 1 if r0 > 0 else np.nan
        rows.append(row)
    return pd.DataFrame(rows).set_index("date")


def daily_ret(dfs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    out = {}
    for s, df in dfs.items():
        if s.startswith("^"):
            continue
        out[s] = df["close"].pct_change()
    if "HYG" in dfs and "IEF" in dfs:
        r = dfs["HYG"]["close"] / dfs["IEF"]["close"]
        out["hyg_ie"] = r.pct_change()
    return pd.DataFrame(out)


def build_intraday(on: pd.DataFrame) -> pd.DataFrame:
    rows = []
    dset = {d.date() if hasattr(d, "date") else d: on.loc[d] for d in on.index}
    for tk in ("SPY", "QQQ"):
        df = load(tk)
        days = [g.reset_index(drop=True) for _, g in df.groupby("d") if len(g) >= 70]
        closes = np.array([g.c.iloc[-1] for g in days])
        highs = np.array([g.h.max() for g in days])
        lows = np.array([g.l.min() for g in days])
        for k in range(21, len(days)):
            g = days[k]
            d = g.d.iloc[0]
            if d not in dset:
                continue
            shock = dset[d]
            pcs = closes[k - 21 : k]
            tr = np.maximum(
                highs[k - 20 : k] - lows[k - 20 : k],
                np.maximum(abs(highs[k - 20 : k] - pcs[:-1]), abs(lows[k - 20 : k] - pcs[:-1])),
            ) / pcs[:-1]
            atr = tr.mean()
            ret5 = closes[k - 1] / closes[k - 6] - 1 if k >= 6 else 0.0
            o = g.o.iloc[0]
            hyg = shock.get("on_hyg_ie", np.nan)
            tlt = shock.get("on_TLT", np.nan)
            uup = shock.get("on_UUP", np.nan)
            jpy = shock.get("on_JPY=X", np.nan)
            btc = shock.get("on_BTC-USD", np.nan)
            spy_on = shock.get("on_SPY", np.nan)
            # One checkpoint per session (overnight shock is day-constant; S139 placebo needs mixed event/non-event days).
            i = min(len(g) - 2, max(5, (120 - 5) // 5))
            m = int(g.m.iloc[i]) + 5
            if m < 30 or m > 330:
                continue
            p = g.c.iloc[i]
            rest = g.iloc[i + 1 :]
            sub = g.iloc[: i + 1]
            sc = risk_score(sub, m, atr, ret5)
            rows.append(
                dict(
                    tk=tk,
                    d=d,
                    m=m,
                    dropx=(min(rest.l.min() / p - 1, 0) / atr) <= -0.5,
                    rest_rng=(rest.h.max() - rest.l.min()) / p / atr,
                    score=sc,
                    hyg_ie_shock=hyg <= -0.008 if hyg == hyg else False,
                    tlt_flight=tlt >= 0.006 and spy_on <= 0 if tlt == tlt and spy_on == spy_on else False,
                    uup_spike=uup >= 0.004 if uup == uup else False,
                        usdjpy_yen=jpy <= -0.004 if jpy == jpy else False,
                    btc_riskoff=btc <= -0.02 if btc == btc else False,
                )
            )
    return pd.DataFrame(rows)


def logit_inc_t(R: pd.DataFrame, col: str, ycol: str, half: str) -> float:
    y = R[R.half == half].dropna(subset=["score", col, ycol])
    if len(y) < 200:
        return float("nan")
    X = sm.add_constant(y[["score", col]].astype(float))
    mod = Logit(y[ycol].astype(int), X).fit(disp=0, maxiter=100)
    cov = cov_cluster(mod, pd.Categorical(y.d).codes)
    i = list(X.columns).index(col)
    se = np.sqrt(cov[i, i])
    return float(mod.params[col] / se) if se > 0 else float("nan")


def logit_inc_daily(X: pd.DataFrame, half: str) -> float:
    y = X[X.half == half].dropna(subset=["breach", "atr_hi", "er_lo", "flag"])
    if len(y) < 200 or y.flag.sum() < 8:
        return float("nan")
    Xd = sm.add_constant(y[["atr_hi", "er_lo", "flag"]].astype(float))
    try:
        mod = Logit(y.breach.astype(int), Xd).fit(disp=0, maxiter=80)
        cov = cov_cluster(mod, pd.Categorical(y.index).codes)
        i = list(Xd.columns).index("flag")
        se = np.sqrt(cov[i, i])
        return float(mod.params["flag"] / se) if se > 0 else float("nan")
    except Exception:
        return float("nan")


def eval_daily_breach(dfs: dict[str, pd.DataFrame], col: str, mask: pd.Series, claim: str, src: str) -> dict:
    spy = dfs["SPY"]
    vix = dfs["^VIX"].close
    F = features(spy, vix, {})
    m = mask.reindex(F.index).fillna(False)
    res = {}
    for h in (5, 10):
        O = outcomes(F, h)
        X = F.join(O).iloc[252::h].dropna(subset=["breach"]).copy()
        X["flag"] = m.reindex(X.index).fillna(False)
        X["atr_hi"] = (X.atr_pct > 0.8).astype(int)
        X["er_lo"] = (X.er20 < 0.4).astype(int)
        on_days = X.index[X.flag]
        if len(on_days) >= 4:
            split = on_days[len(on_days) // 2]
            X["half"] = np.where(X.index < split, "H1", "H2")
        else:
            X["half"] = "H1"
        ts = {}
        eff = {}
        mde = {}
        n_half = {}
        for half in ("H1", "H2"):
            sub = X[X.half == half]
            a = sub[sub.flag].breach
            b = sub[~sub.flag].breach
            n_half[half] = len(a)
            ts[half] = tstat(a, b)
            eff[half] = 100 * (a.mean() - b.mean()) if len(a) > 5 and len(b) > 5 else float("nan")
            mde[half] = mde_se_pp(a, b) if len(a) > 5 and len(b) > 5 else float("nan")
        n = int(X.flag.sum())
        e1, e2 = eff["H1"], eff["H2"]
        same = math.isfinite(e1) and math.isfinite(e2) and e1 != 0 and np.sign(e1) == np.sign(e2)
        pass_bar = same and abs(ts["H1"]) >= 2 and abs(ts["H2"]) >= 2 and e1 > 0
        inc1, inc2 = logit_inc_daily(X, "H1"), logit_inc_daily(X, "H2")
        res[h] = dict(
            ts=ts,
            eff=eff,
            mde=mde,
            n_half=n_half,
            pass_bar=pass_bar,
            n=n,
            inc=(inc1, inc2),
        )
    return dict(name=col, claim=claim, source=src, daily=res)


def put_skip_daily(flags: set[date]) -> str:
    import band_engine as BE
    from put_benchmark import engine_rule, verdict

    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
    tr = [r for r in rows if r["d"] < BE.SPLIT]
    table = BE.fit(tr)
    live = engine_rule(table)
    weeks = sorted({r["d"] for r in rows if r["d"] >= BE.SPLIT})
    te = [r for r in rows if r["d"] >= BE.SPLIT]
    tr_weeks = sorted({r["d"] for r in tr})

    def rule(row):
        from datetime import timedelta

        pd_ = row["d"] - timedelta(days=1)
        while pd_.weekday() >= 5:
            pd_ -= timedelta(days=1)
        if pd_ in flags:
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
    return f"Δ{dbp:+.1f}bp t{t:+.1f} → **{v}**"


INTRADAY = [
    ("hyg_ie_shock", "dropx", "overnight HYG/IEF selloff → ↑ SPY drop ≥½ ATR", "Credit stress (HYG/IEF)"),
    ("tlt_flight", "dropx", "overnight TLT rally + SPY not up → ↑ drop risk", "Flight to quality (TLT)"),
    ("uup_spike", "dropx", "overnight UUP spike → ↑ SPY drop risk", "DXY / UUP"),
    ("usdjpy_yen", "dropx", "overnight USDJPY drop (yen up) → ↑ drop risk", "USD/JPY"),
    ("btc_riskoff", "dropx", "overnight BTC −2% → ↑ SPY drop risk", "BTC risk-off"),
]

DAILY = [
    ("hyg_ie_day", lambda dr: dr["hyg_ie"] <= -0.01, "HYG/IEF 1d ≤ −1% → ↑ 5–10d put breach", "Credit (HYG/IEF)"),
    ("tlt_spike_day", lambda dr: dr["TLT"] >= 0.01, "TLT 1d ≥ +1% → ↑ breach", "Rates (TLT)"),
    ("uup_spike_day", lambda dr: dr["UUP"] >= 0.005, "UUP 1d ≥ +0.5% → ↑ breach", "DXY (UUP)"),
    ("usdjpy_day", lambda dr: dr["JPY=X"] <= -0.005, "USDJPY 1d ≤ −0.5% (yen up) → ↑ breach", "USD/JPY"),
    ("btc_crash_day", lambda dr: dr["BTC-USD"] <= -0.03, "BTC 1d ≤ −3% → ↑ breach", "BTC"),
]


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break
    with connect() as conn:
        dfs = {sym: quotes_df(conn, sym) for sym in SYMS if sym != "QQQ"}
    dr = daily_ret(dfs)
    on = overnight_map(dfs)
    print("build intraday panel…", flush=True)
    R = build_intraday(on)
    lines = [
        "# A314 family 5 — cross-asset leads",
        "",
        "No cross-asset 5m in optlab; intraday = prior-close→open shock, SPY/QQQ ~120m checkpoint, placebo same minute on calm days. Daily = Yahoo 1d (vendor_raw).",
        "",
    ]
    put_lines = []
    for ev, out, claim, src in INTRADAY:
        Ra = arm_half(R, ev)
        r = eval_cross(R, ev, out, claim, src)
        inc1 = logit_inc_t(Ra, ev, "dropx", "H1")
        inc2 = logit_inc_t(Ra, ev, "dropx", "H2")
        if "eff" not in r:
            lines.append(
                f"- **{ev}** · {src} · {claim} · **{r.get('verdict', 'FAIL')}** · inc n/a · MDE n/a"
            )
            continue
        e1, e2 = r["eff"]["H1"], r["eff"]["H2"]
        t1, t2 = r["ts"]["H1"], r["ts"]["H2"]
        m1, m2 = r["mde"]["H1"], r["mde"]["H2"]
        nh1, nh2 = r["n_half"]["H1"], r["n_half"]["H2"]
        pf = "PASS intraday" if r.get("pass_bar") else "FAIL"
        opp = " · opp (fewer drops)" if r.get("opp_sign") else ""
        ef = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        tf = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        mf = lambda x: f"{x:.0f}" if math.isfinite(x) else "n/a"
        lines.append(
            f"- **{ev}** · {src} · n {nh1}/{nh2} · effect {ef(e1)}/{ef(e2)}pp · t {tf(t1)}/{tf(t2)} · "
            f"inc {tf(inc1)}/{tf(inc2)} · MDE {mf(m1)}/{mf(m2)}pp · **{pf}**{opp}"
        )
        if r.get("pass_bar") and abs(inc1) >= 2 and abs(inc2) >= 2:
            put_lines.append(put_overlay(Ra, ev))

    for col, fn, claim, src in DAILY:
        mask = fn(dr)
        mask.index = pd.to_datetime(mask.index)
        ev = eval_daily_breach(dfs, col, mask, claim, src)
        d5 = ev["daily"][5]
        t1, t2 = d5["ts"]["H1"], d5["ts"]["H2"]
        e1, e2 = d5["eff"]["H1"], d5["eff"]["H2"]
        m1, m2 = d5["mde"]["H1"], d5["mde"]["H2"]
        nh1, nh2 = d5["n_half"]["H1"], d5["n_half"]["H2"]
        inc1, inc2 = d5["inc"]
        pf = "PASS daily breach h5" if d5["pass_bar"] else "FAIL daily"
        ef = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        tf = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        mf = lambda x: f"{x:.0f}" if math.isfinite(x) else "n/a"
        lines.append(
            f"- **{col}** · {src} · n {nh1}/{nh2} · breach Δ {ef(e1)}/{ef(e2)}pp · t {tf(t1)}/{tf(t2)} · "
            f"inc {tf(inc1)}/{tf(inc2)} vs ATR80+ER40 · MDE {mf(m1)}/{mf(m2)}pp · **{pf}**"
        )
        if d5["pass_bar"] and abs(inc1) >= 2 and abs(inc2) >= 2:
            flags = set(mask[mask].index.date)
            put_lines.append(f"put skip prior {col}: {put_skip_daily(flags)}")

    if put_lines:
        lines += ["", "## Put benchmark", ""] + [f"- {x}" for x in put_lines]
    else:
        lines.append("- put overlay: none (no PASS with incremental |t|≥2)")

    packet = "\n".join(lines[:25]) + "\n"
    OUT.write_text(packet)
    print(packet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
