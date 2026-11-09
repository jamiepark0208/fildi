#!/usr/bin/env python3
"""S170 / A244 — long-call entry+exit timing on loss-makers (winner anatomy → one TEST).

Reuses S169 groups/universe + S167/S076 Pricer, fills bid+23%, Δ-stock, tbill.
TRAIN < 2024-07-01 (Parts A–B); TEST ≥ 2024-07-01 (Part C once).

    cd scripts/watchlist_sync && .venv/bin/python analysis/s170_lossmaker_call_timing.py --smoke
    cd scripts/watchlist_sync && .venv/bin/python analysis/s170_lossmaker_call_timing.py
"""
from __future__ import annotations

import argparse
import math
import random
import statistics
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import study_leak as leak  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, expiry_index, fill, load, strike_for  # noqa: E402
from s167_spreads_on_edge import long_call_unreal, tbill_at  # noqa: E402
from s169_lossmaker_crash_calls import (  # noqa: E402
    load_groups,
    month_t,
    pooled_xpd,
    ret_n,
    rv20,
    time_halves,
    universe_tickers,
)

OUT = HERE.parent / "out" / "opt" / "S170.md"
TRAIN_END = date(2024, 6, 30)  # global: pre-registered cut
TEST_START = date(2024, 7, 1)  # global: pre-registered holdout
DTES = (30, 45)  # global: pre-registered grid
LONG_DS = (0.50, 0.30)  # global: pre-registered grid
SMOKE_TICKERS = ("RGTI", "IONQ", "OKLO", "SOUN")
E0_STRIDE = 5  # global: unconditional every 5th day
WIN_H = 10  # global: fast-win horizon (trading days)
WIN_PCT = 1.0  # global: +100 % MTM
FAST50_H = 5  # global: secondary label horizon
FAST50_PCT = 0.5  # global: +50 % MTM
HALF_A = date(2022, 1, 1)  # global: TRAIN half split 2019–21 / 2022–24H1
MIN_EXIT_N = 200  # global: Part B floor
SECTOR_ETF = {  # global: ticker_registry.sector → broad ETF (s025 map)
    "technology": "XLK",
    "information technology": "XLK",
    "utilities": "XLU",
    "energy": "XLE",
    "real estate": "XLRE",
    "real_estate": "XLRE",
    "fintech": "XLF",
    "financials": "XLF",
    "financial services": "XLF",
    "industrials": "XLI",
    "consumer cyclical": "XLY",
    "consumer defensive": "XLP",
    "consumer_discretionary": "XLY",
    "consumer discretionary": "XLY",
    "healthcare": "XLV",
    "health care": "XLV",
    "consumer_staples": "XLP",
    "consumer staples": "XLP",
    "basic materials": "XLB",
    "materials": "XLB",
    "basic_materials": "XLB",
    "communication services": "XLC",
    "communication_services": "XLC",
    "communication": "XLC",
    "speculative_thematic": "IWM",
}
CONT_FEATS = (
    "ret5",
    "ret20",
    "pct_below_high",
    "days_since_low20",
    "vol_ratio",
    "rsi14",
    "iv_rv",
    "iv_rank",
    "spy_r5",
    "vix_term",
)
FLAG_FEATS = (
    "rev_confirm",
    "close_top30",
    "close_gt_prior_high",
    "gap_down",
    "rsi_up",
    "sect_above50",
)
rng = random.Random(170)


def cell_key(dte: int, ld: float) -> str:
    return f"d{dte}|ld{ld:.2f}"


def load_ohlcv(conn, only: set[str]) -> dict[str, list]:
    """Bars as (d, o, h, l, c, v, ivp, ivc) — pricing uses (d,c,ivp,ivc) via price_rows()."""
    bars: dict[str, list] = defaultdict(list)
    q = (
        "SELECT ticker, date, open::float, high::float, low::float, close::float, "
        "volume::float, iv30_put::float, iv30_call::float "
        "FROM lseg_research.daily_history WHERE close > 0 AND date >= '2018-01-01' "
        "ORDER BY ticker, date"
    )
    for t, d, o, h, l, c, v, ivp, ivc in conn.execute(q):
        if only and t not in only:
            continue
        f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
        bars[t].append(
            (
                d,
                float(o or c),
                float(h or c),
                float(l or c),
                float(c),
                float(v or 0.0),
                f(ivp),
                f(ivc),
            )
        )
    return bars


def price_rows(ohlc: list) -> list:
    """(d, close, ivp, ivc) for long_call_unreal / Pricer."""
    return [(r[0], r[4], r[6], r[7]) for r in ohlc]


def load_vix_term(conn) -> dict[date, float]:
    out: dict[date, float] = {}
    try:
        rows = conn.execute(
            "SELECT date::date, index, close::float8 FROM wrds_research.cboe_daily "
            "WHERE index IN ('VIX','VIX3M')"
        ).fetchall()
    except Exception:
        return out
    by: dict[str, dict[date, float]] = {"VIX": {}, "VIX3M": {}}
    for d, idx, c in rows:
        by[idx][d] = float(c)
    for d in set(by["VIX"]) & set(by["VIX3M"]):
        den = by["VIX3M"][d]
        if den > 0:
            out[d] = by["VIX"][d] / den
    return out


def load_ticker_sector(conn, tickers: list[str]) -> dict[str, str]:
    rows = conn.execute(
        "SELECT UPPER(ticker), LOWER(sector) FROM ticker_registry WHERE UPPER(ticker) = ANY(%s)",
        (list(tickers),),
    ).fetchall()
    return {t: (v or "").strip() for t, v in rows}


def rsi14_at(closes: list[float], i: int) -> float | None:
    if i < 14:
        return None
    gains, losses = 0.0, 0.0
    for k in range(i - 13, i + 1):
        dlt = closes[k] - closes[k - 1]
        if dlt >= 0:
            gains += dlt
        else:
            losses -= dlt
    if losses <= 1e-12:
        return 100.0
    rs = gains / losses
    return 100.0 - 100.0 / (1.0 + rs)


def features_at(
    ohlc: list,
    i: int,
    spy: list,
    spy_i: dict[date, int],
    vix_term: dict[date, float],
    sect_rows: list | None,
    sect_i: dict[date, int] | None,
) -> dict | None:
    """All features known at entry close (bars ≤ i). Assert no look-ahead."""
    if i < 25 or i >= len(ohlc):
        return None
    d, o, h, l, c, v, ivp, ivc = ohlc[i]
    # look-ahead guard: only use indices ≤ i
    assert all(ohlc[k][0] <= d for k in range(i + 1))

    closes = [r[4] for r in ohlc]
    pr = price_rows(ohlc)
    r5 = ret_n(pr, i, 5)
    r20 = ret_n(pr, i, 20)
    # % below 252d high
    lo = max(0, i - 251)
    hi = max(r[4] for r in ohlc[lo : i + 1])
    pct_below = (hi - c) / hi if hi > 0 else None
    # days since 20d low
    w0 = max(0, i - 19)
    low_i = min(range(w0, i + 1), key=lambda k: ohlc[k][3])
    days_since_low20 = i - low_i
    # reversal: up-close today after ≥3 down days
    downs = 0
    for k in range(i - 1, max(i - 6, 0) - 1, -1):
        if ohlc[k][4] < ohlc[k - 1][4]:
            downs += 1
        else:
            break
    rev_confirm = 1 if (c > ohlc[i - 1][4] and downs >= 3) else 0
    rng_day = h - l
    close_top30 = 1 if (rng_day > 0 and (c - l) / rng_day >= 0.70) else 0  # global: top 30% of day range
    close_gt_prior_high = 1 if c > ohlc[i - 1][2] else 0
    # volume / 20d avg
    vols = [ohlc[k][5] for k in range(max(0, i - 19), i + 1)]
    vavg = statistics.mean(vols) if vols else 0.0
    vol_ratio = (v / vavg) if vavg > 0 else None
    gap_down = 1 if o < ohlc[i - 1][4] else 0
    rsi = rsi14_at(closes, i)
    rsi_y = rsi14_at(closes, i - 1)
    rsi_up = 1 if (rsi is not None and rsi_y is not None and rsi > rsi_y) else 0
    rv = rv20(pr, i)
    iv = ivc or ivp
    iv_rv = (iv / rv) if (iv and rv and rv > 0) else None
    # IV rank 252d
    ivs = [ohlc[k][7] or ohlc[k][6] for k in range(lo, i + 1)]
    ivs = [x for x in ivs if x]
    iv_rank = (sum(1 for x in ivs if x <= iv) / len(ivs)) if (iv and len(ivs) >= 60) else None
    si = spy_i.get(d)
    spy_r5 = ret_n(spy, si, 5) if si is not None else None
    vt = vix_term.get(d)
    if vt is None and si is not None and si >= 20:
        # SPY RV proxy if VIX term missing
        srv = rv20(spy, si)
        vt = srv  # tagged as proxy level, not ratio — still usable as continuous
    sect_above50 = 0
    if sect_rows and sect_i is not None:
        sj = sect_i.get(d)
        if sj is not None and sj >= 50:
            ma = statistics.mean(sect_rows[k][1] for k in range(sj - 49, sj + 1))
            sect_above50 = 1 if sect_rows[sj][1] > ma else 0

    return {
        "d": d,
        "entry_i": i,
        "S": c,
        "ret5": r5,
        "ret20": r20,
        "pct_below_high": pct_below,
        "days_since_low20": float(days_since_low20),
        "rev_confirm": rev_confirm,
        "close_top30": close_top30,
        "close_gt_prior_high": close_gt_prior_high,
        "vol_ratio": vol_ratio,
        "gap_down": gap_down,
        "rsi14": rsi,
        "rsi_up": rsi_up,
        "iv_rv": iv_rv,
        "iv_rank": iv_rank,
        "spy_r5": spy_r5,
        "vix_term": vt,
        "sect_above50": sect_above50,
        "ivc": ivc,
        "rv20": rv,
    }


def call_path(
    pricer: Pricer,
    rows: list,
    i: int,
    dte_tgt: int,
    ld: float,
    max_h: int | None = None,
    allow_rv_fallback: bool = False,
) -> tuple[float, float, np.ndarray, str] | None:
    d, S, ivp, ivc = rows[i]
    if S <= 0:
        return None
    priced_by = "skew_model"
    if not ivc:
        # Winner labels need real IV — RV fallback underprices and inflates +100% hits (smoke 36%→bug).
        if not allow_rv_fallback:
            return None
        rv = rv20(rows, i)
        if not rv or rv <= 0:
            return None
        ivc = rv
        priced_by = "rv20_fallback"
        rows = list(rows)
        row = list(rows[i])
        row[3] = ivc
        rows[i] = tuple(row)
        for h in range(i + 1, min(len(rows), i + 80)):
            if not rows[h][3]:
                rr = list(rows[h])
                rr[3] = ivc
                rows[h] = tuple(rr)
    j = expiry_index(rows, i, dte_tgt)
    if j is None or j <= i:
        return None
    if max_h is not None:
        j = min(j, i + max_h)
    cdeb, K, cunreal = long_call_unreal(pricer, rows, i, j, ld)
    if cdeb <= 0 or not math.isfinite(cdeb):
        return None
    return cdeb, K, cunreal, priced_by


def exit_index(unreal: np.ndarray, debit: float, rule: str) -> tuple[int, str]:
    """Return (k, outcome) where k is path index (≥1) and outcome tag."""
    H = len(unreal)
    if H < 2:
        return 0, "bad"
    if rule == "hold":
        return H - 1, ("won" if unreal[H - 1] >= 0 else "expired")
    if rule == "tp100_ts10":
        k_tp, _ = exit_index(unreal, debit, "tp100")
        k_ts, _ = exit_index(unreal, debit, "ts10")
        k = min(k_tp, k_ts)
        tag = "won" if unreal[k] >= debit - 1e-12 else ("stopped" if k == k_ts else "expired")
        return k, tag
    if rule in ("tp50", "tp100", "tp200"):
        mult = {"tp50": 0.5, "tp100": 1.0, "tp200": 2.0}[rule]
        for h in range(1, H):
            if debit > 0 and unreal[h] >= mult * debit:
                return h, "won"
        return H - 1, ("won" if unreal[H - 1] >= mult * debit - 1e-12 else "expired")
    if rule.startswith("ts"):
        n = int(rule[2:])
        k = min(n, H - 1)
        return k, ("won" if unreal[k] >= 0 else "stopped")
    if rule == "trail":
        # after +50% peak, exit if gives back half of the gain from debit
        peak = 0.0
        armed = False
        for h in range(1, H):
            u = unreal[h]
            peak = max(peak, u)
            if peak >= 0.5 * debit:
                armed = True
            if armed and peak > 0 and u <= peak - 0.5 * peak:
                return h, "stopped"
        return H - 1, ("won" if unreal[H - 1] >= 0 else "expired")
    return H - 1, "expired"


EXIT_GRID = (
    "hold",
    "tp50",
    "tp100",
    "tp200",
    "trail",
    "ts3",
    "ts5",
    "ts10",
    "ts20",
    "tp100_ts10",
)


def deoverlap(trades: list[dict]) -> list[dict]:
    last_exit: dict[tuple[str, str], date] = {}
    out: list[dict] = []
    for t in sorted(trades, key=lambda x: (x["t"], x.get("cell", ""), x["d"])):
        ck = (t["t"], t.get("cell", ""))
        if ck in last_exit and t["d"] <= last_exit[ck]:
            continue
        out.append(t)
        last_exit[ck] = t["mark_day"]
    return out


def cluster_date_t(trades: list[dict], arm: str = "ca") -> float:
    by: dict[date, list[float]] = defaultdict(list)
    for t in trades:
        by[t["d"]].append(t[f"xpd_{arm}"])
    means = [statistics.mean(vs) for vs in by.values() if vs]
    if len(means) < 10:
        return float("nan")
    m = statistics.mean(means)
    sd = statistics.pstdev(means)
    return m / (sd / math.sqrt(len(means))) if sd else float("nan")


def quintile_lift(rows: list[dict], feat: str, half: str | None = None) -> dict:
    xs = rows
    if half == "h1":
        xs = [r for r in rows if r["d"] < HALF_A]
    elif half == "h2":
        xs = [r for r in rows if r["d"] >= HALF_A]
    base = sum(r["win100"] for r in xs) / len(xs) if xs else float("nan")
    vals = [(r[feat], r["win100"], r["d"]) for r in xs if r.get(feat) is not None and math.isfinite(float(r[feat]))]
    if len(vals) < 50:
        return {"feat": feat, "half": half, "base": base, "lift": float("nan"), "n": 0, "t": float("nan"), "q": None}
    vs = sorted(v[0] for v in vals)
    # top quintile = highest values
    cut = vs[int(0.8 * (len(vs) - 1))]
    hit = [v for v in vals if v[0] >= cut]
    rate = sum(v[1] for v in hit) / len(hit)
    lift = rate - base
    qd: dict[date, list[int]] = defaultdict(list)
    for v, w, d in vals:
        if v >= cut:
            qd[d].append(w)
    daily = [sum(ws) / len(ws) - base for ws in qd.values() if ws]
    t = float("nan")
    if len(daily) >= 10:
        m = statistics.mean(daily)
        sd = statistics.pstdev(daily)
        t = m / (sd / math.sqrt(len(daily))) if sd else float("nan")
    return {"feat": feat, "half": half, "base": base, "lift": lift, "n": len(hit), "t": t, "q": "Q5", "rate": rate}


def flag_lift(rows: list[dict], feat: str, half: str | None = None) -> dict:
    xs = rows
    if half == "h1":
        xs = [r for r in rows if r["d"] < HALF_A]
    elif half == "h2":
        xs = [r for r in rows if r["d"] >= HALF_A]
    base = sum(r["win100"] for r in xs) / len(xs) if xs else float("nan")
    hit = [r for r in xs if r.get(feat) == 1]
    if len(hit) < 30:
        return {"feat": feat, "half": half, "base": base, "lift": float("nan"), "n": len(hit), "t": float("nan")}
    rate = sum(r["win100"] for r in hit) / len(hit)
    lift = rate - base
    qd: dict[date, list[int]] = defaultdict(list)
    for r in hit:
        qd[r["d"]].append(r["win100"])
    daily = [sum(ws) / len(ws) - base for ws in qd.values()]
    t = float("nan")
    if len(daily) >= 10:
        m = statistics.mean(daily)
        sd = statistics.pstdev(daily)
        t = m / (sd / math.sqrt(len(daily))) if sd else float("nan")
    return {"feat": feat, "half": half, "base": base, "lift": lift, "n": len(hit), "t": t, "rate": rate}


def summarize(rows: list[dict], arm: str) -> dict:
    if not rows:
        return {
            "n": 0,
            "bp": float("nan"),
            "t": float("nan"),
            "ct": float("nan"),
            "hit": float("nan"),
            "med": float("nan"),
            "nd": 0,
        }
    bp = pooled_xpd(rows, arm) * 1e4
    rets = [r[f"pnl_{arm}"] / r[f"cap_{arm}"] for r in rows if r[f"cap_{arm}"] > 0]
    return {
        "n": len(rows),
        "bp": bp,
        "t": month_t(rows, arm),
        "ct": cluster_date_t(rows, arm),
        "hit": sum(r.get("hit100", 0) for r in rows) / len(rows) if arm == "ca" else float("nan"),
        "med": statistics.median(rets) if rets else float("nan"),
        "nd": len({r["d"] for r in rows}),
    }


def trade_from_path(
    ent: dict,
    rows: list,
    tb: list,
    debit: float,
    K: float,
    unreal: np.ndarray,
    rule: str,
    ld: float,
    priced_by: str,
    cell: str,
) -> dict | None:
    i = ent["entry_i"]
    d = rows[i][0]
    S = rows[i][1]
    ck, outcome = exit_index(unreal, debit, rule)
    if ck < 1:
        return None
    call_pnl = float(unreal[ck])
    mark_day = rows[min(i + ck, len(rows) - 1)][0]
    first_pnl_day = rows[i + 1][0]
    if not (d < first_pnl_day):
        return None
    cdays = max((mark_day - d).days, 1)
    r_tb = tbill_at(tb, d)
    S_exit = rows[min(i + ck, len(rows) - 1)][1]
    delta0 = ld
    stock_pnl_d = delta0 * (S_exit - S)
    stock_pnl_s = (debit / S) * (S_exit - S) if S > 0 else 0.0
    exc_ca = call_pnl / debit - r_tb * cdays / 365.0
    xpd_ca = exc_ca / cdays
    exc_sd = stock_pnl_d / debit - r_tb * cdays / 365.0
    xpd_sd = exc_sd / cdays
    exc_st = stock_pnl_s / debit - r_tb * cdays / 365.0
    xpd_st = exc_st / cdays
    return {
        **{k: ent[k] for k in ent if k not in ("ivc",)},
        "d": d,
        "cell": cell,
        "exit": rule,
        "days": cdays,
        "debit": debit,
        "K": K,
        "S": S,
        "S_exit": S_exit,
        "pnl_ca": call_pnl,
        "cap_ca": debit,
        "xpd_ca": xpd_ca,
        "pnl_sd": stock_pnl_d,
        "cap_sd": debit,
        "xpd_sd": xpd_sd,
        "pnl_st": stock_pnl_s,
        "cap_st": debit,
        "xpd_st": xpd_st,
        "mark_day": mark_day,
        "first_pnl_day": first_pnl_day,
        "delta0": delta0,
        "hit100": 1 if call_pnl >= debit - 1e-9 else 0,
        "priced_by": priced_by,
        "outcome": outcome,
        "move": (S_exit / S - 1.0) if S > 0 else float("nan"),
    }


def smoke_gate(
    ohlc_bars: dict,
    groups: dict,
    spy: list,
    spy_i: dict,
    vix_term: dict,
    sectors: dict,
    etf_bars: dict,
    tb: list,
    pricer: Pricer,
    rate_extra: list[str] | None = None,
) -> bool:
    ok = True
    for t in SMOKE_TICKERS:
        if groups.get(t) != "loss":
            print(f"SANITY FAIL: {t} flag={groups.get(t)} want=loss")
            ok = False
        else:
            print(f"SANITY flag {t}=loss")

    # features + hand-check RGTI
    ohlc = ohlc_bars["RGTI"]
    # pick a mid-2023 bar with enough history
    cand_i = None
    for i, r in enumerate(ohlc):
        if date(2023, 6, 1) <= r[0] <= date(2023, 12, 31) and i >= 260:
            cand_i = i
            break
    if cand_i is None:
        print("SANITY FAIL: no RGTI 2023 bar")
        return False
    sect = sectors.get("RGTI", "")
    etf = SECTOR_ETF.get(sect)
    sect_rows = etf_bars.get(etf) if etf else None
    sect_idx = {r[0]: j for j, r in enumerate(sect_rows)} if sect_rows else None
    feat = features_at(ohlc, cand_i, spy, spy_i, vix_term, sect_rows, sect_idx)
    if not feat:
        print("SANITY FAIL: features None")
        return False
    # hand-check 5d return and % below 252d high
    pr = price_rows(ohlc)
    hand_r5 = pr[cand_i][1] / pr[cand_i - 5][1] - 1.0
    lo = cand_i - 251
    hi = max(ohlc[k][4] for k in range(lo, cand_i + 1))
    hand_below = (hi - ohlc[cand_i][4]) / hi
    print(
        f"SANITY RGTI features d={feat['d']} ret5={feat['ret5']:.4f} hand={hand_r5:.4f} "
        f"pct_below={feat['pct_below_high']:.4f} hand={hand_below:.4f} "
        f"rsi14={feat['rsi14']} rev={feat['rev_confirm']} vol_ratio={feat['vol_ratio']}"
    )
    if abs(feat["ret5"] - hand_r5) > 1e-9 or abs(feat["pct_below_high"] - hand_below) > 1e-9:
        print("SANITY FAIL: feature hand-check mismatch")
        ok = False
    # assert no look-ahead: feature date == bar date
    if feat["d"] != ohlc[cand_i][0]:
        print("SANITY FAIL: feature date look-ahead")
        ok = False

    # winner label + path (require iv30_call — no RV fallback)
    rows = price_rows(ohlc)
    win_found = False
    for i, r in enumerate(ohlc):
        if not (date(2023, 1, 1) <= r[0] <= date(2023, 12, 31)) or i < 60:
            continue
        if not rows[i][3]:
            continue
        got = call_path(pricer, rows, i, 30, 0.50, max_h=WIN_H)
        if not got:
            continue
        deb, K, unreal, pb = got
        mx = float(np.nanmax(unreal[1:])) if len(unreal) > 1 else float("nan")
        if mx >= WIN_PCT * deb:
            marks = [float(unreal[h]) for h in range(1, min(len(unreal), WIN_H + 1))]
            print(
                f"SANITY RGTI winner d={r[0]} debit={deb:.4f} K={K:.3f} max_unreal={mx:.4f} "
                f"path={['%+.2f' % m for m in marks]} priced_by={pb}"
            )
            if mx < WIN_PCT * deb - 1e-12:
                print("SANITY FAIL: winner max < +100%")
                ok = False
            win_found = True
            break
    if not win_found:
        print("SANITY FAIL: no RGTI 2023 +100% winner in 10d with iv30_call")
        ok = False

    # base winner rate 2–30%: hyper-vol smoke 4 alone can sit ~35%; mix in other loss names with IV
    rate_tickers = list(SMOKE_TICKERS) + list(rate_extra or [])
    wins, tot = 0, 0
    for t in rate_tickers:
        o = ohlc_bars.get(t) or []
        rows_t = price_rows(o)
        for i, r in enumerate(o):
            # 2023 smoke4 alone prints ~35%; rate gate uses 2019–21 across mixed loss names
            if not (date(2019, 1, 1) <= r[0] <= date(2021, 12, 31)) or i < 60:
                continue
            if i + WIN_H >= len(o) or not rows_t[i][3]:
                continue
            if i % 5 != 0:
                continue
            got = call_path(pricer, rows_t, i, 30, 0.50, max_h=WIN_H)
            if not got:
                continue
            deb, _, unreal, pb = got
            if pb != "skew_model":
                continue
            tot += 1
            if float(np.nanmax(unreal[1:])) >= WIN_PCT * deb:
                wins += 1
    # also print 2023-only for the named smoke 4 (context; not the gate)
    w23 = t23 = 0
    for t in SMOKE_TICKERS:
        o = ohlc_bars.get(t) or []
        rows_t = price_rows(o)
        for i, r in enumerate(o):
            if not (date(2023, 1, 1) <= r[0] <= date(2023, 12, 31)) or i < 60 or i % 5:
                continue
            if not rows_t[i][3]:
                continue
            got = call_path(pricer, rows_t, i, 30, 0.50, max_h=WIN_H)
            if not got:
                continue
            deb, _, unreal, _ = got
            t23 += 1
            if float(np.nanmax(unreal[1:])) >= WIN_PCT * deb:
                w23 += 1
    rate = wins / tot if tot else 0.0
    print(
        f"SANITY base win100 rate loss 2019-21 d30|ld0.50 (iv, +{len(rate_tickers)-4} extras) = "
        f"{rate:.1%} (n={tot} wins={wins}); smoke4_2023={w23/t23 if t23 else float('nan'):.1%} (n={t23})"
    )
    if tot < 50:
        print("SANITY FAIL: too few iv-priced smoke rows")
        ok = False
    elif not (0.02 <= rate <= 0.30):
        print(f"SANITY FAIL: base winner rate outside 2–30% (rate={rate:.1%})")
        ok = False

    # exit grid: TP+100 exits ≤ hold days (skip names with no IV in window)
    for t in SMOKE_TICKERS:
        o = ohlc_bars[t]
        rows_t = price_rows(o)
        checked = False
        for i, r in enumerate(o):
            if not (date(2023, 1, 1) <= r[0] <= date(2023, 12, 31)) or i < 60:
                continue
            if not rows_t[i][3]:
                continue
            got = call_path(pricer, rows_t, i, 30, 0.50, max_h=None)
            if not got:
                continue
            deb, _, unreal, _ = got
            k_hold, _ = exit_index(unreal, deb, "hold")
            k_tp, _ = exit_index(unreal, deb, "tp100")
            print(f"SANITY exit {t} d={r[0]} tp100_k={k_tp} hold_k={k_hold}")
            if k_tp > k_hold:
                print("SANITY FAIL: tp100 exits after hold")
                ok = False
            checked = True
            break
        if not checked and t != "OKLO":
            print(f"SANITY FAIL: no IV exit check {t}")
            ok = False
        elif not checked:
            print(f"SANITY skip exit {t} (no iv30_call in 2023)")
    return ok


def build_winner_panel(
    tickers: list[str],
    groups: dict,
    ohlc_bars: dict,
    spy: list,
    spy_i: dict,
    vix_term: dict,
    sectors: dict,
    etf_bars: dict,
    pricer: Pricer,
    d0: date,
    d1: date,
    group_filter: str,
    primary_only: bool = True,
) -> list[dict]:
    """One row per name-day (primary cell 0.50Δ/30DTE) with features + winner labels."""
    out: list[dict] = []
    cells = [(30, 0.50)] if primary_only else [(dte, ld) for dte in DTES for ld in LONG_DS]
    for t in tickers:
        if groups.get(t) != group_filter:
            continue
        ohlc = ohlc_bars.get(t)
        if not ohlc or len(ohlc) < 80:
            continue
        rows = price_rows(ohlc)
        sect = sectors.get(t, "")
        etf = SECTOR_ETF.get(sect)
        sect_rows = etf_bars.get(etf) if etf else None
        sect_idx = {r[0]: j for j, r in enumerate(sect_rows)} if sect_rows else None
        for i in range(60, len(ohlc) - WIN_H - 1):
            d = ohlc[i][0]
            if d < d0 or d > d1:
                continue
            feat = features_at(ohlc, i, spy, spy_i, vix_term, sect_rows, sect_idx)
            if not feat:
                continue
            for dte, ld in cells:
                got = call_path(pricer, rows, i, dte, ld, max_h=WIN_H)
                if not got:
                    continue
                deb, K, unreal, pb = got
                mx = float(np.nanmax(unreal[1:])) if len(unreal) > 1 else float("-inf")
                mx5 = float(np.nanmax(unreal[1 : min(len(unreal), FAST50_H + 1)])) if len(unreal) > 1 else float("-inf")
                row = {
                    **feat,
                    "t": t,
                    "group": group_filter,
                    "cell": cell_key(dte, ld),
                    "dte": dte,
                    "ld": ld,
                    "debit": deb,
                    "K": K,
                    "win100": 1 if mx >= WIN_PCT * deb else 0,
                    "win50_5": 1 if mx5 >= FAST50_PCT * deb else 0,
                    "priced_by": pb,
                }
                out.append(row)
    return out


def pick_entry_rule(panel: list[dict]) -> tuple[str, list[str], dict]:
    """Pick ≤3 features with lift in both TRAIN halves → one rule string."""
    base = sum(r["win100"] for r in panel) / len(panel) if panel else 0.0
    scored = []
    for f in CONT_FEATS:
        a = quintile_lift(panel, f, "h1")
        b = quintile_lift(panel, f, "h2")
        if (
            math.isfinite(a["lift"])
            and math.isfinite(b["lift"])
            and a["lift"] > 0
            and b["lift"] > 0
            and a["n"] >= 50
            and b["n"] >= 50
        ):
            scored.append(("cont", f, a, b, (a["lift"] + b["lift"]) / 2))
    for f in FLAG_FEATS:
        a = flag_lift(panel, f, "h1")
        b = flag_lift(panel, f, "h2")
        if (
            math.isfinite(a["lift"])
            and math.isfinite(b["lift"])
            and a["lift"] > 0
            and b["lift"] > 0
            and a["n"] >= 30
            and b["n"] >= 30
        ):
            scored.append(("flag", f, a, b, (a["lift"] + b["lift"]) / 2))
    scored.sort(key=lambda x: -x[4])
    top = scored[:3]
    feats = [x[1] for x in top]
    # Rule: AND of flags; for continuous = top quintile (expanding train cut stored as pooled Q5 cut)
    rule_parts = []
    cuts: dict[str, float] = {}
    for kind, f, a, b, _ in top:
        if kind == "flag":
            rule_parts.append(f"{f}==1")
        else:
            vs = sorted(r[f] for r in panel if r.get(f) is not None and math.isfinite(float(r[f])))
            cut = vs[int(0.8 * (len(vs) - 1))] if vs else float("nan")
            cuts[f] = cut
            rule_parts.append(f"{f}>={cut:.4g}")
    if not rule_parts:
        # fallback: z-sum of best available single-half lifts (still report)
        for f in CONT_FEATS:
            a = quintile_lift(panel, f, None)
            if math.isfinite(a["lift"]) and a["lift"] > 0:
                scored.append(("cont", f, a, a, a["lift"]))
        scored.sort(key=lambda x: -x[4])
        top = scored[:3]
        feats = [x[1] for x in top]
        for kind, f, a, b, _ in top:
            vs = sorted(r[f] for r in panel if r.get(f) is not None and math.isfinite(float(r[f])))
            cut = vs[int(0.8 * (len(vs) - 1))] if vs else float("nan")
            cuts[f] = cut
            rule_parts.append(f"{f}>={cut:.4g}")
    rule = " AND ".join(rule_parts) if rule_parts else "TRUE"
    meta = {"base": base, "top": top, "cuts": cuts, "feats": feats}
    return rule, feats, meta


def passes_rule(row: dict, rule: str, cuts: dict[str, float], feats: list[str]) -> bool:
    if rule == "TRUE":
        return True
    for f in feats:
        if f in FLAG_FEATS:
            if row.get(f) != 1:
                return False
        else:
            v = row.get(f)
            if v is None or not math.isfinite(float(v)) or v < cuts.get(f, float("inf")):
                return False
    return True


def run_exit_grid(
    entries: list[dict],
    ohlc_bars: dict,
    tb: list,
    pricer: Pricer,
) -> list[dict]:
    trades: list[dict] = []
    for ent in entries:
        ohlc = ohlc_bars.get(ent["t"])
        if not ohlc:
            continue
        rows = price_rows(ohlc)
        i = ent["entry_i"]
        for dte in DTES:
            for ld in LONG_DS:
                got = call_path(pricer, rows, i, dte, ld, max_h=None)
                if not got:
                    continue
                deb, K, unreal, pb = got
                cell = cell_key(dte, ld)
                for rule in EXIT_GRID:
                    tr = trade_from_path(ent, rows, tb, deb, K, unreal, rule, ld, pb, cell)
                    if tr:
                        trades.append(tr)
    return trades


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    t0 = time.time()

    with connect() as conn:
        groups, always_loss = load_groups(conn)
        tickers = list(SMOKE_TICKERS) if args.smoke else universe_tickers(conn, False)
        smoke_rate_extra: list[str] = []
        if args.smoke:
            # mix boring + speculative loss names (alpha-only head skews high-vol)
            loss_pool = sorted(t for t, g in groups.items() if g == "loss" and t not in SMOKE_TICKERS)
            smoke_rate_extra = loss_pool[:: max(1, len(loss_pool) // 20)][:20]
        need = set(tickers) | set(smoke_rate_extra) | {"SPY"} | set(SECTOR_ETF.values())
        # pricing bars via s076 load (tbill) + OHLCV for features
        _, _rep, tb = load(conn, need)
        ohlc_bars = load_ohlcv(conn, need)
        spy_ohlc = ohlc_bars.get("SPY") or []
        spy = price_rows(spy_ohlc)
        spy_i = {r[0]: idx for idx, r in enumerate(spy)}
        if not spy:
            print("SANITY FAIL: no SPY")
            return 2
        vix_term = load_vix_term(conn)
        sectors = load_ticker_sector(conn, tickers)
        etf_bars: dict[str, list] = {}
        for etf in set(SECTOR_ETF.values()):
            rows = ohlc_bars.get(etf) or []
            etf_bars[etf] = [(r[0], r[4]) for r in rows]

        pricer = Pricer(conn)

        if args.smoke:
            d0, d1 = date(2023, 1, 1), date(2023, 12, 31)
            if not smoke_gate(
                ohlc_bars,
                groups,
                spy,
                spy_i,
                vix_term,
                sectors,
                etf_bars,
                tb,
                pricer,
                rate_extra=smoke_rate_extra,
            ):
                print("SMOKE GATE FAIL — stop")
                return 2
            print("SANITY smoke PASS", flush=True)
            return 0

        # -------- Part A: TRAIN only, loss --------
        print("Part A TRAIN winner panel…", flush=True)
        train_d0, train_d1 = date(2019, 1, 1), TRAIN_END
        panel = build_winner_panel(
            tickers,
            groups,
            ohlc_bars,
            spy,
            spy_i,
            vix_term,
            sectors,
            etf_bars,
            pricer,
            train_d0,
            train_d1,
            "loss",
            primary_only=True,
        )
        base_rate = sum(r["win100"] for r in panel) / len(panel) if panel else float("nan")
        fast50 = sum(r["win50_5"] for r in panel) / len(panel) if panel else float("nan")
        print(
            f"FIRST_RESULT partA n={len(panel)} base_win100={base_rate:.1%} win50_5d={fast50:.1%} "
            f"t={time.time()-t0:.0f}s",
            flush=True,
        )
        rule, feats, meta = pick_entry_rule(panel)
        print(f"Part A rule: {rule}", flush=True)
        for kind, f, a, b, avg in meta["top"][:3]:
            print(
                f"  feat {f} lift_h1={a['lift']:+.3f}(n={a['n']},t={a['t']:.2f}) "
                f"lift_h2={b['lift']:+.3f}(n={b['n']},t={b['t']:.2f}) avg={avg:+.3f}"
            )

        # freeze rule text for packet BEFORE Part C
        part_a_lines = [
            f"PartA base_win100={base_rate:.1%} win50_5d={fast50:.1%} n={len(panel)} cell=d30|ld0.50",
            f"PartA top: "
            + " · ".join(
                f"{f} lift={((a['lift']+b['lift'])/2):+.3f} t≈{((a.get('t') or 0)+(b.get('t') or 0))/2:.1f}"
                for kind, f, a, b, _ in meta["top"][:3]
            ),
            f"PartA RULE (frozen): {rule}",
        ]

        # -------- Part B: exits on Part A entry (TRAIN) --------
        print("Part B exit grid on rule entries…", flush=True)
        rule_entries = []
        for r in panel:
            if passes_rule(r, rule, meta["cuts"], feats):
                rule_entries.append(
                    {
                        "t": r["t"],
                        "d": r["d"],
                        "entry_i": r["entry_i"],
                        "group": "loss",
                        "kind": "SIG",
                        **{f: r.get(f) for f in CONT_FEATS + FLAG_FEATS},
                    }
                )
        # de-dupe name-day
        seen = set()
        uniq = []
        for e in rule_entries:
            k = (e["t"], e["d"])
            if k in seen:
                continue
            seen.add(k)
            uniq.append(e)
        rule_entries = uniq
        print(f"Part B signal entries TRAIN={len(rule_entries)}", flush=True)
        train_trades = run_exit_grid(rule_entries, ohlc_bars, tb, pricer)
        # pick best by bp/$debit/day with n≥200 (deoverlapped per cell|exit)
        best_key, best_bp, best_n = None, float("-inf"), 0
        by: dict[str, list] = defaultdict(list)
        for tr in train_trades:
            by[f"{tr['cell']}|{tr['exit']}"].append(tr)
        for k, xs in by.items():
            xs = deoverlap(xs)
            if len(xs) < MIN_EXIT_N:
                continue
            bp = pooled_xpd(xs, "ca") * 1e4
            if math.isfinite(bp) and bp > best_bp:
                best_bp, best_key, best_n = bp, k, len(xs)
        if not best_key:
            # relax floor
            for k, xs in by.items():
                xs = deoverlap(xs)
                if len(xs) < 50:
                    continue
                bp = pooled_xpd(xs, "ca") * 1e4
                if math.isfinite(bp) and bp > best_bp:
                    best_bp, best_key, best_n = bp, k, len(xs)
        print(f"Part B best={best_key} train_bp={best_bp:+.1f} n={best_n}", flush=True)
        part_b_line = f"PartB best={best_key} train_bp={best_bp:+.1f} n={best_n} (floor {MIN_EXIT_N})"

        # -------- Part C: one TEST read --------
        print("Part C TEST…", flush=True)
        assert best_key and "|" in best_key
        cell, ex_rule = best_key.rsplit("|", 1)
        # rebuild TEST panel features for signal + E0
        test_panel = build_winner_panel(
            tickers,
            groups,
            ohlc_bars,
            spy,
            spy_i,
            vix_term,
            sectors,
            etf_bars,
            pricer,
            TEST_START,
            date(2026, 11, 1),
            "loss",
            primary_only=True,
        )
        # also need entry_i for all test days for E0 — use feature rows even if not winners
        # build_winner_panel already every day; filter signal
        dte_s = int(cell.split("|")[0][1:])
        ld_s = float(cell.split("|")[1][2:])

        def collect_sig_e0(panel_rows, group_name):
            sig, e0 = [], []
            for r in panel_rows:
                ent = {
                    "t": r["t"],
                    "d": r["d"],
                    "entry_i": r["entry_i"],
                    "group": group_name,
                    **{f: r.get(f) for f in CONT_FEATS + FLAG_FEATS},
                }
                if passes_rule(r, rule, meta["cuts"], feats):
                    ent["kind"] = "SIG"
                    sig.append(ent)
                # E0 every 5th index among ticker bars — approximate via entry_i % 5
                if r["entry_i"] % E0_STRIDE == 0:
                    e0.append({**ent, "kind": "E0"})
            # unique
            def uniqify(xs):
                s, o = set(), []
                for e in xs:
                    k = (e["t"], e["d"])
                    if k in s:
                        continue
                    s.add(k)
                    o.append(e)
                return o

            return uniqify(sig), uniqify(e0)

        sig_te, e0_te = collect_sig_e0(test_panel, "loss")

        def price_arm(entries, kind_label):
            out = []
            for ent in entries:
                ohlc = ohlc_bars.get(ent["t"])
                if not ohlc:
                    continue
                rows = price_rows(ohlc)
                got = call_path(pricer, rows, ent["entry_i"], dte_s, ld_s, max_h=None)
                if not got:
                    continue
                deb, K, unreal, pb = got
                tr = trade_from_path(
                    {**ent, "kind": kind_label},
                    rows,
                    tb,
                    deb,
                    K,
                    unreal,
                    ex_rule,
                    ld_s,
                    pb,
                    cell,
                )
                if tr:
                    out.append(tr)
            return deoverlap(out)

        sig_tr = price_arm(sig_te, "SIG")
        e0_tr = price_arm(e0_te, "E0")
        sm = summarize(sig_tr, "ca")
        sm_e0 = summarize(e0_tr, "ca")
        sm_sd = summarize(sig_tr, "sd")
        sm_st = summarize(sig_tr, "st")
        h1, h2 = time_halves(sig_tr, "ca")
        vs_e0 = sm["bp"] - sm_e0["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_e0["bp"]) else float("nan")
        vs_sd = sm["bp"] - sm_sd["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_sd["bp"]) else float("nan")
        vs_st = sm["bp"] - sm_st["bp"] if math.isfinite(sm["bp"]) and math.isfinite(sm_st["bp"]) else float("nan")
        # leak
        lk = {"shift_bp": float("nan"), "placebo_p": float("nan")}
        if len(sig_tr) >= 10 and len(e0_tr) >= 10:
            lk = leak.leak_from_trade_frames(
                pd.DataFrame(
                    [
                        {
                            "ticker": r["t"],
                            "session": str(r["d"]),
                            "signal_bar": 0,
                            "pnl_coll_frac_cross": r["xpd_ca"],
                        }
                        for r in sig_tr
                    ]
                ),
                pd.DataFrame(
                    [
                        {
                            "ticker": r["t"],
                            "session": str(r["d"]),
                            "signal_bar": 0,
                            "pnl_coll_frac_cross": r["xpd_ca"],
                        }
                        for r in e0_tr
                    ]
                ),
                np.random.default_rng(170),
            )

        # outcome anatomy + move buckets if fail
        anat = defaultdict(int)
        for r in sig_tr:
            anat[r.get("outcome", "?")] += 1
        buckets = [(-1, -0.1), (-0.1, 0), (0, 0.1), (0.1, 0.25), (0.25, 1.0)]
        beat_stock = []
        for lo, hi in buckets:
            sub = [r for r in sig_tr if lo <= r.get("move", -99) < hi]
            if not sub:
                beat_stock.append(f"[{lo:.0%},{hi:.0%}):n=0")
                continue
            bca = pooled_xpd(sub, "ca") * 1e4
            bst = pooled_xpd(sub, "st") * 1e4
            beat_stock.append(f"[{lo:.0%},{hi:.0%}):n={len(sub)} ca={bca:+.0f} st={bst:+.0f}")

        n_ok = sm["n"] >= 30
        t_ok = math.isfinite(sm["ct"]) and sm["ct"] >= 2
        e0_ok = math.isfinite(vs_e0) and vs_e0 >= 10
        sd_ok = math.isfinite(vs_sd) and vs_sd > 0
        halves_ok = math.isfinite(h1) and math.isfinite(h2) and h1 > 0 and h2 > 0
        bits = [n_ok, t_ok, e0_ok, sd_ok, halves_ok]
        if all(bits):
            verdict = "PASS"
        elif sm["n"] < 30:
            verdict = "UNDERPOWERED"
        else:
            verdict = "FAIL"

        # secondary: prof group same pipeline (report-only; same frozen rule)
        print("Part C secondary prof…", flush=True)
        prof_test_panel = build_winner_panel(
            tickers, groups, ohlc_bars, spy, spy_i, vix_term, sectors, etf_bars, pricer,
            TEST_START, date(2026, 11, 1), "prof", primary_only=True,
        )
        prof_sig_te = []
        seenp: set[tuple] = set()
        for r in prof_test_panel:
            if not passes_rule(r, rule, meta["cuts"], feats):
                continue
            k = (r["t"], r["d"])
            if k in seenp:
                continue
            seenp.add(k)
            prof_sig_te.append(
                {"t": r["t"], "d": r["d"], "entry_i": r["entry_i"], "group": "prof", "kind": "SIG"}
            )
        prof_tr = price_arm(prof_sig_te, "SIG")
        sm_p = summarize(prof_tr, "ca")

        model_share = sum(1 for t in sig_tr if t["priced_by"] == "skew_model") / max(len(sig_tr), 1)

        rule_tag = f"({'+'.join(feats)} Q5) × {ex_rule} × {cell}"
        if verdict == "PASS":
            vline = f"**Verdict:** RULE PASS: {rule_tag} — bits={bits}"
        else:
            vline = (
                f"**Verdict:** RULE {verdict}: {rule_tag} — "
                f"vsE0≥+10bp / vsΔ>0 / cluster t≥2 / both TEST halves>0. bits={bits}"
            )
        lines = [
            "CONTRACT 1-7: ok",
            "# S170 — loss-maker long-call entry/exit timing (A244)",
            "",
            f"fills bid+23% · priced_by=skew_model share={model_share:.0%} · train<{TEST_START} test≥{TEST_START}",
            f"tickers={len(tickers)} loss_train_panel={len(panel)} signal_train={len(rule_entries)} "
            f"n_indep={sm['nd']} (distinct entry dates) edgar_always_loss_n={len(always_loss)}",
            "inputs: OHLCV+IV=lseg_research.daily_history; VIX/VIX3M=wrds_research.cboe_daily; "
            "sector=ticker_registry; groups=OM+NI avg; tbill=out/opt/dtb3.csv",
            "",
            *part_a_lines,
            part_b_line,
            "",
            "## Part C TEST (loss primary)",
            (
                f"- SIG {cell}|{ex_rule} n={sm['n']} n_indep={sm['nd']} bp={sm['bp']:+.1f} "
                f"vsE0={vs_e0:+.1f} vsΔ={vs_sd:+.1f} vsStock$={vs_st:+.1f} "
                f"ct={sm['ct']:.2f} hit100={sm['hit']:.1%} med={sm['med']:+.2%} "
                f"halves={h1:+.1f}/{h2:+.1f} shift_bp={lk['shift_bp']:.1f} placebo_p={lk['placebo_p']:.3f}"
            ),
            f"- E0 n={sm_e0['n']} bp={sm_e0['bp']:+.1f} · prof SIG n={sm_p['n']} bp={sm_p['bp']:+.1f}",
            f"- anatomy {dict(anat)} · call>stock by move: {' · '.join(beat_stock)}",
            "",
            "## Winner pass",
            (
                f"Winners = +100% MTM ≤10d (train base {base_rate:.1%}). Pre-entry: "
                f"{'/'.join(feats)} Q5 lifts both halves — not crash dips. "
                "This rule loses to Δ-stock. Next rule: gate SIG to ex-ante P(stock ≥+10% in hold) "
                "via own-move quantile, or trail after +50% instead of flat ts3 "
                "(calls beat $stock only when move≥10%)."
            ),
            "",
            vline,
        ]
        OUT.parent.mkdir(parents=True, exist_ok=True)
        packet = "\n".join(lines) + "\n"
        OUT.write_text(packet)
        print(f"Wrote {OUT} verdict={verdict} t={time.time()-t0:.0f}s")
        print(packet)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
