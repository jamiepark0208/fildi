#!/usr/bin/env python3
"""S102 (A279): do the TradingView indicators (indicators.py) change a sold put's outcome — and does put-edge still sort
puts inside a sector drop (A277 next step)?

Rows = S101's 1-week S088 put candidates (real-fill net per collateral-week `hc`, `kept`), features at the entry close.
Two bands: default 0.06–0.10Δ and the ~1 %/wk zone 0.12–0.20Δ. For each pre-declared split: mean net bp, worst 5 %, kept,
each period (2019-12→2022, 2023→). Difference vs the rest, IV/RV-controlled (mean of within-IV/RV-tercile differences),
t from weekly clusters.

PASS (pre-registered): same sign in both periods, |Δ| ≥ 5 bp/wk in each, pooled week-cluster |t| ≥ 2.5 (≈ Holm over ~20 tests),
and the IV/RV-controlled Δ keeps the sign. Only PASS features feed put_recs; the rest are display-only.

    .venv/bin/python analysis/s102_tv_indicators.py
"""
from __future__ import annotations

import math
import pickle
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import band_engine as BE  # noqa: E402
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402

SPLIT = date(2023, 1, 1)
OUT = HERE.parent / "out" / "opt" / "S102.md"
BANDS = {"0.06–0.10Δ": (0.06, 0.10), "0.12–0.20Δ": (0.12, 0.20)}


def attach(conn, rows):
    names = sorted({r["t"] for r in rows})
    bars = IND.load_bars(conn, names)
    feats = {}
    for t in names:
        if t not in bars or len(bars[t][3]) < 320:
            continue
        s = IND.compute(*bars[t])
        feats[t] = s
    # put-edge pieces: vol-of-vol (60-day std of Δlog iv30_put) and put-tech (lab_tech trendContext − volumeConfirm)
    iv = defaultdict(list)
    for t, d, v in conn.execute("SELECT ticker, date, iv30_put::float8 FROM lseg_research.daily_history WHERE iv30_put > 0 "
                                "AND ticker = ANY(%s) ORDER BY ticker, date", (names,)):
        iv[t].append((d, v))
    tech = defaultdict(list)
    for t, a, v2 in conn.execute("SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech WHERE ticker = ANY(%s) ORDER BY ticker, as_of", (names,)):
        cm = (v2 or {}).get("comps") or {}
        if cm.get("trendContext") is not None and cm.get("volumeConfirm") is not None:
            tech[t].append((a, cm["trendContext"] - cm["volumeConfirm"]))
    for r in rows:
        s = feats.get(r["t"])
        if s is None:
            continue
        i = bisect_right(s["d"], r["d"]) - 1
        if i < 300:
            continue
        for k in IND.FIELDS:
            r[k] = float(s[k][i])
        ivs = iv.get(r["t"], [])
        j = bisect_right([x[0] for x in ivs], r["d"]) - 1
        if j >= 60:
            r["vov"] = float(np.std(np.diff(np.log([x[1] for x in ivs[j - 60:j + 1]]))))
        tt = tech.get(r["t"], [])
        j = bisect_right([x[0] for x in tt], r["d"]) - 1
        if j >= 0 and (r["d"] - tt[j][0]).days <= 10:
            r["put_tech"] = tt[j][1]
    # cross-sectional put-edge quintile per entry date (same construction as put_edge.scores)
    by = defaultdict(list)
    for r in rows:
        if all(r.get(k) == r.get(k) and r.get(k) is not None for k in ("iv_rv", "vov", "put_tech")):
            by[r["d"]].append(r)
    for d, rs in by.items():
        names_d = {}
        for r in rs:
            names_d.setdefault(r["t"], r)
        if len(names_d) < 30:
            continue
        keys = list(names_d)
        def rk(x):
            o = np.argsort(x, kind="mergesort"); out = np.empty(len(x)); out[o] = np.arange(len(x)); return out / max(len(x) - 1, 1)
        comp = rk(sum(rk(np.array([names_d[t][k] for t in keys])) for k in ("iv_rv", "vov", "put_tech")))
        q = {t: min(5, int(p * 5) + 1) for t, p in zip(keys, comp)}
        for r in rs:
            r["pe_q"] = q[r["t"]]
    return rows


def wk_t(diffs):
    x = np.array(diffs)
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x)))) if len(x) > 5 and x.std() > 0 else float("nan")


def cell(rs):
    if len(rs) < 150:
        return None
    hc = np.array([r["hc"] for r in rs])
    return {"n": len(rs), "bp": hc.mean() * 1e4, "w5": np.percentile(hc, 5) * 1e4, "kept": np.mean([r["kept"] for r in rs]) * 100}


def compare(rows, pred):
    """per period: (in-cell stats, rest stats, Δbp, IV/RV-controlled Δbp); pooled weekly-cluster t of Δ."""
    res = {}
    wd = []
    for per, f in (("19–22", lambda r: r["d"] < SPLIT), ("23–26", lambda r: r["d"] >= SPLIT)):
        xs = [r for r in rows if f(r)]
        a, b = [r for r in xs if pred(r)], [r for r in xs if not pred(r)]
        ca, cb = cell(a), cell(b)
        if not ca or not cb:
            res[per] = None
            continue
        ctrl = []
        qs = np.nanpercentile([r["iv_rv"] for r in xs if r["iv_rv"] == r["iv_rv"]], [33.3, 66.7])
        for lo, hi in ((-1e9, qs[0]), (qs[0], qs[1]), (qs[1], 1e9)):
            aa = [r["hc"] for r in a if lo <= r["iv_rv"] < hi]
            bb = [r["hc"] for r in b if lo <= r["iv_rv"] < hi]
            if len(aa) >= 50 and len(bb) >= 50:
                ctrl.append((np.mean(aa) - np.mean(bb)) * 1e4)
        res[per] = (ca, cb, ca["bp"] - cb["bp"], float(np.mean(ctrl)) if ctrl else float("nan"))
        wa, wb = defaultdict(list), defaultdict(list)
        for r in a:
            wa[r["d"]].append(r["hc"])
        for r in b:
            wb[r["d"]].append(r["hc"])
        wd += [(np.mean(wa[d]) - np.mean(wb[d])) * 1e4 for d in wa if d in wb and len(wa[d]) >= 3]
    return res, wk_t(wd)


def verdict(res, t):
    if not all(res.get(p) for p in ("19–22", "23–26")):
        return "thin"
    d1, d2 = res["19–22"][2], res["23–26"][2]
    c1, c2 = res["19–22"][3], res["23–26"][3]
    ok = d1 * d2 > 0 and min(abs(d1), abs(d2)) >= 5 and abs(t) >= 2.5 and c1 * d1 > 0 and c2 * d2 > 0
    return ("PASS +" if d1 > 0 else "PASS −") if ok else "fail"


TESTS = [
    ("UT Bot: uptrend", lambda r: r["ut_dir"] > 0),
    ("UT Bot: confidence ≥ 70 in its direction, up", lambda r: r["ut_dir"] > 0 and r["ut_conf"] >= 70),
    ("UT Bot: downtrend, confidence ≥ 70", lambda r: r["ut_dir"] < 0 and r["ut_conf"] >= 70),
    ("UT Bot: downtrend likely over (survival < 0.35)", lambda r: r["ut_dir"] < 0 and r["ut_surv"] == r["ut_surv"] and r["ut_surv"] < 0.35),
    ("UT Bot: fresh flip up (≤ 3 bars)", lambda r: r["ut_dir"] > 0 and r["ut_bars"] <= 3),
    ("SuperTrend-div: uptrend", lambda r: r["stdiv_dir"] > 0),
    ("SuperTrend-div: against-trend divergence active", lambda r: r["div_against"] > 0),
    ("ST cluster: bull share ≥ 0.8", lambda r: r["stc_bull"] >= 0.8),
    ("ST cluster: bull share ≤ 0.2", lambda r: r["stc_bull"] <= 0.2),
    ("ST cluster: bull regime", lambda r: r["stc_regime"] > 0),
    ("SMC: swing-low sweep ≤ 5 bars ago", lambda r: r["sweep_age"] == r["sweep_age"] and r["sweep_age"] <= 5),
    ("SMC: bullish MSS ≤ 10 bars ago", lambda r: r["mss_age"] == r["mss_age"] and r["mss_age"] <= 10),
    ("SMC: last BOS bearish", lambda r: r["bos_dir"] < 0),
    ("SMC: unfilled bull FVG ≤ 1 ATR below", lambda r: r["fvg_dist"] == r["fvg_dist"] and r["fvg_dist"] <= 1),
    ("SMC: bull order block ≤ 1.5 ATR below", lambda r: r["ob_dist"] == r["ob_dist"] and r["ob_dist"] <= 1.5),
    ("Fear & Greed ≤ 30 (fear)", lambda r: r["fear_greed"] <= 30),
    ("Fear & Greed ≥ 70 (greed)", lambda r: r["fear_greed"] >= 70),
]


def main():
    rows = [r for r in pickle.loads(BE.CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        BE.add_sector(c, rows)
        attach(c, rows)
    rows = [r for r in rows if "ut_dir" in r]
    for r in rows:
        r["ms"] = BE.market_state(r)
    L = [f"# S102 — TradingView indicators on sold 1-week puts ({date.today()})", "",
         f"{len(rows):,} S101 put candidates with indicators. Cells: net bp/wk · worst 5 % · kept %. Δ = in-cell minus the rest "
         "(IV/RV-controlled Δ in brackets). PASS = same sign both periods, |Δ| ≥ 5 bp each, week-cluster |t| ≥ 2.5, control keeps sign.", ""]
    for bname, (lo, hi) in BANDS.items():
        xs = [r for r in rows if lo <= r["dlt"] < hi]
        L += [f"## {bname} ({len(xs):,} puts)", "", "| split | 19–22 in / rest | Δ (ctrl) | 23–26 in / rest | Δ (ctrl) | t | verdict |", "|---|---|---|---|---|---|---|"]
        for name, p in TESTS:
            res, t = compare(xs, p)
            def fmt(x):
                return f"{x[0]['bp']:+.0f}/{x[0]['w5']:+.0f}/{x[0]['kept']:.0f}% (n {x[0]['n']:,}) vs {x[1]['bp']:+.0f}/{x[1]['w5']:+.0f}" if x else "—"
            def dl(x):
                return f"{x[2]:+.1f} ({x[3]:+.1f})" if x else "—"
            L.append(f"| {name} | {fmt(res.get('19–22'))} | {dl(res.get('19–22'))} | {fmt(res.get('23–26'))} | {dl(res.get('23–26'))} | {t:.1f} | {verdict(res, t)} |")
        L.append("")
    # A277 next step: put-edge inside sector_drop (and everywhere, for reference)
    L += ["## Put-edge quintile by market state (0.12–0.20Δ and 0.06–0.10Δ)", "",
          "| band | state | Q1 | Q2 | Q3 | Q4 | Q5 | period |", "|---|---|---|---|---|---|---|---|"]
    for bname, (lo, hi) in BANDS.items():
        for st in ("all", "sector_drop", "normal", "rally"):
            for per, f in (("19–22", lambda r: r["d"] < SPLIT), ("23–26", lambda r: r["d"] >= SPLIT)):
                xs = [r for r in rows if lo <= r["dlt"] < hi and f(r) and r.get("pe_q") and (st == "all" or r["ms"] == st)]
                cs = [cell([r for r in xs if r["pe_q"] == q]) for q in range(1, 6)]
                L.append(f"| {bname} | {st} | " + " | ".join(f"{c['bp']:+.0f}/{c['w5']:+.0f} ({c['n']})" if c else "—" for c in cs) + f" | {per} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
