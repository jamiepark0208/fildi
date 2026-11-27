"""A371 shared: regime flags, LSEG quote replay, weekly stats."""
from __future__ import annotations

import math
import re
from collections import defaultdict
from datetime import date, timedelta

import numpy as np

import s109_real_quote_rule as S109

RIC = re.compile(r"^(.+?)([M-X])(\d\d)(\d\d)(\d{5})\.U(\^.*)?$")
SPLIT = date(2024, 7, 1)
HOLDOUT = date(2023, 1, 1)


def week(d: date) -> date:
    return d - timedelta(days=d.weekday())


def week_stats(trades, key="r"):
    if not trades:
        return None
    wk = defaultdict(list)
    for x in trades:
        wk[week(x["d"])].append(float(x[key]))
    w = np.array([np.mean(v) for v in wk.values()])
    if len(w) < 2:
        return {"n": len(trades), "weeks": len(w), "wk_bp": float("nan"), "t": float("nan")}
    sd = w.std(ddof=1)
    t = w.mean() / (sd / math.sqrt(len(w))) if sd > 0 else float("nan")
    return {"n": len(trades), "weeks": len(w), "wk_bp": 1e4 * w.mean(), "t": t}


def half_bits(trades, key="r"):
    a, b = week_stats([t for t in trades if t["d"] < SPLIT], key), week_stats([t for t in trades if t["d"] >= SPLIT], key)
    def bit(s, name):
        if not s or s["weeks"] < 8 or not math.isfinite(s.get("t", float("nan"))):
            return f"{name} thin"
        return f"{name} {s['wk_bp']:+.1f} (t {s['t']:+.1f})"
    return bit(a, "H1"), bit(b, "H2")


def build_regime(px, vix_path):
    from a371_audit import rolling_state, load_vix, asof  # noqa: WPS433 — single home for CRSP/regime cuts

    spy_up, breadth = rolling_state(px)
    vix = load_vix() if vix_path is None else {}
    if vix_path:
        import csv
        from datetime import datetime

        with open(vix_path) as fh:
            for r in csv.DictReader(fh):
                if r.get("VIXCLS") and r["VIXCLS"] != ".":
                    vix[datetime.strptime(r["observation_date"][:10], "%Y-%m-%d").date()] = float(r["VIXCLS"])
    vix_dates = np.array(sorted(vix), dtype="datetime64[D]") if vix else np.array([])
    cuts = np.quantile(list(vix.values()), [1 / 3, 2 / 3]) if len(vix) > 30 else (None, None)

    def attach(d: date):
        v = asof(vix_dates, vix, d) if len(vix_dates) else None
        vb = None
        if v is not None and cuts[0] is not None:
            vb = "low" if v < cuts[0] else "mid" if v < cuts[1] else "high"
        br = breadth.get(d)
        return {"spy_up": spy_up.get(d), "br": br, "vix_bin": vb, "year": d.year}

    return attach, cuts


def quote_pnl(conn, ticker: str, entry: date, K: float, exp: date, px: dict) -> dict | None:
    """Real LSEG fill at entry; intrinsic at expiry close. priced_by=real_quote."""
    q = conn.execute(
        "SELECT ric, date, bid::float8, ask::float8 FROM optlab.lseg_opt_daily WHERE ric LIKE %s ORDER BY date",
        (f"{ticker}%",),
    ).fetchall()
    if not q:
        return None
    by_ric = defaultdict(list)
    for ric, d, b, a in q:
        by_ric[ric].append((d, b, a))
    k100 = int(round(K * 100))
    target = None
    for ric in by_ric:
        m = RIC.match(ric)
        if not m or m.group(1) != ticker or int(m.group(5)) != k100:
            continue
        try:
            ex = date(2000 + int(m.group(4)), ord(m.group(2)) - ord("M") + 1, int(m.group(3)))
        except ValueError:
            continue
        if abs((ex - exp).days) > 7:
            continue
        target = ric
        break
    if not target:
        return None
    rows = sorted(by_ric[target])
    def ok_row(r):
        b, a = r[1], r[2]
        return b is not None and a is not None and b > 0 and a >= b

    ent = next((r for r in rows if r[0] == entry and ok_row(r)), None)
    if not ent:
        ent = next((r for r in rows if abs((r[0] - entry).days) <= 2 and ok_row(r)), None)
    if not ent:
        return None
    d, b, a = ent
    if d not in px:
        return None
    S0 = px[d][0]
    fill = b + 0.23 * (a - b)
    settle_keys = [x for x in px if exp - timedelta(days=3) <= x <= exp + timedelta(days=2)]
    if not settle_keys:
        return None
    St = px[max(settle_keys, key=lambda x: abs((x - exp).days))][0]
    days = max((exp - d).days, 1)
    r = (fill - max(K - St, 0.0)) / K * 7 / days
    return {"d": d, "r": r, "r_model": None, "priced_by": "real_quote", "K": K, "t": ticker, "kept": St >= K}


def synth_s109_put(pricer, ticker, bars, i, dte=30):
    """S076 model put when no chain; priced_by=s076_model."""
    from s076_structures_backtest import fill  # noqa: WPS433
    from s088_sr_zones import listed_strike  # noqa: WPS433

    d = bars["d"][i]
    S = float(bars["c"][i])
    iv = bars["ivp"][i]
    if not iv or iv <= 0 or i < 252:
        return None
    hi = max(bars["c"][max(0, i - 251) : i + 1])
    dd52 = S / hi - 1
    if dd52 > -0.25:
        return None
    K = listed_strike(S * 0.90, S, "put")
    if K <= 0 or K >= S:
        return None
    otm = (S - K) / S
    if otm < 0.10:
        return None
    mid, spread = pricer.mid("put", S, K, iv, dte, d)
    credit = fill(mid, spread, -1)
    days = dte
    inc = credit / K * 7 / days
    if inc < 0.009:
        return None
    j = min(i + max(1, dte // 7) * 5, len(bars["c"]) - 1)
    exp = bars["d"][j]
    St = float(bars["c"][j])
    fill = credit
    r = (fill - max(K - St, 0.0)) / K * 7 / max((exp - d).days, 1)
    return {"d": d, "exp": exp, "r": r, "priced_by": "s076_model", "K": K, "t": ticker, "kept": St >= K, "inc": inc, "otm": otm, "dd52": dd52}