#!/usr/bin/env python3
"""A310 — Alpaca wheel strike score vs Robinhood yield vs Fildi band engine on S088 put candidates.

Public baseline (alpacahq/options-wheel): score = (1 − |Δ|) × 250/(DTE+5) × bid/strike, pick max in 0.05–0.30Δ.
Robinhood screener analogue: max weekly yield (credit/K/h) with Δ ≤ 0.15.
Fildi: band_engine table fit ≤ 2022, choose(market×name), panic → no trade (strategy_engine).
Also fixed 0.11Δ nearest strike.

Rows: ~/.fildi/cache/s101_rows.pkl (S088 1-week puts, S076 pricer, real-fill haircut hc).
Pass (Fildi): engine ≥ Alpaca on P&L with |week-cluster t(c−a)| ≥ 2, or equal P&L with lower worst-5% week.

  cd scripts/watchlist_sync && .venv/bin/python analysis/a310_wheel_baseline.py
"""
from __future__ import annotations

import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import band_engine as BE  # noqa: E402
from build_plan import connect  # noqa: E402
from s088_sr_zones import week_t  # noqa: E402

CACHE = BE.CACHE
SPLIT = BE.SPLIT
OUT = HERE.parent / "out" / "opt" / "A310-packet.md"
FIXED_DLT = 0.11


def dte_days(r):
    return max(5, 7 * r["h"])


def alpaca_score(r):
    d = dte_days(r)
    return (1 - abs(r["dlt"])) * 250 / (d + 5) * (r["credit"] / r["K"])


def pick_alpaca(rs):
    pool = [r for r in rs if 0.05 <= r["dlt"] < 0.30]
    return max(pool, key=alpaca_score) if pool else None


def pick_robinhood(rs):
    pool = [r for r in rs if r["dlt"] <= 0.15]
    return max(pool, key=lambda r: r["inc"]) if pool else None


def pick_fixed(rs, target=FIXED_DLT):
    return min(rs, key=lambda r: abs(r["dlt"] - target)) if rs else None


def make_fildi_rule(table):
    fl = BE.FLOORS["standard"]

    def rule(row):
        if BE.market_state(row) == "panic":
            return None
        return BE.choose(table, BE.market_state(row), BE.name_state(row), fl)

    return rule


def pick_custom(rows, pick_fn):
    by = defaultdict(list)
    for r in rows:
        by[(r["t"], r["d"])].append(r)
    out = []
    for rs in by.values():
        c = pick_fn(rs)
        if c:
            out.append(c)
    return out


def breach_stats(rs):
    if not rs:
        return float("nan"), 0
    br = 1.0 - float(np.mean([r["kept"] for r in rs]))
    return br, len(rs)


def half_stats(rs, weeks):
    if not rs:
        return {"bp": float("nan"), "w5": float("nan"), "breach": float("nan"), "n": 0}
    s = BE.summary(rs, weeks)
    br, _ = breach_stats(rs)
    return {"bp": s["book_bp"], "w5": s["book_w5"], "breach": br, "n": s["n"], "trade_bp": s["bp"]}


def week_diff(a_series, b_series, weeks):
    return [a_series.get(d, 0.0) - b_series.get(d, 0.0) for d in weeks]


def main():
    rows = [r for r in pickle.loads(CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
        BE.add_breadth(c, rows)
    tr = [r for r in rows if r["d"] < SPLIT]
    table = BE.fit(tr)
    fildi_rule = make_fildi_rule(table)

    strategies = {
        "(a) Alpaca score 0.05–0.30Δ": lambda rs: pick_alpaca(rs),
        "(b) Robinhood max yield Δ≤0.15": lambda rs: pick_robinhood(rs),
        "(c) Fildi band engine": None,
        "(d) fixed 0.11Δ": lambda rs: pick_fixed(rs),
    }

    picked = {}
    for name, fn in strategies.items():
        if fn is None:
            picked[name] = BE.pick_rows(rows, fildi_rule)
        else:
            picked[name] = pick_custom(rows, fn)

    all_weeks = sorted({r["d"] for r in rows})
    h1_weeks = [d for d in all_weeks if d < SPLIT]
    h2_weeks = [d for d in all_weeks if d >= SPLIT]

    te_weeks = sorted({r["d"] for r in rows if r["d"] >= SPLIT})

    def report(rs):
        full = half_stats(rs, all_weeks)
        h1 = half_stats([r for r in rs if r["d"] < SPLIT], h1_weeks)
        h2 = half_stats([r for r in rs if r["d"] >= SPLIT], h2_weeks)
        return full, h1, h2

    results = {k: report(v) for k, v in picked.items()}

    te_rows_a = [r for r in picked["(a) Alpaca score 0.05–0.30Δ"] if r["d"] >= SPLIT]
    te_rows_c = [r for r in picked["(c) Fildi band engine"] if r["d"] >= SPLIT]
    sa_te = BE.summary(te_rows_a, te_weeks)
    sc_te = BE.summary(te_rows_c, te_weeks)
    dif = week_diff(sc_te["series"], sa_te["series"], te_weeks)
    t_ca = week_t(dif)

    c_full, c_h1, c_h2 = results["(c) Fildi band engine"]
    a_full, a_h1, a_h2 = results["(a) Alpaca score 0.05–0.30Δ"]

    pass_pnl = sc_te["book_bp"] >= sa_te["book_bp"] and abs(t_ca) >= 2
    pass_tail = abs(sc_te["book_bp"] - sa_te["book_bp"]) < 0.5 and sc_te["book_w5"] > sa_te["book_w5"]
    verdict = "PASS" if (pass_pnl or pass_tail) else "FAIL"

    # Where Alpaca wins if FAIL
    regime_note = ""
    if verdict == "FAIL":
        by_ms = defaultdict(lambda: {"a": [], "c": []})
        for r in picked["(a) Alpaca score 0.05–0.30Δ"]:
            by_ms[BE.market_state(r)]["a"].append(r["hc"])
        for r in picked["(c) Fildi band engine"]:
            by_ms[BE.market_state(r)]["c"].append(r["hc"])
        gaps = []
        for ms, v in sorted(by_ms.items()):
            if len(v["a"]) >= 100 and len(v["c"]) >= 100:
                gaps.append((ms, (np.mean(v["c"]) - np.mean(v["a"])) * 1e4))
        worst = min(gaps, key=lambda x: x[1]) if gaps else None
        best = max(gaps, key=lambda x: x[1]) if gaps else None
        if worst:
            regime_note = f"Alpaca leads most in {worst[0]} ({worst[1]:+.0f} bp/trade); Fildi best in {best[0]} ({best[1]:+.0f})" if best else ""

    L = [
        f"# A310 packet — wheel baseline vs Fildi engine ({date.today()})",
        "",
        f"Data: {len(rows):,} S088 1-wk put candidates ({len(tr):,} fit ≤2022); one pick per name-week; P&L = real-fill hc (bp/collateral-wk).",
        "",
    ]
    for name in strategies:
        full, h1, h2 = results[name]
        L.append(
            f"{name}: all {full['bp']:+.1f} bp/wk · w5 {full['w5']:+.0f} · breach {full['breach']:.1%} (n={full['n']:,}) · "
            f"H1 {h1['bp']:+.1f}/w5 {h1['w5']:+.0f} · H2 {h2['bp']:+.1f}/w5 {h2['w5']:+.0f}."
        )
    L += [
        "",
        f"Primary (2023→): (c)−(a) book bp {sc_te['book_bp'] - sa_te['book_bp']:+.1f} · week-cluster t {t_ca:+.1f} "
        f"(H1 {c_h1['bp'] - a_h1['bp']:+.1f} · H2 {c_h2['bp'] - a_h2['bp']:+.1f}).",
        "Pass: holdout (c)≥(a) P&L with |t|≥2, or ~equal P&L with lower worst-5% week.",
        f"**Verdict: {verdict}** — holdout engine {sc_te['book_bp']:+.1f} vs Alpaca {sa_te['book_bp']:+.1f} bp/wk; t={t_ca:+.1f}; "
        f"w5 {sc_te['book_w5']:+.0f} vs {sa_te['book_w5']:+.0f}.",
    ]
    if regime_note:
        L.append(regime_note)
    if verdict == "FAIL":
        b_full = results["(b) Robinhood max yield Δ≤0.15"][0]
        d_full = results["(d) fixed 0.11Δ"][0]
        L.append(f"Refs: Robinhood {b_full['bp']:+.1f} bp · fixed 0.11Δ {d_full['bp']:+.1f} bp (same pool).")

    text = "\n".join(L) + "\n"
    OUT.write_text(text)
    print(text)
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
