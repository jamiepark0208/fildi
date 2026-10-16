"""S024 (Claude, pre-registered 2026-10-15): do sector-specific fundamental weights beat one global weight set? + null skew.

Data: watchlist_sync.lab_fund (point-in-time weekly features) × lab_outcomes (rel_63 = 3-month forward return minus the
peer-group median that date). Sector = prefix of the name's primary peer group (technology, energy, …; current mapping,
not point-in-time). Fit 2020–2023, test 2024→.

Deviation from the pre-registration, stated up front: lab_fund holds only the expectations family point-in-time
(IBES SUE, revision breadth, estimate drift 1m/3m, dispersion, forward growth). Value/growth/quality/safety statement history
isn't point-in-time (lab_fund_features.py docstring), so "per-sector pillar weights" is tested on the features that exist.

Method: each feature → within-date percentile rank − 0.5 (dispersion flipped: lower = better). Weights = mean train rank IC
per feature (sign kept), normalised to Σ|w| = 1, fitted once on all names (global) and once per sector. Composite = Σ w·x.
Test: per sector, mean within-sector rank IC (composite vs rel_63) over test dates, sector minus global; dates sampled every
4th week (non-overlapping 63-day windows ≈ 13 weeks, so IC series are still autocorrelated → block bootstrap by 13-week blocks).
Pass (as pre-registered): gain ≥ 0.02 in ≥ half of sectors with ≥ 15 names, each Holm p < 0.05 and same sign in both test halves.

Null skew: coverage = share of the 6 features present. Two fills compared: missing → neutral (0) vs engine-style renormalise
(average over present features, which inflates thin rows). Report decile-extreme share by coverage and IC by coverage.

    .venv/bin/python analysis/s024_sector_weights.py     # → out/opt/S024.md
"""
from __future__ import annotations

import math
import random
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402

FEATS = ["ibes_sue", "ibes_breadth", "ibes_drift", "ibes_drift_3m", "ibes_disp", "ibes_fwd_growth"]
FLIP = {"ibes_disp"}
TRAIN_END = date(2023, 12, 31)
MIN_NAMES = 15
B = 3000


def ranks(xs):
    o = sorted(range(len(xs)), key=lambda i: xs[i]); r = [0.0] * len(xs); i = 0
    while i < len(o):
        j = i
        while j + 1 < len(o) and xs[o[j + 1]] == xs[o[i]]: j += 1
        for k in range(i, j + 1): r[o[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(a, b):
    n = len(a)
    if n < 5: return None
    ra, rb = ranks(a), ranks(b); ma, mb = sum(ra) / n, sum(rb) / n
    va = sum((x - ma) ** 2 for x in ra); vb = sum((y - mb) ** 2 for y in rb)
    return sum((x - ma) * (y - mb) for x, y in zip(ra, rb)) / math.sqrt(va * vb) if va and vb else None


def load(conn):
    sec = {t: g.split(".")[0] for t, g in conn.execute(
        "SELECT ticker, primary_peer_group_id FROM ticker_registry WHERE primary_peer_group_id IS NOT NULL").fetchall()}
    by_date = defaultdict(list)
    for t, d, f, y in conn.execute("""SELECT f.ticker, f.as_of, f.features, (o.outcomes->>'rel_63')::float
                                      FROM watchlist_sync.lab_fund f JOIN watchlist_sync.lab_outcomes o USING (ticker, as_of)
                                      WHERE o.outcomes->>'rel_63' IS NOT NULL""").fetchall():
        if t in sec:
            by_date[d].append((t, sec[t], f, y))
    dates = sorted(by_date)
    dates = dates[::4]  # every 4th week
    rows = []  # (date, ticker, sector, {feat: pct-0.5 or None}, coverage, y)
    for d in dates:
        grp = by_date[d]
        x = {}
        for k in FEATS:
            vals = [(i, g[2].get(k)) for i, g in enumerate(grp) if isinstance(g[2].get(k), (int, float))]
            if len(vals) < 5: continue
            rk = ranks([v * (-1 if k in FLIP else 1) for _, v in vals]); n = len(vals)
            for (i, _), r in zip(vals, rk): x.setdefault(i, {})[k] = r / (n - 1) - 0.5
        for i, g in enumerate(grp):
            xi = {k: x.get(i, {}).get(k) for k in FEATS}
            rows.append((d, g[0], g[1], xi, sum(v is not None for v in xi.values()) / len(FEATS), g[3]))
    return rows


def fit(rows):
    """Weights = mean per-date rank IC of each feature (present values only), Σ|w| = 1."""
    by_d = defaultdict(list)
    for r in rows: by_d[r[0]].append(r)
    w = {}
    for k in FEATS:
        ics = [ic for g in by_d.values() if (ic := spearman([r[3][k] for r in g if r[3][k] is not None],
                                                            [r[5] for r in g if r[3][k] is not None])) is not None]
        w[k] = sum(ics) / len(ics) if ics else 0.0
    s = sum(abs(v) for v in w.values()) or 1
    return {k: v / s for k, v in w.items()}


def score(r, w, renorm=False):
    pres = [(w[k], v) for k, v in r[3].items() if v is not None]
    if not pres: return 0.0
    s = sum(a * v for a, v in pres)
    return s / (sum(abs(a) for a, _ in pres) or 1) if renorm else s


def ic_series(rows, scorer):
    by_d = defaultdict(list)
    for r in rows: by_d[r[0]].append(r)
    out = {}
    for d, g in by_d.items():
        ic = spearman([scorer(r) for r in g], [r[5] for r in g])
        if ic is not None: out[d] = ic
    return out


def block_boot_p(diffs: list[float], block=3):
    """Two-sided p for mean(diffs) ≠ 0, moving-block bootstrap (block = 3 sampled dates ≈ 12 weeks)."""
    n = len(diffs)
    if n < 6: return 1.0, (float("nan"), float("nan"))
    m = sum(diffs) / n; rng = random.Random(24); bs = []
    for _ in range(B):
        s = []
        while len(s) < n:
            i = rng.randrange(0, n - block + 1); s.extend(diffs[i:i + block])
        bs.append(sum(s[:n]) / n - m)  # centred
    p = sum(1 for x in bs if abs(x) >= abs(m)) / B
    bs.sort()
    return p, (m + bs[int(0.05 * B)], m + bs[int(0.95 * B)])


def main():
    conn = connect()
    rows = load(conn)
    train = [r for r in rows if r[0] <= TRAIN_END]
    test = [r for r in rows if r[0] > TRAIN_END]
    names_by_sec = defaultdict(set)
    for r in rows: names_by_sec[r[2]].add(r[1])
    eligible = sorted(s for s, n in names_by_sec.items() if len(n) >= MIN_NAMES)
    wg = fit(train)
    res = []
    for s in eligible:
        tr = [r for r in train if r[2] == s]; te = [r for r in test if r[2] == s]
        ws = fit(tr)
        ig = ic_series(te, lambda r: score(r, wg)); isec = ic_series(te, lambda r: score(r, ws))
        ds = sorted(set(ig) & set(isec))
        diffs = [isec[d] - ig[d] for d in ds]
        p, ci = block_boot_p(diffs)
        h = len(ds) // 2
        h1 = sum(diffs[:h]) / max(h, 1); h2 = sum(diffs[h:]) / max(len(ds) - h, 1)
        res.append({"sector": s, "names": len(names_by_sec[s]), "dates": len(ds), "ic_global": sum(ig[d] for d in ds) / max(len(ds), 1),
                    "ic_sector": sum(isec[d] for d in ds) / max(len(ds), 1), "gain": sum(diffs) / max(len(diffs), 1), "p": p, "ci": ci,
                    "halves": (h1, h2), "w": ws})
    # Holm
    order = sorted(range(len(res)), key=lambda i: res[i]["p"]); m = len(res); prev = 0
    for rank_, i in enumerate(order):
        adj = min(1.0, max(prev, res[i]["p"] * (m - rank_))); res[i]["holm"] = adj; prev = adj
    for r in res:
        r["ok"] = r["gain"] >= 0.02 and r["holm"] < 0.05 and r["halves"][0] > 0 and r["halves"][1] > 0
    n_ok = sum(r["ok"] for r in res)
    passed = n_ok >= math.ceil(len(res) / 2) and len(res) > 0
    # overall global IC on test (all names, within-date)
    ig_all = ic_series(test, lambda r: score(r, wg))
    # null skew
    def bucket(c): return "≤ 1/3" if c <= 1 / 3 + 1e-9 else "≤ 2/3" if c <= 2 / 3 + 1e-9 else "> 2/3"
    skew = {}
    for renorm in (False, True):
        by_d = defaultdict(list)
        for r in test: by_d[r[0]].append(r)
        ext = defaultdict(lambda: [0, 0]); icb = defaultdict(list)
        for d, g in by_d.items():
            sc = [score(r, wg, renorm) for r in g]
            srt = sorted(sc); lo, hi = srt[int(0.1 * (len(srt) - 1))], srt[int(0.9 * (len(srt) - 1))]
            for r, v in zip(g, sc):
                b = bucket(r[4]); ext[b][1] += 1
                if v <= lo or v >= hi: ext[b][0] += 1
            for b in ("≤ 1/3", "≤ 2/3", "> 2/3"):
                sub = [(v, r[5]) for r, v in zip(g, sc) if bucket(r[4]) == b]
                if len(sub) >= 8:
                    ic = spearman([a for a, _ in sub], [y for _, y in sub])
                    if ic is not None: icb[b].append(ic)
        skew["renormalise" if renorm else "missing = neutral"] = {
            b: (ext[b][0] / ext[b][1] if ext[b][1] else float("nan"), ext[b][1], sum(icb[b]) / len(icb[b]) if icb[b] else float("nan"), len(icb[b]))
            for b in ("≤ 1/3", "≤ 2/3", "> 2/3")}
    cov = [r[4] for r in test]
    out = [f"# S024 — sector-specific fundamental weights vs one global set ({date.today()})\n",
           f"Point-in-time rows: {len(rows):,} (every 4th week), {len({r[1] for r in rows})} names; train ≤ 2023 ({len(train):,}), test 2024→ ({len(test):,}).",
           "**Deviation (data):** only the expectations family is point-in-time (IBES SUE, breadth, drift 1m/3m, dispersion, fwd growth); "
           "value/growth/quality/safety pillars can't be tested this way. Sector = peer-group prefix (current mapping).\n",
           "Global weights (train IC-proportional): " + ", ".join(f"{k.replace('ibes_', '')} {v:+.2f}" for k, v in wg.items()),
           f"Global composite, test, all names: mean within-date IC {sum(ig_all.values()) / len(ig_all):+.3f} over {len(ig_all)} dates.\n",
           "| Sector | names | test dates | IC global | IC sector | gain | 90 % CI | Holm p | halves | meets rule |", "|---|---|---|---|---|---|---|---|---|---|"]
    for r in res:
        out.append(f"| {r['sector']} | {r['names']} | {r['dates']} | {r['ic_global']:+.3f} | {r['ic_sector']:+.3f} | {r['gain']:+.3f} | "
                   f"{r['ci'][0]:+.3f} … {r['ci'][1]:+.3f} | {r['holm']:.2f} | {r['halves'][0]:+.3f} / {r['halves'][1]:+.3f} | {'yes' if r['ok'] else 'no'} |")
    out.append(f"\n**Verdict: {'PASS' if passed else 'FAIL'}** — {n_ok} of {len(res)} eligible sectors meet the rule (need ≥ {math.ceil(len(res) / 2)}). "
               + ("" if passed else "Global weights stay (fewer parameters win ties)."))
    out.append(f"\n## Null skew (test period, global weights)\nCoverage of the 6 features: median {sorted(cov)[len(cov) // 2]:.2f}; "
               f"rows with ≤ 1/3 present: {sum(c <= 1 / 3 + 1e-9 for c in cov) / len(cov):.0%}.\n")
    out.append("| Fill | coverage | share in top/bottom decile (20 % if neutral) | rows | mean IC | dates |"); out.append("|---|---|---|---|---|---|")
    for fill, d in skew.items():
        for b, (sh, n, ic, nd) in d.items():
            out.append(f"| {fill} | {b} | {sh:.0%} | {n:,} | {ic:+.3f} | {nd} |")
    out.append("\nRead: under 'renormalise' (average over present features, like a weight-renormalising engine), thin rows reach the "
               "extremes more often than under 'missing = neutral' if their extreme share is higher; IC by coverage shows whether those "
               "extremes carry signal.")
    (HERE.parent / "out/opt").mkdir(parents=True, exist_ok=True)
    (HERE.parent / "out/opt/S024.md").write_text("\n".join(out) + "\n")
    print("\n".join(out))


if __name__ == "__main__":
    main()
