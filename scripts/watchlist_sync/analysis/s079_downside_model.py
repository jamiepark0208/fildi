"""S079 — Downside-ranking model (A222): does a gradient-boosted P(breach) pick better weekly puts than live put edge? (Claude 10-21)
Pre-registered in research/studies/plans/S079-downside-model.md. One run, no re-cut.

Question: HGB classifier on breach (lower P = better put) vs the live put-edge composite (rank-sum iv_rv + vol_of_vol + put_tech)
and a logistic on those 3 factors. Data: S059 aligned_events + add_features (same-week NYSE puts, pnl net of fills) plus point-in-time OHLCV
features (entry-day close or earlier). Walk-forward expanding, test years 2022-2026, train on d < year start - 7d, fixed params (no tuning).
Pass: holdout (2024-07->) paired weekly top-quintile diff (model - put edge) > 0, week-cluster t >= 2, both halves > 0, breach not higher.

    .venv/bin/python analysis/s079_downside_model.py [--smoke]
"""
from __future__ import annotations

import math
import sys
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as F  # noqa: E402
from build_plan import connect  # noqa: E402

SPLIT = F.SPLIT
OUT = HERE.parent / "out/opt/S079.md"
PE3 = ["iv_rv", "vol_of_vol", "put_tech"]
BASE = PE3 + ["iv30", "earn", "term_slope", "skew", "idio_vol", "mom_12_1", "rev_1m"]
OHLCV = ["r5", "r20", "r60", "ma20", "ma50", "ma200", "dd20", "atr14", "volz", "rsi14", "beta60"]
FEATS = BASE + OHLCV
PARAMS = dict(max_depth=3, learning_rate=0.05, max_iter=300, min_samples_leaf=200, l2_regularization=1.0, random_state=0)
YEARS = range(2022, 2027)


def add_ohlcv(conn, ev):
    tick = sorted({e["t"] for e in ev})
    bars = defaultdict(list)
    for t, d, h, l, c, v in conn.execute("""SELECT ticker, date, high::float8, low::float8, close::float8, coalesce(volume,0)::float8
                                            FROM lseg_research.daily_history WHERE ticker = ANY(%s) AND close > 0 AND high > 0 AND low > 0
                                            ORDER BY ticker, date""", (tick,)).fetchall():
        bars[t].append((d, h, l, c, v))
    spy = {d: c for d, c in conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker='SPY' ORDER BY date").fetchall()}
    pos = {t: {b[0]: i for i, b in enumerate(bs)} for t, bs in bars.items()}
    for e in ev:
        i = pos.get(e["t"], {}).get(e["d"])
        if i is None or i < 60:
            continue
        bs = bars[e["t"]]
        c = np.array([b[3] for b in bs[max(0, i - 200):i + 1]])   # window ends at entry-day close (no look-ahead)
        h = np.array([b[1] for b in bs[i - 59:i + 1]]); l = np.array([b[2] for b in bs[i - 59:i + 1]])
        v = np.array([b[4] for b in bs[i - 19:i + 1]])
        p = c[-1]
        for k, n in (("r5", 5), ("r20", 20), ("r60", 60)):
            e[k] = p / bs[i - n][3] - 1
        for k, n in (("ma20", 20), ("ma50", 50), ("ma200", 200)):
            if i >= n - 1:
                e[k] = p / float(np.mean(c[-n:])) - 1
        e["dd20"] = p / float(np.max(c[-20:])) - 1
        cc = np.array([b[3] for b in bs[i - 14:i + 1]])
        tr = np.maximum(h[-14:] - l[-14:], np.maximum(abs(h[-14:] - cc[:-1]), abs(l[-14:] - cc[:-1])))
        e["atr14"] = float(np.mean(tr)) / p
        if v.std() > 0:
            e["volz"] = float((v[-1] - v.mean()) / v.std())
        dc = np.diff(cc)
        up, dn = dc[dc > 0].sum(), -dc[dc < 0].sum()
        e["rsi14"] = 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)
        ds = [b[0] for b in bs[i - 60:i + 1]]
        sp = [spy.get(d) for d in ds]
        if all(sp):
            r = np.diff(np.log([b[3] for b in bs[i - 60:i + 1]])); rs = np.diff(np.log(sp))
            e["beta60"] = float(np.cov(r, rs)[0, 1] / (np.var(rs, ddof=1) or 1e-9))


def smoke(conn, ev):
    keep = ["AAPL", "MSFT", "JPM", "XOM", "NVDA"]
    sub = [e for e in ev if e["t"] in keep and all(e.get(k) is not None for k in PE3 + ["r60"])]
    print(f"smoke: {len(sub)} trades on {sorted({e['t'] for e in sub})}; feature coverage:",
          {k: round(np.mean([e.get(k) is not None for e in sub]), 2) for k in FEATS})
    for e in sub[len(sub) // 4::max(1, len(sub) // 3)][:3]:
        rows = conn.execute("SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker=%s AND date BETWEEN %s AND %s ORDER BY date",
                            (e["t"], e["d"] - timedelta(days=100), e["expiry"])).fetchall()
        cl = {d: c for d, c in rows}; ds = [d for d, _ in rows]; i = ds.index(e["d"])
        S0, ST = cl[e["d"]], cl[e["expiry"]]
        K = S0 * math.exp(-S.Z * e["iv30"] * math.sqrt(e["hold_sessions"] / 252))
        r5, r20 = S0 / cl[ds[i - 5]] - 1, S0 / cl[ds[i - 20]] - 1
        print(f"{e['t']} {e['d']}->{e['expiry']} S={S0:.2f} S_T={ST:.2f} K={K:.2f} hand breach={float(ST < K)} event breach={e['breach']} "
              f"| r5 hand {r5:+.4f} vs {e['r5']:+.4f} r20 hand {r20:+.4f} vs {e['r20']:+.4f} | iv_rv={e['iv_rv']:.2f} vov={e['vol_of_vol']:.4f} "
              f"put_tech={e['put_tech']:.1f} atr14={e['atr14']:.4f} rsi14={e['rsi14']:.1f} beta60={e.get('beta60', float('nan')):.2f} pnl={1e4 * e['pnl']:+.1f}bp")
        assert float(ST < K) == e["breach"] and abs(r5 - e["r5"]) < 1e-9 and abs(r20 - e["r20"]) < 1e-9


def X(rows, cols):
    return np.array([[np.nan if e.get(c) is None else e[c] for c in cols] for e in rows], float)


def weekly(rows, minn=30):
    by = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    return [g for _, g in sorted(by.items()) if len(g) >= minn]


def tstat(v):
    v = np.asarray(v); return float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v))))


def quint_table(groups, key):
    qs = defaultdict(list)
    for g in groups:
        sc = S.rank([e[key] for e in g])
        for e, s in zip(g, sc):
            qs[min(4, int(s * 5))].append(e)
    return [f"| Q{q + 1} | {1e4 * np.mean([e['pnl'] for e in v]):+.1f} | {100 * np.mean([e['breach'] for e in v]):.1f} % | {len(v)} |" for q, v in sorted(qs.items())]


def top_q(g, key):
    q = len(g) // 5
    o = np.argsort([e[key] for e in g])[-q:]
    return np.mean([g[k]["pnl"] for k in o]), np.mean([g[k]["breach"] for k in o])


def main():
    t0 = time.time()
    smoke_run = "--smoke" in sys.argv
    with connect() as conn:
        ev = F.aligned_events(conn)
        add_ohlcv(conn, ev)
        if smoke_run:
            smoke(conn, ev); return
    ev = [e for e in ev if e["d"] >= date(2020, 1, 1)]
    print(f"S079 · {len(ev)} puts, {len({e['d'] for e in ev})} weeks, {len({e['t'] for e in ev})} names")
    test = []
    for y in YEARS:
        start = date(y, 1, 1)
        tr = [e for e in ev if e["d"] < start - timedelta(days=7)]
        te = [e for e in ev if e["d"].year == y and all(e.get(k) is not None for k in PE3)]
        if len(tr) < 2000 or not te:
            continue
        yb = np.array([e["breach"] for e in tr]); yp = np.array([e["pnl"] for e in tr])
        clf = HistGradientBoostingClassifier(**PARAMS).fit(X(tr, FEATS), yb)
        reg = HistGradientBoostingRegressor(**PARAMS).fit(X(tr, FEATS), yp)
        trc = [e for e in tr if all(e.get(k) is not None for k in PE3)]
        A = X(trc, PE3); mu, sd = A.mean(0), A.std(0)
        lr = LogisticRegression(max_iter=1000).fit((A - mu) / sd, [e["breach"] for e in trc])
        Xt = X(te, FEATS)
        pm, pr, pl = clf.predict_proba(Xt)[:, 1], reg.predict(Xt), lr.predict_proba((X(te, PE3) - mu) / sd)[:, 1]
        for e, a, b, c in zip(te, pm, pr, pl):
            e["p_model"], e["pnl_model"], e["p_logit"] = a, b, c
            e["s_model"], e["s_reg"], e["s_logit"] = -a, b, -c
        test += te
        print(f"{y}: train {len(tr)} test {len(te)} ({time.time() - t0:.0f}s)")
    # live put edge = within-week rank-sum of the 3 factors (same as put_edge.py / S059 composite)
    groups = weekly(test)
    for g in groups:
        sc = sum(S.rank([e[k] for e in g]) for k in PE3)
        for e, s in zip(g, sc):
            e["s_edge"] = s
    test = [e for g in groups for e in g]
    lines = ["# S079 — downside-ranking model (A222): HGB P(breach) vs live put edge", "",
             f"Walk-forward expanding, test 2022-2026 ({len(test)} puts, {len(groups)} weeks), fixed params {PARAMS}. Features: {len(FEATS)}. Horizon {F.HORIZON_VERSION}.", "",
             "## 1. AUC / Brier for breach (higher AUC = better; put edge has no probability so no Brier)", "",
             "| year | n | base rate | AUC model | AUC logistic | AUC put edge | Brier model | Brier logistic | Brier base |", "|---|---|---|---|---|---|---|---|---|"]
    for y in list(YEARS) + ["pooled"]:
        s = [e for e in test if y == "pooled" or e["d"].year == y]
        if len(s) < 100:
            continue
        yb = np.array([e["breach"] for e in s]); pm = np.array([e["p_model"] for e in s]); pl = np.array([e["p_logit"] for e in s])
        lines.append(f"| {y} | {len(s)} | {100 * yb.mean():.1f} % | {roc_auc_score(yb, pm):.4f} | {roc_auc_score(yb, pl):.4f} | "
                     f"{roc_auc_score(yb, [-e['s_edge'] for e in s]):.4f} | {brier_score_loss(yb, pm):.4f} | {brier_score_loss(yb, pl):.4f} | {brier_score_loss(yb, np.full(len(yb), yb.mean())):.4f} |")
    hold = [g for g in groups if g[0]["d"] >= SPLIT]
    lines += ["", "## 2. Quintiles by score (Q5 = best put; pnl bp/wk net of fills; breach; n)"]
    for title, gs in (("Holdout 2024-07 ->", hold), ("All test years", groups)):
        for nm, key in (("HGB breach model", "s_model"), ("HGB pnl regressor", "s_reg"), ("Put edge (live)", "s_edge")):
            lines += ["", f"**{title} — {nm}**", "", "| q | pnl bp/wk | breach | n |", "|---|---|---|---|"] + quint_table(gs, key)
    lines += ["", "## 3. Decision metric — holdout, top quintile each week, paired (model - put edge)", ""]
    res = {}
    for nm, key in (("HGB breach model", "s_model"), ("HGB pnl regressor (secondary)", "s_reg"), ("logistic 3-factor (secondary)", "s_logit")):
        dp, db = [], []
        for g in hold:
            a, b = top_q(g, key), top_q(g, "s_edge")
            dp.append(1e4 * (a[0] - b[0])); db.append(a[1] - b[1])
        dp, db = np.array(dp), np.array(db); h = len(dp) // 2
        res[key] = (dp, db)
        lines.append(f"- {nm}: {dp.mean():+.1f} bp/wk (week-cluster t {tstat(dp):+.2f}), halves {dp[:h].mean():+.1f} / {dp[h:].mean():+.1f}, "
                     f"weeks better {np.mean(dp > 0):.0%}; breach diff {100 * db.mean():+.2f} pp (t {tstat(db):+.2f}); {len(dp)} weeks")
    dp, db = res["s_model"]; h = len(dp) // 2
    ok = dp.mean() > 0 and tstat(dp) >= 2 and dp[:h].mean() > 0 and dp[h:].mean() > 0 and db.mean() <= 0
    lines += ["", f"**Verdict (pre-registered, HGB breach model): {'PASS — propose as shadow challenger factor, no live change' if ok else 'FAIL — no factor'}**"]
    lines += ["", "## 4. Marginal — within put-edge quintile, model top tercile minus bottom tercile (holdout, pnl bp/wk, week-cluster t)", ""]
    per = defaultdict(list)
    for g in hold:
        sc = S.rank([e["s_edge"] for e in g])
        for q in range(5):
            m = [e for e, s in zip(g, sc) if min(4, int(s * 5)) == q]
            if len(m) >= 6:
                o = sorted(m, key=lambda e: e["s_model"]); k = len(o) // 3
                per[q].append(1e4 * (np.mean([e["pnl"] for e in o[-k:]]) - np.mean([e["pnl"] for e in o[:k]])))
    for q in range(5):
        if len(per[q]) > 5:
            lines.append(f"- put-edge Q{q + 1}: {np.mean(per[q]):+.1f} bp/wk (t {tstat(per[q]):+.2f}, {len(per[q])} weeks)")
    # Post-hoc (Claude 10-21, found on the holdout above → confirmed only on the untouched 2022 → 2024-06 test weeks):
    # two-stage rule = put-edge top quintile minus the model's riskiest third, vs the put-edge top quintile as-is.
    lines += ["", "## 6. Post-hoc two-stage rule (put-edge Q5, drop model's riskiest third) — confirmation on 2022 → 2024-06", ""]
    for lab, gs in (("2022 → 2024-06 (confirmation, untouched)", [g for g in groups if g[0]["d"] < SPLIT]), ("2024-07 → (discovery)", hold)):
        diff, br, base, kept = [], [], [], []
        for g in gs:
            sc = S.rank([e["s_edge"] for e in g])
            q5 = [e for e, s in zip(g, sc) if min(4, int(s * 5)) == 4]
            if len(q5) < 6:
                continue
            o = sorted(q5, key=lambda e: e["s_model"]); k = len(o) // 3
            keep = o[k:]
            diff.append(1e4 * (np.mean([e["pnl"] for e in keep]) - np.mean([e["pnl"] for e in q5])))
            br.append(np.mean([e["breach"] for e in keep]) - np.mean([e["breach"] for e in q5]))
            base.append(1e4 * np.mean([e["pnl"] for e in q5])); kept.append(1e4 * np.mean([e["pnl"] for e in keep]))
        if diff:
            h = len(diff) // 2
            lines.append(f"- {lab}: Q5 {np.mean(base):+.1f} → two-stage {np.mean(kept):+.1f} bp/wk; paired {np.mean(diff):+.1f} "
                         f"(t {tstat(diff):+.2f}, halves {np.mean(diff[:h]):+.1f} / {np.mean(diff[h:]):+.1f}); breach {100 * np.mean(br):+.2f} pp; {len(diff)} weeks")
    # permutation importance on the holdout (model fit on pre-holdout only)
    tr = [e for e in ev if e["d"] < SPLIT - timedelta(days=7)]
    te = [e for g in hold for e in g]
    clf = HistGradientBoostingClassifier(**PARAMS).fit(X(tr, FEATS), [e["breach"] for e in tr])
    pi = permutation_importance(clf, X(te, FEATS), [e["breach"] for e in te], scoring="roc_auc", n_repeats=3, random_state=0)
    imp = sorted(zip(FEATS, pi.importances_mean, pi.importances_std), key=lambda x: -x[1])
    lines += ["", "## 5. Permutation importance on holdout (AUC drop; model fit pre-2024-07)", ""] + [f"- {f}: {m:+.4f} (±{s:.4f})" for f, m, s in imp[:10]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines)); print(f"runtime {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
