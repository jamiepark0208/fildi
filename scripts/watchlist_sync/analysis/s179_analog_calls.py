"""S179 — probabilistic long-call score from historical analogs vs the S177 threshold score (Jamie 11-09: "conditions too
deterministic … a 69 when the cut is 70 gets excluded; simulate all possibilities from historical data").

Trades = S175 cache long_call (0.50Δ, 30 DTE, Monday entries 2021-02→, model-priced w/ skew + RH fill, held to expiry,
pnl per $ debit). Entry state = S177 features. For each Monday W (walk-forward, no look-ahead):
  pool  = every long-call trade entered ≤ W − 35 d (already expired → outcome known)
  for each name entered on W: k nearest pool states (z-scored on the pool) = its scenario set.
    sim_pnl  : the analogs' own realized pnl per $ debit
    sim_move : analogs' standardized move z = ln(S_T/S_0)/(iv0·√T) re-priced on today's call
               (strike = S·e^{½σ²T}, today's debit) → payoff distribution for THIS option, any vol
  outputs: E[pnl], P(pnl > 0), P10/P90 — continuous, no cut.
Comparators (same weeks, same names): S177 threshold score (trade_funnel call_edge), a smooth (logistic) version of it,
all calls. Metrics: weekly top-quintile mean pnl, weekly rank IC, month-block t, Brier of P(profit) vs the pool base rate.
Pre-registered pass: E[pnl] top quintile > threshold top quintile in BOTH eras (2022-23, 2024→) with month-block t ≥ 2
on the pooled weekly difference, AND Brier skill > 0 in both eras. Fail → keep the threshold score; report near-cut table.
"""
from __future__ import annotations

import math
import pickle
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

CACHE = Path.home() / ".fildi/cache/s175_trades.pkl"
SPLIT = date(2024, 1, 1)
START = date(2022, 1, 1)
FEATS = ["ivp", "ivrv", "ret5", "ret20", "ret60", "z50", "off_hi", "rsi", "vixr", "spy20"]
K_NN = int(sys.argv[sys.argv.index("--k") + 1]) if "--k" in sys.argv else 300
NN_FEATS = sys.argv[sys.argv.index("--feats") + 1].split(",") if "--feats" in sys.argv else FEATS   # analog distance space


def rsi(c, n=14):
    from quantcore.ta import rsi_last  # one home (Jamie 11-15)
    v = rsi_last(c, n)
    return float("nan") if v is None else v  # no stand-in (B1)


def thresh(f):   # trade_funnel.py call_edge (S177 terms) — the hard-cut score in production
    return (1 - f["ivp"]) - 0.5 * (f["ret20"] <= -0.15) - 0.3 * (f["off_hi"] >= -0.02) - 0.2 * (f["z50"] >= 1.44)


def smooth(f):   # same terms, logistic ramps instead of steps (width ≈ the feature's noise near the cut)
    s = lambda x: 1 / (1 + math.exp(-x))
    return (1 - f["ivp"]) - 0.5 * s((-0.15 - f["ret20"]) / 0.03) - 0.3 * s((f["off_hi"] + 0.02) / 0.01) - 0.2 * s((f["z50"] - 1.44) / 0.25)


def month_t(xs):
    m = defaultdict(list)
    for d, v in xs:
        m[(d.year, d.month)].append(v)
    v = [np.mean(a) for a in m.values()]
    return (np.mean(v) / (np.std(v, ddof=1) / math.sqrt(len(v)))) if len(v) > 2 and np.std(v) > 0 else float("nan"), len(v)


def spearman(a, b):
    ra, rb = np.argsort(np.argsort(a)), np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1]) if len(a) > 4 else float("nan")


def main():
    T = [x for x in pickle.loads(CACHE.read_bytes()) if x["s"] == "long_call"]
    names = sorted({x["t"] for x in T})
    H = defaultdict(list)
    with connect() as conn:
        for t, d, c, iv in conn.execute("""SELECT ticker, date, close::float8, iv30_call::float8 FROM lseg_research.daily_history
                                           WHERE ticker = ANY(%s) AND date >= '2019-06-01' AND close > 0 ORDER BY ticker, date""", (names + ["SPY"],)):
            H[t].append((d, c, iv))
        vx = {d: float(r) for d, r in conn.execute("""SELECT a.date, a.value / b.value FROM watchlist_sync.macro_daily a
                  JOIN watchlist_sync.macro_daily b ON b.date = a.date AND b.series = 'vix3m' WHERE a.series = 'vix' AND b.value > 0""")}
        raw = defaultdict(dict)
        for d, i, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily WHERE index IN ('VIX','VIX3M')"):
            raw[d][i] = c
    for d, v in raw.items():
        if "VIX" in v and v.get("VIX3M"):
            vx.setdefault(d, v["VIX"] / v["VIX3M"])
    vd = sorted(vx)
    idx = {t: [r[0] for r in H[t]] for t in H}
    spy = H["SPY"]; sd = idx["SPY"]

    rows = []
    for x in T:
        h = H.get(x["t"])
        if not h:
            continue
        i = bisect_right(idx[x["t"]], x["d"]) - 1
        j = bisect_right(idx[x["t"]], x["d"] + timedelta(days=x["days"])) - 1
        if i < 260 or j <= i or not h[i][2]:
            continue
        c = [r[1] for r in h[i - 260:i + 1]]
        ivs = [r[2] for r in h[i - 252:i + 1] if r[2]]
        m50 = np.mean(c[-50:]); s50 = np.std(c[-50:]) or 1
        k = bisect_right(vd, x["d"]) - 1; q = bisect_right(sd, x["d"]) - 1
        iv0 = h[i][2] / 100; Ty = x["days"] / 365
        f = {"ivp": sum(v <= ivs[-1] for v in ivs) / len(ivs), "ivrv": x["ivrv"], "ret5": c[-1] / c[-6] - 1,
             "ret20": c[-1] / c[-21] - 1, "ret60": c[-1] / c[-61] - 1, "z50": (c[-1] - m50) / s50,
             "off_hi": c[-1] / max(c[-252:]) - 1, "rsi": rsi(c), "vixr": vx[vd[k]] if k >= 0 else 1.0,
             "spy20": spy[q][1] / spy[q - 20][1] - 1 if q >= 20 else 0.0}
        z = math.log(h[j][1] / c[-1]) / (iv0 * math.sqrt(Ty))
        rows.append({"t": x["t"], "d": x["d"], "pnl": x["pnl"], "capS": x["capS"], "iv0": iv0, "Ty": Ty, "z": z, **f})
    rows.sort(key=lambda r: r["d"])
    D = np.array([r["d"].toordinal() for r in rows])
    X = np.array([[r[k] for k in FEATS] for r in rows], float)
    P = np.array([r["pnl"] for r in rows]); Z = np.array([r["z"] for r in rows])
    # sanity: re-pricing an option on its OWN move must reproduce its own pnl (strike = S·e^{½σ²T}, debit = capS)
    own = np.array([max(math.exp(r["z"] * r["iv0"] * math.sqrt(r["Ty"])) - math.exp(0.5 * r["iv0"] ** 2 * r["Ty"]), 0) / r["capS"] - 1
                    for r in rows])
    print(f"S179: {len(rows)} long calls with features · own-move repricing vs cache pnl: corr {np.corrcoef(own, P)[0,1]:.3f}, "
          f"median |Δ| {np.median(np.abs(own - P)):.3f}")

    weeks = sorted({r["d"] for r in rows if r["d"] >= START})
    # walk-forward boosted model (refit every 13 weeks on expired trades only): E[pnl] (pnl clipped at +5) and P(win)
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    GP = np.full(len(rows), np.nan); GW = np.full(len(rows), np.nan)
    for b in range(0, len(weeks), 13):
        w0 = weeks[b]; w1 = weeks[min(b + 13, len(weeks)) - 1]
        tr = D <= (w0 - timedelta(days=35)).toordinal()
        te = (D >= w0.toordinal()) & (D <= w1.toordinal())
        kw = dict(max_depth=3, learning_rate=0.05, max_iter=200, min_samples_leaf=200, random_state=179)
        GP[te] = HistGradientBoostingRegressor(**kw).fit(X[tr], np.minimum(P[tr], 5)).predict(X[te])
        GW[te] = HistGradientBoostingClassifier(**kw).fit(X[tr], P[tr] > 0).predict_proba(X[te])[:, 1]
    cols = [FEATS.index(k) for k in NN_FEATS]
    out = []   # per trade: d, pnl, thresh, smooth, e_pnl, p_win, e_move, p_move, p10, p90, base
    for w in weeks:
        cut = (w - timedelta(days=35)).toordinal()
        pool = np.where(D <= cut)[0]
        cur = np.where(D == w.toordinal())[0]
        if len(pool) < 5000 or len(cur) < 20:
            continue
        mu, sdv = X[pool][:, cols].mean(0), X[pool][:, cols].std(0) + 1e-9
        Xp = (X[pool][:, cols] - mu) / sdv
        base = float((P[pool] > 0).mean())
        for c_ in cur:
            r = rows[c_]
            d2 = (((X[c_, cols] - mu) / sdv - Xp) ** 2).sum(1)
            nn = pool[np.argpartition(d2, K_NN)[:K_NN]]
            sp = P[nn]
            kx = math.exp(0.5 * r["iv0"] ** 2 * r["Ty"])
            sm = np.maximum(np.exp(Z[nn] * r["iv0"] * math.sqrt(r["Ty"])) - kx, 0) / r["capS"] - 1
            out.append((w, r["pnl"], thresh(r), smooth(r), sp.mean(), (sp > 0).mean(), sm.mean(), (sm > 0).mean(),
                        np.percentile(sm, 10), np.percentile(sm, 90), base, r, GP[c_], GW[c_]))
    print(f"analog space {NN_FEATS} · walk-forward weeks {len({o[0] for o in out})} · trades scored {len(out)} · k {K_NN}")

    def era(o):
        return "2022-23" if o[0] < SPLIT else "2024→"

    S = {"threshold (prod)": 2, "smooth threshold": 3, "analog E[pnl]": 4, "analog P(win)": 5, "analog repriced E": 6, "analog repriced P": 7, "boosted E[pnl]": 12, "boosted P(win)": 13}
    byw = defaultdict(list)
    for o in out:
        byw[o[0]].append(o)
    print("\nweekly top-quintile mean pnl per $ debit (all calls = baseline) · IC = weekly rank corr score vs pnl")
    print(f"{'score':22s} {'era':8s} {'topQ':>7s} {'botQ':>7s} {'all':>7s} {'IC':>6s} {'t(top−all)':>10s} {'t(top−thr)':>10s}")
    res = {}
    for name, col in S.items():
        for e in ("2022-23", "2024→", "all"):
            tops, bots, alls, ics, d_all, d_thr = [], [], [], [], [], []
            for w, os_ in byw.items():
                if e != "all" and era(os_[0]) != e:
                    continue
                sc = np.array([o[col] for o in os_]); pn = np.array([o[1] for o in os_]); th = np.array([o[2] for o in os_])
                n5 = max(len(os_) // 5, 1)
                top = pn[np.argsort(-sc)[:n5]].mean(); bot = pn[np.argsort(sc)[:n5]].mean(); topth = pn[np.argsort(-th)[:n5]].mean()
                tops.append(top); bots.append(bot); alls.append(pn.mean()); ics.append(spearman(sc, pn))
                d_all.append((w, top - pn.mean())); d_thr.append((w, top - topth))
            t1, _ = month_t(d_all); t2, nm = month_t(d_thr)
            res[(name, e)] = (np.mean(tops), np.mean([x for _, x in d_thr]), t2)
            print(f"{name:22s} {e:8s} {np.mean(tops):+7.3f} {np.mean(bots):+7.3f} {np.mean(alls):+7.3f} {np.nanmean(ics):+6.3f} "
                  f"{t1:10.2f} {t2 if col != 2 else float('nan'):10.2f}")
    print("\ncalibration of P(win) (pnl > 0) · Brier vs the pool base rate (skill > 0 = better than base)")
    for e in ("2022-23", "2024→"):
        oo = [o for o in out if era(o) == e]
        y = np.array([o[1] > 0 for o in oo], float)
        for nm, col in (("analog P(win)", 5), ("analog repriced P", 7), ("boosted P(win)", 13)):
            p = np.array([o[col] for o in oo]); b = np.array([o[10] for o in oo])
            bs, bb = ((p - y) ** 2).mean(), ((b - y) ** 2).mean()
            bins = np.digitize(p, [0.2, 0.3, 0.4, 0.5])
            cal = " ".join(f"[{['<.2','.2-.3','.3-.4','.4-.5','>.5'][k]} n{(bins==k).sum()} hit {y[bins==k].mean():.2f}]" for k in range(5) if (bins == k).sum())
            print(f"  {e} {nm:18s} Brier {bs:.4f} vs base {bb:.4f} skill {1 - bs / bb:+.3f} · {cal}")
    # near-cut: trades the threshold just failed vs just passed, by analog E (does the cliff throw away good ones?)
    print("\nnear the cuts (2022→): mean pnl · n — just inside vs just outside, and analog E[pnl] top half within each")
    for lab, key, cut_, wid, bad_below in (("ret20 ≤ −15 % (penalised)", "ret20", -0.15, 0.03, True),
                                           ("off_hi ≥ −2 % (penalised)", "off_hi", -0.02, 0.01, False),
                                           ("z50 ≥ 1.44 (penalised)", "z50", 1.44, 0.25, False)):
        band = [o for o in out if abs(o[11][key] - cut_) <= wid]
        pen = [o for o in band if (o[11][key] <= cut_) == bad_below]
        ok = [o for o in band if (o[11][key] <= cut_) != bad_below]
        def m(xs):
            return f"{np.mean([o[1] for o in xs]):+.3f} n{len(xs)}" if xs else "—"
        hi = lambda xs: [o for o in xs if o[4] >= np.median([q[4] for q in xs])] if xs else []
        print(f"  {lab:26s} penalised side {m(pen)} (analog top half {m(hi(pen))}) · free side {m(ok)} (analog top half {m(hi(ok))})")
    pickle.dump([o[:11] + ({k: o[11][k] for k in ("t",) + tuple(FEATS)},) + o[12:] for o in out],
                open(Path.home() / ".fildi/cache/s179_scored.pkl", "wb"))


if __name__ == "__main__":
    main()
