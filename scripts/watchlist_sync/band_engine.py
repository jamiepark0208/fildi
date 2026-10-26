#!/usr/bin/env python3
"""Sold-put band engine (A277 §8, S101): the target |Δ| band moves with the market and with the stock (Jamie 10-26).

State = market state × name state, read from point-in-time indicators:
  market  panic      VIX ÷ VIX3M ≥ 1 (vol curve inverted: the selloff is still running)
          sharp_drop SPY 3m ≤ −8 %, curve back < 1 (V-shaped selloff)
          bear_grind SPY ≥ 10 % below its 52w high without a sharp 3m drop (2022-style slow bear)
          rally      SPY 6m ≥ +10 % or SPY within 2 % of its 52w high
          normal     everything else
  name    crashed    stock ≥ 30 % below its 52w high or 3m return ≥ 20 % under SPY
          extended   3m return ≥ 15 % over SPY
          normal     everything else
For every state the engine keeps each band's history (net real-fill bp/wk, worst 5 %, kept %, income %/wk) and picks the
band with the best net bp/wk whose worst 5 % week stays above the risk floor (default −150 bp; aggressive −300).
`backtest` fits the table on ≤ 2022 and grades the auto-band against fixed bands on 2023 → (rows from S101's cache).

    .venv/bin/python band_engine.py backtest
    .venv/bin/python band_engine.py today [--tickers=A,B]      # every band per name, chosen band marked
"""
from __future__ import annotations

import json
import math
import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "analysis"))

from s088_sr_zones import LADDER_BANDS, week_t  # noqa: E402

CACHE = Path.home() / ".fildi" / "cache" / "s101_rows.pkl"
TABLE = HERE / "out" / "opt" / "band_engine.json"
REPORT = HERE / "out" / "opt" / "band_engine.md"
SPLIT = date(2023, 1, 1)
FLOORS = {"standard": -150.0, "aggressive": -300.0}
MIN_N = 150
BANDS = [f"{lo:.2f}-{hi:.2f}" for lo, hi in LADDER_BANDS]


def market_state(f):
    if f.get("vix_ratio", 0) >= 1.0:
        return "panic"
    if f["spy_3m"] <= -0.08:
        return "sharp_drop"
    if f["spy_dd52"] <= -0.10:
        return "bear_grind"
    if f["spy_6m"] >= 0.10 or f["spy_dd52"] >= -0.02:
        return "rally"
    return "normal"


def name_state(f):
    if f["stk_dd52"] <= -0.30 or f["rel_3m"] <= -0.20:
        return "crashed"
    if f["rel_3m"] >= 0.15:
        return "extended"
    return "normal"


def band_of(dl):
    for lo, hi in LADDER_BANDS:
        if lo <= dl < hi:
            return f"{lo:.2f}-{hi:.2f}"
    return None


def stats(rs):
    hc = np.array([r["hc"] for r in rs])
    return {"n": len(rs), "bp": float(hc.mean() * 1e4), "w5": float(np.percentile(hc, 5) * 1e4),
            "kept": float(np.mean([r["kept"] for r in rs])), "inc": float(np.mean([r["inc"] for r in rs]) * 100),
            "months": len({(r["d"].year, r["d"].month) for r in rs})}


def fit(rows):
    g = defaultdict(list)
    for r in rows:
        b = band_of(r["dlt"])
        if b:
            g[(market_state(r), name_state(r), b)].append(r)
    return {f"{m}|{n}|{b}": stats(v) for (m, n, b), v in g.items() if len(v) >= MIN_N}


def choose(table, m, n, floor):
    """Best net bp/wk with worst 5 % ≥ floor. Panic → no band unless one is positive with the tail inside the floor."""
    ok = [(b, table[k]) for b in BANDS if (k := f"{m}|{n}|{b}") in table and table[k]["w5"] >= floor]
    if not ok:
        return None
    b, s = max(ok, key=lambda x: x[1]["bp"])
    return b if s["bp"] > 0 else None


def pick_rows(rows, rule):
    """One trade per name-week: the candidate nearest the middle of the band `rule(row)` returns (None = no trade)."""
    by = defaultdict(list)
    for r in rows:
        by[(r["t"], r["d"])].append(r)
    out = []
    for rs in by.values():
        band = rule(rs[0])
        if not band:
            continue
        lo, hi = (float(x) for x in band.split("-"))
        inb = [r for r in rs if lo <= r["dlt"] < hi]
        if inb:
            out.append(min(inb, key=lambda r: abs(r["dlt"] - (lo + hi) / 2)))
    return out


def weekly(rs):
    w = defaultdict(list)
    for r in rs:
        w[r["d"]].append(r["hc"])
    return {d: float(np.mean(v)) for d, v in w.items()}


def summary(rs, all_weeks):
    """Per collateral-week of a book that trades the rule each week (no-trade weeks count as 0, so pausing has a cost)."""
    w = weekly(rs)
    series = np.array([w.get(d, 0.0) for d in all_weeks])
    s = stats(rs) if rs else {"n": 0, "bp": float("nan"), "w5": float("nan"), "kept": float("nan"), "inc": float("nan"), "months": 0}
    eq = np.cumprod(1 + series)
    return {**s, "book_bp": float(series.mean() * 1e4), "book_w5": float(np.percentile(series, 5) * 1e4),
            "sharpe": float(series.mean() / series.std(ddof=1) * math.sqrt(52)) if series.std() > 0 else float("nan"),
            "mdd": float((eq / np.maximum.accumulate(eq) - 1).min() * 100), "series": dict(zip(all_weeks, series))}


def state_weights(rows, table):
    pk = pick_rows(rows, lambda r: choose(table, market_state(r), name_state(r), FLOORS["standard"]))
    bp = defaultdict(list)
    for r in pk:
        bp[market_state(r)].append(r["hc"])
    m = {s: float(np.mean(v)) for s, v in bp.items()}
    top = max(m.values())
    return {s: max(0.0, m.get(s, 0.0)) / top for s in ("panic", "sharp_drop", "bear_grind", "normal", "rally")}


def backtest():
    rows = [r for r in pickle.loads(CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    tr = [r for r in rows if r["d"] < SPLIT]
    te = [r for r in rows if r["d"] >= SPLIT]
    table = fit(tr)
    weeks = sorted({r["d"] for r in te})
    mid = weeks[len(weeks) // 2]
    rules = {f"fixed {b}": (lambda r, b=b: b) for b in ("0.06-0.08", "0.10-0.12", "0.15-0.20")}
    for name, fl in FLOORS.items():
        rules[f"auto ({name}, tail ≥ {fl:.0f})"] = lambda r, fl=fl: choose(table, market_state(r), name_state(r), fl)
    res = {k: summary(pick_rows(te, f), weeks) for k, f in rules.items()}
    # Timing = size by market state (S101: post-crash weeks pay 2–3×). Weights from ≤ 2022 only: the state's book bp at its
    # chosen bands ÷ the best state's, floored at 0 → panic 0. Applied to the standard auto rule.
    sw = state_weights(tr, table)
    pk = pick_rows(te, rules["auto (standard, tail ≥ -150)"])
    sized = [{**r, "hc": r["hc"] * sw[market_state(r)]} for r in pk]
    res["auto standard + size by market state"] = summary(sized, weeks)
    res["auto standard + size by market state"]["note"] = sw
    base = res["fixed 0.06-0.08"]["series"]
    L = [f"# Band engine — auto band vs fixed bands ({date.today()})", "",
         f"Table fitted on {min(r['d'] for r in tr)} → 2022-12 ({len(tr):,} 1-week put candidates); graded on 2023-01 → "
         f"{max(weeks)} ({len(te):,}). One trade per name-week at the chosen band. **book** = the average name-week each week, "
         "weeks with no trade count as 0. bp = real-fill net per collateral-week.", "",
         "| rule | trades | book bp/wk | book worst 5 % wk | Sharpe | max DD % | per-trade bp | per-trade worst 5 % | income %/wk | vs fixed 0.06–0.08: Δ bp (t) · halves |",
         "|---|---|---|---|---|---|---|---|---|---|"]
    for k, s in res.items():
        dif = [s["series"][d] - base[d] for d in weeks]
        h1 = np.mean([x for d, x in zip(weeks, dif) if d < mid]) * 1e4
        h2 = np.mean([x for d, x in zip(weeks, dif) if d >= mid]) * 1e4
        L.append(f"| {k} | {s['n']:,} | {s['book_bp']:+.1f} | {s['book_w5']:+.0f} | {s['sharpe']:.2f} | {s['mdd']:.1f} | "
                 f"{s['bp']:+.1f} | {s['w5']:+.0f} | {s['inc']:.2f} | {np.mean(dif) * 1e4:+.1f} ({week_t(dif):.1f}) · {h1:+.1f} / {h2:+.1f} |")
    L += ["", "Size by market state (fitted ≤ 2022): " + " · ".join(f"{k} {v:.2f}×" for k, v in sw.items()), ""]
    L += ["", "## The table: chosen band per state (fitted ≤ 2022; standard / aggressive floor) + test check 2023 →", "",
          "| market | name | standard band | aggressive band | train bp / worst 5 % (standard) | test bp / worst 5 % (standard band) | test months |",
          "|---|---|---|---|---|---|---|"]
    test_tab = fit(te)
    for m in ("panic", "sharp_drop", "bear_grind", "normal", "rally"):
        for n in ("crashed", "normal", "extended"):
            bs, ba = choose(table, m, n, FLOORS["standard"]), choose(table, m, n, FLOORS["aggressive"])
            a = table.get(f"{m}|{n}|{bs}") if bs else None
            t = test_tab.get(f"{m}|{n}|{bs}") if bs else None
            L.append(f"| {m} | {n} | {bs or 'no trade'} | {ba or 'no trade'} | "
                     f"{f'{a['bp']:+.0f} / {a['w5']:+.0f}' if a else '—'} | {f'{t['bp']:+.0f} / {t['w5']:+.0f}' if t else '—'} | "
                     f"{t['months'] if t else '—'} |")
    full = fit(rows)   # live table = all history (the test was the out-of-sample check above)
    TABLE.write_text(json.dumps({"fitted": str(date.today()), "rows": len(rows), "floors": FLOORS, "table": full,
                                 "size": state_weights(rows, full)}, indent=1))
    REPORT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    print(f"→ {REPORT} · live table {TABLE}")


def today():
    """Every band for each name at the last close: modelled 1-week strike + income, the band's history in this name's state,
    and the engine's pick (standard / aggressive). Credits are modelled (S076 pricer on LSEG IV), not live quotes."""
    from build_plan import connect
    from s076_structures_backtest import Pricer
    from s088_sr_zones import candidates, load, side_delta, zones
    from s101_band_regime import rets, spy_and_vix
    tab = json.loads(TABLE.read_text())
    table = tab["table"]
    args = dict(a.split("=", 1) for a in sys.argv[2:] if "=" in a)
    with connect() as c:
        only = set(args["--tickers"].split(",")) if "--tickers" in args else {
            t for (t,) in c.execute("SELECT DISTINCT ticker FROM watchlist")}
        bars, (spy, vix), pr = load(c, only), spy_and_vix(c), Pricer(c)
    si = len(spy["d"]) - 1
    d0 = spy["d"][si]
    m = rets(spy["c"], spy["h"], si)
    mf = {f"spy_{k}": v for k, v in m.items()} | {"vix_ratio": vix["VIX"][d0] / vix["VIX3M"][d0]}
    ms = market_state(mf)
    L = [f"# Sold-put bands today ({d0} close)", "",
         f"Market: SPY 1m {m['1m']:+.1%} · 3m {m['3m']:+.1%} · 6m {m['6m']:+.1%} · {m['dd52']:+.1%} from 52w high · VIX {vix['VIX'][d0]:.1f} · "
         f"VIX ÷ VIX3M {mf['vix_ratio']:.2f} → **{ms}**", "",
         "Each cell: modelled 1-week strike · income %/wk · history in this state (net bp/wk, worst 5 %). "
         "**bold** = engine pick (standard tail ≥ −150), ◆ = aggressive pick (tail ≥ −300).", "",
         "| ticker | name state | " + " | ".join(BANDS) + " |", "|---|---|" + "---|" * len(BANDS)]
    for t in sorted(only):
        b = bars.get(t)
        if not b:
            continue
        i = len(b["c"]) - 1
        s = rets(b["c"], b["h"], i)
        ns = name_state({"stk_dd52": s["dd52"], "rel_3m": s["3m"] - m["3m"]})
        pick_s, pick_a = choose(table, ms, ns, FLOORS["standard"]), choose(table, ms, ns, FLOORS["aggressive"])
        zs, a = zones(b, i)
        best = {}
        for r in candidates(b, i, "put", pr, zs, a):
            if r["h"] != 1:
                continue
            bd = band_of(side_delta(r))
            if bd:
                lo, hi = (float(x) for x in bd.split("-"))
                mid_ = (lo + hi) / 2
                if bd not in best or abs(side_delta(r) - mid_) < abs(side_delta(best[bd]) - mid_):
                    best[bd] = r
        cells = []
        for bd in BANDS:
            h = table.get(f"{ms}|{ns}|{bd}")
            hist = f"{h['bp']:+.0f}/{h['w5']:+.0f}" if h else "–"
            r = best.get(bd)
            txt = f"{r['K']:g} · {r['credit'] / r['K'] * 100:.2f}% · {hist}" if r else f"— · {hist}"
            txt = f"**{txt}**" if bd == pick_s else txt
            cells.append(txt + (" ◆" if bd == pick_a else ""))
        L.append(f"| {t} {b['c'][i]:.2f} | {ns} ({s['dd52']:+.0%} hi, {s['3m'] - m['3m']:+.0%} vs SPY 3m) | " + " | ".join(cells) + " |")
    out = HERE / "out" / "opt" / "band_engine_today.md"
    out.write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    {"backtest": backtest, "today": today}[sys.argv[1] if len(sys.argv) > 1 else "backtest"]()
