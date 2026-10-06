#!/usr/bin/env python3
"""Scorecard lab: grade Fildi's scorecards (replayed history) against the claim each one makes. Read-only.

Inputs (built once, re-used by every test): watchlist_sync.lab_tech (lab-replay-technicals.ts: live engines replayed),
watchlist_sync.lab_outcomes (lab_outcomes.py: forward outcomes + point-in-time candidate features). A local cache
(out/lab/cache.npz) makes re-runs take seconds; it rebuilds when either table changes.

A score is GOOD when the claim it makes comes true (strategy-neutral; strategies only choose how to *use* a score):
  1 predictive   monthly rank IC vs its target > 0 with Newey-West |t| ≥ 2, hit rate > 55%
  2 monotonic    quintile means rise Q1 → Q5 (Spearman of quintile index vs mean ≥ 0.9)
  3 stable       same sign in 2020–22 and 2023–26, and in broad selloffs (median stock ≥ 20% off its high) vs normal
  4 out-of-sample  weights only change if a variant beats the champion on held-out years (paired t ≥ 2) — see `weights`
  5 beats a simple baseline (one raw feature) on the same target
  6 not redundant  |corr| with the other scorecards < 0.7 and it adds IC beyond them
Sanity checks run first: placebo (score shuffled within date → IC ≈ 0) and IV-mechanics (options targets measured with IV held fixed).

Usage: .venv/bin/python analysis/lab.py [report|weights|pca] → out/lab/*.md
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "lab"
V2 = ["oversoldDepth", "reversalSignal", "volatilityState", "trendContext", "optionsFlow", "volumeConfirm"]
V2_W = {"oversoldDepth": 0.25, "reversalSignal": 0.20, "volatilityState": 0.22, "trendContext": 0.18, "optionsFlow": 0.10, "volumeConfirm": 0.05}
FEATS = ["dd_52w", "mom_12_1", "dist_ma200", "rev5", "beta", "idio_vol", "iv30", "iv_rv", "iv_rank_1y", "earnings_21", "alpha",
         "mkt_med_dd", "spy_dd_52w", "spy_vrp"]
OUTS = ["ret_5", "ret_21", "ret_63", "ret_126", "rel_5", "rel_21", "rel_63", "rel_126", "mae_21", "mfe_21", "rv_fwd_21", "vrp_real"]
CACHE_VERSION = "4"   # bump when load() changes
ENGINE = ""           # engine digest to grade; default = the most recently replayed base engine (--engine to pin)
INPUTS = ["realizedVol20d", "rsi14Pct", "mfi14Pct", "stochPct", "priceVsMa50Atr", "priceVsMa200Atr", "ivRankRvProxy", "ivRankEffective", "ivVsRealizedVol",
          "bbWidthPct", "vsSpy20d", "earningsDaysOut"]


# ---------------- data ----------------
def load() -> dict:
    global ENGINE
    OUT.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        stamp = conn.execute("""SELECT (SELECT max(computed_at)::text FROM watchlist_sync.lab_tech) || '|' ||
                                       (SELECT max(computed_at)::text FROM watchlist_sync.lab_outcomes) || '|' ||
                                       COALESCE((SELECT max(computed_at)::text FROM watchlist_sync.lab_fund), '')""").fetchone()[0]
        ENGINE = ENGINE or conn.execute("""SELECT engine_digest FROM watchlist_sync.lab_tech WHERE engine_digest NOT LIKE '%-%'
                                            GROUP BY 1 ORDER BY max(computed_at) DESC LIMIT 1""").fetchone()[0]
        key = hashlib.sha1((stamp + CACHE_VERSION + ENGINE).encode()).hexdigest()[:10]
        cache = OUT / f"cache_{key}.npz"
        if cache.exists():
            z = np.load(cache, allow_pickle=True)
            return {k: z[k] for k in z.files}
        ENGINE = ENGINE or conn.execute("""SELECT engine_digest FROM watchlist_sync.lab_tech WHERE engine_digest NOT LIKE '%-%'
                                            GROUP BY 1 ORDER BY max(computed_at) DESC LIMIT 1""").fetchone()[0]
        R = rows(conn, """SELECT t.ticker, t.as_of, t.inputs, t.v2, t.v4_put, t.v4_call, o.outcomes, o.features, x.v2 v2x, x.v4_put v4px,
                                 COALESCE(fu.features, '{}'::jsonb) fund
                          FROM watchlist_sync.lab_tech t JOIN watchlist_sync.lab_outcomes o USING (ticker, as_of)
                          LEFT JOIN watchlist_sync.lab_fund fu USING (ticker, as_of)
                          LEFT JOIN watchlist_sync.lab_tech x ON x.ticker = t.ticker AND x.as_of = t.as_of AND x.engine_digest = t.engine_digest || '-ivhist'
                          WHERE t.engine_digest = %s ORDER BY t.as_of, t.ticker""", (ENGINE,))
    n = len(R)
    D = {"ticker": np.array([r["ticker"] for r in R]), "as_of": np.array([r["as_of"].isoformat() for r in R]),
         "peer": np.array([str(r["inputs"].get("peerGroupId")) for r in R])}

    def col(get):
        return np.array([np.nan if (v := get(r)) is None else float(v) for r in R])

    D["v2_total"] = col(lambda r: (r["v2"] or {}).get("total"))
    for k in V2:
        D[f"v2.{k}"] = col(lambda r, k=k: (r["v2"] or {}).get("comps", {}).get(k))
    for side in ("put", "call"):
        D[f"v4{side[0]}_total"] = col(lambda r, s=side: (r[f"v4_{s}"] or {}).get("total"))
        keys = sorted({k for r in R[:2000] for k in ((r[f"v4_{side}"] or {}).get("comps") or {})})
        for k in keys:
            D[f"v4{side[0]}.{k}"] = col(lambda r, s=side, k=k: ((r[f"v4_{s}"] or {}).get("comps") or {}).get(k))
    D["v2x_total"] = col(lambda r: (r["v2x"] or {}).get("total"))
    D["v4px_total"] = col(lambda r: (r["v4px"] or {}).get("total"))
    D["v2x.volatilityState"] = col(lambda r: ((r["v2x"] or {}).get("comps") or {}).get("volatilityState"))
    for k in INPUTS:
        D[f"in.{k}"] = col(lambda r, k=k: r["inputs"].get(k))
    D["in.fallingKnife"] = col(lambda r: r["inputs"].get("fallingKnife"))
    for k in FEATS:
        D[f"f.{k}"] = col(lambda r, k=k: r["features"].get(k))
    for k in ("ibes_breadth", "ibes_drift", "ibes_drift_3m", "ibes_disp", "ibes_sue", "ibes_numest"):
        D[f"fu.{k}"] = col(lambda r, k=k: r["fund"].get(k))
    for k in OUTS:
        D[f"o.{k}"] = col(lambda r, k=k: r["outcomes"].get(k))
    # volatility-normalized timing targets: worst drop / best rise in units of the stock's own expected 21-day move at entry
    # _z  = ÷ the vol that actually followed (direction/path only; immune to vol mean-reversion and to IV level)
    # _iv = ÷ the implied move at entry (did the stock fall/rise further than options priced? the seller's question)
    sf = D["o.rv_fwd_21"] / 100 * math.sqrt(21 / 252)
    si = D["f.iv30"] / 100 * math.sqrt(21 / 252)
    with np.errstate(divide="ignore", invalid="ignore"):
        D["o.mae_z"] = np.where(sf > 0, D["o.mae_21"] / sf, np.nan)
        D["o.mfe_z"] = np.where(sf > 0, D["o.mfe_21"] / sf, np.nan)
        D["o.mae_iv"] = np.where(si > 0, D["o.mae_21"] / si, np.nan)
        D["o.mfe_iv"] = np.where(si > 0, D["o.mfe_21"] / si, np.nan)
    for old in OUT.glob("cache_*.npz"):
        old.unlink()
    np.savez(cache, **D)
    print(f"lab cache built: {n:,} rows → {cache.name}")
    return D


def month_mask(D):
    """First replay date of each month (non-overlapping 21d samples)."""
    seen, m = set(), np.zeros(len(D["as_of"]), bool)
    dates = sorted(set(D["as_of"]))
    firsts = {d for d in dates if d[:7] not in seen and not seen.add(d[:7])}
    for i, d in enumerate(D["as_of"]):
        m[i] = d in firsts
    return m


# ---------------- statistics ----------------
def rankc(x):
    """Ranks centered to (−0.5, 0.5), NaN preserved (average ties)."""
    out = np.full(len(x), np.nan)
    ok = ~np.isnan(x)
    v = x[ok]
    if len(v) < 2:
        return out
    order = v.argsort(kind="mergesort")
    r = np.empty(len(v))
    r[order] = np.arange(len(v))
    # average ties
    _, inv, cnt = np.unique(v, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=r)
    r = sums[inv] / cnt[inv]
    out[ok] = (r + 0.5) / len(v) - 0.5
    return out


def nw_t(x, lag):
    x = np.asarray([v for v in x if not np.isnan(v)])
    n = len(x)
    if n < 8:
        return np.nan
    e = x - x.mean()
    s = e @ e / n
    for l in range(1, lag + 1):
        s += 2 * (1 - l / (lag + 1)) * (e[l:] @ e[:-l]) / n
    return x.mean() / math.sqrt(s / n) if s > 0 else np.nan


class Lab:
    def __init__(self, D, sample="month"):
        self.D = D
        self.m = month_mask(D) if sample == "month" else np.ones(len(D["as_of"]), bool)
        idx = np.where(self.m)[0]
        self.groups = defaultdict(list)
        for i in idx:
            self.groups[D["as_of"][i]].append(i)
        self.dates = sorted(self.groups)
        self.year = {d: int(d[:4]) for d in self.dates}
        mk = D["f.mkt_med_dd"]
        self.selloff = {d: mk[self.groups[d][0]] <= -0.20 for d in self.dates}

    def ic_series(self, s, y, control=None):
        out = []
        for d in self.dates:
            g = np.array(self.groups[d])
            a, b = s[g], y[g]
            ok = ~np.isnan(a) & ~np.isnan(b)
            if control is not None:
                ok &= ~np.isnan(control[g])
            if ok.sum() < 30:
                out.append(np.nan)
                continue
            ra, rb = rankc(a[ok]), rankc(b[ok])
            if control is not None:  # partial: residualize both ranks on the control's rank
                rc = rankc(control[g][ok])
                for v in (ra, rb):
                    v -= rc * (np.dot(rc, v) / np.dot(rc, rc))
            sd = ra.std() * rb.std()
            out.append(float(np.mean((ra - ra.mean()) * (rb - rb.mean())) / sd) if sd > 0 else np.nan)
        return np.array(out)

    def quintiles(self, s, y):
        acc = defaultdict(list)
        for d in self.dates:
            g = np.array(self.groups[d])
            ok = ~np.isnan(s[g]) & ~np.isnan(y[g])
            if ok.sum() < 30:
                continue
            q = np.minimum(4, (rankc(s[g][ok]) + 0.5) * 5).astype(int)
            for k in range(5):
                if (q == k).any():
                    acc[k].append(np.median(y[g][ok][q == k]))
        return [float(np.mean(acc[k])) if acc[k] else np.nan for k in range(5)]

    def card(self, s, y, lag, base=None, others=(), control=None):
        ics = self.ic_series(s, y, control)
        good = ~np.isnan(ics)
        if good.sum() < 12:
            return None
        icm, t = float(np.nanmean(ics)), float(nw_t(ics, lag))
        hit = float(np.mean(ics[good] > 0))
        q = self.quintiles(s, y)
        mono = float(np.corrcoef(np.arange(5), rankc(np.array(q)))[0, 1]) if not np.isnan(q).any() else np.nan
        h1 = float(np.nanmean([v for d, v in zip(self.dates, ics) if self.year[d] <= 2022]))
        h2 = float(np.nanmean([v for d, v in zip(self.dates, ics) if self.year[d] >= 2023]))
        so = float(np.nanmean([v for d, v in zip(self.dates, ics) if self.selloff[d]]))
        nm = float(np.nanmean([v for d, v in zip(self.dates, ics) if not self.selloff[d]]))
        c = {"ic": icm, "t": t, "hit": hit, "q": q, "mono": mono, "h1": h1, "h2": h2, "selloff": so, "normal": nm, "months": int(good.sum())}
        if base is not None:
            c["base_ic"] = float(np.nanmean(self.ic_series(base, y, control)))
        red = []
        for name, o in others:
            ok = ~np.isnan(s) & ~np.isnan(o) & self.m
            red.append((name, float(np.corrcoef(rankc(s[ok]), rankc(o[ok]))[0, 1]) if ok.sum() > 100 else np.nan))
        c["corr"] = red
        sign_ok = (h1 > 0) == (h2 > 0) and (so > 0) == (nm > 0) or (abs(so) < 0.01)
        c["pass"] = {
            "1 predictive": icm > 0 and abs(t) >= 2 and hit > 0.55,
            "2 monotonic": not np.isnan(mono) and mono >= 0.9,
            "3 stable": bool(sign_ok and h1 > 0 and h2 > 0),
            "5 beats baseline": base is None or icm > c["base_ic"],
            "6 not redundant": all(abs(v) < 0.7 for _, v in red if not np.isnan(v)),
        }
        return c

    def placebo(self, s, y, seed=7):
        rng = np.random.default_rng(seed)
        sh = s.copy()
        for d in self.dates:
            g = np.array(self.groups[d])
            sh[g] = rng.permutation(sh[g])
        return float(np.nanmean(self.ic_series(sh, y)))


def composite(D, weights, prefix="v2."):
    """Engine-style weighted mean over available components (re-normalized when a component is missing)."""
    num = np.zeros(len(D["as_of"]))
    den = np.zeros(len(D["as_of"]))
    for k, w in weights.items():
        x = D[f"{prefix}{k}"] if f"{prefix}{k}" in D else D[k]
        ok = ~np.isnan(x)
        num[ok] += w * x[ok]
        den[ok] += w
    out = np.full(len(num), np.nan)
    out[den > 0] = num[den > 0] / den[den > 0]
    return out


def fmt_q(v, target):
    if np.isnan(v):
        return "—"
    if target in ("vrp_real", "mae_z", "mfe_z", "−mfe_z", "mae_iv", "mfe_iv", "−mfe_iv"):
        return f"{v:+.2f}"
    return f"{100 * v:+.1f}"


def fmt_card(name, c, target):
    if c is None:
        return f"| {name} | {target} | not enough data |" + " |" * 9
    p = c["pass"]
    marks = "".join("✅" if p[k] else "❌" for k in ("1 predictive", "2 monotonic", "3 stable", "5 beats baseline", "6 not redundant"))
    q = " / ".join(fmt_q(v, target.split(" | ")[0]) for v in c["q"])
    base = f"{c.get('base_ic', float('nan')):+.3f}" if "base_ic" in c else "—"
    return (f"| {name} | {target} | {c['ic']:+.3f} | {c['t']:+.1f} | {c['hit']:.0%} | {q} | {c['h1']:+.3f} / {c['h2']:+.3f} | "
            f"{c['selloff']:+.3f} / {c['normal']:+.3f} | {base} | {marks} |")


HEAD = ["| score | target | IC | t | hit | quintile medians Q1→Q5 (% · σ-units for _z · pts for vrp) | 2020–22 / 2023–26 | selloff / normal | baseline IC | 1 2 3 5 6 |",
        "|---|---|---|---|---|---|---|---|---|---|"]


# ---------------- reports ----------------
def report(D) -> str:
    L = Lab(D, "month")
    W = Lab(D, "week")
    y = lambda k: D[f"o.{k}"]
    neg = lambda x: -x
    L_ = [f"# Scorecard lab report ({date.today()})", "",
          f"Engine {ENGINE} · {len(D['as_of']):,} replayed (ticker, date) rows · {len(set(D['ticker']))} names · {min(D['as_of'])} → {max(D['as_of'])} · "
          f"monthly samples for ≥ 21-day targets, weekly for 5-day. Engines replayed from live code (lab-replay-technicals.ts).", "",
          "Pass marks: 1 predictive · 2 monotonic · 3 stable · 5 beats a one-feature baseline · 6 not redundant (criterion 4 = `lab.py weights`).", ""]
    # sanity
    pl = L.placebo(D["v2_total"], y("rel_21"))
    ivc = float(np.nanmean(L.ic_series(D["f.iv30"], y("vrp_real"))))
    L_ += ["## Sanity checks", "",
           f"- Placebo (v2 total shuffled within each date) vs 21d peer-relative return: IC {pl:+.4f} (should be ≈ 0).",
           f"- IV mechanics: raw IV level vs realized variance premium IC {ivc:+.3f}. High-IV names show bigger premiums in points by construction, "
           "so every options-claim test below is also shown with IV held fixed.", ""]

    # TECHNICALS
    L_ += ["## Technicals: v2 (UI / snapshots) and v4 (options scanner)", "",
           "Claims tested: **trend** (score ↑ → stock beats peers next 1–3 months) and **entry timing for puts** (score ↑ → smaller "
           "worst-drop over the next 21 days, better 5-day return). Call side (v4 call): score ↑ → smaller best-rise over 21 days "
           "(stock less likely to run through a call).", ""] + HEAD
    others_t = [("v4 put", D["v4p_total"]), ("fund-proxy alpha", D["f.alpha"])]
    rows_ = [
        ("v2 total", D["v2_total"], "rel_21", L, 1, D["f.mom_12_1"], [("v4 put", D["v4p_total"])]),
        ("v2 total", D["v2_total"], "rel_63", L, 3, D["f.mom_12_1"], []),
        ("v2 total", D["v2_total"], "mae_z", L, 1, D["f.dist_ma200"], []),
        ("v2 total", D["v2_total"], "rel_5", W, 1, D["f.rev5"] * -1, []),
        ("v4 put total", D["v4p_total"], "rel_21", L, 1, D["f.mom_12_1"], [("v2", D["v2_total"])]),
        ("v4 put total", D["v4p_total"], "mae_z", L, 1, D["f.dist_ma200"], []),
        ("v4 put total", D["v4p_total"], "rel_5", W, 1, -D["f.rev5"], []),
        ("v4 call total", D["v4c_total"], "−mfe_z", L, 1, -D["f.mom_12_1"], [("v4 put", D["v4p_total"])]),
        ("v2 total · true IV rank", D["v2x_total"], "rel_21", L, 1, D["f.mom_12_1"], []),
        ("v2 total · true IV rank", D["v2x_total"], "mae_z", L, 1, D["f.dist_ma200"], []),
    ]
    cards = {}
    for name, s, tg, lab, lag, base, oth in rows_:
        yy = -y("mfe_z") if tg == "−mfe_z" else y(tg)
        c = lab.card(s, yy, lag, base, oth)
        cards[(name, tg)] = c
        L_.append(fmt_card(name, c, tg))
    L_ += ["", "Baselines: 12-1 momentum for trend targets, distance from the 200-day average for worst-drop, −5d return (reversal) for "
           "5-day targets. mae_z / mfe_z = worst drop / best rise over 21 days ÷ the volatility that actually followed (direction only; dividing "
           "by trailing vol instead made high IV/RV names look worse because vol mean-reverts). Raw % drops are dominated by volatility (low-vol names drop less by construction: IC of −idio vol on raw drop = +0.43), "
           "which would make any timing score look bad or good for the wrong reason.", ""]

    # components
    L_ += ["### Components (which parts of the technical scores carry the signal)", ""] + HEAD
    comp_targets = [("rel_21", L, 1), ("mae_z", L, 1)]
    comp_cards = {}
    for k in V2:
        for tg, lab, lag in comp_targets:
            c = lab.card(D[f"v2.{k}"], y(tg), lag)
            comp_cards[(f"v2.{k}", tg)] = c
            L_.append(fmt_card(f"v2.{k}", c, tg))
    v4k = sorted(k for k in D if k.startswith("v4p."))
    for k in v4k:
        for tg, lab, lag in comp_targets:
            c = lab.card(D[k], y(tg), lag)
            comp_cards[(k, tg)] = c
            L_.append(fmt_card(k, c, tg))
    L_ += ["", "### Candidate additions (Step 8 factors, not in any scorecard today)", ""] + HEAD
    for k in ["f.mom_12_1", "f.dist_ma200", "f.dd_52w", "in.priceVsMa200Atr"]:
        for tg, lab, lag in (("rel_21", L, 1), ("rel_63", L, 3)):
            L_.append(fmt_card(k, lab.card(D[k], y(tg), lag), tg))
    for k in ["f.idio_vol", "f.beta"]:
        L_.append(fmt_card(f"−{k}", L.card(-D[k], y("mae_z"), 1), "mae_z"))
        L_.append(fmt_card(f"−{k} (raw % drop, mechanical)", L.card(-D[k], y("mae_21"), 1), "mae_21"))

    # OPTIONS pricing
    L_ += ["", "## Options: pricing components (claim: score ↑ → options were rich vs what the stock then did)", "",
           "Target = entry 30d ATM IV − realized vol over the next 21 days. Second line of each pair holds the IV level fixed.", ""] + HEAD
    for name, s in [("IV/RV (LSEG)", D["f.iv_rv"]), ("IV rank 1y (LSEG hist)", D["f.iv_rank_1y"]), ("ivRank RV-proxy (live today)", D["in.ivRankRvProxy"]),
                    ("v2.volatilityState", D["v2.volatilityState"]), ("v4p.volatilityState", D.get("v4p.volatilityState", D["v2.volatilityState"])),
                    ("BB width pct (squeeze)", -D["in.bbWidthPct"])]:
        L_.append(fmt_card(name, L.card(s, y("vrp_real"), 1), "vrp_real"))
        L_.append(fmt_card(name + " | IV fixed", L.card(s, y("vrp_real"), 1, control=D["f.iv30"]), "vrp_real"))
    L_ += ["", "Seller's view: worst drop (puts) / best rise (calls) over 21 days in units of the implied move at entry "
           "(−1 = the stock moved exactly one implied σ against the seller).", ""] + HEAD
    for name, s in [("IV/RV (LSEG)", D["f.iv_rv"]), ("IV rank 1y (LSEG hist)", D["f.iv_rank_1y"]), ("v4p.volatilityState", D.get("v4p.volatilityState")),
                    ("v4 put total", D["v4p_total"])]:
        L_.append(fmt_card(name, L.card(s, y("mae_iv"), 1), "mae_iv"))
    for name, s in [("IV/RV (LSEG)", D["f.iv_rv"]), ("v4 call total", D["v4c_total"])]:
        L_.append(fmt_card(name + " (calls)", L.card(s, -y("mfe_iv"), 1), "−mfe_iv"))
    L_ += ["", "## Fundamentals: analyst-expectations family (the only fundamentals family with point-in-time history)", "",
           "Claim: score ↑ → the stock beats its peers over the next 3–6 months (ownership). Definitions mirror the live engine "
           "(ibesRevBreadth, avgIbesSue, mean-estimate drift). Baseline = 12-1 momentum (revisions often just follow price).", ""] + HEAD
    rk0 = lambda x: rankc_by_date(D, x, L)
    expect = np.nanmean(np.vstack([rk0(D["fu.ibes_breadth"]), rk0(D["fu.ibes_drift_3m"]), rk0(D["fu.ibes_sue"])]), axis=0)
    trend0 = np.nanmean(np.vstack([rk0(D["in.priceVsMa200Atr"]), rk0(D["f.mom_12_1"])]), axis=0)
    for name, sc in [("IBES revision breadth (engine)", D["fu.ibes_breadth"]), ("IBES mean drift, last month (engine)", D["fu.ibes_drift"]),
                     ("IBES mean drift, 3 months", D["fu.ibes_drift_3m"]), ("IBES SUE avg last 4 (engine)", D["fu.ibes_sue"]),
                     ("−IBES dispersion", -D["fu.ibes_disp"]), ("StarMine combined alpha", D["f.alpha"]), ("EXPECTATIONS composite", expect)]:
        for tg, lag in (("rel_63", 3), ("rel_126", 6)):
            c = L.card(sc, y(tg), lag, base=D["f.mom_12_1"], others=[("TECH TREND", trend0)])
            cards[(name, tg)] = c
            L_.append(fmt_card(name, c, tg))
    # incremental: does EXPECTATIONS add beyond TECH TREND? (partial IC holding trend fixed)
    for tg, lag in (("rel_63", 3), ("rel_126", 6)):
        c = L.card(expect, y(tg), lag, control=trend0)
        L_.append(fmt_card("EXPECTATIONS | TECH TREND fixed", c, tg))
    # ---- proposed restructure (each part graded on its own claim) ----
    rk = lambda x: rankc_by_date(D, x, L)
    trend = np.nanmean(np.vstack([rk(D["in.priceVsMa200Atr"]), rk(D["f.mom_12_1"])]), axis=0)
    ivr = np.where(np.isnan(D["f.iv_rank_1y"]), np.nan, D["f.iv_rank_1y"])
    pricing = 0.7 * rk(D["f.iv_rv"]) + 0.3 * np.where(np.isnan(ivr), rk(D["f.iv_rv"]), ivr - 0.5)
    L_ += ["", "## Proposed restructure (graded on each part's own claim)", "",
           "TECH TREND = mean rank of price vs 200-day average (ATR units, already computed live but unused) and 12-1 momentum. "
           "OPTIONS PRICING = 0.7 · IV/RV rank + 0.3 · 1-year IV rank (true IV history), i.e. today's Model List PREMIUM, moved into the "
           "options scorecard. These were chosen after Step 8 (different targets, 2020–26), so the 2024–26 column is the cleaner read.", ""] + HEAD
    for name, sc, tg, lag, base in [("TECH TREND", trend, "rel_63", 3, D["f.mom_12_1"]), ("TECH TREND", trend, "rel_21", 1, D["f.mom_12_1"]),
                                    ("TECH TREND", trend, "mae_z", 1, D["f.dist_ma200"]),
                                    ("OPTIONS PRICING", pricing, "vrp_real", 1, D["f.iv_rv"]), ("OPTIONS PRICING", pricing, "mae_iv", 1, D["f.iv_rv"]),
                                    ("OPTIONS PRICING (calls)", pricing, "−mfe_iv", 1, D["f.iv_rv"])]:
        yy = -y("mfe_iv") if tg == "−mfe_iv" else y(tg)
        c = L.card(sc, yy, lag, base, [("v2 total", D["v2_total"]), ("v4 put", D["v4p_total"])] + ([("TECH TREND", trend)] if name.startswith("OPT") else [("OPTIONS PRICING", pricing)]))
        cards[(name, tg)] = c
        L_.append(fmt_card(name, c, tg))
        if c:
            yrs = np.array([L.year[d] >= 2024 for d in L.dates])
            ics = L.ic_series(sc, yy)
            L_.append(f"| ↳ 2024–26 only | {tg} | {np.nanmean(ics[yrs]):+.3f} | {nw_t(ics[yrs], lag):+.1f} | | | | | | |")
    L_ += ["", "### Call side: what predicts the stock running through a short call (best rise in implied-σ units)?", ""] + HEAD
    for name, sc in [("−12-1 momentum", -D["f.mom_12_1"]), ("−20d vs SPY", -D["in.vsSpy20d"]), ("RSI pct (overbought)", D["in.rsi14Pct"]),
                     ("−price vs MA200", -D["in.priceVsMa200Atr"]), ("IV/RV", D["f.iv_rv"]), ("v4 call total", D["v4c_total"])]:
        L_.append(fmt_card(name, L.card(sc, -y("mfe_iv"), 1), "−mfe_iv"))
    # ---- market regime (time series, one value per month): does the seller's outcome depend on the regime? ----
    L_ += ["", "## Market regime layer (per month, all names): seller outcomes by regime", "",
           "| regime bucket | months | median stock drop vs implied move (puts) | P(drop > 1 implied σ) | realized VRP (pts) | 21d rel. return spread, TECH TREND Q5−Q1 |",
           "|---|---|---|---|---|---|"]
    mk, sv = D["f.mkt_med_dd"], D["f.spy_vrp"]
    for lab_, cond in [("breadth: median stock ≥ 20% off high", lambda i: mk[i] <= -0.20), ("breadth: normal", lambda i: mk[i] > -0.20),
                       ("SPY VRP > 4 pts (rich)", lambda i: sv[i] > 4), ("SPY VRP 0–4", lambda i: 0 <= sv[i] <= 4), ("SPY VRP < 0 (panic)", lambda i: sv[i] < 0)]:
        ds = [d for d in L.dates if cond(L.groups[d][0])]
        if not ds:
            continue
        g = np.concatenate([L.groups[d] for d in ds])
        m = D["o.mae_iv"][g]
        sp = []
        for d in ds:
            gg = np.array(L.groups[d])
            r = rankc(trend[gg]); yy = D["o.rel_21"][gg]
            ok = ~np.isnan(r) & ~np.isnan(yy)
            if ok.sum() > 30:
                sp.append(np.nanmedian(yy[ok][r[ok] >= 0.3]) - np.nanmedian(yy[ok][r[ok] < -0.3]))
        L_.append(f"| {lab_} | {len(ds)} | {np.nanmedian(m):+.2f} σ | {np.nanmean(m < -1):.0%} | {np.nanmedian(D['o.vrp_real'][g]):+.1f} | {100 * np.nanmean(sp):+.2f}% |")
    (OUT / "report.md").write_text("\n".join(L_) + "\n")
    json.dump({f"{a}|{b}": v for (a, b), v in {**cards, **comp_cards}.items()}, open(OUT / "report.json", "w"), default=str, indent=1)
    return "\n".join(L_)


def pca(D) -> str:
    L = Lab(D, "month")
    names = [f"v2.{k}" for k in V2 if k != "optionsFlow"] + [k for k in D if k.startswith("v4p.") and k not in ("v4p.optionsFlow", "v4p.analystUpside")] + \
            ["f.mom_12_1", "f.dist_ma200", "f.dd_52w", "f.idio_vol", "f.beta", "f.iv_rv", "f.iv_rank_1y", "f.alpha", "in.ivRankRvProxy"]
    names = [n for n in names if n in D and np.mean(~np.isnan(D[n][L.m])) > 0.5]
    idx = np.where(L.m)[0]
    X = np.zeros((len(idx), len(names)))
    pos = {i: n for n, i in enumerate(idx)}
    for d in L.dates:
        g = np.array(L.groups[d])
        for c, nme in enumerate(names):
            r = rankc(D[nme][g])
            X[[pos[i] for i in g], c] = np.nan_to_num(r)
    Xs = (X - X.mean(0)) / np.where(X.std(0) > 0, X.std(0), 1)
    C = np.corrcoef(Xs, rowvar=False)
    w, V = np.linalg.eigh(C)
    o = np.argsort(w)[::-1]
    w, V = w[o] / w.sum(), V[:, o]
    k = int(np.searchsorted(np.cumsum(w), 0.8) + 1)
    out = [f"# Scorecard lab PCA ({date.today()})", "", f"{len(names)} components/features, monthly cross-sectional ranks, {len(idx):,} rows. "
           f"{k} PCs explain {np.cumsum(w)[k - 1]:.0%}.", "", "| PC | var | top loadings | IC rel_21 | IC mae_z | IC rel_63 |", "|---|---|---|---|---|---|"]
    for j in range(k):
        v = V[:, j] * (1 if V[np.argmax(np.abs(V[:, j])), j] > 0 else -1)
        top = ", ".join(f"{'+' if v[i] > 0 else '−'}{names[i]}" for i in np.argsort(-np.abs(v))[:4])
        sc = np.full(len(D["as_of"]), np.nan)
        sc[idx] = Xs @ v
        ics = [np.nanmean(L.ic_series(sc, D[f"o.{t}"])) for t in ("rel_21", "mae_z", "rel_63")]
        out.append(f"| PC{j + 1} | {w[j]:.0%} | {top} | " + " | ".join(f"{x:+.3f}" for x in ics) + " |")
    out += ["", "Highly overlapping pairs (|rank corr| ≥ 0.6) — candidates for consolidation:", ""]
    for a in range(len(names)):
        for b in range(a + 1, len(names)):
            if abs(C[a, b]) >= 0.6:
                out.append(f"- {names[a]} ↔ {names[b]}: {C[a, b]:+.2f}")
    (OUT / "pca.md").write_text("\n".join(out) + "\n")
    return "\n".join(out)


VARIANTS = {   # pre-registered (written before running): each tests one hypothesis from Step 8 / this lab's design notes
    "champion v2 (live)": dict(V2_W),
    "A: drop optionsFlow (no inputs in history or often live)": {k: v for k, v in V2_W.items() if k != "optionsFlow"},
    "B: volatilityState uses true IV rank (LSEG) instead of RV proxy": "B",
    "C: + long-term trend component (12-1 mom, MA200) at 0.18": "C",
    "D: B + C": "D",
    "E: oversold depth halved (0.25 → 0.125)": {**V2_W, "oversoldDepth": 0.125},
}


def weights(D) -> str:
    """Criterion 4: paired out-of-sample comparison (2024–26 held out; nothing was fit on it) vs the champion."""
    L = Lab(D, "month")
    lt = rankc_by_date(D, D["f.mom_12_1"], L) * 0.5 + rankc_by_date(D, D["f.dist_ma200"], L) * 0.5 + 0.5   # [0,1]
    D2 = dict(D)
    D2["v2.volatilityStateX"] = np.where(np.isnan(D["v2x.volatilityState"]), D["v2.volatilityState"], D["v2x.volatilityState"])
    D2["v2.longTrend"] = lt
    out = [f"# Weight variants: out-of-sample test ({date.today()})", "",
           "Variants were written down before running. Test years 2024–2026 (no fitting anywhere, so the whole span is out of sample; the "
           "held-out years guard against picking a variant that only fits 2020–23). Targets: 21d peer-relative return and 21d worst drop in σ units (mae_z). "
           "Paired t = Newey-West t of (variant IC − champion IC) month by month.", "",
           "| variant | IC rel_21 all | IC rel_21 2024–26 | Δ vs champ (t) | IC mae_z 2024–26 | Δ vs champ (t) | verdict |", "|---|---|---|---|---|---|---|"]
    test = np.array([L.year[d] >= 2024 for d in L.dates])
    base = {}
    for name, w in VARIANTS.items():
        if w == "B":
            w = {**{k: v for k, v in V2_W.items() if k != "volatilityState"}, "volatilityStateX": V2_W["volatilityState"]}
        elif w == "C":
            w = {**V2_W, "longTrend": 0.18}
        elif w == "D":
            w = {**{k: v for k, v in V2_W.items() if k != "volatilityState"}, "volatilityStateX": V2_W["volatilityState"], "longTrend": 0.18}
        s = composite(D2, w)
        res = {}
        for tg in ("rel_21", "mae_z"):
            res[tg] = L.ic_series(s, D[f"o.{tg}"])
        if not base:
            base = res
        cells = [f"{np.nanmean(res['rel_21']):+.3f}", f"{np.nanmean(res['rel_21'][test]):+.3f}"]
        verdict = []
        for tg in ("rel_21", "mae_z"):
            dif = res[tg][test] - base[tg][test]
            t = nw_t(dif, 1)
            if tg == "mae_z":
                cells.append(f"{np.nanmean(res[tg][test]):+.3f}")
            cells.append(f"{np.nanmean(dif):+.3f} ({t:+.1f})" if name != "champion v2 (live)" else "—")
            if name != "champion v2 (live)":
                verdict.append("better" if np.nanmean(dif) > 0 and t >= 2 else ("worse" if np.nanmean(dif) < 0 and t <= -2 else "no sig. diff"))
        out.append(f"| {name} | " + " | ".join(cells) + f" | {' / '.join(verdict) or 'baseline'} |")
    (OUT / "weights.md").write_text("\n".join(out) + "\n")
    return "\n".join(out)


def rankc_by_date(D, x, L):
    out = np.full(len(x), np.nan)
    for d in set(D["as_of"]):
        g = np.where(D["as_of"] == d)[0]
        out[g] = rankc(x[g])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("what", nargs="?", default="all", choices=["all", "report", "pca", "weights"])
    ap.add_argument("--engine", default="", help="engine digest to grade (default: latest base replay)")
    a = ap.parse_args()
    global ENGINE
    ENGINE = a.engine
    D = load()
    if a.what in ("all", "report"):
        report(D)
    if a.what in ("all", "pca"):
        pca(D)
    if a.what in ("all", "weights"):
        weights(D)
    print(f"wrote {OUT}/" + ("report.md pca.md weights.md" if a.what == "all" else f"{a.what}.md"))


if __name__ == "__main__":
    main()
