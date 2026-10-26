#!/usr/bin/env python3
"""S101 — does the best sold-put |Δ| band move with the market / the stock? (A277 §6–7, Jamie 10-26). INDEX row S101.

Jamie: "after a crash I sell puts at a higher Δ (the drop is my buffer); after a rally, lower Δ. 'Crashed' = which horizon,
how big?" → find the thresholds by backtest, honestly:
  * rows = S088 put candidates (LSEG daily_history, weekly entries, 1/2/4-week holds, S076 pricer, fill bid + 23 % of spread,
    real-fill haircut), every name, 2017-12 →.
  * TRAIN 2017-12 … 2022-12 (2018 Q4, 2020 crash, 2022 bear) picks, per cell, the band with the best real-fill bp/wk whose
    worst 5 % ≥ −150 bp/wk; TEST 2023-01 → grades that band against the default 0.08–0.10 band in the same cell
    (paired by entry week). A cell ships only if TEST Δ ≥ +8 bp/wk, week t ≥ 2, same sign both test halves, worst 5 % ≥ −150,
    n ≥ 300 per band, and it survives Holm 5 % across every cell tried.
  * cells = SPY 1m/3m/6m return and drawdown-from-52w-high thresholds (crash side and rally side), the stock's own
    1m/3m/6m return vs SPY and drawdown from its 52w high, × trend (above/below 200d), VIX level, VIX ÷ VIX3M.
  * also: support distance within a band (cushion σ / support between strike and spot) and the technicals as a
    name-quality ranker (not timing) at the default band.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s101_band_regime.py [--rebuild] [--tickers=A,B]
Rows cache: ~/.fildi/cache/s101_rows.pkl (rebuilt with --rebuild; ~20–40 min).
"""
from __future__ import annotations

import math
import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer  # noqa: E402
from s088_sr_zones import (LADDER_BANDS, candidates, entries, haircut_pnl, load, side_delta,  # noqa: E402
                           week_t, zones)

OUT = HERE.parent / "out" / "opt" / "S101.md"
CACHE = Path.home() / ".fildi" / "cache" / "s101_rows.pkl"
SPLIT = date(2023, 1, 1)
DEFAULT = (0.08, 0.10)
MIN_N, MIN_DELTA, MIN_T, WORST_FLOOR = 300, 8.0, 2.0, -150.0
KEEP = ("d", "h", "S", "K", "credit", "dist_sig", "iv", "pnl", "kept", "side", "rsi14", "ret20", "dist50", "dist200",
        "dd60", "iv_rv", "iv_rank", "guard_n", "cushion_sig", "cushion_score", "at_zone", "grid_m")


# ---------------------------------------------------------------- data

def spy_and_vix(conn):
    spy = {"d": [], "c": [], "h": []}
    for d, c, h in conn.execute("SELECT date, close::float8, high::float8 FROM lseg_research.daily_history "
                                "WHERE ticker = 'SPY' AND close > 0 ORDER BY date"):
        spy["d"].append(d), spy["c"].append(c), spy["h"].append(h or c)
    spy["c"], spy["h"] = np.array(spy["c"]), np.array(spy["h"])
    vix = defaultdict(dict)
    for d, idx, c in conn.execute("SELECT date, index, close::float8 FROM wrds_research.cboe_daily "
                                  "WHERE index IN ('VIX','VIX3M')"):
        vix[idx][d] = c
    return spy, vix


def rets(c, h, i):
    out = {}
    for n, k in ((21, "1m"), (63, "3m"), (126, "6m")):
        out[k] = float(c[i] / c[i - n] - 1) if i >= n else float("nan")
    out["dd52"] = float(c[i] / h[max(0, i - 251): i + 1].max() - 1)
    return out


def build(conn, only=None):
    bars = load(conn, only)
    spy, vix = spy_and_vix(conn)
    spy_i = {d: i for i, d in enumerate(spy["d"])}
    pricer = Pricer(conn)
    rows = []
    for n, (t, b) in enumerate(sorted(bars.items())):
        for i in entries(b):
            si = spy_i.get(b["d"][i])
            if si is None or si < 252:
                continue
            zs, a = zones(b, i)
            m = rets(spy["c"], spy["h"], si)
            s = rets(b["c"], b["h"], i)
            d = b["d"][i]
            ctx = {"t": t, **{f"spy_{k}": v for k, v in m.items()}, **{f"stk_{k}": v for k, v in s.items()},
                   **{f"rel_{k}": s[k] - m[k] for k in ("1m", "3m", "6m")},
                   "above200": float(b["c"][i] >= b["c"][max(0, i - 199): i + 1].mean()),
                   "vix": vix["VIX"].get(d, float("nan")),
                   "vix_ratio": (vix["VIX"][d] / vix["VIX3M"][d]) if d in vix["VIX"] and d in vix["VIX3M"] else float("nan")}
            for r in candidates(b, i, "put", pricer, zs, a):
                if "pnl" not in r:
                    continue
                x = {k: r[k] for k in KEEP if k in r}
                x["dlt"] = side_delta(r)
                x["hc"] = haircut_pnl(r)                       # real-fill pnl per collateral-week
                x["inc"] = r["credit"] / r["K"] / r["h"]       # premium collected per week (Jamie's %/wk)
                x.update(ctx)
                rows.append(x)
        if n % 25 == 0:
            print(f"  {n}/{len(bars)} names · {len(rows):,} rows", flush=True)
    return rows


# ---------------------------------------------------------------- stats

def band_of(dl):
    for lo, hi in LADDER_BANDS:
        if lo <= dl < hi:
            return (lo, hi)
    return None


def stats(rs):
    if len(rs) < 20:
        return None
    hc = np.array([r["hc"] for r in rs])
    wk = defaultdict(list)
    for r in rs:
        wk[r["d"]].append(r["hc"])
    return {"n": len(rs), "bp": float(hc.mean() * 1e4), "w5": float(np.percentile(hc, 5) * 1e4),
            "kept": float(np.mean([r["kept"] for r in rs])), "inc": float(np.mean([r["inc"] for r in rs]) * 100),
            "wk": {d: float(np.mean(v)) for d, v in wk.items()}}


def by_band(rs):
    g = defaultdict(list)
    for r in rs:
        b = band_of(r["dlt"])
        if b:
            g[b].append(r)
    return {b: stats(v) for b, v in g.items()}


def choose(bands):
    ok = [(b, s) for b, s in bands.items() if s and s["n"] >= MIN_N and s["w5"] >= WORST_FLOOR]
    return max(ok, key=lambda x: x[1]["bp"])[0] if ok else None


def paired(a, b, mid):
    ks = sorted(set(a["wk"]) & set(b["wk"]))
    diff = [a["wk"][k] - b["wk"][k] for k in ks]
    h1 = [x for k, x in zip(ks, diff) if k < mid]
    h2 = [x for k, x in zip(ks, diff) if k >= mid]
    return week_t(diff), (np.mean(h1) if h1 else float("nan"), np.mean(h2) if h2 else float("nan")), len(ks)


def pval(t):
    return math.erfc(abs(t) / math.sqrt(2)) if t == t else 1.0


def holm(ps, alpha=0.05):
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    out, m, ok = [False] * len(ps), len(ps), True
    for rank, i in enumerate(order):
        ok = ok and ps[i] <= alpha / (m - rank)
        out[i] = ok
    return out


# ---------------------------------------------------------------- cells

def cells():
    """(name, predicate). Thresholds are the scan Jamie asked for: horizon × size, crash side and rally side."""
    out = []
    for k in ("1m", "3m", "6m"):
        for th in (0.03, 0.05, 0.08, 0.10, 0.15):
            out.append((f"SPY {k} ≤ −{th:.0%}", lambda r, k=k, th=th: r[f"spy_{k}"] <= -th))
            out.append((f"SPY {k} ≥ +{th:.0%}", lambda r, k=k, th=th: r[f"spy_{k}"] >= th))
    for th in (0.05, 0.10, 0.15, 0.20):
        out.append((f"SPY ≥ {th:.0%} below 52w high", lambda r, th=th: r["spy_dd52"] <= -th))
    out.append(("SPY within 2% of 52w high", lambda r: r["spy_dd52"] >= -0.02))
    for k in ("1m", "3m", "6m"):
        for th in (0.05, 0.10, 0.15, 0.20, 0.30):
            out.append((f"stock {k} vs SPY ≤ −{th:.0%}", lambda r, k=k, th=th: r[f"rel_{k}"] <= -th))
            out.append((f"stock {k} vs SPY ≥ +{th:.0%}", lambda r, k=k, th=th: r[f"rel_{k}"] >= th))
    for k in ("3m",):
        for th in (0.10, 0.20):
            out.append((f"stock {k} vs SPY ≤ −{th:.0%} & above 200d", lambda r, k=k, th=th: r[f"rel_{k}"] <= -th and r["above200"]))
            out.append((f"stock {k} vs SPY ≤ −{th:.0%} & below 200d", lambda r, k=k, th=th: r[f"rel_{k}"] <= -th and not r["above200"]))
    for th in (0.10, 0.20, 0.30, 0.40):
        out.append((f"stock ≥ {th:.0%} below 52w high", lambda r, th=th: r["stk_dd52"] <= -th))
    for lo, hi in ((0, 15), (15, 20), (20, 25), (25, 30), (30, 99)):
        out.append((f"VIX {lo}–{hi}", lambda r, lo=lo, hi=hi: lo <= r["vix"] < hi))
    out.append(("VIX ÷ VIX3M ≥ 1 (inverted)", lambda r: r["vix_ratio"] >= 1.0))
    out.append(("VIX ÷ VIX3M < 0.85 (calm)", lambda r: r["vix_ratio"] < 0.85))
    return out


def fmt_band(b):
    return f"{b[0]:.2f}–{b[1]:.2f}" if b else "—"


def analyse(rows):
    tr = [r for r in rows if r["d"] < SPLIT]
    te = [r for r in rows if r["d"] >= SPLIT]
    mid = sorted({r["d"] for r in te})[len({r["d"] for r in te}) // 2]
    L = [f"# S101 — does the best sold-put Δ band move with the market or the stock? ({date.today()})", "",
         f"{len(rows):,} put candidates · {len({r['t'] for r in rows})} names · train {min(r['d'] for r in tr)} → 2022-12 "
         f"(band chosen here) · test 2023-01 → {max(r['d'] for r in te)} (graded here; halves split {mid}).",
         "bp = real-fill pnl per collateral-week (bid + 23 % of spread, LSEG haircut), held to expiry. inc = premium collected "
         "%/wk. Default band 0.08–0.10. Pass: test Δ ≥ +8 bp/wk, week t ≥ 2, same sign both halves, worst 5 % ≥ −150, "
         "n ≥ 300, Holm 5 % across all cells.", ""]
    res = []
    for h in (1, 2, 4):
        trh = [r for r in tr if r["h"] == h]
        teh = [r for r in te if r["h"] == h]
        base_tr, base_te = by_band(trh), by_band(teh)
        L += [f"## {h}-week puts — every band, all weeks (no regime)", "",
              "| band | train bp | train worst 5 % | test bp | test worst 5 % | test kept | test inc %/wk | test n |", "|---|---|---|---|---|---|---|---|"]
        for b in LADDER_BANDS:
            a, s = base_tr.get(b), base_te.get(b)
            if a and s:
                L.append(f"| {fmt_band(b)} | {a['bp']:+.1f} | {a['w5']:+.0f} | {s['bp']:+.1f} | {s['w5']:+.0f} | {s['kept']:.1%} | {s['inc']:.2f} | {s['n']:,} |")
        L.append("")
        for name, pred in cells():
            ctr = [r for r in trh if _safe(pred, r)]
            cte = [r for r in teh if _safe(pred, r)]
            if len(cte) < MIN_N:
                continue
            btr, bte = by_band(ctr), by_band(cte)
            pick = choose(btr)
            dft = bte.get(DEFAULT)
            if not pick or not dft or not bte.get(pick) or bte[pick]["n"] < MIN_N or dft["n"] < MIN_N:
                continue
            s = bte[pick]
            t, halves, nw = paired(s, dft, mid)
            res.append({"h": h, "cell": name, "pick": pick, "s": s, "dft": dft, "t": t, "halves": halves, "nw": nw,
                        "d": s["bp"] - dft["bp"], "tr_pick": btr[pick], "bands_te": bte, "p": pval(t) if pick != DEFAULT else 1.0})
    flags = holm([r["p"] for r in res])
    for r, f in zip(res, flags):
        r["pass"] = (f and r["pick"] != DEFAULT and r["d"] >= MIN_DELTA and r["t"] >= MIN_T and r["s"]["w5"] >= WORST_FLOOR
                     and all(x > 0 for x in r["halves"]))
    return L, res, mid


def _safe(pred, r):
    try:
        return bool(pred(r))
    except (KeyError, TypeError):
        return False


def report_cells(L, res):
    for h in (1, 2, 4):
        hr = sorted([r for r in res if r["h"] == h], key=lambda r: -r["d"])
        L += [f"## {h}-week puts — band picked on 2018–22, graded 2023 →", "",
              "| cell | picked band | test bp | default bp | Δ | t | halves | worst 5 % | inc %/wk | n | ships |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for r in hr:
            L.append(f"| {r['cell']} | {fmt_band(r['pick'])} | {r['s']['bp']:+.1f} | {r['dft']['bp']:+.1f} | {r['d']:+.1f} | "
                     f"{r['t']:.1f} | {r['halves'][0] * 1e4:+.0f} / {r['halves'][1] * 1e4:+.0f} | {r['s']['w5']:+.0f} | "
                     f"{r['s']['inc']:.2f} | {r['s']['n']:,} | {'**yes**' if r['pass'] else 'no'} |")
        L.append("")


def support_and_tech(L, rows):
    """Within the default-ish band (0.08–0.12): does support distance or the technical state change outcomes? Test period only."""
    te = [r for r in rows if r["d"] >= SPLIT and r["h"] == 1 and 0.08 <= r["dlt"] < 0.12]
    L += ["## Support distance at the same Δ (1-week, 0.08–0.12Δ, 2023 →)", "",
          "| state | bp | worst 5 % | kept | n |", "|---|---|---|---|---|"]
    groups = [("support zone between strike and price", lambda r: r.get("guard_n", 0) > 0),
              ("no support between strike and price", lambda r: r.get("guard_n", 0) == 0),
              ("next support below strike ≤ 0.5σ away", lambda r: r.get("cushion_sig", 9) <= 0.5),
              ("next support below strike 0.5–1.5σ away", lambda r: 0.5 < r.get("cushion_sig", 9) <= 1.5),
              ("no support within 1.5σ below strike", lambda r: r.get("cushion_sig", 9) > 1.5)]
    for name, p in groups:
        s = stats([r for r in te if p(r)])
        if s:
            L.append(f"| {name} | {s['bp']:+.1f} | {s['w5']:+.0f} | {s['kept']:.1%} | {s['n']:,} |")
    L += ["", "## Technicals as name quality (same band, 1-week, 2023 →): top vs bottom fifth", "",
          "| feature | bottom fifth bp | top fifth bp | top − bottom | week t | worst 5 % top / bottom |", "|---|---|---|---|---|---|"]
    for f in ("dist200", "dist50", "ret20", "rsi14", "dd60", "iv_rv", "iv_rank", "rel_3m", "stk_dd52"):
        xs = [r for r in te if r.get(f) is not None and r[f] == r[f]]
        if len(xs) < 1000:
            continue
        by = defaultdict(list)
        for r in xs:
            by[r["d"]].append(r)
        lo_r, hi_r = [], []
        for d, v in by.items():   # cross-sectional fifths each week (no look-ahead)
            v = sorted(v, key=lambda r: r[f])
            k = max(1, len(v) // 5)
            lo_r += v[:k]
            hi_r += v[-k:]
        a, b = stats(lo_r), stats(hi_r)
        t, _, _ = paired(b, a, date(2100, 1, 1))
        L.append(f"| {f} | {a['bp']:+.1f} | {b['bp']:+.1f} | {b['bp'] - a['bp']:+.1f} | {t:.1f} | {b['w5']:+.0f} / {a['w5']:+.0f} |")
    L.append("")


def main():
    args = {a.split("=")[0]: (a.split("=")[1] if "=" in a else True) for a in sys.argv[1:]}
    only = set(args["--tickers"].split(",")) if "--tickers" in args else None
    if only or args.get("--rebuild") or not CACHE.exists():
        with connect() as conn:
            rows = build(conn, only)
        if not only:
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_bytes(pickle.dumps(rows))
    else:
        rows = pickle.loads(CACHE.read_bytes())
    print(f"{len(rows):,} rows", flush=True)
    L, res, _ = analyse(rows)
    report_cells(L, res)
    support_and_tech(L, rows)
    passed = [r for r in res if r["pass"]]
    L.insert(5, f"**Cells tried {len(res)} · ship {len(passed)}** — " + "; ".join(
        f"{r['h']}w {r['cell']} → {fmt_band(r['pick'])} ({r['d']:+.1f} bp/wk, t {r['t']:.1f})" for r in passed[:12]) + "\n")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[:8]))
    print(f"→ {OUT}")


if __name__ == "__main__":
    main()
