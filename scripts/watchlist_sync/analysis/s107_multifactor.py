#!/usr/bin/env python3
"""S107 (Jamie 10-26: "your test is not good … timing and execution dependent on many factors"): does a model that sees EVERY
factor at once pick better weekly sold puts than (a) the same model on price/vol only (S088 inputs), (b) fixed-Δ bands, and
(c) Jamie's rule (≥ ~1 %/wk, ≥ 10 % OTM, in crashed names)?

Rows: S101's cached put candidates (~/.fildi/cache/s101_rows.pkl, S088 σ-grid strikes per name-week, S076 pricer with the 10-26
fix, credit haircut to real LSEG fills), 1-week horizon. Target hc = net pnl per $ collateral per week after the real-fill haircut.
Added point-in-time features per (name, entry day):
  indicators   indicators.compute on the name's daily bars (author defaults) — UT Bot dir / age / confidence, SuperTrend cluster,
               ST-by-divergence, RSI divergence (last 5 bars), SMC BOS / sweep age / MSS age / FVG / order-block distance, Fear & Greed
  sector       best-correlated sector ETF's drawdown (band_engine.add_sector, prior-year correlation), UT breadth
  analysts     I/B/E/S FY1 EPS consensus as of the last monthly statpers ≥ 7 days before entry: revision breadth (up − down) ÷ n,
               1-month change in the median estimate
  earnings     an I/B/E/S announcement date inside the week (dates are scheduled weeks ahead; S066 convention)
Models (HistGradientBoosting, walk-forward: fit on years < Y, predict Y; Y = 2021 … 2026; holdout = 2023 →):
  M0 price/vol (S088-style inputs)   M1 = M0 + indicators   M2 = M1 + sector + analysts + earnings
Policy: per week, best candidate per name, keep predicted P(kept) ≥ 0.90, top 10 by predicted hc.
Comparators on the same weeks: fixed 0.08–0.10Δ / 0.10–0.12Δ top 10 by IV/RV; Jamie rule = income ≥ 0.9 %/wk, OTM ≥ 10 %, stock ≥ 25 %
off its 52-week high, top 10 by income.
Pass: M2 beats M0 and Jamie's rule on bp per collateral-week, both holdout halves, week-cluster t ≥ 2.5, worst-5 % week no worse.

    .venv/bin/python analysis/s107_multifactor.py [--tickers=A,B]   → out/opt/S107.md
"""
from __future__ import annotations

import math
import pickle
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import band_engine as BE  # noqa: E402
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402

CACHE = Path.home() / ".fildi" / "cache" / "s101_rows.pkl"
M0 = ("dist_sig", "dlt", "iv", "iv_rv", "iv_rank", "rsi14", "ret20", "dist50", "dist200", "dd60", "inc", "stk_1m", "stk_3m",
      "stk_6m", "stk_dd52", "rel_1m", "rel_3m", "rel_6m", "above200", "spy_1m", "spy_3m", "spy_dd52", "vix", "vix_ratio")
TECH = ("ut_dir", "ut_bars", "ut_surv", "ut_dist", "ut_conf", "stc_bull", "stdiv_dir", "div_against", "rsi_div5", "bos_dir",
        "sweep_age", "mss_age", "fvg_dist", "ob_dist", "fear_greed")
CTX = ("sec_dd52", "ut_breadth", "rev_breadth", "est_chg_1m", "er_in_week")
TOP, PMIN = 10, 0.90


def tech_features(conn, names):
    """{(t, d): {feature: value}} from indicators.compute, point-in-time (value at the entry bar's close)."""
    out = {}
    for t, (d, h, l, c, v, o) in IND.load_bars(conn, names).items():
        if len(c) < 320:
            continue
        s = IND.compute(d, h, l, c, v, o)
        rd = s["rsi_div"]
        r5 = np.array([np.sign(np.nansum(rd[max(0, i - 4):i + 1])) for i in range(len(c))])
        for i, day in enumerate(d):
            out[(t, day)] = {**{k: float(s[k][i]) for k in TECH if k in s}, "rsi_div5": float(r5[i])}
    return out


def ibes(conn, names):
    """{t: [(available_from, rev_breadth, est_chg_1m)]} FY1 EPS, sorted; available 7 days after statpers."""
    rows = conn.execute("""SELECT ticker, statpers, numest, numup, numdown, medest FROM wrds_research.ibes_statsum
                           WHERE measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1' AND ticker = ANY(%s) ORDER BY ticker, statpers""",
                        (names,)).fetchall()
    out = defaultdict(list)
    prev = {}
    for t, sp, n, up, dn, med in rows:
        n = n or 0
        rb = ((up or 0) - (dn or 0)) / n if n else None
        p = prev.get(t)
        ch = (med - p) / abs(p) if p not in (None, 0) and med is not None else None
        out[t].append((sp + timedelta(days=7), rb, ch))
        prev[t] = med
    return out


def announcements(conn, names):
    out = defaultdict(list)
    for t, a in conn.execute("SELECT DISTINCT ticker, anndats FROM wrds_research.ibes_surpsum WHERE ticker = ANY(%s) AND anndats IS NOT NULL",
                             (names,)):
        out[t].append(a)
    for t in out:
        out[t].sort()
    return out


def enrich(conn, rows):
    names = sorted({r["t"] for r in rows})
    tf = tech_features(conn, names)
    BE.add_sector(conn, rows)
    BE.add_breadth(conn, rows)
    ib, an = ibes(conn, names), announcements(conn, names)
    for r in rows:
        r.update(tf.get((r["t"], r["d"]), {}))
        hist = [x for x in ib.get(r["t"], []) if x[0] <= r["d"]]
        r["rev_breadth"], r["est_chg_1m"] = (hist[-1][1], hist[-1][2]) if hist else (None, None)
        end = r["d"] + timedelta(days=7)
        r["er_in_week"] = 1.0 if any(r["d"] < a <= end for a in an.get(r["t"], [])) else 0.0
    return rows


def X(rows, feats):
    return np.array([[np.nan if r.get(f) is None else float(r[f]) for f in feats] for r in rows], float)


def walk(rows, feats):
    """{id(row): (p_kept, pred_hc)} for test years 2021 … 2026, fit only on rows whose week ended before 1 Jan of Y."""
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    pred = {}
    for Y in range(2021, 2027):
        tr = [r for r in rows if r["d"] < date(Y, 1, 1) - timedelta(days=8)]
        te = [r for r in rows if r["d"].year == Y]
        if len(tr) < 5000 or not te:
            continue
        Xtr, Xte = X(tr, feats), X(te, feats)
        clf = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, random_state=107)
        clf.fit(Xtr, [r["kept"] for r in tr])
        reg = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, random_state=107)
        reg.fit(Xtr, [r["hc"] for r in tr])
        for r, p, y in zip(te, clf.predict_proba(Xte)[:, 1], reg.predict(Xte)):
            pred[id(r)] = (p, y)
    return pred


def by_week(rows):
    w = defaultdict(list)
    for r in rows:
        w[r["d"] - timedelta(days=r["d"].weekday())].append(r)
    return w


def pick_model(weeks, pred, pmin=PMIN, ok=lambda r: True):
    out = {}
    for wk, rs in weeks.items():
        best = {}
        for r in rs:
            p = pred.get(id(r))
            if p and p[0] >= pmin and ok(r) and (r["t"] not in best or p[1] > pred[id(best[r["t"]])][1]):
                best[r["t"]] = r
        out[wk] = sorted(best.values(), key=lambda r: -pred[id(r)][1])[:TOP]
    return out


def pick_rule(weeks, ok, key):
    out = {}
    for wk, rs in weeks.items():
        best = {}
        for r in rs:
            if ok(r) and (r["t"] not in best or key(r) > key(best[r["t"]])):
                best[r["t"]] = r
        out[wk] = sorted(best.values(), key=lambda r: -key(r))[:TOP]
    return out


def summ(picks, lo, hi):
    wk = {w: np.mean([r["hc"] for r in rs]) for w, rs in picks.items() if rs and lo <= w < hi}
    allr = [r for w, rs in picks.items() if lo <= w < hi for r in rs]
    v = np.array([wk[k] for k in sorted(wk)]) * 1e4
    eq = np.cumprod(1 + v / 1e4) if len(v) else np.array([1.0])
    return {"weeks": wk, "bp": float(v.mean()) if len(v) else float("nan"), "w5": float(np.percentile(v, 5)) if len(v) else float("nan"),
            "sharpe": float(v.mean() / v.std() * math.sqrt(52)) if len(v) > 2 and v.std() > 0 else float("nan"),
            "mdd": float(np.min(eq / np.maximum.accumulate(eq) - 1)),
            "kept": float(np.mean([r["kept"] for r in allr])) if allr else float("nan"), "n": len(allr), "nw": len(v)}


def diff_t(a, b):
    ks = sorted(set(a["weeks"]) & set(b["weeks"]))
    d = np.array([a["weeks"][k] - b["weeks"][k] for k in ks]) * 1e4
    return (float(d.mean()), float(d.mean() / (d.std(ddof=1) / math.sqrt(len(d))))) if len(d) > 5 and d.std() > 0 else (float("nan"),) * 2


def main():
    only = {x for a in sys.argv[1:] if a.startswith("--tickers=") for x in a[10:].upper().split(",")}
    rows = [r for r in pickle.load(open(CACHE, "rb")) if r["side"] == "put" and r["h"] == 1 and r.get("hc") is not None
            and (not only or r["t"] in only)]
    print(f"S107: {len(rows):,} 1-week put candidates, {len({r['t'] for r in rows})} names", flush=True)
    with connect() as conn:
        enrich(conn, rows)
    print("features added", flush=True)
    models = {"M0 price/vol": M0, "M1 + indicators": M0 + TECH, "M2 + indicators, sector, analysts, earnings": M0 + TECH + CTX}
    weeks = by_week(rows)
    picks, preds = {}, {}
    for name, feats in models.items():
        preds[name] = walk(rows, feats)
        picks[name] = pick_model(weeks, preds[name])
        print(f"  {name} done", flush=True)
    jamie = lambda r: r["inc"] >= 0.009 and (r["S"] - r["K"]) / r["S"] >= 0.10 and (r["stk_dd52"] or 0) <= -0.25  # noqa: E731
    full = "M2 + indicators, sector, analysts, earnings"
    picks["M2, no P(kept) floor"] = pick_model(weeks, preds[full], pmin=0.0)
    picks["Jamie rule, ranked by M2"] = pick_model(weeks, preds[full], pmin=0.0, ok=jamie)
    picks["Jamie rule, M2 P(kept) ≥ 0.85"] = pick_model(weeks, preds[full], pmin=0.85, ok=jamie)
    picks["fixed 0.08–0.10Δ (top IV/RV)"] = pick_rule(weeks, lambda r: 0.08 <= r["dlt"] < 0.10, lambda r: r["iv_rv"] or 0)
    picks["fixed 0.10–0.12Δ (top IV/RV)"] = pick_rule(weeks, lambda r: 0.10 <= r["dlt"] < 0.12, lambda r: r["iv_rv"] or 0)
    picks["Jamie rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high)"] = pick_rule(weeks, jamie, lambda r: r["inc"])
    halves = (("2023-01→2024-12", date(2023, 1, 1), date(2025, 1, 1)), ("2025-01→now", date(2025, 1, 1), date(2100, 1, 1)),
              ("holdout 2023→", date(2023, 1, 1), date(2100, 1, 1)), ("walk-fwd 2021–22", date(2021, 1, 1), date(2023, 1, 1)))
    L = [f"# S107 — every factor at once vs price/vol only vs fixed bands vs Jamie's rule ({date.today()})", "",
         f"{len(rows):,} one-week put candidates, {len({r['t'] for r in rows})} names; real-fill haircut; top {TOP}/week, model picks need "
         f"P(kept) ≥ {PMIN:.0%}.", "",
         "| policy | period | weeks | picks | bp / collateral-wk | kept | worst 5 % week bp | Sharpe (ann.) | max DD |", "|---|---|---|---|---|---|---|---|---|"]
    S = {}
    for name in picks:
        for lab, lo, hi in halves:
            s = summ(picks[name], lo, hi)
            S[(name, lab)] = s
            L.append(f"| {name} | {lab} | {s['nw']} | {s['n']} | {s['bp']:+.1f} | {100 * s['kept']:.1f} % | {s['w5']:+.0f} | "
                     f"{s['sharpe']:.2f} | {100 * s['mdd']:.1f} % |")
    m2, m0, jr = "M2 + indicators, sector, analysts, earnings", "M0 price/vol", "Jamie rule (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high)"
    L += ["", "| comparison (same weeks) | 2023-24 bp (t) | 2025→ bp (t) | holdout bp (t) |", "|---|---|---|---|"]
    for a, b in ((m2, m0), ("M1 + indicators", m0), (m2, jr), (m0, jr), (m2, "fixed 0.10–0.12Δ (top IV/RV)"),
                 ("Jamie rule, ranked by M2", jr), ("Jamie rule, M2 P(kept) ≥ 0.85", jr), ("M2, no P(kept) floor", jr)):
        cells = [diff_t(S[(a, lab)], S[(b, lab)]) for lab, *_ in halves[:3]]
        L.append(f"| {a} − {b} | " + " | ".join(f"{x[0]:+.1f} ({x[1]:+.1f})" for x in cells) + " |")
    ok = all(diff_t(S[(m2, lab)], S[(b, lab)])[0] > 0 for b in (m0, jr) for lab, *_ in halves[:2]) and \
        all(diff_t(S[(m2, halves[2][0])], S[(b, halves[2][0])])[1] >= 2.5 for b in (m0, jr)) and \
        S[(m2, halves[2][0])]["w5"] >= min(S[(m0, halves[2][0])]["w5"], S[(jr, halves[2][0])]["w5"])
    L.append(f"\n**Verdict: {'PASS' if ok else 'FAIL'}** (bar: M2 beats M0 and Jamie's rule in both holdout halves, t ≥ 2.5, worst-5 % no worse).")
    # what the full model leans on: permutation importance on the 2025 → test rows
    try:
        from sklearn.ensemble import HistGradientBoostingRegressor
        from sklearn.inspection import permutation_importance
        feats = M0 + TECH + CTX
        tr = [r for r in rows if r["d"] < date(2024, 12, 24)]
        te = [r for r in rows if r["d"] >= date(2025, 1, 1)]
        te = te[:: max(1, len(te) // 40000)]
        reg = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.05, max_leaf_nodes=31, random_state=107).fit(X(tr, feats), [r["hc"] for r in tr])
        pi = permutation_importance(reg, X(te, feats), [r["hc"] for r in te], n_repeats=3, random_state=107)
        top = sorted(zip(feats, pi.importances_mean), key=lambda x: -x[1])[:15]
        L += ["", "Permutation importance (2025 → rows, R² drop): " + ", ".join(f"{f} {v:.4f}" for f, v in top)]
    except Exception as e:   # importance is a readout, never blocks the verdict
        L.append(f"\n(importance skipped: {e})")
    txt = "\n".join(L)
    if not only:
        (HERE.parent / "out" / "opt" / "S107.md").write_text(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
