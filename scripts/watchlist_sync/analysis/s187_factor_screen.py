"""S187 — broad factor screen on simulated weekly short puts (Claude 11-10; Jamie: "think of many more factors, rank which is
best and why, then test many"). Catalogue + ranking: research/common/factor-catalogue-2026-11-10.md.

Population  S059 aligned_events: first NYSE session of each week → last session, ~1σ put at own IV30, net of fill cost
            (bid + 23 % spread), lab_outcomes names (252), 2020-02 → 2026-10.
Targets     pnl (net, per $ strike) · breach · stock part = short-put delta × (ST − S)/K · vol part = pnl − stock part
            (one-week static-delta split: G1 "two bets").
Test        weekly cross-sectional Spearman IC, ranks residualised on iv_rv, iv30, earnings flag (S045 fm controls).
            Select on TRAIN (< 2024-07-01) only. Family = every feature × {pnl, breach}; Benjamini-Hochberg q 0.10 AND |t| ≥ 3
            AND same sign both train halves AND sign = PREREG (where a sign is registered) → candidate.
            Candidates → HOLDOUT (≥ 2024-07-01) IC t, then marginal IC with put_edge also controlled.
Regime      rule 12 trend label, causal: UP = SPY close > 200d MA and SPY 63d return ≥ 0; DOWN = otherwise. Unit = week.
            Cell reported only when ≥ 30 weeks, else "can't answer at this n".
Limits      sim prices every strike at IV30 (no skew in the price) → skew/term effects show only through realised paths;
            lab names = current watchlist (survivorship); breach/pnl are the same week, so the 4 targets are not independent.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s187_factor_screen.py
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as F  # noqa: E402
from build_plan import connect  # noqa: E402

SPLIT = date(2024, 7, 1)
OUT = HERE.parent / "out" / "studies" / "S187.md"

# expected sign of IC vs net put pnl (+ = higher value → better for the seller); 0 = no registered sign (two-sided, exploratory)
PREREG = {
    # stock direction (the delta bet)
    "mom_12_1": +1, "rev_1m": -1, "ret5": -1, "dist_52w_high": +1, "max_ret_21": -1, "min_ret_21": +1, "dist_ma200": +1,
    "dist_ma50": 0, "beta": -1, "rsi14": -1, "close_loc_21": -1, "down_streak": +1, "log_price": +1, "log_dollar_vol": +1,
    "vol_ratio_5_60": -1,
    # tail / jump (the breach)
    "idio_vol": 0, "rskew_60": 0, "jump_cnt_252": -1, "gap_cnt_63": -1, "rv5_rv60": -1, "range_ratio": -1,
    "earn_jump_iv": -1, "days_since_earn": +1,
    # option pricing (the vol bet)
    "vol_of_vol": +1, "term_slope": +1, "iv_chg_5d": +1, "iv_chg_21d": +1, "iv_pct_252": +1, "har_iv": -1,
    "opt_mom_52w": +1, "breach_rate_52w": -1, "iv_minus_spy": 0,
    # positioning / events
    "si_dtc": -1, "si_chg_3m": -1, "insider_buy_90": +1, "insider_sell_90": -1, "fin_8k_30": -1, "risk_8k_30": -1,
    "any_8k_5": -1,
    # fundamentals / analysts (lab_fund)
    "ibes_breadth": +1, "ibes_drift": +1, "ibes_drift_3m": +1, "ibes_disp": -1, "ibes_sue": +1, "ibes_numest": +1,
    "ibes_fwd_growth": +1, "alpha": +1,
}
TARGETS = ("pnl", "breach", "stock_part", "vol_part")


def _rank(x):
    return S.rank(list(x))


def fm(ev, feat, target, extra=()):
    by = defaultdict(list)
    for e in ev:
        if e.get(feat) is None or e.get("iv_rv") is None or e.get(target) is None or any(e.get(k) is None for k in extra):
            continue
        by[e["d"]].append(e)
    ics = []
    for w in sorted(by):
        g = by[w]
        if len(g) < 30:
            continue
        x, y = np.asarray(_rank(e[feat] for e in g)), np.asarray(_rank(e[target] for e in g))
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        X = np.c_[np.ones(len(g)), _rank(e["iv_rv"] for e in g), _rank(e["iv30"] for e in g), [e["earn"] for e in g],
                  *[_rank(e[k] for e in g) for k in extra]]
        x = x - X @ np.linalg.lstsq(X, x, rcond=None)[0]
        y = y - X @ np.linalg.lstsq(X, y, rcond=None)[0]
        if np.std(x) < 1e-9 or np.std(y) < 1e-9:
            continue
        ics.append((w, float(np.corrcoef(x, y)[0, 1])))
    if len(ics) < 20:
        return None
    v = np.array([i for _, i in ics])
    h = len(v) // 2
    t = float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v))))
    return {"n": len(v), "ic": float(v.mean()), "t": t, "a": float(v[:h].mean()), "b": float(v[h:].mean()),
            "weeks": [w for w, _ in ics], "v": v}


def p_two(t):
    return math.erfc(abs(t) / math.sqrt(2))


def bh(pvals, q=0.10):
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    ok, cut = [False] * m, 0
    for k, i in enumerate(order, 1):
        if pvals[i] <= q * k / m:
            cut = k
    for k, i in enumerate(order, 1):
        ok[i] = k <= cut
    return ok


def add_more(conn, ev):
    tick = sorted({e["t"] for e in ev})
    bars = defaultdict(list)
    for t, d, o, h, l, c, v, p30, p90 in conn.execute(
            """SELECT ticker, date, open::float8, high::float8, low::float8, close::float8, coalesce(volume,0)::float8,
                      iv30_put::float8, iv90_put::float8
               FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 ORDER BY ticker, date""",
            (tick + ["SPY"],)).fetchall():
        bars[t].append((d, o, h, l, c, v, p30, p90))
    pos = {t: {b[0]: i for i, b in enumerate(bs)} for t, bs in bars.items()}
    spy = bars["SPY"]
    spy_c = np.array([b[4] for b in spy])
    spy_pos = pos["SPY"]

    def regime(d):
        i = spy_pos.get(d)
        if i is None or i < 200:
            return None
        return "up" if spy_c[i] > spy_c[i - 199:i + 1].mean() and spy_c[i] / spy_c[i - 63] - 1 >= 0 else "down"

    # events / positioning tables
    em = defaultdict(list)
    for t, d, m in conn.execute("SELECT ticker, report_date, abs(move_pct)::float8 FROM lseg_research.earnings_moves "
                                "WHERE move_pct IS NOT NULL ORDER BY ticker, report_date"):
        em[t].append((d, m))
    si = defaultdict(list)
    for t, d, dtc, s in conn.execute("SELECT ticker, settlement_date, days_to_cover, short_interest::float8 FROM "
                                     "watchlist_sync.s099_short_interest ORDER BY ticker, settlement_date"):
        si[t].append((d, dtc, s))
    f4 = defaultdict(list)
    for t, d, code in conn.execute("SELECT ticker, filing_date, code FROM watchlist_sync.s099_form4 WHERE code IN ('P','S') "
                                   "AND record_type = 'transaction' ORDER BY ticker, filing_date"):
        f4[t].append((d, code))
    k8 = defaultdict(list)
    for t, d, cat in conn.execute("SELECT ticker, filing_date, primary_category FROM watchlist_sync.s099_8k ORDER BY ticker, filing_date"):
        k8[t].append((d, cat))
    f4_start, k8_start = date(2022, 1, 3), date(2022, 1, 3)
    fund = {(t, d): f for t, d, f in conn.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_fund")}
    labf = {(t, d): f for t, d, f in conn.execute("SELECT ticker, as_of, features FROM watchlist_sync.lab_outcomes")}

    # option momentum: own past simulated puts that EXPIRED before entry
    hist = defaultdict(list)
    for e in ev:
        hist[e["t"]].append((e["expiry"], e["pnl"], e["breach"]))
    for t in hist:
        hist[t].sort()

    for e in ev:
        t, d = e["t"], e["d"]
        e["regime"] = regime(d)
        b, i = bars.get(t), pos.get(t, {}).get(d)
        j = pos.get(t, {}).get(e["expiry"])
        if b is None or i is None or j is None or i < 253:
            continue
        c = np.array([x[4] for x in b[:j + 1]])
        S0, ST = c[i], c[j]
        iv, tt = e["iv30"], e["hold_sessions"] / 252
        d1 = S.Z + 0.5 * iv * math.sqrt(tt)
        K = S0 * math.exp(-S.Z * iv * math.sqrt(tt))
        e["stock_part"] = 0.5 * math.erfc(d1 / math.sqrt(2)) * (ST - S0) / K
        e["vol_part"] = e["pnl"] - e["stock_part"]
        cw = c[:i + 1]
        r = np.diff(np.log(cw[-253:]))
        r60, r21 = r[-60:], r[-21:]
        hi, lo = np.array([x[2] for x in b[i - 252:i + 1]]), np.array([x[3] for x in b[i - 252:i + 1]])
        vol = np.array([x[5] for x in b[i - 59:i + 1]])
        sd = float(np.std(r60)) or 1e-9
        e["dist_52w_high"] = cw[-1] / hi.max() - 1
        e["max_ret_21"], e["min_ret_21"] = float(r21.max()), float(r21.min())
        e["dist_ma50"] = cw[-1] / cw[-50:].mean() - 1
        e["dist_ma200"] = cw[-1] / cw[-200:].mean() - 1
        up, dn = np.clip(r[-14:], 0, None).mean(), -np.clip(r[-14:], None, 0).mean()
        e["rsi14"] = 100 - 100 / (1 + up / dn) if dn > 0 else 100.0
        h21, l21 = hi[-21:].max(), lo[-21:].min()
        e["close_loc_21"] = (cw[-1] - l21) / (h21 - l21) if h21 > l21 else 0.5
        e["log_price"] = math.log(cw[-1])
        dv = vol * c[i - 59:i + 1]
        e["log_dollar_vol"] = math.log(max(1.0, float(np.median(dv[-20:]))))
        e["vol_ratio_5_60"] = float(vol[-5:].mean() / (vol.mean() or 1e-9))
        m3 = np.mean(r60) if len(r60) else 0
        e["rskew_60"] = float(np.mean((r60 - m3) ** 3) / sd ** 3)
        sd252 = float(np.std(r)) or 1e-9
        e["jump_cnt_252"] = float(np.sum(np.abs(r) > 3 * sd252))
        opens = np.array([x[1] or np.nan for x in b[i - 62:i + 1]])
        prev = c[i - 63:i]
        gaps = np.abs(np.log(opens / prev))
        e["gap_cnt_63"] = float(np.nansum(gaps > 2 * sd))
        e["rv5_rv60"] = float(np.std(r[-5:]) / sd)
        rng = (hi - lo) / np.array([x[4] for x in b[i - 252:i + 1]])
        e["range_ratio"] = float(rng[-5:].mean() / (rng[-60:].mean() or 1e-9))
        lf = labf.get((t, d)) or {}
        for k in ("beta", "alpha", "dist_ma200"):
            if lf.get(k) is not None and k != "dist_ma200":
                e[k] = float(lf[k])
        e["iv_pct_252"] = float(lf["iv_rank_1y"]) if lf.get("iv_rank_1y") is not None else None
        ivs = [x[6] for x in b[i - 252:i + 1]]
        if ivs[-1] and ivs[-6] and ivs[-22]:
            e["iv_chg_5d"] = math.log(ivs[-1] / ivs[-6])
            e["iv_chg_21d"] = math.log(ivs[-1] / ivs[-22])
        si_ = spy_pos.get(d)
        if si_ is not None and spy[si_][6] and ivs[-1]:
            e["iv_minus_spy"] = ivs[-1] - spy[si_][6]
        # option momentum: past 52w of own sim puts expired before d
        hs = hist[t]
        k1, k2 = bisect_left(hs, (d - timedelta(days=365),)), bisect_left(hs, (d,))
        past = hs[k1:k2]
        if len(past) >= 20:
            e["opt_mom_52w"] = float(np.mean([p for _, p, _ in past]))
            e["breach_rate_52w"] = float(np.mean([x for _, _, x in past]))
        # earnings jumps vs IV
        ems = em.get(t, [])
        k = bisect_left(ems, (d,))
        prior = [m for _, m in ems[max(0, k - 8):k]]
        if len(prior) >= 4 and iv:
            e["earn_jump_iv"] = float(np.mean(prior)) / 100.0 / (iv / math.sqrt(252))
        if k > 0:
            e["days_since_earn"] = float((d - ems[k - 1][0]).days)
        # short interest (settlement + 10 calendar days publication lag)
        sl = si.get(t, [])
        k = bisect_right([x[0] for x in sl], d - timedelta(days=10))
        if k >= 7 and sl[k - 1][1] is not None:
            e["si_dtc"] = float(sl[k - 1][1])
            if sl[k - 7][2]:
                e["si_chg_3m"] = math.log(max(1.0, sl[k - 1][2]) / max(1.0, sl[k - 7][2]))
        if d >= f4_start + timedelta(days=90):
            fl = f4.get(t, [])
            a, z = bisect_left(fl, (d - timedelta(days=90),)), bisect_left(fl, (d,))
            w = fl[a:z]
            e["insider_buy_90"] = float(sum(1 for _, cd in w if cd == "P"))
            e["insider_sell_90"] = float(sum(1 for _, cd in w if cd == "S"))
        if d >= k8_start + timedelta(days=30):
            kl = k8.get(t, [])
            a30, a5, z = bisect_left(kl, (d - timedelta(days=30),)), bisect_left(kl, (d - timedelta(days=5),)), bisect_left(kl, (d,))
            e["fin_8k_30"] = float(sum(1 for _, ct in kl[a30:z] if ct == "capital_and_financing"))
            e["risk_8k_30"] = float(sum(1 for _, ct in kl[a30:z] if ct in ("risk_events", "regulatory_and_compliance")))
            e["any_8k_5"] = float(z - a5)
        fd = fund.get((t, d)) or {}
        for kk in ("ibes_breadth", "ibes_drift", "ibes_drift_3m", "ibes_disp", "ibes_sue", "ibes_numest", "ibes_fwd_growth"):
            if fd.get(kk) is not None:
                e[kk] = float(fd[kk])


def main():
    with connect() as conn:
        ev = F.aligned_events(conn)
        add_more(conn, ev)
        S._attach_put_edge(conn, ev)
    feats = [f for f in PREREG if any(e.get(f) is not None for e in ev)]
    missing = [f for f in PREREG if f not in feats]
    tr = [e for e in ev if e["d"] < SPLIT]
    ho = [e for e in ev if e["d"] >= SPLIT]
    wk_reg = {e["d"]: e.get("regime") for e in ev}
    n_up = sum(1 for d, r in wk_reg.items() if r == "up" and d < SPLIT)
    n_dn = sum(1 for d, r in wk_reg.items() if r == "down" and d < SPLIT)
    rows = []
    for f in feats:
        for tgt in TARGETS:
            r = fm(tr, f, tgt)
            if r:
                rows.append((f, tgt, r))
    fam = [i for i, (f, tgt, r) in enumerate(rows) if tgt in ("pnl", "breach")]
    ok = bh([p_two(rows[i][2]["t"]) for i in fam])
    passed = set()
    for i, o in zip(fam, ok):
        f, tgt, r = rows[i]
        want = PREREG[f] * (1 if tgt == "pnl" else -1)
        if o and abs(r["t"]) >= 3 and np.sign(r["a"]) == np.sign(r["b"]) == np.sign(r["ic"]) and (want == 0 or np.sign(r["ic"]) == want):
            passed.add((f, tgt))

    def cell(r, reg):
        v = [x for w, x in zip(r["weeks"], r["v"]) if wk_reg.get(w) == reg]
        if len(v) < 30:
            return f"n {len(v)} (can't answer)"
        v = np.array(v)
        return f"{v.mean():+.3f} (t {v.mean() / (v.std(ddof=1) / math.sqrt(len(v))):+.1f}, n {len(v)})"

    by = {(f, tgt): r for f, tgt, r in rows}
    L = ["# S187 — broad factor screen on weekly short puts", "",
         f"{len(ev)} sim puts · {len({e['t'] for e in ev})} names · train < {SPLIT}: {len({e['d'] for e in tr})} weeks "
         f"(up {n_up} / down {n_dn}) · holdout: {len({e['d'] for e in ho})} weeks · {len(feats)} factors × 4 targets; "
         f"BH family = {len(fam)} tests (pnl + breach).", "",
         f"Not computable (no data): {', '.join(missing) or 'none'}", "",
         "IC = weekly Spearman, controls iv_rv + iv30 + earnings. + on pnl/stock/vol = better for the seller; + on breach = more breaches.", "",
         "## Ranked by |t| on net pnl (train)", "",
         "| # | factor | prereg | pnl IC (t) | halves | breach t | stock-part t | vol-part t | up cell | down cell | pass |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    order = sorted([f for f in feats if (f, "pnl") in by], key=lambda f: -abs(by[(f, "pnl")]["t"]))
    for n, f in enumerate(order, 1):
        r = by[(f, "pnl")]
        g = lambda tg: f"{by[(f, tg)]['t']:+.1f}" if (f, tg) in by else "—"
        ps = ",".join(tg for tg in ("pnl", "breach") if (f, tg) in passed) or "—"
        L.append(f"| {n} | {f} | {PREREG[f]:+d} | {r['ic']:+.4f} ({r['t']:+.1f}) | {r['a']:+.3f}/{r['b']:+.3f} | {g('breach')} | "
                 f"{g('stock_part')} | {g('vol_part')} | {cell(r, 'up')} | {cell(r, 'down')} | {ps} |")
    L += ["", "## Candidates → holdout (≥ 2024-07-01), then marginal over put_edge", "",
          "| factor | target | train t | holdout IC (t) | holdout + put_edge control (t) | verdict |", "|---|---|---|---|---|---|"]
    for f, tgt in sorted(passed):
        h = fm(ho, f, tgt)
        hp = fm(ho, f, tgt, extra=("put_edge",))
        sg = np.sign(by[(f, tgt)]["ic"])
        good = h and np.sign(h["ic"]) == sg and abs(h["t"]) >= 2
        marg = hp and np.sign(hp["ic"]) == sg and abs(hp["t"]) >= 2
        verdict = "HOLDS + marginal" if good and marg else ("holds, redundant with put_edge" if good else "fails holdout")
        L.append(f"| {f} | {tgt} | {by[(f, tgt)]['t']:+.1f} | " + (f"{h['ic']:+.4f} ({h['t']:+.1f})" if h else "—") + " | "
                 + (f"{hp['ic']:+.4f} ({hp['t']:+.1f})" if hp else "—") + f" | {verdict} |")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
