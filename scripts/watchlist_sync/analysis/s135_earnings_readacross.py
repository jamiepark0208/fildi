#!/usr/bin/env python3
"""S135 / A232 — earnings read-across: surprise transfer on V1 chain map.

Outcomes (binding): (b) peer IBES revision sign after leader print; (c) peer pre-print
iv30 drift vs own unconditional + same-chain vs other-industry. (a) reported archive-only.
Crowding split: 20d run-up. Holdout = last 2 calendar years of prints.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s135_earnings_readacross.py
"""
from __future__ import annotations

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
HOLD_OUT_FROM = date(2025, 1, 1)

# V1 curated chains (leader → peers). Typed loosely; supplier edges included.
CHAINS: dict[str, list[str]] = {
    "META": ["NVDA", "AVGO", "ANET", "VRT", "MU", "AMD", "TSM"],
    "MSFT": ["NVDA", "AVGO", "AMZN", "GOOGL", "ORCL"],
    "GOOGL": ["META", "AMZN", "MSFT", "NVDA"],
    "AMZN": ["NVDA", "AVGO", "MSFT", "GOOGL"],  # self-skip later
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


def load_prints(conn):
    """Leader events with surprise from earnings_moves / calendar."""
    rows = conn.execute(
        """
        SELECT ticker, report_date::date, move_pct::float8
        FROM lseg_research.earnings_moves
        WHERE report_date >= '2021-01-01' AND move_pct IS NOT NULL
        ORDER BY report_date
        """
    ).fetchall()
    # surprise from calendar when available
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


def asof_close(px, t, d, look=5):
    for i in range(look + 1):
        dd = d - timedelta(days=i)
        if dd in px.get(t, {}):
            return px[t][dd], dd
    return None, None


def ret_n(px, t, d0, n):
    s0, _ = asof_close(px, t, d0)
    s1, _ = asof_close(px, t, d0 + timedelta(days=n + 3))  # calendar slack
    if not s0 or not s1:
        return None
    # find nth trading day ahead roughly by scanning
    days = sorted(x for x in px[t] if x >= d0)
    if len(days) < n + 1:
        return None
    # index of d0-ish
    i0 = next((i for i, x in enumerate(days) if x >= d0), None)
    if i0 is None or i0 + n >= len(days):
        return None
    return px[t][days[i0 + n]] / px[t][days[i0]] - 1.0


def iv_change(iv, t, d, look=5):
    """iv at d-1 minus iv at d-6 (pre-print drift into the peer's print)."""
    days = sorted(x for x in iv.get(t, {}) if x < d)
    if len(days) < 10:
        return None
    near, far = days[-1], days[max(0, len(days) - 6)]
    return iv[t][near] - iv[t][far]


def runup20(px, t, d):
    days = sorted(x for x in px.get(t, {}) if x < d)
    if len(days) < 21:
        return None
    return px[t][days[-1]] / px[t][days[-21]] - 1.0


def main() -> int:
    print("S135 loading…", flush=True)
    conn = connect()
    leaders = load_prints(conn)
    tickers = sorted(set(CHAINS) | {p for ps in CHAINS.values() for p in ps})
    px, iv = load_px_iv(conn, tickers)
    # IBES monthly meanest for (b) — SAL or EPS; use EPS meanest change
    ibes = defaultdict(dict)  # oftic -> ym -> meanest
    for o, sp, m in conn.execute(
        """SELECT UPPER(oftic), date_trunc('month', statpers)::date, meanest::float
           FROM wrds_research.ibes_statsum
           WHERE measure='EPS' AND fiscalp='ANN' AND fpi='1' AND meanest > 0
             AND statpers >= '2020-01-01'"""
    ):
        ibes[str(o)][sp.date() if hasattr(sp, "date") else sp] = float(m)
    # ticker→oftic
    oftic = {t: t for t in tickers}
    for t, o in conn.execute(
        "SELECT ticker, COALESCE(ibes_oftic, ticker) FROM research_common.security_map WHERE ticker = ANY(%s)",
        (tickers,),
    ):
        oftic[t] = str(o).upper()

    print(f"leaders={len(leaders)} chains={len(CHAINS)}", flush=True)

    rows_a, rows_b, rows_c = [], [], []
    for L in leaders:
        peers = [p for p in CHAINS[L["t"]] if p != L["t"]]
        hot = (L["sue"] is not None and L["sue"] > 0) or (L["sue"] is None and L["move"] > 0)
        cold = (L["sue"] is not None and L["sue"] < 0) or (L["sue"] is None and L["move"] < 0)
        if not hot and not cold:
            continue
        sign = 1 if hot else -1
        for p in peers:
            # (a) peer +3d return
            r3 = ret_n(px, p, L["d"], 3)
            ru = runup20(px, p, L["d"])
            if r3 is not None:
                rows_a.append({
                    "d": L["d"], "leader": L["t"], "peer": p, "sign": sign, "r3": r3 * sign,  # signed with surprise
                    "raw": r3, "crowd": (ru is not None and ru > 0.15),
                    "ho": L["d"] >= HOLD_OUT_FROM,
                })
            # (b) IBES revision next month vs prior
            o = oftic.get(p, p)
            months = sorted(ibes.get(o, {}))
            # first month-end strictly after leader print
            after = [m for m in months if m > L["d"]]
            before = [m for m in months if m <= L["d"]]
            if after and before:
                m1, m0 = after[0], before[-1]
                if ibes[o][m0] > 0:
                    rev = ibes[o][m1] / ibes[o][m0] - 1.0
                    hit = (rev > 0 and sign > 0) or (rev < 0 and sign < 0)
                    rows_b.append({"d": L["d"], "hit": hit, "ho": L["d"] >= HOLD_OUT_FROM, "rev": rev})
            # (c) peer's next print after leader — iv drift into that print
            # find peer's next earnings_moves date
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
            dlt = iv_change(iv, p, pd)
            if dlt is None:
                continue
            rows_c.append({
                "d": L["d"], "peer": p, "sign": sign, "iv_chg": dlt, "ho": L["d"] >= HOLD_OUT_FROM,
                "crowd": (ru is not None and ru > 0.15) if ru is not None else False,
            })

    def hit_rate(xs):
        if len(xs) < 30:
            return None, len(xs)
        return float(np.mean([x["hit"] for x in xs])), len(xs)

    def mean_t(xs, key):
        if len(xs) < 30:
            return float("nan"), len(xs)
        v = [x[key] for x in xs]
        m = float(np.mean(v))
        s = float(np.std(v)) or 1e-12
        t = m / (s / np.sqrt(len(v)))
        return m, t, len(xs)

    # (a)
    a_fit = [x for x in rows_a if not x["ho"]]
    a_ho = [x for x in rows_a if x["ho"]]
    a_fit_c = [x for x in a_fit if not x["crowd"]]
    # (b)
    b_all, b_ho = hit_rate(rows_b), hit_rate([x for x in rows_b if x["ho"]])
    # (c) hot vs cold iv change
    c_hot = [x for x in rows_c if x["sign"] > 0]
    c_cold = [x for x in rows_c if x["sign"] < 0]
    c_hot_ho = [x for x in c_hot if x["ho"]]
    c_cold_ho = [x for x in c_cold if x["ho"]]

    lines = [
        "# S135 — earnings read-across V1 chains (A232)",
        "",
        f"Chains: {len(CHAINS)} leaders. Leader prints in map: {len(leaders)}.",
        f"Holdout prints ≥ {HOLD_OUT_FROM}.",
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
    crowd_n = sum(1 for x in rows_a if x["crowd"])
    lines.append(f"- Crowding cell n={crowd_n} ({'OK' if crowd_n >= 50 else 'underpowered <50'})")

    lines += ["", "## (b) peer IBES EPS revision sign after leader (monthly snapshot)", ""]
    hr, n = b_all
    lines.append(f"- Full hit rate: {hr:.1%} n={n}" if hr is not None else f"- Full: thin n={n}")
    hr, n = b_ho
    lines.append(f"- Holdout hit rate: {hr:.1%} n={n}" if hr is not None else f"- Holdout: thin n={n}")
    b_pass = hr is not None and hr >= 0.58 and n >= 30

    lines += ["", "## (c) peer pre-own-print iv30 change after hot vs cold leader", ""]
    if len(c_hot) >= 30 and len(c_cold) >= 30:
        mh, th, nh = mean_t(c_hot, "iv_chg")
        mc, tc, nc = mean_t(c_cold, "iv_chg")
        base = float(np.mean([abs(x["iv_chg"]) for x in rows_c])) or 1e-12
        rel = (mh - mc) / base
        lines.append(f"- Fit hot ivΔ {mh:+.4f} (n={nh}) vs cold {mc:+.4f} (n={nc}); rel Δ {rel:+.1%}")
    else:
        rel = float("nan")
        lines.append(f"- Fit thin hot={len(c_hot)} cold={len(c_cold)}")
    if len(c_hot_ho) >= 20 and len(c_cold_ho) >= 20:
        mh, _, nh = mean_t(c_hot_ho, "iv_chg")
        mc, _, nc = mean_t(c_cold_ho, "iv_chg")
        base = float(np.mean([abs(x["iv_chg"]) for x in rows_c if x["ho"]])) or 1e-12
        rel_ho = (mh - mc) / base
        lines.append(f"- Holdout hot {mh:+.4f} (n={nh}) vs cold {mc:+.4f} (n={nc}); rel Δ {rel_ho:+.1%}")
    else:
        rel_ho = float("nan")
        lines.append(f"- Holdout thin hot={len(c_hot_ho)} cold={len(c_cold_ho)}")
    c_pass = rel_ho == rel_ho and abs(rel_ho) >= 0.10 and (
        (rel_ho > 0)  # hot → higher iv into peer print
    )

    earn = b_pass or c_pass
    lines += [
        "",
        f"**Verdict: {'PASS' if earn else 'FAIL'}** — "
        f"(b) {'PASS' if b_pass else 'FAIL'} · (c) {'PASS' if c_pass else 'FAIL'} · "
        f"(a) archive-only. "
        + ("Earns build (modulate S066/S069)." if earn else "Archive; no chain feature."),
        "",
        "Refs: A232",
    ]
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
