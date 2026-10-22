"""S081 — long calls / long puts held to expiry: does a Direction × Price screen beat unconditional buying? (A244)

Pre-registered in research/studies/INDEX.md (row S081) and committed BEFORE this script was run. Everything below mirrors
that row. Amendment authority: "Claude review S080 2026-10-22" in research/common/asks/A244.md.

What changed vs S080 (the amendment):
  1. **Exit = hold to expiry** (intrinsic at the last bar ≤ expiry). S080's pre-registered barrier rule (+100 % / −50 % /
     21 DTE) was itself a large negative: it capped the right tail long calls live on and stopped out 55 % of trades.
     Because S080's descriptive held-to-expiry number (+17.8 % long calls) was read on a sample that included 2025-07→,
     **2025-07→ is no longer a clean holdout**. Out-of-sample here = the era split plus a *live forward paper ledger*
     opened by this run (out/opt/S081_forward_ledger.jsonl) — that ledger is the true holdout.
  2. **Timing leg dropped as a gate** (S025 event + SPY below its 200-day fired on 3,356 of 466k name-days; the S025/S027
     priors had already failed). It is reported descriptively only.
  3. Arms = direction ∩ price, **tested separately for long calls and long puts** → 2 primary tests, **Holm over 2**.
  4. The IV-spread / put-skew tilt from real Polygon closes stays **descriptive** (1,649 name-days, 2024-10→).
  5. Earnings: hold-to-expiry means the whole window is exposed → an entry is skipped if a report falls in (entry, expiry].
     S080 only excluded reports before its 21-DTE exit, so the two trade populations are not identical. Reconciled below.

Engine: reused from S080 / S076 — Black-Scholes at the stock's iv30_<side> × the S075 skew ratio for the (side, DTE, |Δ|)
cell, entry fill = bid + 23 % of the spread, LSEG daily panel, T-bill (FRED DTB3) subtracted over the holding days.
Daily entries 2021-02→, one contract: 0.50Δ, ~45 DTE, long call or long put. Outcome = pnl per $ debit, excess over T-bill.

Pre-registered pass bar, per side, on the test window 2021-02-01→2025-12-31 (the two eras):
  mean > 0 after fills  AND  month-block bootstrap t ≥ 2 in **both** eras (2021-23, 2024-25)  AND  mean > 0 in **both**
  eras  AND  beats (a) unconditional on the same side  AND  beats buying the stock on the same signal per $ risked
  (equal-volatility scaled)  AND  the sign survives the ±25 % stress on the call skew ratio  AND  Holm-adjusted p < 0.05
  over the 2 sides.
Stop rule (INDEX row S081, verbatim): either side fails Holm → **no list**; one side is never shipped alone. A failing
side logs which condition failed; no substitute arm is promoted. Era n is reported beside every verdict so a low-powered
FAIL is visible as such (the row pre-registers no power provision, so n does not change the verdict).
Sensitivities (reported, never selected on): Δ 0.40; selling on the last bar at the model mid − fill instead of taking
expiry intrinsic; the dropped timing leg as a slice.
2026 entries sit outside both pre-registered eras and are reported descriptively.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s081_long_options.py [--tickers=AAPL,NVDA] [--smoke]
                                                                                [--max-names=N] [--delta=0.40]
"""
from __future__ import annotations

import json
import math
import random
import statistics
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402  (the S080 engine: load / features / iv_rank / stats / arm (g))
from s080_long_options import SCEN  # noqa: E402  — base · rich (×1.25) · cheap (×0.75) on the call ratio
from s076_structures_backtest import Pricer, fill, strike_for  # noqa: E402
from s045_put_retest import ncdf  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S081.md"
LEDGER = HERE.parent / "out" / "opt" / "S081_forward_ledger.jsonl"

START = date(2021, 2, 1)
ERA1 = (date(2021, 2, 1), date(2023, 12, 31))   # era 2021-23
ERA2 = (date(2024, 1, 1), date(2025, 12, 31))   # era 2024-25
TEST_END = ERA2[1]                              # the pre-registered test window ends here; 2026 is descriptive

DELTA, DTE = 0.50, 45
IV_RANK_MAX = 0.50
SIG_Z, EVENT_GAP = 2.0, 10                      # S025 event, descriptive only in S081
ALPHA = 0.05
MIN_ERA_N = 30
rng = random.Random(81)


# ---------------------------------------------------------------- stats

def boot(xs, key="base", n=600):
    """Month-block bootstrap, arithmetically identical to S080.boot (mean over the resampled blocks' pooled values) but
    aggregated per block so the 466k-trade arms do not rebuild a list per resample. Returns (t, 90 % CI)."""
    by = S80.month_blocks(xs, key)
    ks = list(by)
    if len(ks) < 6:
        return float("nan"), (float("nan"), float("nan"))
    agg = {k: (math.fsum(v), len(v)) for k, v in by.items()}

    def m(sel):
        s = c = 0
        for k in sel:
            a, b = agg[k]
            s += a
            c += b
        return s / c

    obs = m(ks)
    bs = sorted(m([rng.choice(ks) for _ in ks]) for _ in range(n))
    sd = statistics.pstdev(bs)
    lo, hi = bs[int(0.05 * n)], bs[int(0.95 * n) - 1]
    return (obs / sd if sd else float("nan")), (lo, hi)


S80.boot = boot          # S080.stats() calls boot() — swap in the aggregated version, same estimator
stats, fmt = S80.stats, S80.fmt


def pval(s):
    """Two-sided p from the month-block bootstrap t (normal approximation)."""
    if not s or s["t"] != s["t"]:
        return float("nan")
    return 2 * (1 - ncdf(abs(s["t"])))


def holm(pairs):
    """Holm step-down over the tested sides. pairs = [(label, p)] → {label: adjusted p}."""
    live = sorted([(p, k) for k, p in pairs if p == p])
    out = {k: float("nan") for k, _ in pairs}
    run = 0.0
    for i, (p, k) in enumerate(live):
        run = max(run, min(1.0, (len(live) - i) * p))
        out[k] = run
    return out


# ---------------------------------------------------------------- trades

def build(conn, px, rep, tb, tech_hi, screen_from=None):
    """One pass over every bar. Normally returns priced hold-to-expiry trades; with screen_from set it returns the signal
    flags for bars on or after that date instead (the last ~6 weeks cannot produce a finished trade). Same code computes
    both, so the live screen cannot drift from the backtest."""
    pricer = Pricer(conn)
    tbd = [d for d, _ in tb]
    spy = px.get("SPY")
    if not spy:
        raise SystemExit("SPY missing from lseg_research.daily_history")
    sc = np.array([r[1] for r in spy], float)
    spy_dates = [r[0] for r in spy]
    spy_ma = np.full(len(sc), np.nan)
    cs = np.concatenate([[0.0], np.cumsum(sc)])
    spy_ma[199:] = (cs[200:] - cs[:-200]) / 200
    spy_below = {spy_dates[i]: bool(sc[i] < spy_ma[i]) for i in range(199, len(sc))}

    trades = []
    for t, rows in sorted(px.items()):
        if t in ("SPY", "QQQ", "IWM"):
            continue
        dates = [r[0] for r in rows]
        c, lr, ma50, ma200, rv20, z5, vol20, vol60 = S80.features(rows)
        irp = S80.iv_rank([r[2] for r in rows])
        irc = S80.iv_rank([r[3] for r in rows])
        earn = rep.get(t, [])
        n = len(rows)
        # S025 events (descriptive in S081): 5-day log return ≤ −2σ of the 60-day sd measured before the move, 10-bar spacing
        ev_bull = np.zeros(n, bool)
        ev_bear = np.zeros(n, bool)
        last_b = last_s = -99
        for i in range(70, n):
            z = z5[i]
            if np.isnan(z):
                continue
            if z <= -SIG_Z and i - last_b >= EVENT_GAP:
                ev_bull[i], last_b = True, i
            elif z >= SIG_Z and i - last_s >= EVENT_GAP:
                ev_bear[i], last_s = True, i

        for i in range(252, n):
            d, S, ivp, ivc = rows[i][0], rows[i][1], rows[i][2], rows[i][3]
            if d < START or not ivp or not ivc or np.isnan(rv20[i]) or np.isnan(ma200[i]):
                continue
            e = d + timedelta(days=DTE)
            if any(d < x <= e for x in earn):          # held to expiry → the whole window is exposed to earnings
                continue
            mon = d - timedelta(days=d.weekday())
            th = tech_hi.get((t, mon))
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            below = spy_below.get(d)

            up_struct = bool(ma50[i] > ma200[i])
            s046_call = bool(vol20[i] < vol60[i]) and bool(S <= ma200[i]) if not np.isnan(vol20[i]) else False
            dir_bull = up_struct and bool(th)
            dir_bear = (not up_struct) and s046_call
            pf_call = (ivc <= rv20[i]) and (not np.isnan(irc[i])) and irc[i] < IV_RANK_MAX
            pf_put = (ivp <= rv20[i]) and (not np.isnan(irp[i])) and irp[i] < IV_RANK_MAX
            tim_bull = bool(ev_bull[i - 1]) and below is True
            tim_bear = bool(ev_bear[i - 1]) and below is False

            if screen_from is not None:
                if d >= screen_from:
                    for side, iv0, dirf, pff, timf in (("call", ivc, dir_bull, pf_call, tim_bull),
                                                       ("put", ivp, dir_bear, pf_put, tim_bear)):
                        K = strike_for(S, iv0, DTE / 365, DELTA, side)
                        m, spr = pricer.mid(side, S, K, iv0, DTE, d)
                        trades.append({"t": t, "d": d, "side": side, "S": S, "K": K, "e": e, "iv": iv0,
                                       "rv": float(rv20[i]), "debit": fill(m, spr, 1), "spread": spr,
                                       "dir": dirf, "pf": pff, "tim": timf, "signal": dirf and pff})
                continue

            je = bisect_right(dates, e) - 1
            if je <= i or je >= n - 1 or (e - dates[je]).days > 5:   # the expiry bar must exist inside the panel
                continue
            Se = rows[je][1]
            days = (dates[je] - d).days

            for side, iv0, dirf, pff, timf in (("call", ivc, dir_bull, pf_call, tim_bull),
                                               ("put", ivp, dir_bear, pf_put, tim_bear)):
                K = strike_for(S, iv0, DTE / 365, DELTA, side)
                intrinsic = max(Se - K, 0.0) if side == "call" else max(K - Se, 0.0)
                res, debits = {}, {}
                for sn in SCEN:
                    m, spr = pricer.mid(side, S, K, iv0, DTE, d, sn)
                    debit = fill(m, spr, 1)
                    if debit < 0.05:
                        res = {}
                        break
                    debits[sn] = debit
                    res[sn] = intrinsic / debit - 1 - r_tb * days / 365
                if "base" not in res:
                    continue
                # sensitivity: sell the contract on the last bar instead of taking expiry intrinsic (model mid − fill)
                ivE = (rows[je][3] if side == "call" else rows[je][2]) or iv0
                mE, sprE = pricer.mid(side, Se, K, ivE, max((e - dates[je]).days, 1), dates[je])
                sell = fill(mE, sprE, -1) / debits["base"] - 1 - r_tb * days / 365
                x = {"t": t, "d": d, "side": side, "K": K, "S": S, "Se": Se, "e": e, "xd": dates[je], "days": days,
                     "debit": debits["base"], "iv": iv0, "rv": float(rv20[i]), "raw": intrinsic / debits["base"] - 1,
                     "dir": dirf, "pf": pff, "tim": timf, "signal": dirf and pff, "sell": sell,
                     "stock": (Se / S - 1) * (1 if side == "call" else -1)}
                x.update({sn: res[sn] for sn in res})
                x["base"] = res["base"]
                trades.append(x)
    return trades, pricer


# ---------------------------------------------------------------- real option closes (descriptive)

def real_expiry_check(conn, trades):
    """Match 2024-10→ trades to a real Polygon contract (cached in optlab.bars) and compare the held-to-expiry return per
    $ debit against the model's. 0 new vendor calls. Exit = the contract's last cached close on or before expiry."""
    rows = conn.execute("""SELECT k.underlying, k.type, k.expiry, k.strike::float, b.date, b.c::float
                           FROM optlab.bars b JOIN optlab.contracts k ON k.occ = b.occ
                           WHERE b.c > 0 AND b.date >= %s""", (S80.REAL_PX_FROM,)).fetchall()
    chain, bars = defaultdict(set), defaultdict(dict)
    for u, ty, exp, strike, d, c in rows:
        chain[(u, ty)].add((exp, strike))
        bars[(u, ty, exp, strike)][d] = c
    out = []
    for x in trades:
        if x["d"] < S80.REAL_PX_FROM:
            continue
        best = None
        for exp, strike in chain.get((x["t"], x["side"]), ()):
            dte = (exp - x["d"]).days
            if not 25 <= dte <= 75 or abs(strike / x["K"] - 1) > 0.10:
                continue
            cost = abs(dte - DTE) / 45 + abs(strike / x["K"] - 1) * 10
            if best is None or cost < best[0]:
                best = (cost, exp, strike)
        if not best:
            continue
        _, exp, strike = best
        ser = bars[(x["t"], x["side"], exp, strike)]
        p0 = ser.get(x["d"])
        later = [dd for dd in ser if x["d"] < dd <= exp]
        if not p0 or p0 < 0.05 or not later:
            continue
        last = max(later)
        if (exp - last).days > 10:            # the cache must reach expiry, else the hold is truncated
            continue
        out.append({"t": x["t"], "d": x["d"], "side": x["side"], "real": ser[last] / p0 - 1, "model": x["raw"],
                    "signal": x["signal"]})
    return out


# ---------------------------------------------------------------- report

def main():
    global DELTA, OUT
    args = sys.argv[1:]
    only = next((set(a.split("=", 1)[1].split(",")) for a in args if a.startswith("--tickers=")), None)
    maxn = next((int(a.split("=", 1)[1]) for a in args if a.startswith("--max-names=")), None)
    smoke = "--smoke" in args
    for a in args:
        if a.startswith("--delta="):
            DELTA = float(a.split("=", 1)[1])
        if a.startswith("--tag="):
            OUT = OUT.with_name(f"S081_{a.split('=', 1)[1]}.md")
    conn = connect()
    px, rep, tb, tech_hi = S80.load(conn, only, maxn)
    print(f"loaded {len(px)} names", flush=True)
    all_trades, pricer = build(conn, px, rep, tb, tech_hi)
    print(f"{len(all_trades):,} trades", flush=True)

    if smoke:
        hand = [x for x in all_trades if x["signal"]][:3] or all_trades[:3]
        for x in hand:
            m, spr = pricer.mid(x["side"], x["S"], x["K"], x["iv"], DTE, x["d"])
            print(f"\n{x['t']} {x['d']} {x['side']} spot {x['S']:.2f} K {x['K']:.2f} iv {x['iv']:.2%} dte {DTE}"
                  f"\n  mid {m:.3f} spread {spr:.1%} debit(buy) {fill(m, spr, 1):.3f}"
                  f"\n  expiry {x['e']} last bar {x['xd']} spot {x['Se']:.2f} intrinsic "
                  f"{max(x['Se'] - x['K'], 0) if x['side'] == 'call' else max(x['K'] - x['Se'], 0):.3f}"
                  f"\n  ret/debit {x['raw']:+.1%} (excess {x['base']:+.1%}) days {x['days']} stock {x['stock']:+.1%}"
                  f"\n  flags dir={x['dir']} pf={x['pf']} signal={x['signal']}")
        print(f"\nsignal entries: {sum(x['signal'] for x in all_trades)} / {len(all_trades)}")
        return

    test = [x for x in all_trades if x["d"] <= TEST_END]
    post = [x for x in all_trades if x["d"] > TEST_END]
    era = lambda xs, w: [x for x in xs if w[0] <= x["d"] <= w[1]]  # noqa: E731
    prim = {s: [x for x in test if x["side"] == s and x["signal"]] for s in ("call", "put")}
    uncond = {s: [x for x in test if x["side"] == s] for s in ("call", "put")}

    L = [f"# S081 — long calls / long puts held to expiry: Direction × Price (A244, {date.today()})", "",
         f"{len(all_trades):,} trades, {len({x['t'] for x in all_trades})} names, daily entries {START} →. "
         f"{DELTA:.2f}Δ ~{DTE} DTE single long option, **held to expiry** (intrinsic at the last bar ≤ expiry), earnings "
         f"anywhere in the holding window excluded. Returns are **per $ debit, net of the entry fill (bid + 23 % of the "
         f"spread), minus T-bill** over the holding days. Pre-registered in INDEX row S081 and committed before this run; "
         f"primary tests = direction ∩ price for long calls and for long puts, **Holm over 2**. Test window "
         f"{START}→{TEST_END}; {len(post):,} entries after it are descriptive.", "",
         "## Primary tests (test window, direction ∩ price)", "",
         "| test | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    st = {s: stats(prim[s]) for s in prim}
    for s in ("call", "put"):
        L.append(f"| long {s}s (PRIMARY) {fmt(st[s])}")
    L += ["", "## Eras (pre-registered: both must clear t ≥ 2)", "",
          "| test | era | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|---|"]
    est = {}
    for s in ("call", "put"):
        for lab, w in (("2021-23", ERA1), ("2024-25", ERA2)):
            est[(s, lab)] = stats(era(prim[s], w))
            L.append(f"| long {s}s | {lab} {fmt(est[(s, lab)])}")

    # comparator (f): buying the stock on the same signal, same entry and exit dates
    cmp_f = {}
    for s in ("call", "put"):
        xs = prim[s]
        if len(xs) > 1:
            sm = statistics.mean([x["stock"] for x in xs])
            ssd = statistics.pstdev([x["stock"] for x in xs])
            cmp_f[s] = (sm, ssd, sm * (st[s]["sd"] / ssd) if ssd and st[s] else float("nan"))
        else:
            cmp_f[s] = (float("nan"),) * 3

    ps = holm([(s, pval(st[s])) for s in ("call", "put")])
    ust = {s: stats(uncond[s]) for s in ("call", "put")}
    verdicts, checks = {}, {}
    for s in ("call", "put"):
        e1, e2 = est[(s, "2021-23")], est[(s, "2024-25")]
        if not st[s] or not e1 or not e2:
            verdicts[s] = ("FAIL", "too few trades to compute the bar")
            checks[s] = []
            continue
        sc = st[s]["scen"]
        checks[s] = [("mean > 0 after fills", st[s]["mean"] > 0),
                     ("t ≥ 2 era 2021-23", e1["t"] >= 2 if e1["t"] == e1["t"] else False),
                     ("t ≥ 2 era 2024-25", e2["t"] >= 2 if e2["t"] == e2["t"] else False),
                     ("mean > 0 in both eras", e1["mean"] > 0 and e2["mean"] > 0),
                     ("beats (a) unconditional, same side", st[s]["mean"] > ust[s]["mean"] if ust[s] else False),
                     ("beats the stock per $ risked", st[s]["mean"] > cmp_f[s][2] if cmp_f[s][2] == cmp_f[s][2] else False),
                     ("call stress ±25 % keeps the sign",
                      all((sc[k] > 0) == (sc["base"] > 0) for k in SCEN if sc[k] == sc[k])),
                     (f"Holm p < {ALPHA}", ps[s] == ps[s] and ps[s] < ALPHA)]
        ok = all(v for _, v in checks[s])
        verdicts[s] = ("PASS", "") if ok else ("FAIL", "failed: " + ", ".join(k for k, v in checks[s] if not v))

    ship = all(verdicts[s][0] == "PASS" for s in ("call", "put"))
    L += ["", "## Verdict against the pre-registered bar", ""]
    for s in ("call", "put"):
        v, why = verdicts[s]
        e1, e2 = est[(s, "2021-23")], est[(s, "2024-25")]
        power = f" · era n {e1['n'] if e1 else 0} / {e2['n'] if e2 else 0}" + \
                ("  **(low-powered: an era has < %d trades)**" % MIN_ERA_N
                 if (not e1 or not e2 or min(e1["n"], e2["n"]) < MIN_ERA_N) else "")
        L += [f"**long {s}s: {v}**" + (f" — {why}" if why else "")
              + (f" · raw p {pval(st[s]):.4f}, Holm p {ps[s]:.4f}" if st[s] and pval(st[s]) == pval(st[s]) else "")
              + power, ""]
        if checks[s]:
            L += ["| check | result |", "|---|---|"] + [f"| {k} | {'✓' if v2 else '✗'} |" for k, v2 in checks[s]] + [""]
    L += [f"**Ship decision: {'LIST' if ship else 'NO LIST'}** — the pre-registered stop rule requires *both* sides to "
          f"clear Holm; one side is never shipped alone. No substitute arm is promoted.", "",
          "## Call-skew stress ±25 % and the stock comparator", "",
          "Unlike S080, this stress is **not** a no-op: hold-to-expiry pays intrinsic, which the skew ratio does not touch, "
          "so a 25 % richer entry debit lowers the return per $ debit directly (≈ ÷1.25 on the gross payoff).", "",
          "| test | base | rich +25 % | cheap −25 % | stock, equal $ | stock sd | stock scaled to the option's vol |",
          "|---|---|---|---|---|---|---|"]
    for s in ("call", "put"):
        if not st[s]:
            continue
        sc, (sm, ssd, sv) = st[s]["scen"], cmp_f[s]
        p = lambda v: "—" if v != v else f"{v:+.1%}"  # noqa: E731
        L.append(f"| long {s}s | {p(sc['base'])} | {p(sc['rich'])} | {p(sc['cheap'])} | {p(sm)} | {ssd:.1%} | {p(sv)} |")

    # ---------------- descriptive
    L += ["", "## Descriptive (never selected on)", "",
          "| slice | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    desc = [("unconditional long calls", uncond["call"]), ("unconditional long puts", uncond["put"]),
            ("calls: direction only", [x for x in test if x["side"] == "call" and x["dir"]]),
            ("calls: price filter only", [x for x in test if x["side"] == "call" and x["pf"]]),
            ("puts: direction only", [x for x in test if x["side"] == "put" and x["dir"]]),
            ("puts: price filter only", [x for x in test if x["side"] == "put" and x["pf"]]),
            ("calls: the dropped timing leg", [x for x in test if x["side"] == "call" and x["tim"]]),
            ("puts: the dropped timing leg", [x for x in test if x["side"] == "put" and x["tim"]]),
            ("calls signal, 2026 (outside the eras)", [x for x in post if x["side"] == "call" and x["signal"]]),
            ("puts signal, 2026 (outside the eras)", [x for x in post if x["side"] == "put" and x["signal"]])]
    for nm, xs in desc:
        L.append(f"| {nm} {fmt(stats(xs))}")

    L += ["", "### Sensitivity: sell on the last bar instead of taking expiry intrinsic", "",
          "| slice | hold to expiry (intrinsic) | sell at the last bar (model mid − fill) |", "|---|---|---|"]
    for nm, xs in (("unconditional calls", uncond["call"]), ("unconditional puts", uncond["put"]),
                   ("signal calls", prim["call"]), ("signal puts", prim["put"])):
        if xs:
            L.append(f"| {nm} | {statistics.mean([x['base'] for x in xs]):+.1%} | "
                     f"{statistics.mean([x['sell'] for x in xs]):+.1%} |")
    L += ["", "Reconciliation with S080: S080 excluded earnings only before its 21-DTE exit, S081 excludes them anywhere in "
              "the window, so the two trade sets differ — S080's descriptive +17.8 % held-to-expiry long call is not "
              "expected to reproduce exactly.", ""]

    # real option closes
    rp = real_expiry_check(conn, all_trades)
    if rp:
        L += ["## Real option closes (Polygon, 2024-10→) vs the model, held to expiry", "",
              f"{len(rp):,} trades matched to a real contract (same name/side, 25–75 DTE, strike within 10 % of the model's "
              f"continuous Δ-strike; the cache must reach expiry). Mean per $ debit: real "
              f"{statistics.mean([r['real'] for r in rp]):+.1%} vs model {statistics.mean([r['model'] for r in rp]):+.1%} "
              f"(median difference {statistics.median([r['real'] - r['model'] for r in rp]):+.1%}). Real closes are prints, "
              f"not mids, and carry no fill haircut — a direction check on the model, not a replacement.", ""]
    else:
        L += ["## Real option closes (Polygon, 2024-10→)", "",
              "No trade matched a cached real contract that also reached expiry — the model prices stand alone here.", ""]

    # arm (g): IV-spread / skew tilt, descriptive
    pg = S80.polygon_direction(conn)
    if pg:
        sp = [v["spread"] for v in pg.values() if "spread" in v]
        sk = [v["skew"] for v in pg.values() if "skew" in v]
        idx = defaultdict(dict)
        for (u, d), v in pg.items():
            idx[u][d] = v
        med_sk = statistics.median(sk) if sk else None
        tagged = []
        for x in all_trades:
            v = idx.get(x["t"], {}).get(x["d"])
            if not v:
                continue
            if x["side"] == "call" and "spread" in v:
                tagged.append((v["spread"] > 0, x))
            elif x["side"] == "put" and "skew" in v and med_sk is not None:
                tagged.append((v["skew"] > med_sk, x))
        L += ["## IV-spread / put-skew tilt (real Polygon closes, 2024-10→) — descriptive only", "",
              f"{len(pg):,} name-days carry an inverted IV pair ({len(sp):,} ATM call + put, {len(sk):,} OTM put + ATM "
              f"call). Call−put IV spread median {statistics.median(sp):+.3f}; OTM-put skew median {med_sk:+.3f}. Fixed "
              f"rule: long call if the spread > 0, long put if the skew is above its full-window median. "
              f"{len(tagged):,} trades carry a signal. LSEG cannot produce these (iv30_put ≡ iv30_call → S059's nan).", "",
              "| slice | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|",
              f"| tilt on {fmt(stats([x for ok, x in tagged if ok]))}",
              f"| tilt off {fmt(stats([x for ok, x in tagged if not ok]))}", ""]
    else:
        L += ["## IV-spread / put-skew tilt", "", "No inverted IV pairs available — not reported.", ""]

    # ---------------- today's flags → forward paper ledger (the true holdout)
    scr, _ = build(conn, px, rep, tb, tech_hi, screen_from=date(2026, 9, 25))
    last = max(x["d"] for x in scr)
    today = [x for x in scr if x["d"] == last and x["signal"]]
    week = [x for x in scr if x["d"] >= last - timedelta(days=7) and x["signal"]]
    seen = set()
    if LEDGER.exists():
        for line in LEDGER.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                seen.add((r["date"], r["ticker"], r["side"]))
    added = 0
    with LEDGER.open("a") as fh:
        for x in sorted(today, key=lambda y: (y["side"], y["t"])):
            k = (str(x["d"]), x["t"], x["side"])
            if k in seen:
                continue
            fh.write(json.dumps({"study": "S081", "date": str(x["d"]), "ticker": x["t"], "side": x["side"],
                                 "spot": round(x["S"], 4), "strike": round(x["K"], 4), "expiry": str(x["e"]),
                                 "dte": DTE, "delta": DELTA, "model_debit": round(x["debit"], 4),
                                 "spread": round(x["spread"], 4), "iv30": round(x["iv"], 4), "rv20": round(x["rv"], 4),
                                 "exit_rule": "hold to expiry, intrinsic", "logged": str(date.today())}) + "\n")
            added += 1
    L += ["## Today's flags for the frozen rule → forward paper ledger", "",
          f"The forward ledger is S081's **true out-of-sample test** (2025-07→ is no longer clean: S080's descriptive "
          f"held-to-expiry number was read on a sample that included it). Latest LSEG bar {last}. "
          f"**{len(today)} flags today** ({sum(x['side'] == 'call' for x in today)} calls, "
          f"{sum(x['side'] == 'put' for x in today)} puts); {len(week)} in the last 7 days. "
          f"{added} new rows appended to `out/opt/S081_forward_ledger.jsonl` (hold to expiry, graded at expiry).", ""]
    if today:
        L += ["| ticker | side | spot | strike | expiry | model debit | iv30 | rv20 |", "|---|---|---|---|---|---|---|---|"]
        for x in sorted(today, key=lambda y: (y["side"], y["t"])):
            L.append(f"| {x['t']} | {x['side']} | {x['S']:.2f} | {x['K']:.2f} | {x['e']} | {x['debit']:.2f} | "
                     f"{x['iv']:.1%} | {x['rv']:.1%} |")
        L.append("")

    L += ["## Known weaknesses", "",
          "- Call skew rests on one day of Schwab ladders (S075); the ±25 % stress is the guard, not a fix. It bites here "
          "(the entry debit is scaled, the intrinsic payoff is not), so read the stress row before any product.",
          "- Expiry intrinsic assumes assignment/settlement at no spread. The sell-at-the-last-bar sensitivity is the "
          "version where you must trade out.",
          "- Continuous strikes at the flat-IV Δ; real chains round to listed strikes.",
          "- Daily entries overlap heavily (45 DTE) → month-block bootstrap, not iid t.",
          "- lab_tech is a Monday panel forward-filled inside the week.",
          "- 2025-07→ is not a holdout here (see the header); the forward ledger is.",
          "- Real option closes only exist from 2024-10 (Polygon plan limit); everything earlier is model-priced."]

    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    json.dump([{k: str(v) if isinstance(v, date) else v for k, v in x.items()} for x in all_trades if x["signal"]],
              open(f"/tmp/{OUT.stem}_signal_trades.json", "w"), default=str)


if __name__ == "__main__":
    main()
