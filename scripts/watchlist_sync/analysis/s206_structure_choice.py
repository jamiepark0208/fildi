#!/usr/bin/env python3
"""S206 / A192 V4 — paired structure choice per idea: does a signal-conditioned scenario set pick better structures?

    cd scripts/watchlist_sync && .venv/bin/python analysis/s206_structure_choice.py [--smoke]

PRE-REGISTERED (Claude 11-24, before any result):
  Ideas      S100 entries (top-10/wk by ibes_drift + ret60, collect_s100_entries), entry = NEXT bar close after the signal week
             (one-bar delay; daily data only → contract 13 intraday entry candle NOT met, said on line 1). Earnings inside → skip.
  Horizon    30 calendar days, every structure expires at the same bar j (expiry_index) → no early-expiry policy needed.
  Candidates 100 shares · long call 0.50Δ · call spread 0.50Δ/+1σ · short put 0.20Δ (cash-secured) · put spread 0.20/0.10Δ ·
             cash (T-bill, DTB3) · no trade. Priced by s076 Pricer (BS at LSEG iv30 × real-LSEG-quote ratio, point in time) +
             fill at 23 % of the modelled spread → priced_by = model_calibrated (contract 8: no real chains for 2021–26 names).
  Policies   no_view   = the name's own last-2y 30-day paths, martingale (structure_context ctx-1.0, what the board uses now)
             s100      = z-scores log(ST/S)/(rv20·√T) of S100 entries that EXPIRED before this entry (walk-forward), × this name's rv20
             placebo   = same, z from random non-signal (ticker, week) entries of the same universe that expired before
             fixed     = always stock / always long call (current S100 rule) / always short put (CSP-first) / always call spread
  Choice     per lens: argmax model return among candidates; ≤ T-bill → cash. Lenses judged on REALIZED, model-free units:
             cash lens  = realized pnl ÷ cash tied up; finite-loss lens = realized pnl ÷ max loss (stock max loss = S).
  Stat       month-block means (overlapping 30-day holds → independent ≈ months), t over months; pool ≥ 150 expired episodes
             before a policy can choose. Holdout slice = entries ≥ 2024-07-01 (S100's own FIT/HOLDOUT split) printed too.
  Regime     SPY close > its 200d SMA at entry = bull, else bear (trend label, contract 12).
  Expected   bull: s100 − no_view > 0 (signal drift tilts to calls/stock; no_view picks short premium) and s100 ≈ long call.
             bear: s100 − no_view ≤ 0 (S100 episodes are mostly bull; conditioning over-picks calls) ; s100 − always-CSP < 0.
             placebo − no_view ≈ s100 − no_view would mean "any real drift" not the signal.
  PASS (V4)  s100 beats no_view AND every fixed selector on the cash lens in the bull cell with t ≥ 2, same sign in the
             holdout slice, placebo gap < half of s100's gap. Bear cell < 30 months → UNDERPOWERED, no claim.
  STOP       < 30 months in a cell → that cell is not reported as a result.
"""
from __future__ import annotations

import argparse
import math
import random
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import structure_context as CX  # noqa: E402
from build_plan import connect  # noqa: E402
from s076_structures_backtest import FILL_K, Pricer, expiry_index, fill, load, strike_for  # noqa: E402
from s167_spreads_on_edge import bar_index, collect_s100_entries, tbill_at  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S206.md"
H_CAL = 30
MIN_POOL = 150
HOLDOUT = date(2024, 7, 1)
CANDS = ("stock", "long_call", "call_spread", "short_put", "put_spread")
LENSES = ("cash", "finite_loss")
rng = random.Random(206)


def build_trade(rows, i, j, pricer):
    """Entry prices + per-share payoff function of terminal price for every candidate (same expiry j)."""
    d, S, ivp, ivc = rows[i]
    e = rows[j][0]
    dte = (e - d).days
    T = dte / 365
    out = {}
    out["stock"] = dict(cost=S, cash=S, max_loss=S, f=lambda ST: ST - S)
    Kc = strike_for(S, ivc, T, 0.50, "call")
    m, sp = pricer.mid("call", S, Kc, ivc, dte, d)
    pc = fill(m, sp, +1)
    out["long_call"] = dict(cash=pc, max_loss=pc, f=lambda ST, K=Kc, p=pc: np.maximum(ST - K, 0) - p)
    Ks = S * math.exp(ivc * math.sqrt(T))
    if Ks <= Kc:
        Ks = Kc + max(0.05 * S, 1.0)
    m2, sp2 = pricer.mid("call", S, Ks, ivc, dte, d)
    deb = pc - fill(m2, sp2, -1)
    if 0 < deb < Ks - Kc:
        out["call_spread"] = dict(cash=deb, max_loss=deb,
                                  f=lambda ST, a=Kc, b=Ks, p=deb: np.maximum(ST - a, 0) - np.maximum(ST - b, 0) - p)
    Kp = strike_for(S, ivp, T, 0.20, "put")
    m3, sp3 = pricer.mid("put", S, Kp, ivp, dte, d)
    cr = fill(m3, sp3, -1)
    if cr > 0:
        out["short_put"] = dict(cash=Kp, max_loss=Kp - cr, f=lambda ST, K=Kp, c=cr: c - np.maximum(K - ST, 0))
        Kw = strike_for(S, ivp, T, 0.10, "put")
        m4, sp4 = pricer.mid("put", S, Kw, ivp, dte, d)
        cr2 = cr - fill(m4, sp4, +1)
        if 0 < cr2 < Kp - Kw:
            out["put_spread"] = dict(cash=Kp - Kw - cr2, max_loss=Kp - Kw - cr2,
                                     f=lambda ST, a=Kp, b=Kw, c=cr2: c - np.maximum(a - ST, 0) + np.maximum(b - ST, 0))
    return out, dte


def choose(trade, ST_scen, rf_ret):
    """{lens: chosen id} from model returns on one scenario set (uniform weights). ≤ T-bill → cash."""
    w = np.full(len(ST_scen), 1 / len(ST_scen))
    best = {}
    for lens in LENSES:
        top, top_r = "cash", rf_ret
        for k, c in trade.items():
            x = c["f"](ST_scen)
            den = c["cash"] if lens == "cash" else c["max_loss"]
            r = float(w @ x) / den if den > 0 else -1e9
            if r > top_r:
                top, top_r = k, r
        best[lens] = top
    return best


def realized(trade, k, ST, rf_ret, lens):
    if k == "cash":
        return rf_ret if lens == "cash" else 0.0   # cash has no loss budget to use: 0 per $ of max loss
    c = trade[k]
    den = c["cash"] if lens == "cash" else c["max_loss"]
    return float(c["f"](np.array([ST]))[0]) / den


def rv20(rows, i):
    c = np.array([r[1] for r in rows[max(0, i - 21):i + 1]], float)
    return float(np.std(np.diff(np.log(c))) * math.sqrt(252)) if len(c) > 10 else None


def tstat(xs):
    xs = [x for x in xs if x == x]
    if len(xs) < 3:
        return float("nan"), float("nan"), len(xs)
    m = statistics_mean(xs)
    s = float(np.std(xs, ddof=1))
    return m, m / (s / math.sqrt(len(xs))) if s > 0 else float("nan"), len(xs)


def statistics_mean(xs):
    return float(np.mean(xs))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    with connect() as conn:
        ents = collect_s100_entries(conn)
        print(f"S100 entries {len(ents)} · {min(e['d'] for e in ents)} → {max(e['d'] for e in ents)} · "
              f"{len({e['t'] for e in ents})} tickers", flush=True)
        names = {e["t"] for e in ents} | {"SPY"}
        bars, rep, tb = load(conn, names if not a.smoke else None)
        pricer = Pricer(conn)
    spy = bars.get("SPY") or []
    spy_d = [r[0] for r in spy]
    spy_c = np.array([r[1] for r in spy], float)
    print(f"bars: {len(bars)} tickers · SPY {len(spy)} days · fill = {FILL_K:.0%} of modelled spread · priced_by model_calibrated", flush=True)
    if a.smoke:
        ents = rng.sample(ents, min(400, len(ents)))
    # random non-signal pool for the placebo: same universe, same weeks, tickers not picked that week
    picked = {(e["t"], e["d"]) for e in ents}
    weeks = sorted({e["d"] for e in ents})
    tick = sorted({e["t"] for e in ents})
    rand = []
    for d in weeks:
        for t in rng.sample(tick, min(10, len(tick))):
            if (t, d) not in picked:
                rand.append({"t": t, "d": d})

    def episode(ent):
        rows = bars.get(ent["t"])
        if not rows:
            return None
        i0 = bar_index(rows, ent["d"])
        if i0 is None or i0 + 1 >= len(rows) or i0 < 300:
            return None
        i = i0 + 1                                       # one-bar delayed entry
        j = expiry_index(rows, i, H_CAL)
        if j is None or j >= len(rows) or (rows[j][0] - rows[i][0]).days < H_CAL - 4:
            return None
        if any(rows[i][0] < x <= rows[j][0] for x in rep.get(ent["t"], [])):
            return None
        if not rows[i][2] or not rows[i][3]:
            return None
        v = rv20(rows, i)
        if not v:
            return None
        S, ST = rows[i][1], rows[j][1]
        T = (j - i) / 252
        return dict(t=ent["t"], d=rows[i][0], e=rows[j][0], i=i, j=j, S=S, ST=ST, rv=v, h=j - i,
                    z=math.log(ST / S) / (v * math.sqrt(T)))

    sig = [x for x in (episode(e) for e in ents) if x]
    plc = [x for x in (episode(e) for e in rand) if x]
    print(f"episodes: signal {len(sig)} · placebo pool {len(plc)}", flush=True)
    sig.sort(key=lambda x: x["d"]); plc.sort(key=lambda x: x["e"])
    sig_by_e = sorted(sig, key=lambda x: x["e"])

    res = []
    for ep in sig:
        pool = np.array([x["z"] for x in sig_by_e if x["e"] < ep["d"]])
        ppool = np.array([x["z"] for x in plc if x["e"] < ep["d"]])
        if len(pool) < MIN_POOL or len(ppool) < MIN_POOL:
            continue
        rows = bars[ep["t"]]
        trade, dte = build_trade(rows, ep["i"], ep["j"], pricer)
        r_tb = tbill_at(tb, ep["d"]) * dte / 365
        T = ep["h"] / 252
        logc = np.log(np.array([r[1] for r in rows[max(0, ep["i"] - 504):ep["i"] + 1]], float))
        nv = CX.paths(logc, ep["h"])
        if nv is None:
            continue
        scen = {"no_view": ep["S"] * np.exp(nv[:, -1]),
                "s100": ep["S"] * np.exp(pool * ep["rv"] * math.sqrt(T)),
                "placebo": ep["S"] * np.exp(ppool * ep["rv"] * math.sqrt(T))}
        k = int(np.searchsorted(spy_d, ep["d"], side="right")) - 1
        regime = "bull" if k >= 200 and spy_c[k] > spy_c[k - 199:k + 1].mean() else "bear"
        row = dict(d=ep["d"], month=(ep["d"].year, ep["d"].month), regime=regime, t=ep["t"])
        for pol, ST_s in scen.items():
            ch = choose(trade, ST_s, r_tb)
            for lens in LENSES:
                row[f"{pol}:{lens}"] = realized(trade, ch[lens], ep["ST"], r_tb, lens)
                row[f"{pol}:{lens}:pick"] = ch[lens]
        for k2 in CANDS:
            for lens in LENSES:
                row[f"{k2}:{lens}"] = realized(trade, k2, ep["ST"], r_tb, lens) if k2 in trade else float("nan")
        row["rf"] = r_tb
        res.append(row)
    print(f"evaluated (walk-forward, pool ≥ {MIN_POOL}): {len(res)} trades · {len({r['month'] for r in res})} months", flush=True)

    sels = ["s100", "no_view", "placebo", *CANDS]
    lines = ["# S206 — paired structure choice per idea (A192 V4)", "",
             "CONTRACT 1-7: ok (fill 23 % of modelled spread; T-bill; month blocks; one-bar delay + placebo; regime cells; "
             "LSEG iv30/closes; same job) · 8: model_calibrated (no 2021–26 chains) · 13: missing (daily closes, no intraday candle) · "
             "20: today's names (survivorship: S010 haircut not applied — relative comparisons only)", ""]
    verdict_cells = {}
    for cell, filt in (("all", lambda r: True), ("bull", lambda r: r["regime"] == "bull"), ("bear", lambda r: r["regime"] == "bear"),
                       ("holdout ≥ 2024-07", lambda r: r["d"] >= HOLDOUT), ("holdout bull", lambda r: r["d"] >= HOLDOUT and r["regime"] == "bull")):
        rs = [r for r in res if filt(r)]
        months = sorted({r["month"] for r in rs})
        lines.append(f"## {cell}: {len(rs)} trades · {len(months)} months" + ("  — below 30 independent months, not a result" if len(months) < 30 else ""))
        for lens in LENSES:
            mm = {s: [] for s in sels}
            for m in months:
                g = [r for r in rs if r["month"] == m]
                for s in sels:
                    v = [r[f"{s}:{lens}"] for r in g if r[f"{s}:{lens}"] == r[f"{s}:{lens}"]]
                    mm[s].append(float(np.mean(v)) if v else float("nan"))
            lines.append(f"**{lens} lens** (realized pnl ÷ {'cash tied up' if lens == 'cash' else 'max loss'}, month-mean, 30 d)")
            lines.append("| selector | mean | t | s100 − this (t) | worst-5 % trade |")
            lines.append("|---|---|---|---|---|")
            for s in sels:
                m_, t_, _ = tstat(mm[s])
                diff = [x - y for x, y in zip(mm["s100"], mm[s]) if x == x and y == y]
                dm, dt, _ = tstat(diff) if s != "s100" else (float("nan"), float("nan"), 0)
                per = sorted(r[f"{s}:{lens}"] for r in rs if r[f"{s}:{lens}"] == r[f"{s}:{lens}"])
                w5 = float(np.mean(per[:max(1, len(per) // 20)])) if per else float("nan")
                lines.append(f"| {s} | {100 * m_:+.2f} % | {t_:.1f} | {'' if s == 's100' else f'{100 * dm:+.2f} pt ({dt:.1f})'} | {100 * w5:+.1f} % |")
                if lens == "cash" and s != "s100":
                    verdict_cells[(cell, s)] = (dm, dt, len(months))
            picks = defaultdict(int)
            for r in rs:
                picks[r[f"s100:{lens}:pick"]] += 1
            nvp = defaultdict(int)
            for r in rs:
                nvp[r[f"no_view:{lens}:pick"]] += 1
            lines.append(f"picks s100: {dict(sorted(picks.items(), key=lambda x: -x[1]))} · no_view: {dict(sorted(nvp.items(), key=lambda x: -x[1]))}")
            lines.append("")
    # pre-registered verdict
    def ok(cell, s):
        dm, dt, n = verdict_cells.get((cell, s), (float("nan"),) * 3)
        return n >= 30 and dm > 0 and dt >= 2
    bull_n = verdict_cells.get(("bull", "no_view"), (0, 0, 0))[2]
    beats = all(ok("bull", s) for s in ["no_view", *CANDS])
    hold_sign = all(verdict_cells.get(("holdout bull", s), (-1,))[0] > 0 for s in ["no_view", *CANDS])
    gap = verdict_cells.get(("bull", "no_view"), (0,))[0]
    pgap = gap - verdict_cells.get(("bull", "placebo"), (0,))[0]   # placebo − no_view = (s100−no_view) − (s100−placebo)
    placebo_ok = pgap < 0.5 * gap if gap > 0 else False
    if bull_n < 30:
        v = f"UNDERPOWERED: bull cell {bull_n} months < 30"
    elif beats and hold_sign and placebo_ok:
        v = "PASS: s100-conditioned choice beats no-view and every fixed selector (bull, cash lens, t ≥ 2), holdout same sign, placebo gap < half"
    else:
        why = [f"vs {s} {100 * verdict_cells[('bull', s)][0]:+.2f} pt (t {verdict_cells[('bull', s)][1]:.1f})" for s in ["no_view", *CANDS] if not ok("bull", s)]
        v = "NO-LIFT (pre-registered): " + "; ".join(why) + ("" if hold_sign else " · holdout sign differs") + \
            ("" if placebo_ok else f" · placebo carries {100 * pgap:+.2f} of {100 * gap:+.2f} pt")
    lines.insert(2, f"**Verdict: RULE** {v}")
    lines.insert(3, "")
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:60]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
