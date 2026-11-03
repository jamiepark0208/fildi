#!/usr/bin/env python3
"""S135 / A232 — earnings read-across: surprise transfer on V1 chain map.

Outcomes: (b) fpedats-matched IBES EPS revision (numest≥5); (c) peer iv drift post-leader
into own print, gap vs iv level + realized/implied + sub-industry control. (a) archive-only.
Holdout = last two earnings seasons in sample (fixed rule). Grade (b) on fit; holdout confirms.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s135_earnings_readacross.py
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S135.md"
MIN_ANALYSTS = 5
IV_SCALE = math.sqrt(1 / 252)

# V1 curated chains (leader → peers). Typed loosely; supplier edges included.
CHAINS: dict[str, list[str]] = {
    "META": ["NVDA", "AVGO", "ANET", "VRT", "MU", "AMD", "TSM"],
    "MSFT": ["NVDA", "AVGO", "AMZN", "GOOGL", "ORCL"],
    "GOOGL": ["META", "AMZN", "MSFT", "NVDA"],
    "AMZN": ["NVDA", "AVGO", "MSFT", "GOOGL"],
    "NVDA": ["AVGO", "TSM", "ASML", "AMAT", "LRCX", "KLAC", "MU", "MRVL", "SMCI"],
    "AVGO": ["NVDA", "TSM", "MRVL", "ANET"],
    "SMCI": ["NVDA", "DELL", "HPE", "AMZN"],
    "T": ["VZ", "TMUS"],
    "NFLX": ["DIS", "WBD", "PARA"],
    "AAPL": ["AVGO", "TSM", "QCOM", "SWKS"],
    "TSLA": ["GM", "F", "RIVN", "LCID"],
    "JPM": ["BAC", "WFC", "C", "GS", "MS"],
    "XOM": ["CVX", "COP", "EOG"],
    "UNH": ["ELV", "CI", "HUM"],
}


def earnings_season(d: date) -> tuple[int, int]:
    """US earnings-season bucket by report month (1=Jan–Feb … 4=Oct–Dec)."""
    if d.month <= 2:
        return (d.year, 1)
    if d.month <= 5:
        return (d.year, 2)
    if d.month <= 8:
        return (d.year, 3)
    return (d.year, 4)


def holdout_seasons(leader_dates: list[date]) -> set[tuple[int, int]]:
    seasons = sorted(set(earnings_season(d) for d in leader_dates))
    if len(seasons) < 2:
        return set(seasons)
    return {seasons[-2], seasons[-1]}


def load_prints(conn):
    rows = conn.execute(
        """
        SELECT ticker, report_date::date, move_pct::float8
        FROM lseg_research.earnings_moves
        WHERE report_date >= '2021-01-01' AND move_pct IS NOT NULL
        ORDER BY report_date
        """
    ).fetchall()
    sue = {}
    for t, d, s in conn.execute(
        """SELECT ticker, report_date::date, surprise_pct::float8 FROM earnings_calendar
           WHERE surprise_pct IS NOT NULL AND report_date >= '2021-01-01'"""
    ).fetchall():
        sue[(t, d)] = float(s)
    out = []
    for t, d, mv in rows:
        if t not in CHAINS:
            continue
        out.append({"t": t, "d": d, "move": float(mv), "sue": sue.get((t, d))})
    return out


def load_px_iv(conn, tickers):
    px, iv = defaultdict(dict), defaultdict(dict)
    for t, d, c, ivc in conn.execute(
        "SELECT ticker, date::date, close::float8, iv30_call::float8 FROM lseg_research.daily_history "
        "WHERE ticker = ANY(%s) AND close > 0 AND date >= '2020-01-01'",
        (tickers,),
    ):
        px[t][d] = float(c)
        if ivc and ivc > 0:
            iv[t][d] = float(ivc) / 100.0 if ivc > 3 else float(ivc)
    return px, iv


def load_gics(conn, tickers: list[str]) -> dict[str, str]:
    g = {}
    for t, sub in conn.execute(
        "SELECT ticker, gics_sub_industry FROM research_common.security_class "
        "WHERE ticker = ANY(%s) AND gics_sub_industry IS NOT NULL",
        (tickers,),
    ):
        g[str(t)] = str(sub)
    return g


def load_ibes_eps(conn) -> dict[str, list[tuple[date, date, str, float, int]]]:
    """oftic -> [(statpers, fpedats, fpi, meanest, numest), …]."""
    by_o: dict[str, list[tuple[date, date, str, float, int]]] = defaultdict(list)
    for o, sp, fp, fpi, m, n in conn.execute(
        """
        SELECT UPPER(oftic), statpers::date, fpedats::date, fpi::text, meanest::float, numest::int
        FROM wrds_research.ibes_statsum
        WHERE measure='EPS' AND fiscalp='ANN' AND fpi IN ('1','2','3')
          AND statpers >= '2020-01-01' AND meanest > 0 AND fpedats IS NOT NULL
        """
    ):
        by_o[str(o)].append((sp, fp, str(fpi), float(m), int(n or 0)))
    return by_o


def pick_fy1_fpe(points: list[tuple[date, date, str, float, int]], sp: date) -> tuple[date, float, int] | None:
    cands: list[tuple[int, int, date, float, int]] = []
    for s, fpe, fpi, mean, num in points:
        if s != sp:
            continue
        days = (fpe - sp).days
        if 335 <= days <= 750:
            rank = {"1": 0, "2": 1, "3": 2}.get(fpi, 9)
            cands.append((rank, abs(days - 545), fpe, mean, num))
    if not cands:
        return None
    cands.sort(key=lambda x: (x[0], x[1]))
    _, _, fpe, mean, num = cands[0]
    return fpe, mean, num


def meanest_num_at_fpe(
    points: list[tuple[date, date, str, float, int]], sp: date, fpe: date
) -> tuple[float, int] | None:
    for s, fp, _fpi, mean, num in points:
        if s == sp and fp == fpe and mean > 0:
            return mean, num
    return None


def peer_ibes_revision(
    points: list[tuple[date, date, str, float, int]], leader_d: date
) -> tuple[float, bool] | None:
    statpers = sorted(set(s for s, *_ in points))
    before = [s for s in statpers if s <= leader_d]
    after = [s for s in statpers if s > leader_d]
    if not before or not after:
        return None
    sp0, sp1 = before[-1], after[0]
    now = pick_fy1_fpe(points, sp1)
    if now is None:
        return None
    fpe, mean1, num1 = now
    prev = meanest_num_at_fpe(points, sp0, fpe)
    if prev is None:
        return None
    mean0, num0 = prev
    if num0 < MIN_ANALYSTS or num1 < MIN_ANALYSTS:
        return None
    rev = mean1 / mean0 - 1.0
    return rev, True


def asof_close(px, t, d, look=5):
    for i in range(look + 1):
        dd = d - timedelta(days=i)
        if dd in px.get(t, {}):
            return px[t][dd], dd
    return None, None


def ret_n(px, t, d0, n):
    days = sorted(x for x in px.get(t, {}) if x >= d0)
    if len(days) < n + 1:
        return None
    i0 = next((i for i, x in enumerate(days) if x >= d0), None)
    if i0 is None or i0 + n >= len(days):
        return None
    return px[t][days[i0 + n]] / px[t][days[i0]] - 1.0


def iv_drift_post_leader(iv, t, peer_d, leader_d) -> tuple[float | None, float | None]:
    """Iv change from after leader print to day before peer print; return (delta, iv level at end)."""
    days = sorted(x for x in iv.get(t, {}) if leader_d < x < peer_d)
    if len(days) >= 2:
        return iv[t][days[-1]] - iv[t][days[0]], iv[t][days[-1]]
    days = sorted(x for x in iv.get(t, {}) if x < peer_d)
    if len(days) < 6:
        return None, None
    if (peer_d - leader_d).days <= 7:
        return None, None
    near, far = days[-1], days[max(0, len(days) - 6)]
    if far <= leader_d:
        return iv[t][near] - iv[t][far], iv[t][near]
    return None, None


def runup20(px, t, d):
    days = sorted(x for x in px.get(t, {}) if x < d)
    if len(days) < 21:
        return None
    return px[t][days[-1]] / px[t][days[-21]] - 1.0


def realized_implied(move_abs: float, iv_end: float) -> float | None:
    if iv_end is None or iv_end <= 0:
        return None
    return move_abs / (iv_end * IV_SCALE)


def hit_rate(xs):
    if len(xs) < 30:
        return None, len(xs)
    return float(np.mean([x["hit"] for x in xs])), len(xs)


def mean_t(xs, key, min_n=30):
    if len(xs) < min_n:
        return float("nan"), float("nan"), len(xs)
    v = [x[key] for x in xs]
    m = float(np.mean(v))
    s = float(np.std(v, ddof=1)) or 1e-12
    t = m / (s / math.sqrt(len(v)))
    return m, t, len(xs)


def welch_t(a, b, key):
    if len(a) < 20 or len(b) < 20:
        return float("nan"), float("nan"), float("nan")
    va = [x[key] for x in a]
    vb = [x[key] for x in b]
    ma, mb = float(np.mean(va)), float(np.mean(vb))
    sa = float(np.var(va, ddof=1)) or 1e-12
    sb = float(np.var(vb, ddof=1)) or 1e-12
    na, nb = len(va), len(vb)
    se = math.sqrt(sa / na + sb / nb)
    t = (ma - mb) / se if se > 0 else float("nan")
    return ma - mb, t, float(np.mean([x["iv_lvl"] for x in a + b]))


def main() -> int:
    print("S135 loading…", flush=True)
    conn = connect()
    leaders = load_prints(conn)
    ho_seasons = holdout_seasons([L["d"] for L in leaders])

    chain_tickers = sorted(set(CHAINS) | {p for ps in CHAINS.values() for p in ps})
    gics = load_gics(conn, chain_tickers)
    # Industry panel: same sub-industry names in daily_history (chain names only for v1)
    industry_pool = defaultdict(list)
    for t, sub in gics.items():
        industry_pool[sub].append(t)

    px, iv = load_px_iv(conn, chain_tickers)
    ibes_by_o = load_ibes_eps(conn)
    oftic = {t: t for t in chain_tickers}
    for t, o in conn.execute(
        "SELECT ticker, COALESCE(ibes_oftic, ticker) FROM research_common.security_map WHERE ticker = ANY(%s)",
        (chain_tickers,),
    ):
        oftic[t] = str(o).upper()

    peer_moves = {
        (t, d): abs(m) / 100.0  # move_pct stored as percent
        for t, d, m in conn.execute(
            "SELECT ticker, report_date::date, move_pct::float8 FROM lseg_research.earnings_moves "
            "WHERE report_date >= '2021-01-01' AND move_pct IS NOT NULL"
        )
    }

    print(f"leaders={len(leaders)} chains={len(CHAINS)} holdout_seasons={sorted(ho_seasons)}", flush=True)

    rows_a, rows_b, rows_c = [], [], []

    def is_ho(d: date) -> bool:
        return earnings_season(d) in ho_seasons

    for L in leaders:
        peers = [p for p in CHAINS[L["t"]] if p != L["t"]]
        hot = (L["sue"] is not None and L["sue"] > 0) or (L["sue"] is None and L["move"] > 0)
        cold = (L["sue"] is not None and L["sue"] < 0) or (L["sue"] is None and L["move"] < 0)
        if not hot and not cold:
            continue
        sign = 1 if hot else -1
        chain_set = set(peers) | {L["t"]}

        for p in peers:
            r3 = ret_n(px, p, L["d"], 3)
            ru = runup20(px, p, L["d"])
            if r3 is not None:
                rows_a.append({
                    "d": L["d"], "leader": L["t"], "peer": p, "sign": sign, "r3": r3 * sign,
                    "crowd": (ru is not None and ru > 0.15),
                    "ho": is_ho(L["d"]),
                })

            o = oftic.get(p, p)
            rev_out = peer_ibes_revision(ibes_by_o.get(o, []), L["d"])
            if rev_out is not None:
                rev, _ = rev_out
                hit = (rev > 0 and sign > 0) or (rev < 0 and sign < 0)
                rows_b.append({"d": L["d"], "hit": hit, "ho": is_ho(L["d"]), "rev": rev})

            nxt = conn.execute(
                "SELECT report_date::date FROM lseg_research.earnings_moves "
                "WHERE ticker=%s AND report_date > %s ORDER BY report_date LIMIT 1",
                (p, L["d"]),
            ).fetchone()
            if not nxt:
                continue
            pd = nxt[0]
            if (pd - L["d"]).days > 60:
                continue
            dlt, iv_lvl = iv_drift_post_leader(iv, p, pd, L["d"])
            if dlt is None or iv_lvl is None or iv_lvl <= 0:
                continue
            move_abs = peer_moves.get((p, pd))
            ri = realized_implied(move_abs, iv_lvl) if move_abs is not None else None

            # Sub-industry control: non-chain names in same GICS (chain panel only)
            sub = gics.get(p)
            ind_drifts = []
            if sub:
                for t2 in industry_pool.get(sub, []):
                    if t2 in chain_set or t2 == p:
                        continue
                    n2 = conn.execute(
                        "SELECT report_date::date FROM lseg_research.earnings_moves "
                        "WHERE ticker=%s AND report_date > %s ORDER BY report_date LIMIT 1",
                        (t2, L["d"]),
                    ).fetchone()
                    if not n2 or (n2[0] - L["d"]).days > 60:
                        continue
                    d2, _ = iv_drift_post_leader(iv, t2, n2[0], L["d"])
                    if d2 is not None:
                        ind_drifts.append(d2)
            ind_mean = float(np.mean(ind_drifts)) if len(ind_drifts) >= 2 else None

            rows_c.append({
                "d": L["d"], "peer": p, "sign": sign, "iv_chg": dlt, "iv_lvl": iv_lvl,
                "iv_excess": (dlt - ind_mean) if ind_mean is not None else None,
                "ri": ri, "ho": is_ho(L["d"]),
            })

    b_fit = [x for x in rows_b if not x["ho"]]
    b_ho = [x for x in rows_b if x["ho"]]
    b_fit_hr, b_fit_n = hit_rate(b_fit)
    b_ho_hr, b_ho_n = hit_rate(b_ho)
    b_pass = (
        b_fit_hr is not None and b_fit_hr >= 0.58 and b_fit_n >= 30
        and b_ho_hr is not None and b_ho_hr >= 0.58 and b_ho_n >= 30
    )

    c_fit = [x for x in rows_c if not x["ho"]]
    c_ho = [x for x in rows_c if x["ho"]]
    c_hot_fit = [x for x in c_fit if x["sign"] > 0]
    c_cold_fit = [x for x in c_fit if x["sign"] < 0]
    c_hot_ho = [x for x in c_ho if x["sign"] > 0]
    c_cold_ho = [x for x in c_ho if x["sign"] < 0]

    gap_fit, t_fit, iv_ref_fit = welch_t(c_hot_fit, c_cold_fit, "iv_chg")
    rel_fit = (gap_fit / iv_ref_fit) if iv_ref_fit and iv_ref_fit > 0 else float("nan")
    gap_ho_confirm = float("nan")
    if len(c_hot_ho) >= 5 and len(c_cold_ho) >= 5:
        gap_ho_confirm = float(np.mean([x["iv_chg"] for x in c_hot_ho])) - float(
            np.mean([x["iv_chg"] for x in c_cold_ho])
        )

    c_pass = (
        t_fit == t_fit and abs(t_fit) >= 2.0
        and gap_fit == gap_fit
        and gap_ho_confirm == gap_ho_confirm
        and (gap_fit > 0) == (gap_ho_confirm > 0)
    )

    # Realized/implied hot vs cold (fit)
    ri_hot_fit = [x for x in c_hot_fit if x.get("ri") is not None]
    ri_cold_fit = [x for x in c_cold_fit if x.get("ri") is not None]
    ri_gap_fit, ri_t_fit, _ = welch_t(ri_hot_fit, ri_cold_fit, "ri") if ri_hot_fit and ri_cold_fit else (float("nan"), float("nan"), float("nan"))

    # Industry excess (fit)
    ex_fit = [x for x in c_fit if x.get("iv_excess") is not None]
    ex_hot = [x for x in ex_fit if x["sign"] > 0]
    ex_cold = [x for x in ex_fit if x["sign"] < 0]
    ex_gap, ex_t, _ = welch_t(ex_hot, ex_cold, "iv_excess") if ex_hot and ex_cold else (float("nan"), float("nan"), float("nan"))

    a_fit = [x for x in rows_a if not x["ho"]]
    a_ho = [x for x in rows_a if x["ho"]]
    a_fit_c = [x for x in a_fit if not x["crowd"]]
    crowd_n = sum(1 for x in rows_a if x["crowd"])

    earn = b_pass or c_pass
    ho_label = ", ".join(f"{y}S{s}" for y, s in sorted(ho_seasons))

    lines = [
        "# S135 — earnings read-across V1 chains (A232)",
        "",
        f"Chains: {len(CHAINS)} leaders. Leader prints in map: {len(leaders)}.",
        f"Holdout seasons (last 2 in sample): {ho_label}.",
        f"(b) IBES: EPS FY1, identical fpedats at consecutive monthly snapshots, numest≥{MIN_ANALYSTS}.",
        "",
        "## (a) peer +3d return × leader surprise sign (archive-only)",
        "",
    ]
    if len(a_fit) >= 30:
        m, t, n = mean_t(a_fit, "r3")
        lines.append(f"- Fit signed peer +3d: {m*1e4:+.1f} bp t={t:.2f} n={n}")
    if len(a_ho) >= 30:
        m, t, n = mean_t(a_ho, "r3")
        lines.append(f"- Holdout signed peer +3d: {m*1e4:+.1f} bp t={t:.2f} n={n}")
    if len(a_fit_c) >= 30:
        m, t, n = mean_t(a_fit_c, "r3")
        lines.append(f"- Fit excl. crowded (runup>15%): {m*1e4:+.1f} bp t={t:.2f} n={n}")
    lines.append(f"- Crowding cell n={crowd_n} ({'OK' if crowd_n >= 50 else 'underpowered <50'})")

    lines += ["", "## (b) peer IBES revision sign (fpedats-matched)", ""]
    if b_fit_hr is not None:
        lines.append(f"- Fit hit rate: {b_fit_hr:.1%} n={b_fit_n}")
    else:
        lines.append(f"- Fit: thin n={b_fit_n}")
    if b_ho_hr is not None:
        lines.append(f"- Holdout hit rate: {b_ho_hr:.1%} n={b_ho_n}")
    else:
        lines.append(f"- Holdout: thin n={b_ho_n}")

    lines += ["", "## (c) peer iv drift post-leader into own print (hot vs cold leader)", ""]
    if len(c_hot_fit) >= 20 and len(c_cold_fit) >= 20:
        mh, _, nh = mean_t(c_hot_fit, "iv_chg", min_n=20)
        mc, _, nc = mean_t(c_cold_fit, "iv_chg", min_n=20)
        lines.append(
            f"- Fit hot ivΔ {mh:+.4f} (n={nh}) vs cold {mc:+.4f} (n={nc}); "
            f"gap {gap_fit:+.4f} vol pt, rel iv {rel_fit:+.1%}, t={t_fit:.2f}"
        )
    else:
        lines.append(f"- Fit thin hot={len(c_hot_fit)} cold={len(c_cold_fit)}")
    if len(c_hot_ho) >= 5 and len(c_cold_ho) >= 5:
        mh = float(np.mean([x["iv_chg"] for x in c_hot_ho]))
        mc = float(np.mean([x["iv_chg"] for x in c_cold_ho]))
        gap_ho_r = mh - mc
        iv_ref_ho = float(np.mean([x["iv_lvl"] for x in c_hot_ho + c_cold_ho]))
        rel_ho_r = gap_ho_r / iv_ref_ho if iv_ref_ho > 0 else float("nan")
        same_sign = (gap_ho_r > 0) == (gap_fit > 0)
        lines.append(
            f"- Holdout hot {mh:+.4f} (n={len(c_hot_ho)}) vs cold {mc:+.4f} (n={len(c_cold_ho)}); "
            f"gap {gap_ho_r:+.4f}, rel iv {rel_ho_r:+.1%} (confirm same sign as fit: {same_sign})"
        )
    else:
        lines.append(f"- Holdout thin hot={len(c_hot_ho)} cold={len(c_cold_ho)}")
    if ri_hot_fit and ri_cold_fit:
        lines.append(
            f"- Fit realized/implied at peer print: hot vs cold gap {ri_gap_fit:+.2f}, t={ri_t_fit:.2f} "
            f"(|move|÷iv√(1/252))"
        )
    if ex_hot and ex_cold:
        lines.append(f"- Fit chain−subindustry iv excess: hot−cold gap {ex_gap:+.4f}, t={ex_t:.2f} (n hot/cold {len(ex_hot)}/{len(ex_cold)})")

    lines += [
        "",
        f"**Verdict: {'PASS' if earn else 'FAIL'}** — "
        f"(b) {'PASS' if b_pass else 'FAIL'} · (c) {'PASS' if c_pass else 'FAIL'} · "
        f"(a) archive-only. Study only — no S066 wire.",
        "",
        "Refs: A232",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
