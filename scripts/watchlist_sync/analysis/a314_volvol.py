"""A314 family 3 — vol-of-vol & VIX term structure on S130 daily harness (+ intraday if VIX bars exist).

Methods (wrds_research.cboe_daily + SPY daily for RV):
  vix_1d_spike, vix9d_over_vix, term_inverted (VIX/VIX3M>1), term_slope_5d, vvix_spike, rv_accel (RV5/RV20 jump).
Daily claim: 5d put breach (S130 v2, own IV) and next-day range/ATR; H1/H2 split; MDE on day-clustered gaps.
Incremental: logit breach ~ S130 vol baseline + method (H2 coef t, day-clustered SE).
Pass daily: |t|≥2 both halves, same sign on breach claim. Passers → put_benchmark prior-day skip.
Run: cd scripts/watchlist_sync && nice -n 15 .venv/bin/python analysis/a314_volvol.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from datetime import date, timedelta
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
from s130_daily_regime import features, tstat  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "A314-volvol-packet.md"
CACHE = Path.home() / ".fildi/cache/a314_yahoo_daily.json"
SPLIT = pd.Timestamp("2010-01-01")
VOL_START = pd.Timestamp("2009-09-18")
VOL_SPLIT = pd.Timestamp("2018-01-01")
SYMS = ("SPY", "QQQ", "DIA", "^VIX", "^VXN", "^VXD", "HYG", "IEF", "RSP")


def fetch_yahoo_daily() -> dict:
    if CACHE.is_file():
        return json.loads(CACHE.read_text())
    out = {}
    for sym in SYMS:
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym.replace('^', '%5E')}"
            f"?period1=631152000&period2=4102444800&interval=1d"
        )
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        raw = json.loads(urllib.request.urlopen(req, timeout=60).read())
        q = raw["chart"]["result"][0]
        ts = q["timestamp"]
        ind = q["indicators"]["quote"][0]
        rows = []
        for i, t in enumerate(ts):
            if ind["close"][i] is None:
                continue
            rows.append(
                {
                    "date": pd.Timestamp(t, unit="s").strftime("%Y-%m-%d"),
                    "open": ind["open"][i],
                    "high": ind["high"][i],
                    "low": ind["low"][i],
                    "close": ind["close"][i],
                    "volume": ind["volume"][i] or 0,
                }
            )
        out[sym] = rows
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(out))
    return out


def load_daily() -> dict[str, pd.DataFrame]:
    raw = fetch_yahoo_daily()
    out = {}
    for t, q in raw.items():
        d = pd.DataFrame(q)
        d["date"] = pd.to_datetime(d["date"])
        d = d.dropna(subset=["close"]).drop_duplicates("date").set_index("date").sort_index()
        out[t.replace("%5E", "^")] = d[["close"]].astype(float)
    return out


def load_cboe() -> pd.DataFrame:
    with connect() as cn:
        cb = pd.read_sql("select date, index, close::float8 from wrds_research.cboe_daily", cn)
    cb["date"] = pd.to_datetime(cb.date)
    return cb.pivot_table(index="date", columns="index", values="close")


def mde_pp(std: float, n: int) -> float:
    if n < 5 or std <= 0 or not math.isfinite(std):
        return float("nan")
    return 100 * (1.96 + 0.84) * std / math.sqrt(n)


def yahoo_spy_ohlc() -> pd.DataFrame:
    raw = fetch_yahoo_daily()["SPY"]
    spyq = pd.DataFrame(raw)
    spyq["date"] = pd.to_datetime(spyq["date"])
    spyq = spyq.set_index("date").sort_index()
    if "open" not in spyq.columns:
        url = "https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=631152000&period2=4102444800&interval=1d"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        q = json.loads(urllib.request.urlopen(req, timeout=60).read())["chart"]["result"][0]
        ind = q["indicators"]["quote"][0]
        spyq = pd.DataFrame(
            {
                "date": pd.to_datetime(q["timestamp"], unit="s"),
                "open": ind["open"],
                "high": ind["high"],
                "low": ind["low"],
                "close": ind["close"],
                "volume": ind["volume"],
            }
        ).dropna(subset=["close"]).set_index("date")
    return spyq.astype(float)


def build_frame(cb: pd.DataFrame) -> pd.DataFrame:
    spyq = yahoo_spy_ohlc()
    vix = cb["VIX"].reindex(spyq.index).ffill()
    vix9d = cb["VIX9D"].reindex(spyq.index).ffill()
    vix3m = cb["VIX3M"].reindex(spyq.index).ffill()
    vvix = cb["VVIX"].reindex(spyq.index).ffill()
    rv5 = np.log(spyq.close).diff().rolling(5).std() * np.sqrt(252) * 100
    rv20 = np.log(spyq.close).diff().rolling(20).std() * np.sqrt(252) * 100
    ext = {"vix_term": vix / vix3m, "vvix": vvix}
    F = features(spyq, vix, ext)
    extra = pd.DataFrame(
        {
            "dvix_pct": vix.pct_change(),
            "vix9d_vix": vix9d / vix,
            "term_chg5": (vix / vix3m).pct_change(5),
            "dvvix_pct": vvix.pct_change(),
            "rv_accel": rv5 / rv20,
            "rv_accel_chg5": (rv5 / rv20).pct_change(5),
        }
    )
    F = F.join(extra)
    h = 5
    sig = F.vix / 100 * np.sqrt(h / 252)
    K = F.c * np.exp(-sig)
    fwd = F.c.shift(-h) / F.c - 1
    atr14 = (spyq.high - spyq.low).rolling(14).mean()
    F["breach"] = (F.c.shift(-h) < K).astype(float).where(fwd.notna())
    F["nd_range_atr"] = ((spyq.high.shift(-1) - spyq.low.shift(-1)) / F.c / atr14).where(spyq.high.shift(-1).notna())
    return F.dropna(subset=["breach", "vix_term"])


def method_flags(F: pd.DataFrame) -> list[tuple[str, str, str, pd.Series, pd.Timestamp]]:
    vix_sp = F.dvix_pct > F.dvix_pct.rolling(252, min_periods=60).quantile(0.9)
    vv_sp = (F.vvix > F.vvix.rolling(252, min_periods=60).quantile(0.9)) | (F.dvvix_pct > 0.1)
    return [
        ("vix_1d_spike", "ΔVIX top decile → higher 5d put breach", "CBOE VIX daily", vix_sp, VOL_START),
        ("vix9d_over_vix", "VIX9D/VIX > 1.02 → near-term stress, higher breach", "CBOE VIX9D/VIX", F.vix9d_vix > 1.02, pd.Timestamp("2011-01-04")),
        ("term_inverted", "VIX/VIX3M > 1 → panic curve, higher breach", "CBOE term (S130)", F.vix_term > 1, VOL_START),
        ("term_slope_5d", "5d rise in VIX/VIX3M top decile → higher breach", "CBOE term slope", F.term_chg5 > F.term_chg5.rolling(252, min_periods=60).quantile(0.9), VOL_START),
        ("vvix_spike", "VVIX spike (90th or +10%/d) → higher breach", "CBOE VVIX", vv_sp, VOL_START),
        ("rv_accel", "RV5/RV20 5d jump top decile → higher breach", "SPY realized vol", F.rv_accel_chg5 > F.rv_accel_chg5.rolling(252, min_periods=60).quantile(0.9), VOL_START),
    ]


def grade_breach(F: pd.DataFrame, m: pd.Series, start: pd.Timestamp = VOL_START) -> dict:
    x = F.loc[F.index >= start].iloc[252::5].copy()
    mm = m.reindex(x.index).fillna(False)
    x["half"] = np.where(x.index < VOL_SPLIT, "H1", "H2")
    eff, ts, diffs = {}, {}, []
    for h in ("H1", "H2"):
        on, off = x[mm & (x.half == h)], x[~mm & (x.half == h)]
        if len(on) < 20 or len(off) < 20:
            eff[h] = ts[h] = float("nan")
            continue
        eff[h] = 100 * (on.breach.mean() - off.breach.mean())
        ts[h] = tstat(on.breach, off.breach)
        diffs.append(on.groupby(on.index.to_period("M")).breach.mean() - off.groupby(off.index.to_period("M")).breach.mean())
    all_d = pd.concat([d for d in diffs if len(d)]) if diffs else pd.Series(dtype=float)
    mde = mde_pp(float(all_d.std()), len(all_d)) if len(all_d) > 3 else float("nan")
    e1, e2 = eff.get("H1", np.nan), eff.get("H2", np.nan)
    t1, t2 = ts.get("H1", np.nan), ts.get("H2", np.nan)
    same = math.isfinite(e1) and math.isfinite(e2) and e1 != 0 and np.sign(e1) == np.sign(e2)
    return dict(eff=eff, ts=ts, mde=mde, n=len(x[mm]), pass_daily=same and abs(t1) >= 2 and abs(t2) >= 2)


def incremental_t(F: pd.DataFrame, m: pd.Series, start: pd.Timestamp = VOL_START) -> tuple[float, float]:
    x = F.loc[F.index >= start].iloc[252::5].dropna(subset=["breach"]).copy()
    base = pd.DataFrame(
        {
            "vix_hi": (x.vix >= 25).astype(int),
            "term_inv": (x.vix_term > 1).astype(int),
            "rv_hi": (x.rv_accel > 1.2).astype(int),
            "m": m.reindex(x.index).fillna(False).astype(int),
            "breach": x.breach,
            "half": np.where(x.index < VOL_SPLIT, "H1", "H2"),
            "d": x.index,
        }
    )
    out: dict[str, float] = {}
    for half in ("H1", "H2"):
        y = base[base.half == half]
        if len(y) < 200 or y.m.sum() < 10:
            out[half] = float("nan")
            continue
        X = sm.add_constant(y[["vix_hi", "term_inv", "rv_hi", "m"]].astype(float))
        try:
            mod = Logit(y.breach.astype(int), X).fit(disp=0, maxiter=80)
            cov = cov_cluster(mod, pd.Categorical(y.d).codes)
            idx = list(X.columns).index("m")
            se = np.sqrt(cov[idx, idx])
            out[half] = float(mod.params["m"] / se) if se > 0 else float("nan")
        except Exception:
            out[half] = float("nan")
    return out.get("H1", float("nan")), out.get("H2", float("nan"))


def put_overlay(flag_days: set[date]) -> str:
    import pickle

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
    base = BE.summary(BE.pick_rows(te, live), weeks)
    base_tr = BE.summary(BE.pick_rows(tr, live), tr_weeks)

    def prior(d: date) -> bool:
        pd_ = d - timedelta(days=1)
        while pd_.weekday() >= 5:
            pd_ -= timedelta(days=1)
        return pd_ in flag_days

    def rule(row):
        if prior(row["d"]):
            return None
        return live(row)

    s = BE.summary(BE.pick_rows(te, rule), weeks)
    st = BE.summary(BE.pick_rows(tr, rule), tr_weeks)
    diff = np.array([s["series"][w] - base["series"][w] for w in weeks])
    t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) if diff.std() > 0 else 0.0
    dbp, dw5 = s["book_bp"] - base["book_bp"], s["book_w5"] - base["book_w5"]
    v = verdict(dbp, t, dw5)
    pbp = st["book_bp"] - base_tr["book_bp"]
    if v == "BETTER" and pbp < -1:
        v = "BETTER (holdout only)"
    return f"skip prior flag: Δ{dbp:+.1f}bp t{t:+.1f} pre-2023 Δ{pbp:+.1f} · **{v}**"


def main() -> int:
    for p in (HERE.parents[2] / ".env.local", HERE.parents[2] / ".env"):
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=False)
            break
    print("A314 family3: load data…", flush=True)
    load_daily()
    cb = load_cboe()
    F = build_frame(cb)
    methods = method_flags(F)
    L = ["# A314 family 3 — vol-of-vol & VIX term (daily S130 harness)", ""]
    passed = []
    for name, claim, src, flag, start in methods:
        g = grade_breach(F, flag, start)
        it1, it2 = incremental_t(F, flag, start)
        e1, e2 = g["eff"].get("H1", np.nan), g["eff"].get("H2", np.nan)
        t1, t2 = g["ts"].get("H1", np.nan), g["ts"].get("H2", np.nan)
        v = "PASS daily breach" if g["pass_daily"] else "FAIL"
        if g["pass_daily"]:
            passed.append((name, flag, start))
        ef = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        tf = lambda x: f"{x:+.1f}" if math.isfinite(x) else "n/a"
        mde = g["mde"]
        ms = f"{mde:.1f}pp" if math.isfinite(mde) else "n/a"
        L.append(
            f"- **{name}** · {src} · {claim} · n≈{g['n']} · effect H1/H2 {ef(e1)}/{ef(e2)}pp breach · "
            f"t {tf(t1)}/{tf(t2)} · incr {tf(it1)}/{tf(it2)} vs vol baseline · MDE≈{ms} · **{v}**"
        )
    L.append("- **intraday VIX bars** · n/a · no stored intraday VIX series · **skip intraday**")
    if passed:
        L.append("")
        for name, flag, start in passed:
            days = {ts.date() for ts in F.loc[F.index >= start].index[flag.reindex(F.index).fillna(False)]}
            L.append(f"- put **{name}**: {put_overlay(days)}")
    else:
        L.append("- put overlay: none (no daily PASS)")
    packet = "\n".join(L[:25]) + "\n"
    OUT.write_text(packet)
    print(packet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
