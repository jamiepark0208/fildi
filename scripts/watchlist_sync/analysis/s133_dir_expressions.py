#!/usr/bin/env python3
"""S133 / A244 — express S081 dir×price bull signal as short-put / RR / financed-call (not long-only).

Remap: A244 asked for s127_dir_expressions / S127 (taken by earnings direction) → **S133**.

Arms (Monday entries, hold to expiry, S076/S081 pricing + SCEN stress):
  (1) short 0.30Δ put ~30 DTE
  (2) risk reversal: sell 0.30Δ put + buy 0.30Δ call (same DTE)
  (3) call financed 50% by short put (buy 0.40Δ 45 DTE call; sell puts until credit ≥ 50% debit)
  (4) 2-feature rule (fit 2021–23): iv_rank AND prox_52w both in bottom tercile → same short-put expression

Pass: beats equal-vol stock per $ risked both eras (2021–23 / 2024–25), month-block t ≥ 2,
survives +25% call-cost stress (SCEN rich). No product ship on FAIL.

    cd scripts/watchlist_sync && .venv/bin/python -u analysis/s133_dir_expressions.py [--smoke]
"""
from __future__ import annotations

import math
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402
from s080_long_options import SCEN  # noqa: E402
from s076_structures_backtest import Pricer, fill, strike_for  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S133.md"
START = date(2021, 2, 1)
FIT_END = date(2023, 12, 31)
HO_START = date(2024, 1, 1)
HO_END = date(2025, 12, 31)
PUT_DTE, PUT_D = 30, 0.30
CALL_DTE, CALL_D = 45, 0.40
IV_RANK_MAX = 0.50  # S081


def boot_t(xs, key="pnl", n=400):
    by = defaultdict(list)
    for x in xs:
        by[(x["d"].year, x["d"].month)].append(x[key])
    ks = list(by)
    if len(ks) < 6:
        return float("nan")
    rng = np.random.default_rng(133)
    agg = {k: (math.fsum(v), len(v)) for k, v in by.items()}

    def mean(sel):
        s = c = 0
        for k in sel:
            a, b = agg[k]
            s += a
            c += b
        return s / c if c else 0.0

    m0 = mean(ks)
    draws = []
    for _ in range(n):
        sel = [ks[i] for i in rng.integers(0, len(ks), len(ks))]
        draws.append(mean(sel))
    sd = statistics.pstdev(draws) or 1e-12
    return m0 / sd


def era(xs, a, b):
    return [x for x in xs if a <= x["d"] <= b]


def prox_52w(c, i):
    w = c[max(0, i - 251): i + 1]
    hi = float(np.max(w))
    return c[i] / hi - 1.0 if hi > 0 else float("nan")


def build(conn, smoke=False):
    px, rep, tb, tech_hi = S80.load(conn, max_names=40 if smoke else None)
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    rows_out = []

    # collect cross-section features for tercile rule (fit window only, point-in-time by Monday)
    # We compute terciles within each Monday cross-section using prior-fit distribution frozen after FIT_END.
    feat_fit = []  # (d, t, iv_rank, prox) on Mondays in fit for bull-eligible names

    for t, rows in sorted(px.items()):
        if t in ("SPY", "QQQ", "IWM"):
            continue
        dates = [r[0] for r in rows]
        c, lr, ma50, ma200, rv20, z5, vol20, vol60 = S80.features(rows)
        irc = S80.iv_rank([r[3] for r in rows])
        earn = rep.get(t, [])
        n = len(rows)
        for i in range(252, n):
            d, S, ivp, ivc = rows[i][0], rows[i][1], rows[i][2], rows[i][3]
            if d < START or d > HO_END or not ivp or not ivc:
                continue
            if d.weekday() != 0:  # Mondays only
                continue
            if np.isnan(rv20[i]) or np.isnan(ma200[i]) or np.isnan(irc[i]):
                continue
            e_put = d + timedelta(days=PUT_DTE)
            e_call = d + timedelta(days=CALL_DTE)
            if any(d < x <= e_call for x in earn):
                continue
            mon = d - timedelta(days=d.weekday())
            th = tech_hi.get((t, mon))
            up_struct = bool(ma50[i] > ma200[i])
            dir_bull = up_struct and bool(th)
            pf_call = (ivc <= rv20[i]) and irc[i] < IV_RANK_MAX
            signal = dir_bull and pf_call
            prox = prox_52w(c, i)
            if d <= FIT_END and signal and prox == prox:
                feat_fit.append((d, t, float(irc[i]), float(prox)))

            if not signal and d <= FIT_END:
                # still need non-signal for? no — only trade on signal / rule
                pass

            je_p = bisect_right(dates, e_put) - 1
            je_c = bisect_right(dates, e_call) - 1
            if je_p <= i or je_c <= i:
                continue
            Se_p, Se_c = rows[je_p][1], rows[je_c][1]
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            days_p = (dates[je_p] - d).days
            days_c = (dates[je_c] - d).days
            stock = Se_c / S - 1.0  # hold ~call window for comparator

            # --- arm helpers ---
            def put_credit(delta, dte, scen="base"):
                K = strike_for(S, ivp, dte / 365, delta, "put")
                m, spr = pricer.mid("put", S, K, ivp, dte, d, scen)
                cr = fill(m, spr, -1)  # sell
                return K, cr, spr

            def call_debit(delta, dte, scen="base"):
                K = strike_for(S, ivc, dte / 365, delta, "call")
                m, spr = pricer.mid("call", S, K, ivc, dte, d, scen)
                deb = fill(m, spr, 1)
                return K, deb, spr

            base = {
                "t": t, "d": d, "S": S, "signal": signal, "iv_rank": float(irc[i]), "prox": float(prox),
                "rv": float(rv20[i]), "stock": stock, "r_tb": r_tb, "days_c": days_c,
            }

            # (1) short put
            try:
                Kp, cr, _ = put_credit(PUT_D, PUT_DTE, "base")
                if cr > 0.05:
                    exit_p = max(Kp - Se_p, 0.0)
                    pnl_cred = (cr - exit_p) / cr - r_tb * days_p / 365
                    pnl_coll = (cr - exit_p) / Kp - r_tb * days_p / 365
                    # Equal-vol (S081): scale stock UP by iv/rv so cash stock matches option risk.
                    # Short-put pnl is per $ collateral; stock_eq = stock * (ivp/rv).
                    lev = (ivp / rv20[i]) if rv20[i] > 0 else 1.0
                    stock_eq = stock * lev
                    rows_out.append({
                        **base, "arm": "short_put", "pnl": pnl_coll, "pnl_cred": pnl_cred,
                        "stock_cmp": stock_eq, "rich": None, "Kp": Kp, "cr": cr,
                    })
                    # stress: richer puts (seller gets less credit)
                    pnl_rich = (cr * 0.80 - exit_p) / Kp - r_tb * days_p / 365
                    rows_out[-1]["rich"] = pnl_rich
            except Exception:
                pass

            # (2) risk reversal
            try:
                Kp, cr, _ = put_credit(PUT_D, PUT_DTE, "base")
                Kc, deb, _ = call_debit(PUT_D, PUT_DTE, "base")
                if cr > 0.05 and deb > 0.05:
                    exit_p = max(Kp - Se_p, 0.0)
                    exit_c = max(Se_p - Kc, 0.0)  # same expiry window
                    # Capital = put collateral (same as short-put book); RR is an overlay on CSP.
                    risked = Kp
                    pnl = (cr - exit_p + exit_c - deb) / risked - r_tb * days_p / 365
                    lev = (ivc / rv20[i]) if rv20[i] > 0 else 1.0
                    stock_eq = stock * lev
                    _, deb_r, _ = call_debit(PUT_D, PUT_DTE, "rich")
                    pnl_r = (cr - exit_p + exit_c - deb_r) / risked - r_tb * days_p / 365
                    rows_out.append({
                        **base, "arm": "risk_rev", "pnl": pnl, "pnl_cred": pnl,
                        "stock_cmp": stock_eq, "rich": pnl_r, "Kp": Kp, "cr": cr,
                    })
            except Exception:
                pass

            # (3) financed call 50%
            try:
                Kc, deb, _ = call_debit(CALL_D, CALL_DTE, "base")
                Kp, cr, _ = put_credit(PUT_D, PUT_DTE, "base")
                if deb > 0.05 and cr > 0.05:
                    # sell enough put notional so credit ≥ 0.5 * debit (1:1 contracts here; scale put qty)
                    qty_p = max(0.5 * deb / cr, 0.5)
                    net_debit = deb - qty_p * cr
                    if net_debit <= 0:
                        net_debit = 0.05 * deb  # still mark a floor
                    exit_c = max(Se_c - Kc, 0.0)
                    exit_p = max(Kp - Se_p, 0.0)  # put may expire earlier — use put exit date price
                    # align put exit to put expiry already
                    pnl = (exit_c - deb + qty_p * (cr - exit_p)) / net_debit - r_tb * days_c / 365
                    lev = (ivc / rv20[i]) if rv20[i] > 0 else 1.0
                    stock_eq = stock * lev
                    _, deb_r, _ = call_debit(CALL_D, CALL_DTE, "rich")
                    net_r = max(deb_r - qty_p * cr, 0.05 * deb_r)
                    pnl_r = (exit_c - deb_r + qty_p * (cr - exit_p)) / net_r - r_tb * days_c / 365
                    rows_out.append({
                        **base, "arm": "financed_call", "pnl": pnl, "pnl_cred": pnl,
                        "stock_cmp": stock_eq, "rich": pnl_r, "Kp": Kp, "cr": cr,
                    })
            except Exception:
                pass

            rows_out.append({
                **base, "arm": "meta", "pnl": 0.0, "stock_cmp": stock, "rich": None,
            })

    # freeze tercile cuts from fit Mondays with S081 signal
    if feat_fit:
        ivs = [x[2] for x in feat_fit]
        pxs = [x[3] for x in feat_fit]
        iv_cut = float(np.quantile(ivs, 1 / 3))
        px_cut = float(np.quantile(pxs, 1 / 3))
    else:
        iv_cut = px_cut = float("nan")

    # rebuild short_put rows tagged with rule2
    for x in rows_out:
        if x["arm"] != "short_put":
            continue
        x["rule2"] = bool(
            x["iv_rank"] == x["iv_rank"] and x["prox"] == x["prox"]
            and x["iv_rank"] <= iv_cut and x["prox"] <= px_cut
        )

    return rows_out, iv_cut, px_cut, pricer


def summarize(xs, label):
    if len(xs) < 8:
        return f"| {label} | {len(xs)} | thin | | | | |"
    pnls = [x["pnl"] for x in xs]
    stocks = [x["stock_cmp"] for x in xs]
    t = boot_t(xs, "pnl")
    beat = float(np.mean(pnls)) > float(np.mean(stocks))
    rich = [x["rich"] for x in xs if x.get("rich") is not None]
    rich_ok = (float(np.mean(rich)) > 0) if rich else False
    return (
        f"| {label} | {len(xs)} | {float(np.mean(pnls)):+.1%} | {float(np.mean(stocks)):+.1%} | "
        f"{t:.2f} | {'Y' if beat else 'N'} | {'Y' if rich_ok else 'N'} |"
    ), float(np.mean(pnls)), float(np.mean(stocks)), t, beat, rich_ok, len(xs)


def main() -> int:
    smoke = "--smoke" in sys.argv
    print("S133 loading…", flush=True)
    conn = connect()
    rows, iv_cut, px_cut, _ = build(conn, smoke=smoke)
    print(f"rows={len(rows)} iv_cut={iv_cut:.3f} prox_cut={px_cut:.3f}", flush=True)

    lines = [
        "# S133 — S081 dir×price bull as short-put / RR / financed-call (A244; remap from S127)",
        "",
        f"Monday entries {START}→{HO_END}. Fit≤{FIT_END}, holdout {HO_START}→{HO_END}.",
        f"2-feature cuts (fit signal Mondays): iv_rank≤{iv_cut:.3f}, prox_52w≤{px_cut:.3f}.",
        "Pass: beat equal-collateral stock both eras, month-t≥2, rich-stress mean>0.",
        "",
        "| arm / window | n | mean pnl | stock_cmp | t | beat stock? | rich>0? |",
        "|---|---:|---:|---:|---:|---|---|",
    ]

    arms = ["short_put", "risk_rev", "financed_call"]
    verdicts = []
    for arm in arms:
        base = [x for x in rows if x["arm"] == arm and x["signal"]]
        for name, a, b in (
            ("fit", START, FIT_END),
            ("holdout", HO_START, HO_END),
        ):
            xs = era(base, a, b)
            s = summarize(xs, f"{arm} {name}")
            if isinstance(s, tuple):
                lines.append(s[0])
                verdicts.append((arm, name, *s[1:]))
            else:
                lines.append(s)

    # rule2 short put
    r2 = [x for x in rows if x["arm"] == "short_put" and x.get("rule2")]
    for name, a, b in (("fit", START, FIT_END), ("holdout", HO_START, HO_END)):
        xs = era(r2, a, b)
        s = summarize(xs, f"rule2_short_put {name}")
        if isinstance(s, tuple):
            lines.append(s[0])
            verdicts.append(("rule2_short_put", name, *s[1:]))
        else:
            lines.append(s)

    # pick winners
    lines += ["", "## Pass check", ""]
    passed = []
    for arm in arms + ["rule2_short_put"]:
        fit = next((v for v in verdicts if v[0] == arm and v[1] == "fit"), None)
        ho = next((v for v in verdicts if v[0] == arm and v[1] == "holdout"), None)
        if not fit or not ho:
            lines.append(f"- {arm}: missing window")
            continue
        # fit: mean, stock, t, beat, rich_ok, n
        ok = (
            fit[2] > 0 and ho[2] > 0
            and fit[4] >= 2 and ho[4] >= 2
            and fit[5] and ho[5]
            and fit[6] and ho[6]
        )
        lines.append(
            f"- {arm}: fit pnl {fit[2]:+.1%} t {fit[4]:.2f} beat={fit[5]} rich={fit[6]} · "
            f"HO {ho[2]:+.1%} t {ho[4]:.2f} beat={ho[5]} rich={ho[6]} → "
            f"{'PASS' if ok else 'FAIL'}"
        )
        if ok:
            passed.append(arm)

    verdict = "PASS" if passed else "FAIL"
    lines += [
        "",
        f"**Verdict: {verdict}** — "
        + (f"ship candidates: {', '.join(passed)}" if passed else "no expression clears bar; no buy/sell list"),
        "",
        "Refs: A244",
    ]
    text = "\n".join(lines) + "\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(text)
    print(f"wrote {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
