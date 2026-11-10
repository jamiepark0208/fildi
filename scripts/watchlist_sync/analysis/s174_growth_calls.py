"""S174 — growth factors graded on long-call P&L (Jamie 11-08 NEXT #3 + #4).

Question: do "exceptional growth" factors pick long calls that pay, alone or on top of the live S100 call rule
(ibes_drift + ret60)? Graded on option P&L (S081 pricer, 0.50Δ ~45 DTE held to expiry, per $ debit), not rank IC.

Pre-registered (11-09, before any run):
  factors (direction fixed = higher growth → calls; nothing fitted):
    rev_yoy        latest reported quarter revenue YoY (SEC companyfacts, FIRST-filed value, known at `filed`)
    rev_accel      rev_yoy − prior quarter's YoY
    accel_streak   consecutive quarters (0–4) with YoY rising
    beat_streak    consecutive positive EPS surprises (earnings_calendar, report_date < week)
    surp4          mean EPS surprise % last 4 reports (clipped ±100)
    ibes_fwd_growth FY1→FY2 EPS growth (lab_fund)
    ibes_drift_3m  3-month FY1 revision (lab_fund)
    ibes_sue       latest SUE (lab_fund)
  panel = S100 long panel (lab_tech universe, weekly), FIT < 2024-07-01, HOLDOUT ≥.
  A) single: top-10 by factor vs buy-all same weeks.
  B) add-on: rank-sum(ibes_drift, ret60, factor) top-10 vs S100 pair top-10, same weeks.
  PASS (B) = holdout gain > 0, block t ≥ 2, both holdout halves > 0, FIT gain > 0. One holdout; no re-runs on it.
"""
from __future__ import annotations

import json
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from build_plan import connect  # noqa: E402
from s100_factor_pairs import block_t, rank  # noqa: E402

SPLIT = date(2024, 7, 1)
TOPN = 10
REV = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
       "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense"]
GROWTH = ["rev_yoy", "rev_accel", "accel_streak", "beat_streak", "surp4", "ibes_fwd_growth", "ibes_drift_3m", "ibes_sue"]
BASE = ["ibes_drift", "ret60"]


def _d(s):
    return date.fromisoformat(s[:10])


def quarters(conn, tickers):
    """{ticker: [(end, filed, val)]} first-reported quarterly revenue; Q4 = FY − Q1..Q3 (filed with the FY)."""
    out = {}
    q = """SELECT DISTINCT ON (key) key, payload->'facts'->'us-gaap' FROM vendor_raw
           WHERE source='sec' AND endpoint='companyfacts' AND key = ANY(%s) ORDER BY key, fetched_on DESC"""
    for t, gaap in conn.execute(q, (list(tickers),)).fetchall():
        gaap = json.loads(gaap) if isinstance(gaap, str) else (gaap or {})
        per = {}   # (start,end) -> (filed, val) earliest filing, max across concepts
        for c in REV:
            for u in ((gaap.get(c) or {}).get("units", {}).get("USD", [])):
                if u.get("form") not in ("10-K", "10-Q", "10-K/A", "10-Q/A") or not u.get("start"):
                    continue
                k = (u["start"], u["end"])
                cur = per.get((c, k))
                if cur is None or u["filed"] < cur[0]:
                    per[(c, k)] = (u["filed"], float(u["val"]))
        byk = {}
        for (c, k), (f, v) in per.items():
            if k not in byk or v > byk[k][1]:
                byk[k] = (f, v)
        qs = {}
        for (s, e), (f, v) in byk.items():
            n = (_d(e) - _d(s)).days
            if 80 <= n <= 100:
                qs[e] = (f, v)
        for (s, e), (f, v) in byk.items():
            if 350 <= (_d(e) - _d(s)).days <= 380 and e not in qs:
                inside = [(qe, qv) for qe, qv in qs.items() if _d(s) < _d(qe) < _d(e)]
                if len(inside) == 3:
                    qs[e] = (f, v - sum(x[1][1] for x in inside))
        rows = sorted((_d(e), _d(f), v) for e, (f, v) in qs.items() if v > 0)
        if rows:
            out[t] = rows
    return out


def rev_feats(rows, d):
    known = [(e, v) for e, f, v in rows if f < d]
    if len(known) < 6 or (d - known[-1][0]).days > 200:
        return {}
    ends = [e for e, _ in known]

    def yoy(k):
        e, v = known[k]
        for j in range(k - 1, -1, -1):
            gap = (e - known[j][0]).days
            if 345 <= gap <= 385:
                return v / known[j][1] - 1
            if gap > 385:
                break
        return None
    ys = [yoy(len(known) - 1 - k) for k in range(5)]
    if ys[0] is None or ys[1] is None:
        return {}
    st = 0
    for k in range(4):
        if ys[k] is not None and ys[k + 1] is not None and ys[k] > ys[k + 1]:
            st += 1
        else:
            break
    return {"rev_yoy": min(ys[0], 3.0), "rev_accel": max(-1.0, min(ys[0] - ys[1], 1.0)), "accel_streak": float(st)}


def surprises(conn, tickers):
    out = defaultdict(list)
    for t, rd, s in conn.execute("""SELECT ticker, report_date, surprise_pct::float8 FROM earnings_calendar
                                    WHERE ticker = ANY(%s) AND surprise_pct IS NOT NULL ORDER BY ticker, report_date""",
                                 (list(tickers),)).fetchall():
        out[t].append((rd, s))
    return out


def surp_feats(rows, d):
    i = bisect_right([r for r, _ in rows], d) - 1
    while i >= 0 and rows[i][0] >= d:
        i -= 1
    if i < 3 or (d - rows[i][0]).days > 200:
        return {}
    st = 0
    for k in range(i, -1, -1):
        if rows[k][1] > 0:
            st += 1
        else:
            break
    return {"beat_streak": float(min(st, 12)), "surp4": float(np.mean([max(-100, min(100, rows[k][1])) for k in range(i - 3, i + 1)]))}


def main():
    import s085_regime_analog as e
    import s086_strategy_board as B
    with connect() as conn:
        e.DIGEST = B.pick_digest(conn)
        e.IBES = tuple(dict.fromkeys(list(e.IBES) + ["ibes_fwd_growth", "ibes_drift_3m", "ibes_sue"]))   # loader drops unlisted keys
        only = [a for a in sys.argv[1:] if a != "winners"]
        win_mode = "winners" in sys.argv
        px = e.load_prices(conn)
        universe = sorted(t for t in px if t not in e.BENCH)
        tech, fund, tgt, _ = e.load_lab(conn, set(universe))
        weeks = sorted(d for d in set(tech) | set(fund) if tgt.get(d))
        panel = e.build_panel(px, universe, weeks, tech, fund)
        names = {t for row in panel.values() for t in row}
        qs, sp = quarters(conn, names), surprises(conn, names)
        print(f"panel {len(weeks)} weeks, {len(names)} names · SEC revenue {len(qs)} · surprises {len(sp)}", flush=True)
        for d, row in panel.items():
            for t, f in row.items():
                f.update(B.extras(px[t], f["_i"]))
                if t in qs:
                    f.update(rev_feats(qs[t], d))
                if t in sp:
                    f.update(surp_feats(sp[t], d))
        pricer, tb = e.Pricer(conn), e.tbill_map(conn)
        cache = {}

        def opt(t, d):
            k = (t, d)
            if k not in cache:
                tr = e.price_long(pricer, px[t], panel[d][t]["_i"], "call", e.tbill_at(tb, d))
                cache[k] = tr["expiry"] if tr else None
            return cache[k]

        def val(row, t, f):
            v = row[t].get(f)
            return v if isinstance(v, (int, float)) and v == v else None

        def picks(row, fs):
            ns = [t for t in row if all(val(row, t, f) is not None for f in fs)]
            if len(ns) < 40:
                return []
            sc = sum(rank([val(row, t, f) for t in ns]) for f in fs)   # all signs + (pre-registered)
            return [ns[k] for k in np.argsort(sc)[-TOPN:]]

        def wr(d, ts):
            v = [x for t in ts if (x := opt(t, d)) is not None]
            return float(np.mean(v)) if len(v) >= 5 else float("nan")

        def rel(d, ts):
            v = [tgt[d][t] for t in ts if t in tgt[d]]
            return float(np.mean(v)) if v else float("nan")

        wk = [d for d in weeks if d in panel and len(panel[d]) >= 40]
        fit, ho = [d for d in wk if d < SPLIT], [d for d in wk if d >= SPLIT]
        allw = {d: wr(d, list(panel[d])) for d in fit[::4] + ho}
        base = {d: wr(d, picks(panel[d], BASE)) for d in wk}
        print(f"weeks fit {len(fit)} ho {len(ho)} · buy-all ho {np.nanmean([allw[d] for d in ho]):+.3f} · "
              f"S100 base fit {np.nanmean([base[d] for d in fit]):+.3f} ho {np.nanmean([base[d] for d in ho]):+.3f}", flush=True)
        if win_mode:   # winner pass: holdout, every priced name-week; winners = top decile call P&L
            feats = GROWTH + BASE + ["iv_rank252", "iv_rv20", "mom_12_1", "prox_52w"]
            recs = []
            for d in ho:
                row = panel[d]
                pct = {}
                for f in feats:
                    ns = [t for t in row if val(row, t, f) is not None]
                    if len(ns) >= 40:
                        r_ = rank([val(row, t, f) for t in ns])
                        pct[f] = dict(zip(ns, r_))
                for t in row:
                    p_ = opt(t, d)
                    if p_ is not None:
                        recs.append((d, t, p_, {f: pct[f].get(t) for f in pct}))
            cut = np.quantile([r[2] for r in recs], 0.9)
            W, L = [r for r in recs if r[2] >= cut], [r for r in recs if r[2] < cut]
            print(f"winners: {len(W)} of {len(recs)} name-weeks (P&L ≥ {cut:+.2f}/$), {len({r[1] for r in W})} names, "
                  f"{len({(r[0].year, r[0].month) for r in W})} entry months")
            for f in feats:
                a = [r[3][f] for r in W if r[3].get(f) is not None]
                b = [r[3][f] for r in L if r[3].get(f) is not None]
                if a and b:
                    print(f"  {f:16s} winners pctile {np.mean(a):.2f} vs rest {np.mean(b):.2f} (n {len(a)})")
            from collections import Counter
            print("  top winner names:", Counter(r[1] for r in W).most_common(12))
            pl = [(r[0], round(r[2], 2), {k: round(v, 2) for k, v in r[3].items() if v is not None and k in ("rev_accel", "ibes_drift", "ret60", "iv_rank252")}) for r in recs if r[1] == "PLTR"]
            print("  PLTR weeks:", len(pl), "mean P&L", round(float(np.mean([x[1] for x in pl])), 2) if pl else None, pl[:3])
            return
        res = {}
        for g in (only or GROWTH):
            cov = np.mean([sum(1 for t in panel[d] if val(panel[d], t, g) is not None) for d in ho])
            sg = {d: wr(d, picks(panel[d], [g])) for d in wk}
            ad = {d: wr(d, picks(panel[d], BASE + [g])) for d in wk}
            srel = np.nanmean([rel(d, picks(panel[d], [g])) for d in ho])
            gain_f = [(d, ad[d] - base[d]) for d in fit]
            gain_h = [(d, ad[d] - base[d]) for d in ho]
            vs_all = [(d, sg[d] - allw[d]) for d in ho]
            h = len(gain_h) // 2
            r = {"cov_ho": round(float(cov)), "single_fit": np.nanmean([sg[d] for d in fit]), "single_ho": np.nanmean([sg[d] for d in ho]),
                 "single_vs_all_ho": np.nanmean([v for _, v in vs_all]), "single_vs_all_t": block_t(vs_all), "single_rel21_ho": srel,
                 "addon_fit_gain": np.nanmean([v for _, v in gain_f]), "addon_ho": np.nanmean([ad[d] for d in ho]),
                 "addon_ho_gain": np.nanmean([v for _, v in gain_h]), "addon_ho_t": block_t(gain_h),
                 "halves": (np.nanmean([v for _, v in gain_h[:h]]), np.nanmean([v for _, v in gain_h[h:]]))}
            r["PASS"] = bool(r["addon_ho_gain"] > 0 and r["addon_ho_t"] >= 2 and min(r["halves"]) > 0 and r["addon_fit_gain"] > 0)
            res[g] = r
            print(g, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}, flush=True)
        out = HERE.parent.parent.parent / f"research/studies/data/s174_growth_calls{'_' + '_'.join(only) if only else ''}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"weeks_fit": len(fit), "weeks_ho": len(ho), "buy_all_ho": np.nanmean([allw[d] for d in ho]),
                                   "s100_fit": np.nanmean([base[d] for d in fit]), "s100_ho": np.nanmean([base[d] for d in ho]),
                                   "res": res}, default=lambda o: float(o) if isinstance(o, (np.floating,)) else str(o), indent=1))
        print("wrote", out)


if __name__ == "__main__":
    main()
