#!/usr/bin/env python3
"""S103 (A279 v2, Jamie 10-26): use the TradingView indicators the way they are built — to TIME entries and exits — on a
sold-put lane that closes early and re-sells, graded on return per dollar of collateral per day (idle days earn T-bills).

S102 graded the indicators as filters on puts held to expiry from a fixed Monday. That is not their job: UT Bot / SuperTrend
time trend flips, SMC times reversals after liquidity sweeps, Fear & Greed times sentiment extremes, divergence warns a trend
is tiring. Here each one gets the role it is designed for.

Lane (one per name): when flat and the entry rule is on, sell a put at the close (1 week: 0.12Δ; 3 weeks: 0.15Δ; earnings
inside the window → 0.07Δ, the far rule). Mark it every close with the S076 pricer (BS at LSEG iv30_put × real/model ratio
curve), buy back at mid + 27 % of the modelled spread (≥ $0.02). Exit on the first exit rule that fires, else settle at
expiry. Re-sell at the exit close if the entry rule is still on (the "find another opportunity" step).

Entry rules (when to sell)
  N0 Monday            today's lane: every Monday (baseline)
  N1 any day           re-sell immediately whenever flat
  N2 UT up             UT Bot long, fresh flip (≤ 3 bars) or confidence ≥ 60
  N3 cluster bull      SuperTrend cluster regime bull and bull share ≥ 0.6
  N4 SMC reclaim       swing-low sweep ≤ 3 bars ago, closed back above; strike at or below the swept low
  N5 fear exhausted    Fear & Greed crossed back above 30 within 3 bars (sell into fear as it turns)
  N6 bull divergence   confirmed bullish RSI divergence ≤ 5 bars ago
  N7 skip downtrend    any day, except UT down with ≥ 60 % of past downtrends still running (wait it out)
Exit rules (when to buy back)
  E0 hold · E1 50 % / 65 % / 80 % of the credit captured
  E2 pace k: captured ≥ 25 % and captured ÷ elapsed days ≥ k × (1 ÷ total days), k = 2, 3, 4 (Jamie: 1 %/wk ≈ 0.14 %/day;
     earning 0.5–0.75 %/day = 3.5–5× pace → take it and re-sell)
  E3 UT flips down (stop) · E4 cluster turns bear (stop) · E5 greed ≥ 70 with ≥ 25 % captured · E6 bearish divergence in profit
  E7 pace 2 + greed · E8 pace 3 + UT stop

PASS (pre-registered): annualized lane return beats N0×E0 (1 week) in BOTH periods (2020-09→2022, 2023→), weekly-difference
t ≥ 3 (≈ 190 combos), and max drawdown not > 25 % worse. Winners then re-checked on real LSEG option quotes (optlab.lseg_opt_daily).

    .venv/bin/python analysis/s103_put_lifecycle.py --tickers=NVDA,AAPL,MSFT,AMD,JPM   # smoke test: prints trades
    .venv/bin/python analysis/s103_put_lifecycle.py                                    # full run → out/opt/S103.md
"""
from __future__ import annotations

import math
import pickle
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from statistics import NormalDist

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent)); sys.path.insert(0, str(HERE))
import indicators as IND  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import Pricer, fill  # noqa: E402
from s088_sr_zones import MIN_CREDIT, MIN_SPOT, listed_strike  # noqa: E402

START, SPLIT = date(2020, 9, 1), date(2023, 1, 1)
OUT = HERE.parent / "out" / "opt" / "S103.md"
CACHE = Path.home() / ".fildi" / "cache" / "s103_paths.pkl"
TENORS = {"1w": (5, 0.12), "3w": (15, 0.15)}
FAR_DELTA = 0.07
MIN_BUY = 0.02
N = NormalDist()

EXITS = {
    "E0 hold": lambda p: None,
    "E1 50%": lambda p: _first(p["cap"] >= 0.50),
    "E1 65%": lambda p: _first(p["cap"] >= 0.65),
    "E1 80%": lambda p: _first(p["cap"] >= 0.80),
    "E2 pace 2×": lambda p: _first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 2 / p["tot"])),
    "E2 pace 3×": lambda p: _first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 3 / p["tot"])),
    "E2 pace 4×": lambda p: _first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 4 / p["tot"])),
    "E2 pace 5×": lambda p: _first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 5 / p["tot"])),
    "E2 pace 6×": lambda p: _first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 6 / p["tot"])),
    "E3 UT flips down": lambda p: _first(p["ut_dn"]),
    "E4 cluster bear": lambda p: _first(p["cl_dn"]),
    "E5 greed ≥70": lambda p: _first((p["fg"] >= 70) & (p["cap"] >= 0.25)),
    "E6 bear div in profit": lambda p: _first(p["bdiv"] & (p["cap"] > 0)),
    "E7 pace 2× + greed": lambda p: _min(_first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 2 / p["tot"])), _first((p["fg"] >= 70) & (p["cap"] >= 0.25))),
    "E8 pace 3× + UT stop": lambda p: _min(_first((p["cap"] >= 0.25) & (p["cap"] / p["el"] >= 3 / p["tot"])), _first(p["ut_dn"])),
}


def _first(mask):
    idx = np.flatnonzero(mask)
    return int(idx[0]) if len(idx) else None


def _min(a, b):
    return a if b is None else b if a is None else min(a, b)


def entry_rules(s, d):
    n = len(d)
    mon = np.array([x.weekday() == 0 for x in d])
    fg = s["fear_greed"]
    fg_up = np.zeros(n, bool)
    for i in range(1, n):
        if fg[i - 1] < 30 <= fg[i]:
            fg_up[i:i + 4] = True
    bdiv = np.zeros(n, bool)
    for i in np.flatnonzero(s["rsi_div"] > 0):
        bdiv[i:i + 6] = True
    surv = np.nan_to_num(s["ut_surv"], nan=0.0)
    return {
        "N0 Monday": mon,
        "N1 any day": np.ones(n, bool),
        "N2 UT up": (s["ut_dir"] > 0) & ((s["ut_bars"] <= 3) | (s["ut_conf"] >= 60)),
        "N3 cluster bull": (s["stc_regime"] > 0) & (s["stc_bull"] >= 0.6),
        "N4 SMC reclaim": np.nan_to_num(s["sweep_age"], nan=99) <= 3,
        "N5 fear exhausted": fg_up,
        "N6 bull divergence": bdiv,
        "N7 skip downtrend": ~((s["ut_dir"] < 0) & (surv >= 0.6)),
    }


def build_paths(conn, tickers=None):
    """{ticker: {tenor: {i: path}}} + per-name dates/closes. One path per possible entry day; exits pre-evaluated."""
    pr = Pricer(conn)
    bars = IND.load_bars(conn, tickers)
    iv = defaultdict(dict)
    for t, d, v in conn.execute("SELECT ticker, date, iv30_put::float8 FROM lseg_research.daily_history WHERE iv30_put > 0"
                                + (" AND ticker = ANY(%s)" if tickers else ""), (list(tickers),) if tickers else ()):
        iv[t][d] = v / 100 if v > 3 else v
    rep = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves"):
        rep[t].append(d)
    out = {}
    for t, (d, h, l, c, v) in bars.items():
        if len(c) < 400 or t not in iv:
            continue
        s = IND.compute(d, h, l, c, v)
        c = np.asarray(c, float)
        ivs = np.array([iv[t].get(x, np.nan) for x in d])
        for k in range(1, len(ivs)):   # carry IV ≤ 3 days over gaps
            if np.isnan(ivs[k]) and not np.isnan(ivs[k - 1]) and (d[k] - d[max(0, k - 3)]).days <= 5:
                ivs[k] = ivs[k - 1]
        er = sorted(rep.get(t, []))
        names = {"d": d, "c": c, "rules": entry_rules(s, d), "paths": {}}
        for ten, (H, dl0) in TENORS.items():
            P = {}
            for i in range(len(d) - H):
                if d[i] < START or np.isnan(ivs[i]) or c[i] < MIN_SPOT:
                    continue
                S, sig, j = c[i], ivs[i], i + H
                tot = (d[j] - d[i]).days
                sd = sig * math.sqrt(tot / 365)
                earn = any(d[i] < e <= d[j] for e in er)
                dl = FAR_DELTA if earn else dl0
                K = S * math.exp(-(N.inv_cdf(1 - dl) * sd - 0.5 * sd * sd))
                K_smc = min(K, s["sweep_low"][i]) if not np.isnan(s["sweep_low"][i]) else K
                row = {}
                for tag, KK in (("std", K), ("smc", K_smc)):
                    KK = listed_strike(KK, S, "put")
                    if KK <= 0 or KK >= S:
                        continue
                    mid, spr = pr.mid("put", S, KK, sig, tot, d[i])
                    credit = fill(mid, spr, -1)
                    if credit < MIN_CREDIT:
                        continue
                    ks = np.arange(i + 1, j + 1)
                    buy = np.empty(len(ks))
                    for n_, k in enumerate(ks):
                        if k == j or np.isnan(ivs[k]):
                            buy[n_] = max(KK - c[k], 0.0) if k == j else np.nan
                        else:
                            m, sp = pr.mid("put", c[k], KK, ivs[k], max((d[j] - d[k]).days, 1), d[k])
                            buy[n_] = max(fill(m, sp, +1), MIN_BUY, KK - c[k])
                    if np.isnan(buy[:-1]).any():   # no IV mid-path → exits can't be judged; hold only
                        buy[:-1] = np.where(np.isnan(buy[:-1]), np.inf, buy[:-1])
                    cap = (credit - buy) / credit
                    p = {"cap": cap[:-1], "el": np.array([(d[k] - d[i]).days for k in ks[:-1]], float), "tot": tot,
                         "ut_dn": (s["ut_dir"][ks[:-1]] < 0) & (s["ut_dir"][ks[:-1] - 1] > 0),
                         "cl_dn": (s["stc_bull"][ks[:-1]] <= 0.4) & (s["stc_bull"][ks[:-1] - 1] > 0.4),
                         "fg": np.nan_to_num(s["fear_greed"][ks[:-1]], nan=50), "bdiv": s["rsi_div"][ks[:-1]] < 0}
                    ex = {}
                    for name, rule in EXITS.items():
                        e = rule(p) if len(ks) > 1 else None
                        if e is None or not np.isfinite(buy[e]):
                            ex[name] = (j, credit - buy[-1])
                        else:
                            ex[name] = (int(ks[e]), credit - buy[e])
                    row[tag] = {"K": KK, "credit": credit, "ex": ex, "earn": earn}
                if row:
                    P[i] = row
            names["paths"][ten] = P
        out[t] = names
    return out


def tbill(conn):
    tb = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            tb[date.fromisoformat(dd)] = float(v) / 100
    ks = sorted(tb)
    return tb, ks


def lane(nm, ten, entry, exit_, rate):
    """Walk one name's lane. Returns daily return series {date: r} on spot notional (idle days at T-bill) + trades."""
    d, c, P = nm["d"], nm["c"], nm["paths"][ten]
    sig = nm["rules"][entry]
    tag = "smc" if entry == "N4 SMC reclaim" else "std"
    r, trades = {}, []
    i = next((k for k in range(len(d)) if d[k] >= START), len(d))
    while i < len(d) - TENORS[ten][0]:
        tr = P.get(i, {}).get(tag) if sig[i] else None
        if tr is None:
            if i + 1 < len(d):
                r[d[i + 1]] = r.get(d[i + 1], 0.0) + rate(d[i]) * (d[i + 1] - d[i]).days / 365
            i += 1
            continue
        x, pnl = tr["ex"][exit_]
        r[d[x]] = r.get(d[x], 0.0) + pnl / tr["K"]
        trades.append((d[i], d[x], pnl / tr["K"], tr["credit"] / tr["K"], (d[x] - d[i]).days))
        i = x   # re-sell at the exit close if the entry rule is on there
    return r, trades


def book(lanes):
    """Equal-weight book across names: weekly returns (sum of the name's daily r within the week), averaged over names."""
    wk = defaultdict(list)
    for r in lanes:
        w = defaultdict(float)
        for dd, x in r.items():
            w[dd.isocalendar()[:2]] += x
        for k, x in w.items():
            wk[k].append(x)
    return {k: float(np.mean(v)) for k, v in sorted(wk.items())}


def stats(series, trades, part):
    ks = [k for k in series if part(date.fromisocalendar(k[0], k[1], 1))]
    x = np.array([series[k] for k in ks])
    if len(x) < 20:
        return None
    eq = np.cumprod(1 + x)
    tr = [t for t in trades if part(t[0])]
    yrs = len(x) / 52
    return {"ann": float(x.mean() * 52 * 100), "w5": float(np.percentile(x, 5) * 1e4), "mdd": float((eq / np.maximum.accumulate(eq) - 1).min() * 100),
            "sharpe": float(x.mean() / x.std(ddof=1) * math.sqrt(52)) if x.std() > 0 else float("nan"),
            "hold": float(np.mean([t[4] for t in tr])) if tr else float("nan"), "n_yr": len(tr) / yrs,
            "win": float(np.mean([t[2] > 0 for t in tr]) * 100) if tr else float("nan"),
            "worst_tr": float(np.percentile([t[2] for t in tr], 1) * 100) if tr else float("nan")}


def main():
    args = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    tick = args["--tickers"].split(",") if "--tickers" in args else None
    with connect() as conn:
        if tick or not CACHE.exists() or "--rebuild" in sys.argv:
            paths = build_paths(conn, tick)
            if not tick:
                CACHE.parent.mkdir(parents=True, exist_ok=True)
                CACHE.write_bytes(pickle.dumps(paths))
        else:
            paths = pickle.loads(CACHE.read_bytes())
        tb, tks = tbill(conn)
    import bisect

    def rate(dd):
        k = bisect.bisect_right(tks, dd) - 1
        return tb[tks[k]] if k >= 0 else 0.0
    if tick:   # smoke: a few trades per name, hand-checkable
        for t, nm in paths.items():
            for ex in ("E0 hold", "E2 pace 3×", "E1 50%"):
                _, trs = lane(nm, "1w", "N0 Monday", ex, rate)
                print(t, ex, len(trs), "trades; last 3:", [(str(a), str(b), f"{p * 100:+.2f}%", f"cr {cr * 100:.2f}%", n) for a, b, p, cr, n in trs[-3:]])
        return
    parts = (("20-22", lambda x: x < SPLIT), ("23-26", lambda x: x >= SPLIT))
    res = {}
    for ten in TENORS:
        for en in next(iter(paths.values()))["rules"]:
            for ex in EXITS:
                lanes, trades = [], []
                for nm in paths.values():
                    r, trs = lane(nm, ten, en, ex, rate)
                    lanes.append(r); trades += trs
                ser = book(lanes)
                res[(ten, en, ex)] = (ser, {p: stats(ser, trades, f) for p, f in parts})
        print("done", ten, flush=True)
    base_ser, base = res[("1w", "N0 Monday", "E0 hold")]
    L = [f"# S103 — put lifecycle: indicator-timed entries × early exits, re-sell ({date.today()})", "",
         f"{len(paths)} names, 2020-09 → {max(max(nm['d']) for nm in paths.values())}. Annualized return on spot notional per lane "
         "(idle days at the 3-month T-bill), equal-weight book. Baseline = N0 Monday × E0 hold, 1 week "
         f"(20-22 {base['20-22']['ann']:.1f} %/yr, 23-26 {base['23-26']['ann']:.1f} %/yr). PASS: beats it both periods, weekly-difference "
         "t ≥ 3, max DD ≤ 1.25× baseline.", "",
         "| tenor | entry | exit | 20-22 %/yr · DD · hold d · trades/yr · win % | 23-26 %/yr · DD · hold d · trades/yr · win % | Δ vs base (t) | verdict |",
         "|---|---|---|---|---|---|---|"]
    rows_ = []
    for (ten, en, ex), (ser, st) in res.items():
        if not st["20-22"] or not st["23-26"]:
            continue
        ks = [k for k in ser if k in base_ser]
        dif = np.array([ser[k] - base_ser[k] for k in ks])
        t = float(dif.mean() / (dif.std(ddof=1) / math.sqrt(len(dif)))) if dif.std() > 0 else 0.0
        ok = all(st[p]["ann"] > base[p]["ann"] for p in st) and t >= 3 and all(st[p]["mdd"] >= 1.25 * base[p]["mdd"] for p in st)
        rows_.append((st["23-26"]["ann"] + st["20-22"]["ann"], ten, en, ex, st, t, ok))
    for _, ten, en, ex, st, t, ok in sorted(rows_, key=lambda x: -x[0]):
        f = lambda s: f"{s['ann']:+.1f} · {s['mdd']:.1f} · {s['hold']:.1f} · {s['n_yr']:.0f} · {s['win']:.0f}"  # noqa: E731
        L.append(f"| {ten} | {en} | {ex} | {f(st['20-22'])} | {f(st['23-26'])} | "
                 f"{st['20-22']['ann'] - base['20-22']['ann']:+.1f} / {st['23-26']['ann'] - base['23-26']['ann']:+.1f} ({t:.1f}) | {'PASS' if ok else ''} |")
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L[:40]))


if __name__ == "__main__":
    main()
