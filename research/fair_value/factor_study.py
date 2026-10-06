#!/usr/bin/env python3
"""Valuation factor study on the scorecard-lab grader (scripts/watchlist_sync/analysis/lab.py).

Each valuation ingredient is graded as its own factor with the lab's criteria (monthly rank IC, Newey-West t, hit rate,
quintile monotonicity, 2020-22 vs 2023-26 stability, selloff vs normal, placebo), compared with factors the lab already
validated, tested conditional on momentum/trend, then combined in Fama-MacBeth regressions and a PCA.

Point-in-time inputs: WRDS IBES statsum (FY1/FY2/LTG; restated to today's shares with Yahoo splits), LSEG closes,
LSEG consensus price-target history (starmine_history metric pt_mean), lab_outcomes features/returns.

Usage: scripts/watchlist_sync/.venv/bin/python research/fair_value/factor_study.py WORKDIR
       (WORKDIR holds fred_AAA.csv and splits.json from fetch_inputs.py)
"""
from __future__ import annotations

import csv
import json
import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync" / "analysis"))
import lab as L  # noqa: E402
from build_plan import connect  # noqa: E402

W = Path(sys.argv[1])
SPLITS = json.load(open(W / "splits.json"))
AAA = sorted((r[0], float(r[1]) / 100) for r in csv.reader(open(W / "fred_AAA.csv")) if r[0][:1].isdigit() and r[1] not in (".", ""))

D = L.load()
N = len(D["as_of"])
asof = [date.fromisoformat(x) for x in D["as_of"]]

# ── point-in-time inputs ──────────────────────────────────────────────────────
ibes = defaultdict(lambda: defaultdict(list))
pt = defaultdict(list)
px = defaultdict(list)
with connect() as c:
    for t, sp, fpi, me in c.execute("""SELECT ticker, statpers, fpi, meanest::float FROM wrds_research.ibes_statsum
                                       WHERE measure='EPS' AND fpi IN ('0','1','2') AND meanest IS NOT NULL ORDER BY ticker, statpers"""):
        ibes[t][fpi].append((sp, me))
    for t, d, v in c.execute("SELECT ticker, obs_date, value::float FROM lseg_research.starmine_history WHERE metric='pt_mean' ORDER BY ticker, obs_date"):
        pt[t].append((d, v))
    for t, d, cl in c.execute("SELECT ticker, date, close::float FROM lseg_research.daily_history WHERE close IS NOT NULL ORDER BY ticker, date"):
        px[t].append((d, cl))


def at(series, d, max_age):
    ds = [x[0] for x in series]
    i = bisect_right(ds, d)
    if not i or (d - series[i - 1][0]).days > max_age:
        return None
    return series[i - 1]


def split_adj(t, sp, v):
    ts = datetime.combine(sp, datetime.min.time()).timestamp()
    for when, ratio in SPLITS.get(t, []):
        if when > ts:
            v /= ratio
    return v


def aaa_at(d):
    ds = [x[0] for x in AAA]
    i = bisect_right(ds, d.isoformat())
    return AAA[i - 1][1] if i else None


nan = np.full(N, np.nan)
F = {k: nan.copy() for k in ("ey_fwd", "g_short", "ltg", "graham_gap", "oj_gap", "old_formula_gap", "pt_upside", "pt_rev_3m", "price")}
for i in range(N):
    t, d = D["ticker"][i], asof[i]
    p = at(px[t], d, 7)
    if not p:
        continue
    P = p[1]
    F["price"][i] = P
    e = {}
    for fpi in ("0", "1", "2"):
        x = at(ibes[t][fpi], d, 100) if t in ibes else None
        if x:
            e[fpi] = x[1] / 100 if fpi == "0" else split_adj(t, x[0], x[1])
    e1, e2, ltg = e.get("1"), e.get("2"), e.get("0")
    if e1 is not None:
        F["ey_fwd"][i] = e1 / P                      # forward earnings yield (works for losses too)
    if e1 and e1 > 0 and e2 and e2 > 0:
        F["g_short"][i] = e2 / e1 - 1
    if ltg is not None:
        F["ltg"][i] = ltg
    if e1 and e1 > 0:
        gs = [g for g in (ltg, (e2 / e1 - 1) if e2 and e2 > 0 else None) if g is not None]
        g = min(max(np.mean(gs), 0.0), 0.20) if gs else None
        a = aaa_at(d)
        if g is not None and a:
            F["graham_gap"][i] = math.log(e1 * (8.5 + 200 * g) * 4.4 / (a * 100) / P)
        beta = D["f.beta"][i]
        k = 0.04 + (1.0 if np.isnan(beta) else min(max(beta, 0.6), 2.0)) * 0.05
        if e2 and e2 > 0:
            gsj = min(max(np.mean([x for x in ((e2 / e1 - 1), ltg) if x is not None]), 0), 0.30)
            gl = 0.02
            F["oj_gap"][i] = math.log((e1 / k + e1 * (gsj - gl) / (k * (k - gl))) / P)
        # the old Breakdown formula on point-in-time data: EPS × 2 × growth% (growth = FY1/FY0 proxy via FY2/FY1)
        if e2 and e2 > e1:
            F["old_formula_gap"][i] = math.log(e1 * 2 * (e2 / e1 - 1) * 100 / P)
    a0 = at(pt[t], d, 45)
    if a0:
        F["pt_upside"][i] = math.log(a0[1] / P)
        a3 = at(pt[t], date.fromordinal(d.toordinal() - 91), 45)
        if a3 and a3[1] > 0:
            F["pt_rev_3m"][i] = math.log(a0[1] / a3[1])

# cross-sectional (per date) derived factors
by_date = defaultdict(list)
for i, d in enumerate(D["as_of"]):
    by_date[d].append(i)
F["ey_fwd_vs_peer"] = nan.copy()
F["growth_adj_value"] = nan.copy()   # warranted-P/E gap: residual of earnings yield on growth + sector
for d, idx in by_date.items():
    idx = np.array(idx)
    ey = F["ey_fwd"][idx]
    peers = D["peer"][idx]
    for p in set(peers):
        sel = (peers == p) & ~np.isnan(ey)
        pool = idx[sel]
        if sel.sum() >= 4:
            med = np.median(ey[sel])
            F["ey_fwd_vs_peer"][pool] = F["ey_fwd"][pool] - med
    ok = ~np.isnan(ey) & ~np.isnan(F["g_short"][idx]) & (ey > 0)
    if ok.sum() >= 30:
        sec = np.array([s.split(".")[0] for s in peers[ok]])
        secs = sorted(set(sec))
        X = np.column_stack([np.ones(ok.sum())] + [(sec == s).astype(float) for s in secs[1:]]
                            + [np.clip(F["g_short"][idx][ok], -0.5, 1), np.nan_to_num(F["ltg"][idx][ok], nan=np.nanmedian(F["ltg"][idx][ok]) if np.isfinite(np.nanmedian(F["ltg"][idx][ok])) else 0.1)])
        y = np.log(ey[ok])
        b, *_ = np.linalg.lstsq(X, y, rcond=None)
        F["growth_adj_value"][idx[ok]] = y - X @ b

LAB = L.Lab(D)
TARGETS = [("o.rel_63", 3), ("o.rel_126", 6)]
VAL = ["ey_fwd", "ey_fwd_vs_peer", "growth_adj_value", "graham_gap", "oj_gap", "old_formula_gap", "pt_upside", "pt_rev_3m", "g_short", "ltg"]
KNOWN = {"trend: dist_ma200": D["f.dist_ma200"], "momentum 12-1": D["f.mom_12_1"], "IBES revision breadth": D["fu.ibes_breadth"],
         "52w drawdown": D["f.dd_52w"], "beta": D["f.beta"], "idio vol": D["f.idio_vol"]}
ALL = {**{k: F[k] for k in VAL}, **KNOWN}
ntests = 0

out = ["# Valuation factor study (lab grader)\n",
       f"Rows {N:,} · monthly cross-sections {len(LAB.dates)} · tickers {len(set(D['ticker']))}. Targets: peer-relative forward return.",
       "Pass marks follow lab.py: 1 predictive (IC>0, |NW t|≥2, hit>55%) · 2 monotonic quintiles · 3 stable (same sign 2020-22 & 2023-26).",
       "Multiple testing: with ~40 tests here, expect ~2 with |t|≥2 by luck alone; treat |t|≥3 as the bar (Harvey-Liu-Zhu).\n"]
for tgt, lag in TARGETS:
    out.append(f"\n## Single factors vs {tgt}\n")
    out.append("| factor | coverage | IC | NW t | hit | Q1→Q5 (%) | 2020-22 | 2023-26 | selloff | normal | placebo | passes |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for name, s in ALL.items():
        c = LAB.card(s, D[tgt], lag)
        ntests += 1
        if not c:
            out.append(f"| {name} | {np.mean(~np.isnan(s[LAB.m])):.0%} | — | | | | | | | | | too few months |")
            continue
        pl = LAB.placebo(s, D[tgt])
        passes = ",".join(k.split()[0] for k, v in c["pass"].items() if v and k[0] in "123") or "none"
        q = " / ".join(f"{100 * v:+.1f}" for v in c["q"])
        out.append(f"| {name} | {np.mean(~np.isnan(s[LAB.m])):.0%} | {c['ic']:+.3f} | {c['t']:+.1f} | {c['hit']:.0%} | {q} | "
                   f"{c['h1']:+.3f} | {c['h2']:+.3f} | {c['selloff']:+.3f} | {c['normal']:+.3f} | {pl:+.3f} | {passes} |")

# conditional: value inside momentum / trend halves; partial IC controlling for momentum
out.append("\n## Value conditional on momentum (target rel_126)\n")
out.append("| factor | IC, all | partial IC (control: 12-1 momentum) | IC among top-half momentum | IC among bottom-half momentum |")
out.append("|---|---|---|---|---|")
mom = D["f.mom_12_1"]
hi = np.zeros(N, bool)
for d, idx in by_date.items():
    idx = np.array(idx)
    m = mom[idx]
    if np.sum(~np.isnan(m)) > 10:
        hi[idx] = m >= np.nanmedian(m)
for name in ["ey_fwd", "ey_fwd_vs_peer", "growth_adj_value", "graham_gap", "pt_upside", "pt_rev_3m"]:
    s = F[name]
    a = np.nanmean(LAB.ic_series(s, D["o.rel_126"]))
    pc = np.nanmean(LAB.ic_series(s, D["o.rel_126"], control=mom))
    sh, sl = s.copy(), s.copy()
    sh[~hi] = np.nan
    sl[hi] = np.nan
    ih, il = np.nanmean(LAB.ic_series(sh, D["o.rel_126"])), np.nanmean(LAB.ic_series(sl, D["o.rel_126"]))
    ntests += 3
    out.append(f"| {name} | {a:+.3f} | {pc:+.3f} | {ih:+.3f} | {il:+.3f} |")

# Fama-MacBeth: monthly cross-sectional OLS of ranked rel_126 on ranked factors
def fama_macbeth(names, cols, tgt="o.rel_126", lag=6):
    coefs = []
    for d in LAB.dates:
        g = np.array(LAB.groups[d])
        X = np.column_stack([cols[n][g] for n in names])
        y = D[tgt][g]
        ok = ~np.isnan(y) & ~np.isnan(X).any(axis=1)
        if ok.sum() < 40:
            continue
        Xr = np.column_stack([L.rankc(X[ok][:, j]) for j in range(len(names))])
        yr = L.rankc(y[ok])
        b, *_ = np.linalg.lstsq(np.column_stack([np.ones(ok.sum()), Xr]), yr, rcond=None)
        coefs.append(b[1:])
    C = np.array(coefs)
    return [(n, float(C[:, j].mean()), float(L.nw_t(C[:, j], lag))) for j, n in enumerate(names)], len(C)

out.append("\n## Fama-MacBeth (ranked rel_126 on ranked factors; coef = return-rank change per rank of factor)\n")
for spec in (["ey_fwd"], ["ey_fwd", "momentum 12-1"], ["ey_fwd", "momentum 12-1", "trend: dist_ma200", "IBES revision breadth", "beta", "idio vol"],
             ["growth_adj_value", "momentum 12-1", "IBES revision breadth", "beta"], ["pt_upside", "pt_rev_3m", "momentum 12-1"]):
    res, n = fama_macbeth(spec, ALL)
    ntests += len(res)
    out.append(f"- {' + '.join(spec)} ({n} months): " + "; ".join(f"**{k}** {b:+.3f} (t {t:+.1f})" for k, b, t in res))

# PCA on monthly cross-sectional ranks
names = ["ey_fwd", "growth_adj_value", "g_short", "pt_upside", "pt_rev_3m", "momentum 12-1", "trend: dist_ma200", "52w drawdown",
         "IBES revision breadth", "beta", "idio vol"]
Z, Y, Dt = [], [], []
for d in LAB.dates:
    g = np.array(LAB.groups[d])
    X = np.column_stack([ALL[n][g] for n in names])
    ok = ~np.isnan(X).any(axis=1)
    if ok.sum() < 30:
        continue
    Z.append(np.column_stack([L.rankc(X[ok][:, j]) for j in range(len(names))]))
    Y.append(D["o.rel_126"][g][ok])
    Dt.append(np.full(ok.sum(), d))
Z, Y, Dt = np.vstack(Z), np.concatenate(Y), np.concatenate(Dt)
Zs = (Z - Z.mean(0)) / Z.std(0)
vals, vecs = np.linalg.eigh(np.corrcoef(Zs.T))
order = vals.argsort()[::-1]
vals, vecs = vals[order], vecs[:, order]
out.append(f"\n## PCA of factor ranks ({len(Z):,} stock-months with all factors)\n")
out.append("| PC | var | top loadings | IC vs rel_126 (NW t) |")
out.append("|---|---|---|---|")
for k in range(5):
    v = vecs[:, k]
    if v[names.index("momentum 12-1")] < 0:
        v = -v
    score = Zs @ v
    ics = []
    for d in sorted(set(Dt)):
        m = (Dt == d) & ~np.isnan(Y)
        if m.sum() >= 30:
            a, b = L.rankc(score[m]), L.rankc(Y[m])
            ics.append(float(np.corrcoef(a, b)[0, 1]))
    ntests += 1
    top = sorted(zip(names, v), key=lambda x: -abs(x[1]))[:4]
    out.append(f"| PC{k + 1} | {vals[k] / vals.sum():.0%} | " + ", ".join(f"{n} {w:+.2f}" for n, w in top)
               + f" | {np.mean(ics):+.3f} ({L.nw_t(np.array(ics), 6):+.1f}) |")
out.append(f"\nTests run: {ntests}.")
txt = "\n".join(out)
(Path(__file__).parent / "FACTOR_STUDY.md").write_text(txt + "\n")
print(txt)
