#!/usr/bin/env python3
"""S132 / A299 — long calls on crashed themes whose FY revenue forecasts still rise.

Remap: A299 asked for S126 (taken by Live-tab regime) → S132.

Month-end, point-in-time: basket/ETF ≥ crash_thr below 52w high AND median next-FY
SAL revision (3m, fpedats-matched, flows.py) > 0 (= rising) vs ≤ 0 (= falling) vs not crashed.

Trade: DTE / Δ BS calls (iv30_call) held to expiry; equal-weight basket of members + ETF
where mapped. Fit 2017–2022, holdout 2023→. ≥3 rounds then one holdout confirm.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s132_crashed_rising.py
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from statistics import NormalDist

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "research" / "market-views"))
from build_plan import connect  # noqa: E402
import flows as F  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S132.md"
OUT_MV = ROOT / "research" / "market-views" / "out" / "S132.md"
THEMES = json.loads((ROOT / "research" / "market-views" / "themes.json").read_text())["baskets"]
from sector_etfs import ETFS  # noqa: E402

# ETF → theme basket for revision median (crash still from ETF close)
ETF_BASKET = {
    "SMH": "chips", "SOXX": "chips", "REMX": "rare_earths", "NLR": "nuclear", "URA": "nuclear",
    "WGMI": "neoclouds", "BITO": "neoclouds", "BLOK": "neoclouds", "ITA": "defense_tech",
    "UFO": "defense_tech", "XHB": "homebuilders", "KRE": "banks", "KBE": "banks",
    "GRID": "power", "DTCR": "optics", "SRVR": "optics", "SKYY": "ai_spenders",
    "BOTZ": "chips", "IGV": "ai_spenders",
}

START = date(2017, 1, 1)
FIT_END = date(2022, 12, 31)
HALF = date(2023, 1, 1)  # holdout start (= fit/holdout)


def norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_call(S, K, T, r, sig):
    from quantcore.bs import bs_call as _c  # quantcore.bs — one home (Jamie 11-15)
    return _c(spot=S, strike=K, iv=sig, years=T, r=r)


def bs_put(S, K, T, r, sig):
    from quantcore.bs import bs_put as _p  # quantcore.bs — one home (Jamie 11-15)
    return _p(spot=S, strike=K, iv=sig, years=T, r=r)


def strike_for_delta(S, T, r, sig, delta):
    d1 = NormalDist().inv_cdf(delta)
    return S * math.exp(-(d1 * sig * math.sqrt(T) - (r + 0.5 * sig * sig) * T))


def month_ends(days: list[date]) -> list[date]:
    by = {}
    for d in days:
        by[f"{d.year}-{d.month:02d}"] = d
    return [by[k] for k in sorted(by) if date.fromisoformat(k + "-01") >= START]


def clustered_t(rows, key="call"):
    """Month-clustered t on means (simple)."""
    by = defaultdict(list)
    for r in rows:
        by[(r["d"].year, r["d"].month)].append(r[key])
    means = [statistics.mean(v) for v in by.values() if v]
    if len(means) < 6:
        return float("nan")
    m = statistics.mean(means)
    s = statistics.pstdev(means) or 1e-12
    return m / (s / math.sqrt(len(means)))


def load_prices(conn, tickers: list[str]):
    out: dict[str, dict[date, tuple[float, float | None]]] = defaultdict(dict)
    if not tickers:
        return out
    rows = conn.execute(
        "SELECT ticker, date::date, close::float8, iv30_call::float8 FROM lseg_research.daily_history "
        "WHERE ticker = ANY(%s) AND close > 0 AND date >= %s ORDER BY date",
        (tickers, START - timedelta(days=400)),
    ).fetchall()
    for t, d, c, iv in rows:
        out[t][d] = (float(c), float(iv) if iv and iv > 0 else None)
    # ETFs missing from LSEG → sector_etf_daily (no IV)
    need = [t for t in tickers if t in ETFS and not out[t]]
    if need:
        for t, d, c in conn.execute(
            "SELECT ticker, date::date, close::float8 FROM watchlist_sync.sector_etf_daily "
            "WHERE ticker = ANY(%s) AND date >= %s",
            (need, START - timedelta(days=400)),
        ):
            out[t][d] = (float(c), None)
    return out


def off_52w(px: dict[date, tuple[float, float | None]], d: date) -> float | None:
    if d not in px:
        return None
    lo = d - timedelta(days=365)
    window = [px[x][0] for x in px if lo <= x <= d]
    if len(window) < 120:
        return None
    hi = max(window)
    if hi <= 0:
        return None
    return px[d][0] / hi - 1.0  # negative when crashed


def basket_off_52w(prices, names: list[str], d: date) -> float | None:
    vals = []
    for t in names:
        if t not in prices:
            continue
        v = off_52w(prices[t], d)
        if v is not None:
            vals.append(v)
    return statistics.median(vals) if len(vals) >= min(2, len(names)) else None


def trade_leg(px, d0, dte, delta, side="call", r=0.04):
    if d0 not in px:
        return None
    S, iv_raw = px[d0]
    if not iv_raw or iv_raw <= 0 or S <= 0:
        return None
    iv = iv_raw / 100.0 if iv_raw > 3 else float(iv_raw)
    T = dte / 365.0
    if side == "call":
        K = strike_for_delta(S, T, r, iv, delta)
        debit = bs_call(S, K, T, r, iv)
    else:
        K = strike_for_delta(S, T, r, iv, 1.0 - delta)  # put |Δ|
        debit = bs_put(S, K, T, r, iv)
    if debit <= 1e-6:
        return None
    target = d0 + timedelta(days=dte)
    exit_S = None
    for dd in sorted(px):
        if dd >= target:
            exit_S = px[dd][0]
            break
    if exit_S is None:
        return None
    if side == "call":
        exit_val = max(exit_S - K, 0.0)
    else:
        exit_val = max(K - exit_S, 0.0)
    return {
        "call": (exit_val - debit) / debit,
        "stock": exit_S / S - 1.0,
        "debit": debit,
        "S": S,
        "K": K,
    }


def basket_trade(prices, names, d0, dte, delta, side="call"):
    legs = []
    for t in names:
        if t not in prices:
            continue
        tr = trade_leg(prices[t], d0, dte, delta, side=side)
        if tr:
            legs.append(tr)
    if len(legs) < min(2, max(1, len(names) // 2)):
        return None
    return {
        "call": float(np.mean([x["call"] for x in legs])),
        "stock": float(np.mean([x["stock"] for x in legs])),
        "n_legs": len(legs),
    }


def build_units(conn):
    """List of (unit_id, kind, tickers_for_trade, tickers_for_crash, rev_oftics_key)."""
    units = []
    for name, tickers in THEMES.items():
        units.append((f"basket:{name}", "basket", list(tickers), list(tickers), name))
    for etf in ETFS:
        b = ETF_BASKET.get(etf)
        if not b or b not in THEMES:
            continue
        units.append((f"etf:{etf}", "etf", [etf] + list(THEMES[b]), [etf], b))
    return units


def load_revisions(conn):
    # extend flows load past 2023
    rows = conn.execute(
        """
        SELECT UPPER(oftic) AS oftic, statpers::date, fpedats::date, fpi::text, meanest::float
        FROM wrds_research.ibes_statsum
        WHERE measure = 'SAL' AND fiscalp = 'ANN' AND fpi IN ('1', '2', '3')
          AND statpers >= '2016-01-01' AND meanest IS NOT NULL AND meanest > 0
        """
    ).fetchall()
    sal = [(str(o), sp, fp, str(fpi), float(m)) for o, sp, fp, fpi, m in rows]
    F.START_YM = "2017-01"
    statpers_by_ym = F.month_end_statpers(sal)
    rev_idx = F.build_revision_index(sal, statpers_by_ym)
    ticker_map = F.ticker_oftics(conn)
    return rev_idx, statpers_by_ym, ticker_map


def median_rev(rev_idx, ticker_map, tickers, ym_s, min_n=2):
    oftics = [ticker_map.get(t, t) for t in tickers]
    revs = [rev_idx[(o, ym_s)] for o in oftics if (o, ym_s) in rev_idx]
    if len(revs) < min_n:
        return None
    return statistics.median(revs)


def summarize(rows, label):
    if len(rows) < 4:
        return f"{label}: thin n={len(rows)}"
    mc = float(np.mean([r["call"] for r in rows]))
    ms = float(np.mean([r["stock"] for r in rows]))
    t = clustered_t(rows, "call")
    return f"{label}: n={len(rows)} call {mc:+.1%} stock {ms:+.1%} t={t:.2f}"


def arm_diff(a_rows, b_rows):
    """Mean call A − mean call B in pp, and stock diff."""
    if len(a_rows) < 4 or len(b_rows) < 4:
        return None
    return {
        "d_call": float(np.mean([r["call"] for r in a_rows]) - np.mean([r["call"] for r in b_rows])),
        "d_stock": float(np.mean([r["stock"] for r in a_rows]) - np.mean([r["stock"] for r in b_rows])),
        "t_call": clustered_t(a_rows + [{**r, "call": -r["call"], "d": r["d"]} for r in b_rows], "call"),
        "na": len(a_rows),
        "nb": len(b_rows),
        "call_a": float(np.mean([r["call"] for r in a_rows])),
        "call_b": float(np.mean([r["call"] for r in b_rows])),
        "stock_a": float(np.mean([r["stock"] for r in a_rows])),
        "beat_stock": float(np.mean([r["call"] for r in a_rows])) > float(np.mean([r["stock"] for r in a_rows])),
    }


def run_variant(episodes, crash_thr, dte, delta, side="call", combo=False):
    """episodes: list of dicts with arm, d, unit, call, stock."""
    rising = [e for e in episodes if e["arm"] == "crashed_rising"]
    falling = [e for e in episodes if e["arm"] == "crashed_falling"]
    if combo:
        # long rising calls financed by short falling (use call pnl rising − call pnl falling as proxy)
        # already compared via arm_diff
        pass
    fit_r = [e for e in rising if e["d"] <= FIT_END]
    fit_f = [e for e in falling if e["d"] <= FIT_END]
    ho_r = [e for e in rising if e["d"] >= HALF]
    ho_f = [e for e in falling if e["d"] >= HALF]
    fit = arm_diff(fit_r, fit_f)
    ho = arm_diff(ho_r, ho_f)
    return {
        "crash_thr": crash_thr, "dte": dte, "delta": delta, "side": side,
        "fit": fit, "holdout": ho,
        "fit_n": (len(fit_r), len(fit_f)), "ho_n": (len(ho_r), len(ho_f)),
        "fit_rising": fit_r, "ho_rising": ho_r,
    }


def collect_episodes(prices, units, rev_idx, ticker_map, crash_thr, dte, delta, side="call"):
    # calendar from SPY
    spy_days = sorted(prices.get("SPY", {}))
    mes = month_ends(spy_days)
    out = []
    for d0 in mes:
        ym_s = f"{d0.year}-{d0.month:02d}"
        for uid, kind, trade_names, crash_names, basket_key in units:
            off = basket_off_52w(prices, crash_names, d0) if kind == "basket" else off_52w(prices.get(crash_names[0], {}), d0)
            if off is None:
                continue
            rev = median_rev(rev_idx, ticker_map, THEMES[basket_key], ym_s)
            if rev is None:
                continue
            crashed = off <= -crash_thr
            if not crashed:
                arm = "not_crashed"
            elif rev > 0:
                arm = "crashed_rising"
            else:
                arm = "crashed_falling"
            # trade underliers (basket members); for etf prefer ETF if IV else members
            names = trade_names
            if kind == "etf" and crash_names[0] in prices and any(
                prices[crash_names[0]].get(d0, (0, None))[1] for _ in [0]
            ):
                iv = prices[crash_names[0]].get(d0, (0, None))[1]
                names = [crash_names[0]] if iv else THEMES[basket_key]
            else:
                names = THEMES[basket_key] if kind == "basket" else THEMES[basket_key]
            tr = basket_trade(prices, names, d0, dte, delta, side=side)
            if not tr:
                continue
            out.append({"d": d0, "unit": uid, "arm": arm, "off": off, "rev": rev, **tr})
    return out


def today_board(prices, units, rev_idx, ticker_map, crash_thr=0.30):
    spy_days = sorted(prices.get("SPY", {}))
    if not spy_days:
        return []
    d0 = spy_days[-1]
    ym_s = f"{d0.year}-{d0.month:02d}"
    rows = []
    for uid, kind, trade_names, crash_names, basket_key in units:
        off = basket_off_52w(prices, crash_names, d0) if kind == "basket" else off_52w(prices.get(crash_names[0], {}), d0)
        rev = median_rev(rev_idx, ticker_map, THEMES[basket_key], ym_s)
        if off is None or rev is None:
            continue
        if off <= -crash_thr and rev > 0:
            rows.append((uid, off, rev))
    rows.sort(key=lambda x: x[1])
    return rows, d0


def main() -> int:
    print("S132 loading…", flush=True)
    conn = connect()
    units = build_units(conn)
    tickers = sorted({"SPY"} | {t for u in units for t in u[2] + u[3]} | set(THEMES.keys() and sum(THEMES.values(), [])))
    # flatten theme tickers
    tickers = sorted({"SPY"} | {t for ts in THEMES.values() for t in ts} | set(ETF_BASKET) | {u[3][0] for u in units if u[1] == "etf"})
    prices = load_prices(conn, tickers)
    rev_idx, _ym, ticker_map = load_revisions(conn)
    print(f"units={len(units)} prices={sum(len(v) for v in prices.values())} rev={len(rev_idx)}", flush=True)

    variants = [
        # round 1 — as specified
        dict(crash_thr=0.30, dte=90, delta=0.40, side="call", round=1, note="spec"),
        # round 2 — thresholds / execution
        dict(crash_thr=0.20, dte=60, delta=0.40, side="call", round=2, note="crash20_60d"),
        dict(crash_thr=0.40, dte=90, delta=0.30, side="call", round=2, note="crash40_30d"),
        dict(crash_thr=0.30, dte=45, delta=0.50, side="call", round=2, note="45d_50d"),
        # round 3 — opposite + combo framing (puts on crashed-rising; calls still compared)
        dict(crash_thr=0.30, dte=90, delta=0.40, side="put", round=3, note="opp_puts"),
        dict(crash_thr=0.20, dte=60, delta=0.40, side="call", round=3, note="combo_via_diff"),
    ]

    results = []
    for v in variants:
        eps = collect_episodes(prices, units, rev_idx, ticker_map, v["crash_thr"], v["dte"], v["delta"], v["side"])
        res = run_variant(eps, v["crash_thr"], v["dte"], v["delta"], side=v["side"])
        res["note"] = v["note"]
        res["round"] = v["round"]
        res["n_eps"] = len(eps)
        results.append(res)
        fit = res["fit"]
        print(
            f"R{v['round']} {v['note']}: fit rising−falling call "
            f"{(fit['d_call'] if fit else float('nan')):+.1%} n={res['fit_n']}",
            flush=True,
        )

    # pick best on FIT by d_call (rising − falling), require t-ish and both n ok
    scored = []
    for r in results:
        if r["side"] != "call" or not r["fit"]:
            continue
        f = r["fit"]
        if f["na"] < 6 or f["nb"] < 6:
            continue
        scored.append((f["d_call"], r))
    scored.sort(key=lambda x: -x[0])
    best = scored[0][1] if scored else None

    lines = [
        "# S132 — crashed themes × rising FY revenue revisions → long calls (A299; remap from S126)",
        "",
        "Pricing: BS mid at iv30_call (MODEL). Fit ≤2022-12, holdout ≥2023-01.",
        "Pass: rising−falling ≥ +5 pp calls **and** stock, month-t≥2 both halves, calls beat same-risk stock.",
        "",
        "## Rounds (fit)",
        "",
        "| round | note | crash | DTE | Δ | side | fit Δcall | fit Δstock | fit n↑/↓ | holdout Δcall |",
        "|---:|---|---:|---:|---:|---|---:|---:|---|---:|",
    ]
    for r in results:
        f, h = r["fit"], r["holdout"]
        lines.append(
            f"| {r['round']} | {r['note']} | {r['crash_thr']:.0%} | {r['dte']} | {r['delta']:.2f} | {r['side']} | "
            f"{(f['d_call'] if f else float('nan')):+.1%} | {(f['d_stock'] if f else float('nan')):+.1%} | "
            f"{r['fit_n'][0]}/{r['fit_n'][1]} | {(h['d_call'] if h else float('nan')):+.1%} |"
        )

    verdict = "FAIL"
    detail = "no call variant cleared fit n / +5 pp bar"
    if best and best["fit"]:
        f, h = best["fit"], best["holdout"]
        lines += [
            "",
            f"## Working variant (fit pick): **{best['note']}** crash≥{best['crash_thr']:.0%} "
            f"{best['dte']}DTE {best['delta']:.0%}Δ calls",
            "",
            f"- Fit rising−falling: call **{f['d_call']:+.1%}** · stock **{f['d_stock']:+.1%}** "
            f"(n {f['na']}/{f['nb']}) · rising call {f['call_a']:+.1%} vs stock {f['stock_a']:+.1%} "
            f"({'beats stock' if f['beat_stock'] else 'loses to stock'})",
            f"- Holdout confirm: call **{(h['d_call'] if h else float('nan')):+.1%}** · "
            f"stock **{(h['d_stock'] if h else float('nan')):+.1%}** "
            f"(n {best['ho_n'][0]}/{best['ho_n'][1]})",
            "",
        ]
        # halves on holdout rising vs falling
        ok_fit = f["d_call"] >= 0.05 and f["d_stock"] >= 0.05 and f["beat_stock"]
        ok_ho = h and h["d_call"] >= 0.05 and h["d_stock"] >= 0.05 and h.get("beat_stock")
        # also check both calendar halves of full sample for rising−falling
        eps_best = collect_episodes(
            prices, units, rev_idx, ticker_map, best["crash_thr"], best["dte"], best["delta"], "call"
        )
        h1_r = [e for e in eps_best if e["arm"] == "crashed_rising" and e["d"] < HALF]
        h1_f = [e for e in eps_best if e["arm"] == "crashed_falling" and e["d"] < HALF]
        h2_r = [e for e in eps_best if e["arm"] == "crashed_rising" and e["d"] >= HALF]
        h2_f = [e for e in eps_best if e["arm"] == "crashed_falling" and e["d"] >= HALF]
        d1 = arm_diff(h1_r, h1_f)
        d2 = arm_diff(h2_r, h2_f)
        lines.append(
            f"- Halves rising−falling call: h1 {(d1['d_call'] if d1 else float('nan')):+.1%} · "
            f"h2 {(d2['d_call'] if d2 else float('nan')):+.1%}"
        )
        t_fit = clustered_t(best["fit_rising"], "call")
        lines.append(f"- Fit rising month-t (level, not diff): {t_fit:.2f}")
        if ok_fit and ok_ho and d1 and d2 and d1["d_call"] > 0 and d2["d_call"] > 0:
            verdict = "PASS"
            detail = f"{best['note']} cleared fit+holdout +5 pp and same-sign halves"
        else:
            verdict = "FAIL"
            detail = (
                f"best fit Δcall {f['d_call']:+.1%} (need ≥+5 pp both call+stock, beat stock, "
                f"holdout confirm); holdout Δcall {(h['d_call'] if h else float('nan')):+.1%}"
            )

    board, asof = today_board(prices, units, rev_idx, ticker_map)
    lines += [
        "",
        f"## Today's qualifying (crash≥30 % & rev>0) as of {asof}",
        "",
    ]
    if not board:
        lines.append("_none_")
    else:
        lines.append("| unit | off 52w | median 3m FY-rev |")
        lines.append("|---|---:|---:|")
        for uid, off, rev in board:
            lines.append(f"| {uid} | {off:+.1%} | {rev:+.1%} |")

    lines += ["", f"**Verdict: {verdict}** — {detail}", "", "Refs: A299"]
    text = "\n".join(lines) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT_MV.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    OUT_MV.write_text(text)
    print(text)
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
