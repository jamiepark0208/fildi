#!/usr/bin/env python3
"""Sold-put band engine (A277 §8, S101): the target |Δ| band moves with the market and with the stock (Jamie 10-26).

State = market state × name state, read from point-in-time indicators:
  market  panic      VIX ÷ VIX3M ≥ 1 (vol curve inverted: the selloff is still running)
          sharp_drop SPY 3m ≤ −8 %, curve back < 1 (V-shaped selloff)
          bear_grind SPY ≥ 10 % below its 52w high without a sharp 3m drop (2022-style slow bear)
          sector_drop SPY calm but the name's sector ETF ≥ 15 % below its 52w close high (10-26: SMH −20 % while SPY −2.5 %;
                     sector = the ETF its daily returns tracked best over the prior year, point-in-time)
          rally      SPY 6m ≥ +10 % or SPY within 2 % of its 52w high
          normal     everything else
  name    crashed    stock ≥ 30 % below its 52w high or 3m return ≥ 20 % under SPY
          extended   3m return ≥ 15 % over SPY
          normal     everything else
For every state the engine keeps each band's history (net real-fill bp/wk, worst 5 %, kept %, income %/wk) and picks the
band with the best net bp/wk whose worst 5 % week stays above the risk floor (standard −200 bp; aggressive −400), and
moves off the base band only when that beat the base in both halves of the fitted period.
`backtest` fits the table on ≤ 2022 and grades the auto-band against fixed bands on 2023 → (rows from S101's cache).

    .venv/bin/python band_engine.py backtest
    .venv/bin/python band_engine.py today [--tickers=A,B]      # every band per name, chosen band marked
    .venv/bin/python band_engine.py refresh                    # weekly refit of the live table (daily.py)
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
FLOORS = {"standard": -200.0, "aggressive": -400.0}   # 10-26: frontier on fixed pricer — −200 matches the live 0.09Δ return at < ½ its drawdown (2023→)
MIN_N = 150
BANDS = [f"{lo:.2f}-{hi:.2f}" for lo, hi in LADDER_BANDS]
from sector_etfs import BROAD, ETFS as _ETFS  # noqa: E402
# The state uses the 14 broad ETFs (SMH ≈ SOXX, r 0.99). 10-26 test with all 49 (themes: REMX, WGMI, TAN …) as the trigger:
# fires in 41/46 test months, no extra bp at 0.15–0.20Δ (+38/+44) and worst 5 % −550 → themes are where to look
# (sector_etfs.py board), not how aggressive to be.
SECTOR_ETFS = list(BROAD)
BREADTH_WASHOUT = 0.25   # A281 #6 (10-26): ≤ 25 % of names in a UT Bot uptrend while SPY is calm → net bp rises with Δ, mild tails, both periods
SECTOR_DD = -0.15   # S101 sector probe 10-26: ≥ 15 % off high passed both periods; 1m ≤ −8 % / QQQ 1m ≤ −5 % did not


def _closes(conn, tickers, since=None):
    """Stocks from LSEG daily_history, sector ETFs from sector_etf_daily (LSEG / CRSP + Polygon stitched)."""
    px = defaultdict(dict)
    etf = [t for t in tickers if t in _ETFS]
    for tab, ts in (("lseg_research.daily_history", [t for t in tickers if t not in _ETFS]), ("watchlist_sync.sector_etf_daily", etf)):
        for t, d, c in conn.execute(f"SELECT ticker, date, close::float8 FROM {tab} WHERE ticker = ANY(%s) AND close > 0"
                                    + (" AND date >= %s" if since else ""), (ts,) + ((since,) if since else ())):
            px[t][d] = c
    return px


def _best_etf(px, t, days, etfs=None):
    """ETF whose daily log returns correlate most with t's over `days` (≥ 150 shared days), else None."""
    def r(x):
        ds = [d for d in days if d in px[x]]
        return {b: math.log(px[x][b] / px[x][a]) for a, b in zip(ds, ds[1:])}
    rt = r(t)
    best = None
    for e in etfs or SECTOR_ETFS:
        if not px.get(e):
            continue
        re_ = r(e)
        ks = [d for d in rt if d in re_]
        if len(ks) < 150:
            continue
        cc = float(np.corrcoef([rt[d] for d in ks], [re_[d] for d in ks])[0, 1])
        if best is None or cc > best[1]:
            best = (e, cc)
    return best[0] if best else None


def _etf_dd(px, e, d):
    """ETF close at the last date ≤ d vs its 252-day close high (None if < 252 days)."""
    ds = [x for x in sorted(px[e]) if x <= d][-252:]
    return px[e][ds[-1]] / max(px[e][x] for x in ds) - 1 if len(ds) == 252 else None


def breadth_series(conn, tickers=None) -> dict:
    """{date: share of names with UT Bot long} over every LSEG name with ≥ 320 bars (indicators.py), point-in-time."""
    import indicators as IND
    up, n = defaultdict(int), defaultdict(int)
    for t, b in IND.load_bars(conn, tickers).items():
        if t in _ETFS or len(b[3]) < 320:
            continue
        s = IND.compute(*b)
        for d, u in zip(b[0][300:], s["ut_dir"][300:]):
            n[d] += 1
            up[d] += u > 0
    return {d: up[d] / n[d] for d in n if n[d] >= 50}


def add_breadth(conn, rows):
    br = breadth_series(conn)
    for r in rows:
        r["ut_breadth"] = br.get(r["d"])
    return rows


def add_sector(conn, rows):
    """Point-in-time sector ETF (prior calendar year's best correlation) + its drawdown on each row (sec, sec_dd52)."""
    names = sorted({r["t"] for r in rows})
    px = _closes(conn, names + SECTOR_ETFS)
    sec, dd = {}, {}
    for r in rows:
        k = (r["t"], r["d"].year)
        if k not in sec:
            sec[k] = _best_etf(px, r["t"], sorted(d for d in px[r["t"]] if d.year == k[1] - 1)) if px.get(r["t"]) else None
        e = sec[k]
        if e:
            if (e, r["d"]) not in dd:
                dd[(e, r["d"])] = _etf_dd(px, e, r["d"])
            r["sec"], r["sec_dd52"] = e, dd[(e, r["d"])]
    return rows


def sector_now(conn, tickers):
    """{ticker: (etf, etf drawdown)} at the last close; sector = best correlation over the trailing year."""
    from datetime import timedelta
    px = _closes(conn, list(tickers) + SECTOR_ETFS, date.today() - timedelta(days=760))
    end = max(max(px[e]) for e in SECTOR_ETFS if px.get(e))
    out = {}
    for t in tickers:
        e = _best_etf(px, t, sorted(d for d in px.get(t, {}) if d > end - timedelta(days=365))) if px.get(t) else None
        if e:
            out[t] = (e, _etf_dd(px, e, end))
    return out


def market_state(f):
    if f.get("vix_ratio", 0) >= 1.0:
        return "panic"
    if f["spy_3m"] <= -0.08:
        return "sharp_drop"
    if f["spy_dd52"] <= -0.10:
        return "bear_grind"
    if f.get("ut_breadth") is not None and f["ut_breadth"] <= BREADTH_WASHOUT:
        return "breadth_washout"
    if (f.get("sec_dd52") or 0) <= SECTOR_DD:
        return "sector_drop"
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
    """Per state × band stats, plus each half of the fitted period (stability check) and every band over all states
    (the base the states must beat)."""
    ds = sorted({r["d"] for r in rows})
    mid = ds[len(ds) // 2]
    g = defaultdict(list)
    for r in rows:
        b = band_of(r["dlt"])
        if b:
            g[(market_state(r), name_state(r), b)].append(r)
            g[("all", "all", b)].append(r)
    out = {}
    for (m, n, b), v in g.items():
        if len(v) < MIN_N:
            continue
        s = stats(v)
        for h, part in (("h1", [r for r in v if r["d"] < mid]), ("h2", [r for r in v if r["d"] >= mid])):
            s[h] = float(np.mean([r["hc"] for r in part]) * 1e4) if len(part) >= 30 else None
        out[f"{m}|{n}|{b}"] = s
    return out


def base_band(table, floor):
    ok = [(b, table[k]) for b in BANDS if (k := f"all|all|{b}") in table and table[k]["w5"] >= floor]
    return max(ok, key=lambda x: x[1]["bp"])[0] if ok else None


def choose(table, m, n, floor):
    """Best net bp/wk with worst 5 % ≥ floor — but a state's band replaces the base band only if it beats the base in the
    same state in BOTH halves of the fitted period (else the base, if its own tail passes here). Nothing positive → no trade."""
    base = base_band(table, floor)
    ok = [(b, table[k]) for b in BANDS if (k := f"{m}|{n}|{b}") in table and table[k]["w5"] >= floor and table[k]["bp"] > 0]
    if not ok:
        return None
    b, s = max(ok, key=lambda x: x[1]["bp"])
    if b == base:
        return b
    bs = table.get(f"{m}|{n}|{base}")
    stable = bs and all(s[h] is not None and bs[h] is not None and s[h] > bs[h] for h in ("h1", "h2"))
    if stable:
        return b
    return base if bs and bs["w5"] >= floor and bs["bp"] > 0 else b


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


def backtest():
    from build_plan import connect
    rows = [r for r in pickle.loads(CACHE.read_bytes()) if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        add_sector(c, rows)
        add_breadth(c, rows)
    tr = [r for r in rows if r["d"] < SPLIT]
    te = [r for r in rows if r["d"] >= SPLIT]
    table = fit(tr)
    weeks = sorted({r["d"] for r in te})
    mid = weeks[len(weeks) // 2]
    rules = {f"fixed {b}": (lambda r, b=b: b) for b in ("0.06-0.08", "0.08-0.10", "0.10-0.12", "0.15-0.20")}
    for name, fl in FLOORS.items():
        rules[f"auto ({name}, tail ≥ {fl:.0f})"] = lambda r, fl=fl: choose(table, market_state(r), name_state(r), fl)
    res = {k: summary(pick_rows(te, f), weeks) for k, f in rules.items()}
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
    L += ["", "Size by market state was tested (weights from ≤ 2022) and failed out of sample (Sharpe and bp down) → not used; panic = no trade is the only timing rule.", ""]
    L += ["", "## The table: chosen band per state (fitted ≤ 2022; standard / aggressive floor) + test check 2023 →", "",
          "| market | name | standard band | aggressive band | train bp / worst 5 % (standard) | test bp / worst 5 % (standard band) | test months |",
          "|---|---|---|---|---|---|---|"]
    test_tab = fit(te)
    for m in ("panic", "sharp_drop", "bear_grind", "breadth_washout", "sector_drop", "normal", "rally"):
        for n in ("crashed", "normal", "extended"):
            bs, ba = choose(table, m, n, FLOORS["standard"]), choose(table, m, n, FLOORS["aggressive"])
            a = table.get(f"{m}|{n}|{bs}") if bs else None
            t = test_tab.get(f"{m}|{n}|{bs}") if bs else None
            L.append(f"| {m} | {n} | {bs or 'no trade'} | {ba or 'no trade'} | "
                     f"{f'{a['bp']:+.0f} / {a['w5']:+.0f}' if a else '—'} | {f'{t['bp']:+.0f} / {t['w5']:+.0f}' if t else '—'} | "
                     f"{t['months'] if t else '—'} |")
    full = fit(rows)   # live table = all history (the test was the out-of-sample check above)
    TABLE.write_text(json.dumps({"fitted": str(date.today()), "rows": len(rows), "floors": FLOORS, "table": full}, indent=1))
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
         "**bold** = engine pick (standard tail ≥ −200), ◆ = aggressive pick (tail ≥ −400).", "",
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


def refresh():
    """Weekly (daily.py 'band table'): rebuild the S101 rows and refit the live table on all history. ~5 min; skips < 6.5 days."""
    import time
    if TABLE.exists() and time.time() - TABLE.stat().st_mtime < 6.5 * 86400:
        print(f"band table: fresh ({TABLE.name}, {(time.time() - TABLE.stat().st_mtime) / 86400:.1f} d)")
        return
    from build_plan import connect
    from s101_band_regime import build
    with connect() as c:
        rows = build(c)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(pickle.dumps(rows))
    rows = [r for r in rows if r["h"] == 1 and r.get("vix_ratio") == r.get("vix_ratio")]
    with connect() as c:
        add_sector(c, rows)
        add_breadth(c, rows)
    TABLE.write_text(json.dumps({"fitted": str(date.today()), "rows": len(rows), "floors": FLOORS, "table": fit(rows)}, indent=1))
    print(f"band table: refit on {len(rows):,} rows → {TABLE}")


if __name__ == "__main__":
    {"backtest": backtest, "today": today, "refresh": refresh}[sys.argv[1] if len(sys.argv) > 1 else "backtest"]()
