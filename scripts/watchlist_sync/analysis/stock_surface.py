#!/usr/bin/env python3
"""A192 Part S1 — per-stock vol surface (OPTIONS-FRAMEWORK §4).

  cd scripts/watchlist_sync && .venv/bin/python analysis/stock_surface.py --smoke
  .venv/bin/python analysis/stock_surface.py --write
"""
from __future__ import annotations

import argparse
import math
import re
import statistics
import sys
import time
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from build_plan import connect, rows  # noqa: E402
from rules import IV_SANE  # noqa: E402
from s045_put_retest import bs_put, ncdf  # noqa: E402
from s075_skew_calibration import RIC, bs_call, delta  # noqa: E402
from s076_structures_backtest import load as load_bars  # noqa: E402

OUT = ROOT / "out" / "opt" / "S1-surface.md"
DDL = (ROOT / "migrations" / "optlab_stock_surface.sql").read_text()
TENORS = (30, 60, 90)
LSEG_MIN_PUTS = 3
MIN_QUOTES = 5
MIN_QUOTES_PUT_ONLY = 3
MAX_SPREAD_FRAC = 0.50
MAX_EXTRAP_D = 15
SMOKE_TICKERS = ("AAPL", "TSLA", "GILD", "SO", "HD")
SMOKE_LSEG_DATE = date(2021, 6, 15)

LSEG_ROOT = re.compile(r"^([A-Z]+)[A-X][0-9]{4}")


def bs_delta(S, K, v, t, side):
    return delta(S, K, v, t, side)


def _iv_unit(iv: float | None) -> float | None:
    if iv is None or iv <= 0:
        return None
    return iv / 100.0 if iv > 3.0 else float(iv)


def _load_tb() -> dict[date, float]:
    p = ROOT / "out" / "opt" / "dtb3.csv"
    if not p.exists():
        return {}
    out = {}
    for line in p.read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            out[date.fromisoformat(dd)] = float(v) / 100.0
    return out


def _r_at(tb: dict[date, float], d: date) -> float:
    if d in tb:
        return tb[d]
    ds = sorted(tb)
    if not ds:
        return 0.0
    i = bisect_right(ds, d) - 1
    return tb[ds[max(i, 0)]]


@dataclass
class Quote:
    side: str
    strike: float
    bid: float
    ask: float
    iv: float | None
    delta: float | None
    oi: int


@dataclass(frozen=True)
class GroupKey:
    ticker: str
    as_of: date
    expiry: date


@dataclass
class FitRow:
    key: GroupKey
    source: str
    quotes: list[Quote]
    flags: list[str] = field(default_factory=list)
    dte: int = 0
    n_quotes: int = 0
    fwd: float | None = None
    atm_iv: float | None = None
    a: float | None = None
    b: float | None = None
    c: float | None = None
    rmse: float | None = None
    rr25: float | None = None
    bf25: float | None = None
    iv10p: float | None = None
    iv10c: float | None = None
    med_iv_err: float | None = None


def ensure_schema(conn) -> None:
    conn.execute(DDL)
    conn.commit()


def parse_lseg_ric(ric: str) -> tuple[str, str, date, float] | None:
    m = RIC.match(ric)
    if not m:
        return None
    root, let, dd, yy, kraw = m.groups()
    side = "call" if let <= "L" else "put"
    mon = (ord(let) - ord("A")) % 12 + 1
    try:
        exp = date(2000 + int(yy), mon, int(dd))
    except ValueError:
        return None
    strike = int(kraw) / 100.0
    return root.replace(".", ""), side, exp, strike


def _clean_quote(q: Quote) -> bool:
    if q.bid <= 0 or q.ask < q.bid:
        return False
    mid = (q.bid + q.ask) / 2
    if mid <= 0:
        return False
    if (q.ask - q.bid) / mid > MAX_SPREAD_FRAC:
        return False
    if q.iv is not None and not (IV_SANE[0] <= q.iv <= IV_SANE[1]):
        return False
    return True


def forward_from_pcp(quotes: list[Quote], spot: float, r: float, T: float) -> float:
    """Put-call parity on strikes nearest spot; fallback spot*exp(rT)."""
    pairs: dict[float, tuple[float | None, float | None]] = {}
    for q in quotes:
        pairs.setdefault(q.strike, [None, None])
        if q.side == "put":
            pairs[q.strike][0] = (q.bid + q.ask) / 2
        else:
            pairs[q.strike][1] = (q.bid + q.ask) / 2
    candidates = []
    disc = math.exp(-r * T)
    for K, (pm, cm) in pairs.items():
        if pm is None or cm is None:
            continue
        F = K + (cm - pm) / disc
        if F > 0:
            candidates.append((abs(K - spot), F))
    if candidates:
        candidates.sort()
        use = candidates[:3]
        return statistics.mean(f for _, f in use)
    return spot * math.exp(r * T)


def _prelim_atm(quotes: list[Quote], F: float) -> float:
    ivs = []
    for q in quotes:
        if q.iv and q.iv > 0:
            d = abs(math.log(q.strike / F)) if F > 0 and q.strike > 0 else 9
            ivs.append((d, q.iv))
    if not ivs:
        return 0.25
    ivs.sort()
    return ivs[0][1]


def _wls_quad(xs: np.ndarray, ys: np.ndarray, ws: np.ndarray, linear_only: bool) -> tuple[float, float, float, float]:
    if linear_only:
        X = np.column_stack([np.ones(len(xs)), xs])
        beta, *_ = np.linalg.lstsq(X * ws[:, None], ys * ws, rcond=None)
        a, b = float(beta[0]), float(beta[1])
        c = 0.0
    else:
        X = np.column_stack([np.ones(len(xs)), xs, xs**2])
        beta, *_ = np.linalg.lstsq(X * ws[:, None], ys * ws, rcond=None)
        a, b, c = float(beta[0]), float(beta[1]), float(beta[2])
    pred = a + b * xs + c * xs**2
    rmse = float(math.sqrt(np.mean((pred - ys) ** 2)))
    return a, b, c, rmse


def _strike_for_delta(S: float, F: float, T: float, target: float, side: str, atm: float, a: float, b: float, c: float) -> float:
    lo, hi = F * 0.5, F * 1.5
    for _ in range(48):
        mid = (lo + hi) / 2
        x = math.log(mid / F) / (atm * math.sqrt(T) + 1e-12)
        iv = a + b * x + c * x**2
        d = bs_delta(S, mid, max(iv, 1e-4), T, side)
        if side == "put":
            d = abs(d)
        if d > target:
            lo, hi = (lo, mid) if side == "put" else (mid, hi)
        else:
            lo, hi = (mid, hi) if side == "put" else (lo, mid)
    return (lo + hi) / 2


def _iv_at_strike(F: float, K: float, T: float, atm: float, a: float, b: float, c: float) -> float:
    x = math.log(K / F) / (atm * math.sqrt(T) + 1e-12)
    return a + b * x + c * x**2


def fit_group(
    key: GroupKey,
    source: str,
    quotes: list[Quote],
    spot: float,
    r: float,
    put_only: bool,
) -> FitRow | None:
    flags: list[str] = []
    if put_only:
        flags.append("put_only")
        quotes = [q for q in quotes if q.side == "put"]
    else:
        quotes = [q for q in quotes if (q.side == "put" and q.strike < spot) or (q.side == "call" and q.strike > spot)]

    min_n = MIN_QUOTES_PUT_ONLY if put_only else MIN_QUOTES
    clean = [q for q in quotes if _clean_quote(q)]
    if len(clean) < min_n:
        return None

    dte = (key.expiry - key.as_of).days
    if dte < 1:
        return None
    T = dte / 365.0
    if not put_only:
        F = forward_from_pcp(clean, spot, r, T)
        otm = [
            q
            for q in clean
            if (q.side == "put" and q.strike < F) or (q.side == "call" and q.strike > F)
        ]
        if len(otm) < min_n:
            return None
        clean = otm
    else:
        F = spot * math.exp(r * T)

    for q in clean:
        if q.iv is None or q.iv <= 0:
            if q.side == "put":
                q.iv = _implied_put(spot, q.strike, (q.bid + q.ask) / 2, T)
            else:
                q.iv = None
        else:
            q.iv = _iv_unit(q.iv) or q.iv
        if q.iv is None or not (IV_SANE[0] <= q.iv <= IV_SANE[1]):
            q.iv = None

    with_iv = [q for q in clean if q.iv]
    if len(with_iv) < min_n:
        return None

    atm0 = _prelim_atm(with_iv, F)
    xs, ys, ws = [], [], []
    for q in with_iv:
        x = math.log(q.strike / F) / (atm0 * math.sqrt(T) + 1e-12)
        mid = (q.bid + q.ask) / 2
        spr = max(q.ask - q.bid, 1e-4)
        xs.append(x)
        ys.append(q.iv)
        ws.append(1.0 / spr**2)

    linear_only = put_only and len(with_iv) < MIN_QUOTES
    a, b, c, rmse = _wls_quad(np.array(xs), np.array(ys), np.array(ws), linear_only)
    atm_iv = a

    Kp = _strike_for_delta(spot, F, T, 0.25, "put", atm_iv, a, b, c)
    Kc = _strike_for_delta(spot, F, T, 0.25, "call", atm_iv, a, b, c)
    iv_p25 = _iv_at_strike(F, Kp, T, atm_iv, a, b, c)
    iv_c25 = _iv_at_strike(F, Kc, T, atm_iv, a, b, c)
    rr25 = iv_p25 - iv_c25
    bf25 = 0.5 * (iv_p25 + iv_c25) - atm_iv
    if put_only:  # Claude review cd34fbcf #1: call wing is extrapolated from puts → no RR/BF
        rr25 = bf25 = None

    iv10p = iv10c = None
    for q in with_iv:
        if q.delta is None and q.iv:
            q.delta = bs_delta(spot, q.strike, q.iv, T, q.side)
        if q.oi >= 100 and q.delta is not None:
            if q.side == "put" and 0.08 <= abs(q.delta) <= 0.12:
                iv10p = q.iv
            if q.side == "call" and 0.08 <= abs(q.delta) <= 0.12:
                iv10c = q.iv

    med_err = statistics.median(abs((q.iv or 0) - _iv_at_strike(F, q.strike, T, atm_iv, a, b, c)) for q in with_iv)

    row = FitRow(
        key=key,
        source=source,
        quotes=with_iv,
        flags=flags,
        dte=dte,
        n_quotes=len(with_iv),
        fwd=F,
        atm_iv=atm_iv,
        a=a,
        b=b,
        c=None if linear_only else c,
        rmse=rmse,
        rr25=rr25,
        bf25=bf25,
        iv10p=iv10p,
        iv10c=iv10c,
        med_iv_err=med_err,
    )
    row.flags = flags
    return row


def _implied_put(S, K, price, T, v0=0.3):
    lo, hi = 1e-4, 3.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if bs_put(S, K, mid, T) > price:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def load_chain(conn, tickers: set[str] | None, d0: date | None, d1: date | None) -> dict[GroupKey, list[Quote]]:
    q = "SELECT as_of, ticker, expiry, side, strike::float, spot::float, bid::float, ask::float, iv::float, delta::float, open_interest FROM option_chain_history WHERE bid>0"
    args: list = []
    if d0:
        q += " AND as_of >= %s"
        args.append(d0)
    if d1:
        q += " AND as_of <= %s"
        args.append(d1)
    if tickers:
        q += " AND ticker = ANY(%s)"
        args.append(list(tickers))
    out: dict[GroupKey, list[Quote]] = defaultdict(list)
    for row in conn.execute(q, args):
        as_of, t, exp, side, K, spot, bid, ask, iv, delt, oi = row
        ivn = _iv_unit(iv) if iv else None
        out[GroupKey(t, as_of, exp)].append(
            Quote(side, float(K), float(bid), float(ask), ivn, float(delt) if delt else None, int(oi or 0))
        )
    return out


def load_skew(conn, tickers: set[str] | None, d0: date | None, d1: date | None) -> dict[GroupKey, list[Quote]]:
    q = (
        "SELECT as_of, ticker, expiry, side, strike::float, bid::float, ask::float, iv::float, delta::float, oi "
        "FROM optlab.skew_survey WHERE bid>0"
    )
    args: list = []
    if d0:
        q += " AND as_of >= %s"
        args.append(d0)
    if d1:
        q += " AND as_of <= %s"
        args.append(d1)
    if tickers:
        q += " AND ticker = ANY(%s)"
        args.append(list(tickers))
    out: dict[GroupKey, list[Quote]] = defaultdict(list)
    for row in conn.execute(q, args):
        as_of, t, exp, side, K, bid, ask, iv, delt, oi = row
        side = "call" if str(side).lower().startswith("c") else "put"
        ivn = _iv_unit(iv) if iv else None
        out[GroupKey(t, as_of, exp)].append(Quote(side, float(K), float(bid), float(ask), ivn, float(delt) if delt else None, int(oi or 0)))
    return out


def load_lseg_puts(conn, tickers: set[str] | None, d0: date | None, d1: date | None) -> dict[GroupKey, list[Quote]]:
    q = "SELECT ric, date, bid::float, ask::float, mid::float FROM optlab.lseg_opt_daily WHERE bid>0"
    args: list = []
    if d0:
        q += " AND date >= %s"
        args.append(d0)
    if d1:
        q += " AND date <= %s"
        args.append(d1)
    raw: dict[GroupKey, list[Quote]] = defaultdict(list)
    seen_calls: set[GroupKey] = set()
    for ric, d, bid, ask, mid in conn.execute(q, args):
        parsed = parse_lseg_ric(ric)
        if not parsed:
            continue
        root, side, exp, strike = parsed
        if tickers and root not in tickers:
            continue
        key = GroupKey(root, d, exp)
        if side == "call":
            seen_calls.add(key)
            continue
        iv = None
        raw[key].append(Quote("put", strike, float(bid), float(ask), iv, None, 0))
    out: dict[GroupKey, list[Quote]] = {}
    for key, qs in raw.items():
        if len(qs) >= LSEG_MIN_PUTS and key not in seen_calls:
            out[key] = qs
    return out


def merge_sources(
    chain: dict[GroupKey, list[Quote]],
    survey: dict[GroupKey, list[Quote]],
    lseg: dict[GroupKey, list[Quote]],
) -> list[tuple[GroupKey, str, list[Quote], bool]]:
    picked: dict[GroupKey, tuple[str, list[Quote], bool]] = {}
    for key, qs in chain.items():
        picked[key] = ("option_chain_history", qs, False)
    for key, qs in survey.items():
        if key in picked and len(qs) <= len(picked[key][1]):
            continue
        picked[key] = ("skew_survey", qs, False)
    for key, qs in lseg.items():
        if key in picked:
            continue
        picked[key] = ("lseg_opt_daily", qs, True)
    return [(k, src, qs, po) for k, (src, qs, po) in picked.items()]


def spot_for_group(conn, key: GroupKey, quotes: list[Quote]) -> float:
    for q in quotes:
        pass
    r = conn.execute(
        "SELECT spot::float FROM option_chain_history WHERE ticker=%s AND as_of=%s AND spot>0 LIMIT 1",
        (key.ticker, key.as_of),
    ).fetchone()
    if r and r[0]:
        return float(r[0])
    r = conn.execute(
        "SELECT spot::float FROM optlab.skew_survey WHERE ticker=%s AND as_of=%s AND spot>0 LIMIT 1",
        (key.ticker, key.as_of),
    ).fetchone()
    if r and r[0]:
        return float(r[0])
    r = conn.execute(
        "SELECT close::float FROM lseg_research.daily_history WHERE ticker=%s AND date=%s",
        (key.ticker, key.as_of),
    ).fetchone()
    if r and r[0]:
        return float(r[0])
    return 100.0


def interp_cm(rows: list[FitRow], tenor: int) -> FitRow | None:
    """Linear total-variance interpolation in T."""
    Tt = tenor / 365.0
    pts = []
    for r in rows:
        if r.atm_iv and r.dte > 0:
            pts.append((r.dte / 365.0, r.atm_iv**2 * (r.dte / 365.0), r))
    if len(pts) < 1:
        return None
    pts.sort()
    below = [p for p in pts if p[0] <= Tt]
    above = [p for p in pts if p[0] >= Tt]
    if below and above:
        t0, v0, r0 = below[-1]
        t1, v1, r1 = above[0]
        if t0 == t1:
            wvar = v0
            br, cr = r0.b, r0.c
            atm = math.sqrt(wvar / Tt) if Tt > 0 else r0.atm_iv
        else:
            w = (Tt - t0) / (t1 - t0)
            wvar = v0 * (1 - w) + v1 * w
            atm = math.sqrt(wvar / Tt) if Tt > 0 else None
            br = (r0.b or 0) * (1 - w) + (r1.b or 0) * w
            cr = None
            if r0.c is not None and r1.c is not None:
                cr = r0.c * (1 - w) + r1.c * w
        if t0 > 0 and Tt < t0 and (t0 - Tt) * 365 > MAX_EXTRAP_D:
            return None
        if t1 > 0 and Tt > t1 and (Tt - t1) * 365 > MAX_EXTRAP_D:
            return None
        rr = None if r0.rr25 is None or r1.rr25 is None else (r0.rr25 + r1.rr25) / 2
        bf = None if r0.bf25 is None or r1.bf25 is None else (r0.bf25 + r1.bf25) / 2
        return FitRow(
            GroupKey(r0.key.ticker, r0.key.as_of, r0.key.expiry),
            r0.source,
            [],
            dte=tenor,
            atm_iv=atm,
            b=br,
            c=cr,
            rr25=rr,
            bf25=bf,
        )
    return None


def ex_earn_iv(as_of: date, tenor: int, atm: float, earn: list[date], bracket: list[FitRow]) -> float | None:
    horizon = as_of + timedelta(days=tenor)
    nxt = next((e for e in sorted(earn) if as_of < e <= horizon), None)
    if not nxt or atm is None:
        return None
    T = tenor / 365.0
    total_var = atm**2 * T
    # Claude review cd34fbcf #2: ex-event IV = diffusive vol from the last expiry before the event;
    # event variance = total − diffusive·T (kept implicit). No pre-event expiry → unknown, not atm.
    pre = [r for r in bracket if r.key.expiry < nxt and r.atm_iv]
    if not pre:
        return None
    pre.sort(key=lambda r: r.key.expiry, reverse=True)
    sig_d = pre[0].atm_iv
    if total_var - sig_d**2 * T <= 0:  # no event premium visible → front already ≥ term vol
        return atm
    return sig_d


def build_realized(conn, tickers: set[str] | None) -> list[tuple]:
    bars, _, _ = load_bars(conn, tickers)
    out = []
    for t, series in bars.items():
        if tickers and t not in tickers:
            continue
        for i in range(len(series)):
            d, c, _, _ = series[i]
            if i < 60:
                continue
            rets = []
            for j in range(i - 59, i + 1):
                _, c0, _, _ = series[j - 1]
                _, c1, _, _ = series[j]
                if c0 > 0:
                    rets.append(math.log(c1 / c0))
            if len(rets) < 60:
                continue
            rv20 = statistics.pstdev(rets[-20:]) * math.sqrt(252) if len(rets) >= 20 else None
            rv60 = statistics.pstdev(rets) * math.sqrt(252)
            dn = [r**2 for r in rets if r < 0]
            up = [r**2 for r in rets if r > 0]
            semi = (sum(dn) / len(dn)) / (sum(up) / len(up)) if dn and up else None
            mu = statistics.mean(rets)
            m3 = statistics.mean([(r - mu) ** 3 for r in rets])
            rskew = m3 / (statistics.pstdev(rets) ** 3) if statistics.pstdev(rets) > 0 else None
            out.append((t, d, rv20, rv60, semi, rskew))
    return out


def run_build(conn, tickers: set[str] | None, write: bool) -> dict:
    tb = _load_tb()
    t0 = time.time()
    chain = load_chain(conn, tickers, None, None)
    survey = load_skew(conn, tickers, None, None)
    lseg = load_lseg_puts(conn, tickers, None, None)
    merged = merge_sources(chain, survey, lseg)
    fits: list[FitRow] = []
    for key, src, qs, put_only in merged:
        spot = spot_for_group(conn, key, qs)
        r = _r_at(tb, key.as_of)
        row = fit_group(key, src, qs, spot, r, put_only)
        if row:
            fits.append(row)

    by_td: dict[tuple[str, date], list[FitRow]] = defaultdict(list)
    for f in fits:
        by_td[(f.key.ticker, f.key.as_of)].append(f)

    earn: dict[str, list[date]] = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY 1,2"):
        earn[t].append(d)

    cm_rows: list[tuple] = []
    for (t, d), fs in by_td.items():
        for tenor in TENORS:
            cm = interp_cm(fs, tenor)
            if not cm or not cm.atm_iv:
                continue
            cm30 = interp_cm(fs, 30)
            cm90 = interp_cm(fs, 90)
            term = None
            if cm30 and cm30.atm_iv and cm90 and cm90.atm_iv and cm90.atm_iv > 0:
                term = cm30.atm_iv / cm90.atm_iv - 1.0
            ex = ex_earn_iv(d, tenor, cm.atm_iv, earn.get(t, []), fs)
            cm_rows.append((t, d, tenor, cm.atm_iv, cm.b, cm.c, cm.rr25, cm.bf25, term, ex))

    realized = build_realized(conn, tickers)

    if write:
        cur = conn.cursor()
        if tickers:
            cur.execute("DELETE FROM optlab.stock_surface_daily WHERE ticker = ANY(%s)", (list(tickers),))
            cur.execute("DELETE FROM optlab.stock_surface_cm WHERE ticker = ANY(%s)", (list(tickers),))
            cur.execute("DELETE FROM optlab.stock_realized_daily WHERE ticker = ANY(%s)", (list(tickers),))
        else:
            cur.execute("TRUNCATE optlab.stock_surface_daily, optlab.stock_surface_cm, optlab.stock_realized_daily")
        for f in fits:
            cur.execute(
                """INSERT INTO optlab.stock_surface_daily VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (ticker, as_of, expiry, source) DO UPDATE SET
                   dte=excluded.dte, n_quotes=excluded.n_quotes, fwd=excluded.fwd, atm_iv=excluded.atm_iv,
                   a=excluded.a, b=excluded.b, c=excluded.c, rmse=excluded.rmse, rr25=excluded.rr25, bf25=excluded.bf25,
                   iv10p=excluded.iv10p, iv10c=excluded.iv10c, flags=excluded.flags""",
                (
                    f.key.ticker,
                    f.key.as_of,
                    f.key.expiry,
                    f.dte,
                    f.source,
                    f.n_quotes,
                    f.fwd,
                    f.atm_iv,
                    f.a,
                    f.b,
                    f.c,
                    f.rmse,
                    f.rr25,
                    f.bf25,
                    f.iv10p,
                    f.iv10c,
                    ",".join(f.flags),
                ),
            )
        cur.executemany(
            "INSERT INTO optlab.stock_surface_cm VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            cm_rows,
        )
        cur.executemany(
            "INSERT INTO optlab.stock_realized_daily VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            realized,
        )
        conn.commit()

    stats = summarize(fits, chain, survey, lseg, cm_rows, time.time() - t0)
    return stats


def summarize(fits, chain, survey, lseg, cm_rows, elapsed) -> dict:
    src_cov = {
        "option_chain_history": len({(f.key.ticker, f.key.as_of) for f in fits if f.source == "option_chain_history"}),
        "skew_survey": len({(f.key.ticker, f.key.as_of) for f in fits if f.source == "skew_survey"}),
        "lseg_opt_daily": len({(f.key.ticker, f.key.as_of) for f in fits if f.source == "lseg_opt_daily"}),
    }
    ge5 = sum(1 for f in fits if f.n_quotes >= 5) / max(len(fits), 1)
    rmses = [f.rmse for f in fits if f.rmse is not None]
    b_neg = sum(1 for f in fits if f.b is not None and f.b < 0) / max(sum(1 for f in fits if f.b is not None), 1)
    med_iv_err = [f.med_iv_err for f in fits]
    med_iv_err = [x for x in med_iv_err if x is not None]
    return {
        "n_fits": len(fits),
        "src_cov": src_cov,
        "ge5_share": ge5,
        "rmse_p50": statistics.median(rmses) if rmses else None,
        "b_neg_share": b_neg,
        "med_iv_err": statistics.median(med_iv_err) if med_iv_err else None,
        "cm_rows": len(cm_rows),
        "elapsed": elapsed,
        "fits": fits,
    }


def smoke_gate(conn) -> tuple[bool, str]:
    tickers = set(SMOKE_TICKERS)
    tb = _load_tb()
    parts = []
    chain = load_chain(conn, tickers, None, None)
    survey = load_skew(conn, tickers, None, None)
    lseg = load_lseg_puts(conn, tickers, SMOKE_LSEG_DATE, SMOKE_LSEG_DATE)
    merged = merge_sources(chain, survey, lseg)
    fits = []
    for key, src, qs, po in merged:
        row = fit_group(key, src, qs, spot_for_group(conn, key, qs), _r_at(tb, key.as_of), po)
        if row:
            fits.append(row)
    if not fits:
        return False, "SANITY: zero fits"
    errs = [f.med_iv_err or 99 for f in fits]
    med = statistics.median(errs)
    b_share = sum(1 for f in fits if f.b is not None and f.b < 0) / max(sum(1 for f in fits if f.b is not None), 1)
    parts.append(f"SANITY rows={len(fits)} tickers={len(tickers)} med_abs_iv_err={med*100:.2f}volpt b_neg={b_share:.0%}")
    hand = fits[0]
    parts.append(f"SANITY hand F {hand.key.ticker} {hand.key.as_of} F={hand.fwd:.2f} spot via parity n={hand.n_quotes}")
    by_td = defaultdict(list)
    for f in fits:
        by_td[(f.key.ticker, f.key.as_of)].append(f)
    for (t, d), fs in by_td.items():
        cm = interp_cm(fs, 30)
        if cm and cm.atm_iv:
            parts.append(f"SANITY 30d {t} {d} atm_iv={cm.atm_iv*100:.2f}% b={cm.b}")
            break
    ok = med <= 0.01 and b_share >= 0.80
    parts.append(f"SANITY gate={'PASS' if ok else 'FAIL'} (med≤1.0volpt b_neg≥80%)")
    return ok, "\n".join(parts)


def write_report(stats: dict, smoke_txt: str) -> None:
    lines = [
        "# A192 Part S1 — per-stock vol surface",
        "",
        f"Runtime {stats['elapsed']:.1f}s · fitted slices {stats['n_fits']:,} · CM rows {stats['cm_rows']:,}",
        "",
        "| source | ticker-days fitted |",
        "|---|---:|",
    ]
    for s, n in stats["src_cov"].items():
        lines.append(f"| {s} | {n:,} |")
    lines += [
        "",
        f"Share ≥5 quotes: {stats['ge5_share']:.1%}",
        f"RMSE p50: {stats['rmse_p50']*100 if stats['rmse_p50'] else 0:.3f} vol pt",
        f"b<0 share: {stats['b_neg_share']:.1%}",
        f"Median |fit−quote| IV: {stats['med_iv_err']*100 if stats['med_iv_err'] else 0:.3f} vol pt",
        "",
        "```",
        smoke_txt,
        "```",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines))


def rank_extremes(conn, stats: dict) -> tuple[list, list]:
    """Top/bottom 10 by latest 30d b in own-history percentile or sector cross-section."""
    latest = conn.execute("SELECT MAX(as_of) FROM optlab.stock_surface_cm").fetchone()[0]
    if not latest:
        return [], []
    sectors = {r["ticker"]: r.get("gics_sector") for r in rows(conn, "SELECT ticker, gics_sector FROM research_common.security_class WHERE gics_sector IS NOT NULL")}
    cur = rows(
        conn,
        """SELECT ticker, b FROM optlab.stock_surface_cm WHERE as_of=%s AND tenor=30 AND b IS NOT NULL""",
        (latest,),
    )
    hist = defaultdict(list)
    for r in rows(conn, "SELECT ticker, as_of, b FROM optlab.stock_surface_cm WHERE tenor=30 AND b IS NOT NULL ORDER BY ticker, as_of"):
        hist[r["ticker"]].append((r["as_of"], r["b"]))
    ranked = []
    for r in cur:
        t = r["ticker"]
        b = r["b"]
        series = [x[1] for x in hist[t]]
        if len(series) >= 60:
            pct = sum(1 for x in series if x <= b) / len(series)
            ranked.append((t, b, pct, "own"))
        else:
            sec = sectors.get(t, "UNK")
            peers = [x["b"] for x in cur if sectors.get(x["ticker"], "UNK") == sec]
            pct = sum(1 for x in peers if x <= b) / max(len(peers), 1)
            ranked.append((t, b, pct, f"sector:{sec}"))
    ranked.sort(key=lambda x: x[2])
    return ranked[:10], ranked[-10:][::-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--write", action="store_true", help="persist to optlab tables")
    args = ap.parse_args()
    conn = connect()
    ensure_schema(conn)

    if args.smoke:
        ok, txt = smoke_gate(conn)
        print(txt)
        if not ok:
            sys.exit(2)
        # small slice timing check
        t0 = time.time()
        stats = run_build(conn, set(SMOKE_TICKERS), write=False)
        print(f"smoke build {stats['n_fits']} fits in {time.time()-t0:.1f}s")
        return

    ok, smoke_txt = smoke_gate(conn)
    print(smoke_txt)
    if not ok:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text("# S1 smoke FAIL\n\n" + smoke_txt)
        sys.exit(2)

    stats = run_build(conn, None, write=args.write or True)
    print(f"FIRST full-run line: n_fits={stats['n_fits']} ge5={stats['ge5_share']:.1%} rmse_p50={stats['rmse_p50']} elapsed={stats['elapsed']:.1f}s")
    write_report(stats, smoke_txt)
  # rank if written
    if args.write or True:
        top, bot = rank_extremes(conn, stats)
        extra = OUT.read_text() + "\n## Latest 30d skew slope (b) percentiles\n\n"
        extra += "Bottom 10:\n" + "\n".join(f"- {t}: b={b:.4f} pct={p:.2f} ({m})" for t, b, p, m in bot)
        extra += "\n\nTop 10:\n" + "\n".join(f"- {t}: b={b:.4f} pct={p:.2f} ({m})" for t, b, p, m in top)
        OUT.write_text(extra)


if __name__ == "__main__":
    main()
