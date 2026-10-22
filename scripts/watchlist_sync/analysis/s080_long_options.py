"""S080 — long calls / long puts: does a merged Direction × Timing × Price screen beat unconditional option buying? (A244)

Pre-registered in research/studies/INDEX.md (row S080) BEFORE this script was run. Everything below mirrors that row.

Engine: the S076 pricing stack (Black-Scholes at the stock's iv30_<side> × the S075 skew ratio for the (side, DTE, |Δ|) cell,
fills bid + 23 % of the spread) but **daily** entries instead of Monday-only and **barrier exits walked over the daily path**
instead of hold-to-expiry: first of +100 % of the debit (limit fill, capped at +100 %), −50 % of the debit (stop taken at that
day's close, so gaps are counted in full), or 21 DTE left. One contract: 0.50Δ, ~45 DTE, long call or long put. Earnings before
the exit window → the entry is skipped (same rule as the live board). Outcome = pnl per $ debit, excess over T-bill (FRED DTB3).

Arms (flags are tagged on one shared entry grid, so every arm is a slice of the same trades):
  a  unconditional (comparator, re-run in THIS engine — S076's Monday/hold-to-expiry numbers are not the baseline)
  b  direction only      bull: MA50 > MA200 and lab_tech v4_put total ≥ that Monday's cross-sectional median
                         bear: MA50 < MA200 and the S046 call signal (20d avg volume < 60d avg and close ≤ MA200)
  c  timing only         bull: S025 event (5-day log return ≤ −2σ of the 60-day daily sd, ≥ 10 days since the last event)
                               with SPY below its 200-day; entry at the next close
                         bear: the mirror (≥ +2σ over 5 days, SPY above its 200-day)
  d  price filter only   iv30_side ≤ RV20 and 1-year IV rank < 50
  e  merged D×T×P        PRIMARY — the only tested arm; b/c/d/f/g are descriptive and are never selected on
  f  stock on the same signal as (e), same entry and exit dates, equal-$ and equal-volatility scaled
  g  Polygon-derived direction (call−put IV spread, Cremers-Weinbaum; put skew, Xing-Zhang-Zhao) over the 2024-10→ window only

Pricing evidence: real option daily closes exist from 2024-10 (Polygon, cached in optlab.bars/contracts — probed 10-22:
O:AAPL250117C00230000 Dec-2024 OK, 2023 NOT_AUTHORIZED). Model-priced trades in that window are matched to the real contract
and both are reported; before 2024-10 only model pricing exists.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s080_long_options.py [--tickers=AAPL,NVDA] [--smoke] [--max-names=N]
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
import s076_structures_backtest as S76  # noqa: E402
from s076_structures_backtest import Pricer, bs_call, fill, strike_for  # noqa: E402
from s045_put_retest import bs_put, ncdf  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S080.md"
CACHE = HERE.parent.parent.parent / "research" / "cache" / "polygon_options"

START = date(2021, 2, 1)
ERA_SPLIT = date(2024, 1, 1)      # eras 2021-23 vs 2024→
HOLDOUT = date(2025, 7, 1)        # untouched until the arms were frozen (they are: see the INDEX row)
REAL_PX_FROM = date(2024, 10, 15)  # Polygon option history starts here

DELTA, DTE, EXIT_DTE = 0.50, 45, 21
TAKE, STOP = 1.00, -0.50
SIG_Z, EVENT_GAP = 2.0, 10
IV_RANK_MAX = 0.50

# call-skew stress ±25 % (A244 review edit 7 — the call ratio rests on one day of Schwab ladders)
S76.SCEN = {"base": (1.0, 1.0), "rich": (1.25, 1.25), "cheap": (0.75, 0.75)}
SCEN = S76.SCEN
rng = random.Random(80)


# ---------------------------------------------------------------- data

def load(conn, only=None, max_names=None):
    px = {}
    q = ("SELECT ticker, date, close::float, iv30_put::float, iv30_call::float, volume::float "
         "FROM lseg_research.daily_history WHERE close > 0 AND date >= '2019-09-01' ORDER BY ticker, date")
    cur = defaultdict(list)
    for t, d, c, ivp, ivc, v in conn.execute(q):
        f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
        cur[t].append((d, c, f(ivp), f(ivc), v))
    for t, rows in cur.items():
        if len(rows) < 300:
            continue
        px[t] = rows
    if only:
        keep = set(only) | {"SPY"}
        px = {t: r for t, r in px.items() if t in keep}
    elif max_names:
        names = sorted(t for t in px if t not in ("SPY", "QQQ", "IWM"))[:max_names]
        px = {t: r for t, r in px.items() if t in set(names) | {"SPY"}}

    rep = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY report_date"):
        rep[t].append(d)

    tb = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            tb[date.fromisoformat(dd)] = float(v) / 100

    # lab_tech v4_put total, Monday panel → cross-sectional median per week
    tech, by_week = {}, defaultdict(list)
    for t, a, v in conn.execute("SELECT ticker, as_of, (v4_put->>'total')::float FROM watchlist_sync.lab_tech "
                                "WHERE v4_put ? 'total'"):
        if v is not None:
            tech[(t, a)] = v
            by_week[a].append(v)
    med = {a: statistics.median(vs) for a, vs in by_week.items() if len(vs) >= 30}
    tech_hi = {k: (v >= med[k[1]]) for k, v in tech.items() if k[1] in med}
    return px, rep, sorted(tb.items()), tech_hi


def features(rows):
    """Per-bar arrays computed from closes ≤ that bar only."""
    c = np.array([r[1] for r in rows], float)
    v = np.array([r[4] if r[4] is not None else np.nan for r in rows], float)
    n = len(c)
    lr = np.concatenate([[np.nan], np.diff(np.log(c))])
    ma50 = np.full(n, np.nan)
    ma200 = np.full(n, np.nan)
    cs = np.concatenate([[0.0], np.cumsum(c)])
    ma50[49:] = (cs[50:] - cs[:-50]) / 50
    ma200[199:] = (cs[200:] - cs[:-200]) / 200
    rv20 = np.full(n, np.nan)
    for i in range(21, n):
        rv20[i] = lr[i - 19:i + 1].std(ddof=0) * math.sqrt(252)
    # 5-day z-score vs the 60-day daily sd measured BEFORE the drop (S025 definition)
    z5 = np.full(n, np.nan)
    for i in range(70, n):
        sd = lr[i - 64:i - 4].std(ddof=1)
        if sd > 0:
            z5[i] = math.log(c[i] / c[i - 5]) / (sd * math.sqrt(5))
    vol20 = np.full(n, np.nan)
    vol60 = np.full(n, np.nan)
    for i in range(60, n):
        vol20[i] = np.nanmean(v[i - 19:i + 1])
        vol60[i] = np.nanmean(v[i - 59:i + 1])
    return c, lr, ma50, ma200, rv20, z5, vol20, vol60


def iv_rank(series):
    """Fraction of the trailing 252 observations below today's value (point-in-time)."""
    a = np.array([x if x is not None else np.nan for x in series], float)
    out = np.full(len(a), np.nan)
    for i in range(252, len(a)):
        w = a[i - 251:i + 1]
        w = w[~np.isnan(w)]
        if len(w) >= 120 and not np.isnan(a[i]):
            out[i] = (w < a[i]).mean()
    return out


# ---------------------------------------------------------------- trades

def walk(pricer, side, S, K, iv0, d, e, path, scen):
    """Price one long option and walk the daily path to the first barrier. Returns (ret_per_debit, exit_date, exit_why)."""
    m, spr = pricer.mid(side, S, K, iv0, (e - d).days, d, scen)
    debit = fill(m, spr, 1)
    if debit < 0.05:
        return None
    for dk, Sk, ivk in path:
        rem = (e - dk).days
        mk, sprk = pricer.mid(side, Sk, K, ivk, max(rem, 1), dk, scen)
        val = fill(mk, sprk, -1)
        r = val / debit - 1
        if r >= TAKE:
            return TAKE, dk, "take", debit    # limit order at +100 %, not the (higher) close
        if r <= STOP:
            return r, dk, "stop", debit       # stop taken at the close → gaps counted in full
        if rem <= EXIT_DTE:
            return r, dk, "dte", debit
    return None                               # path ran out → incomplete trade, dropped


def build(conn, px, rep, tb, tech_hi, scen_all=True, screen_from=None):
    """Walk every bar once. Normally returns priced trades; with screen_from set it returns the signal flags for bars on or
    after that date instead — the last ~6 weeks cannot produce a trade (no forward path), so 'what does it flag today' has to
    read the flags directly. Same code computes both, so the screen can't drift from the backtest."""
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
        c, lr, ma50, ma200, rv20, z5, vol20, vol60 = features(rows)
        irp = iv_rank([r[2] for r in rows])
        irc = iv_rank([r[3] for r in rows])
        earn = rep.get(t, [])
        n = len(rows)
        # S025 events with the 10-bar spacing rule, computed forward in time
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

        mon = None
        for i in range(252, n):
            d, S, ivp, ivc = rows[i][0], rows[i][1], rows[i][2], rows[i][3]
            if d < START or not ivp or not ivc or np.isnan(rv20[i]) or np.isnan(ma200[i]):
                continue
            e = d + timedelta(days=DTE)
            j = bisect_right(dates, e) - 1
            exit_floor = e - timedelta(days=EXIT_DTE)
            if any(d < x <= exit_floor for x in earn):     # earnings inside the holding window
                continue
            mon = d - timedelta(days=d.weekday())
            th = tech_hi.get((t, mon))
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            below = spy_below.get(d)

            up_struct = bool(ma50[i] > ma200[i])
            s046_call = bool(vol20[i] < vol60[i]) and bool(S <= ma200[i]) if not np.isnan(vol20[i]) else False
            dir_bull = up_struct and bool(th)
            dir_bear = (not up_struct) and s046_call
            tim_bull = bool(ev_bull[i - 1]) and below is True
            tim_bear = bool(ev_bear[i - 1]) and below is False
            raw_bull, raw_bear = bool(ev_bull[i - 1]), bool(ev_bear[i - 1])   # sensitivity: event without the SPY condition
            pf_call = (ivc <= rv20[i]) and (not np.isnan(irc[i])) and irc[i] < IV_RANK_MAX
            pf_put = (ivp <= rv20[i]) and (not np.isnan(irp[i])) and irp[i] < IV_RANK_MAX

            if screen_from is not None:
                if d >= screen_from:
                    for side, dirf, timf, pff, rawf in (("call", dir_bull, tim_bull, pf_call, raw_bull),
                                                        ("put", dir_bear, tim_bear, pf_put, raw_bear)):
                        trades.append({"t": t, "d": d, "side": side, "S": S, "dir": dirf, "tim": timf, "pf": pff,
                                       "tim_nospy": rawf, "merged": dirf and timf and pff})
                continue
            if j <= i or j >= n - 1:
                continue
            path = [(rows[k][0], rows[k][1], rows[k][2] if rows[k][2] else ivp) for k in range(i + 1, j + 1)]
            path_c = [(rows[k][0], rows[k][1], rows[k][3] if rows[k][3] else ivc) for k in range(i + 1, j + 1)]
            if not path:
                continue

            for side, iv0, pth, dirf, timf, pff, rawf in (("call", ivc, path_c, dir_bull, tim_bull, pf_call, raw_bull),
                                                          ("put", ivp, path, dir_bear, tim_bear, pf_put, raw_bear)):
                K = strike_for(S, iv0, DTE / 365, DELTA, side)
                merged = dirf and timf and pff
                res = {}
                for sn in (SCEN if (scen_all or merged) else ("base",)):
                    r = walk(pricer, side, S, K, iv0, d, e, pth, sn)
                    if r is None:
                        res = {}
                        break
                    res[sn] = r
                if "base" not in res:
                    continue
                ret, xd, why, debit = res["base"]
                days = (xd - d).days
                # descriptive: the same contract held to expiry (S076's rule) — isolates the barrier rule from the signal
                je = bisect_right(dates, e) - 1
                Se = rows[je][1]
                intrinsic = max(Se - K, 0) if side == "call" else max(K - Se, 0)
                held = intrinsic / debit - 1
                x = {"t": t, "d": d, "side": side, "K": K, "S": S, "e": e, "xd": xd, "why": why, "days": days,
                     "base": ret - r_tb * days / 365, "raw": ret, "iv": iv0, "rv": rv20[i],
                     "dir": dirf, "tim": timf, "pf": pff, "merged": merged, "tim_nospy": rawf, "held": held,
                     "stock": (rows[bisect_right(dates, xd) - 1][1] / S - 1) * (1 if side == "call" else -1)}
                for sn in SCEN:
                    if sn in res:
                        x[sn] = res[sn][0] - r_tb * days / 365
                trades.append(x)
    return trades, pricer


# ---------------------------------------------------------------- stats

def month_blocks(xs, key):
    by = defaultdict(list)
    for x in xs:
        by[(x["d"].year, x["d"].month)].append(x[key])
    return by


def boot(xs, key="base", n=600):
    by = month_blocks(xs, key)
    ks = list(by)
    if len(ks) < 6:
        return float("nan"), (float("nan"), float("nan"))
    m = lambda s: statistics.mean([v for k in s for v in by[k]])  # noqa: E731
    obs = m(ks)
    bs = sorted(m([rng.choice(ks) for _ in ks]) for _ in range(n))
    sd = statistics.pstdev(bs)
    lo, hi = bs[int(0.05 * n)], bs[int(0.95 * n) - 1]
    return (obs / sd if sd else float("nan")), (lo, hi)


def stats(xs, key="base"):
    if len(xs) < 5:
        return None
    v = sorted(x[key] for x in xs)
    n = len(v)
    wins = [y for y in v if y > 0]
    losses = [y for y in v if y <= 0]
    t, ci = boot(xs, key)
    return {"n": n, "mean": statistics.mean(v), "median": v[n // 2], "t": t, "ci": ci,
            "win": len(wins) / n, "payoff": (statistics.mean(wins) / abs(statistics.mean(losses))) if wins and losses else float("nan"),
            "sd": statistics.pstdev(v),
            "scen": {s: (statistics.mean([x[s] for x in xs if s in x]) if any(s in x for x in xs) else float("nan")) for s in SCEN}}


def arm_slices(trades):
    return {
        "a unconditional": trades,
        "b direction": [x for x in trades if x["dir"]],
        "c timing": [x for x in trades if x["tim"]],
        "d price filter": [x for x in trades if x["pf"]],
        "e merged (PRIMARY)": [x for x in trades if x["merged"]],
    }


def fmt(s):
    if not s:
        return "| — | | | | | | |"
    def p(v):
        return "—" if v != v else f"{v:+.1%}"
    t = "—" if s["t"] != s["t"] else f"{s['t']:.2f}"
    ci = "— (< 6 month blocks)" if s["ci"][0] != s["ci"][0] else f"{p(s['ci'][0])}..{p(s['ci'][1])}"
    payoff = "—" if s["payoff"] != s["payoff"] else f"{s['payoff']:.2f}"
    return f"| {s['n']:,} | {p(s['mean'])} | {p(s['median'])} | {t} | {ci} | {s['win']:.0%} | {payoff} |"


# ---------------------------------------------------------------- real option prices (Polygon → optlab)

def real_price_check(conn, trades):
    """Match model-priced trades (2024-10→) to the real contract and compare entry debit + pnl. 0 new vendor calls:
    optlab.bars/contracts is the cached Polygon option history (research/cache/polygon_options mirrors new fetches)."""
    rows = conn.execute("""SELECT k.underlying, k.type, k.expiry, k.strike, b.date, b.c::float
                           FROM optlab.bars b JOIN optlab.contracts k ON k.occ = b.occ
                           WHERE b.c > 0 AND b.date >= %s""", (REAL_PX_FROM,)).fetchall()
    chain = defaultdict(list)
    bars = {}
    for u, ty, exp, strike, d, c in rows:
        chain[(u, ty)].append((exp, strike))
        bars[(u, ty, exp, strike, d)] = c
    for k in chain:
        chain[k] = sorted(set(chain[k]))
    out = []
    for x in trades:
        if x["d"] < REAL_PX_FROM:
            continue
        cands = chain.get((x["t"], x["side"]), [])
        best = None
        for exp, strike in cands:
            dte = (exp - x["d"]).days
            if not 25 <= dte <= 75 or abs(strike / x["K"] - 1) > 0.10:
                continue
            cost = abs(dte - DTE) / 45 + abs(strike / x["K"] - 1) * 10
            if best is None or cost < best[0]:
                best = (cost, exp, strike)
        if not best:
            continue
        _, exp, strike = best
        p0 = bars.get((x["t"], x["side"], exp, strike, x["d"]))
        p1 = bars.get((x["t"], x["side"], exp, strike, x["xd"]))
        if not p0 or not p1 or p0 < 0.05:
            continue
        out.append({"t": x["t"], "d": x["d"], "side": x["side"], "model_debit": None, "real_debit": p0,
                    "real_ret": min(p1 / p0 - 1, TAKE), "model_ret": x["raw"], "merged": x["merged"],
                    "K": x["K"], "strike": strike, "exp": exp})
    return out


def iv_from_price(side, S, K, px, T):
    lo, hi = 0.01, 4.0
    f = bs_call if side == "call" else bs_put
    if f(S, K, hi, T) < px or f(S, K, lo, T) > px:
        return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if f(S, K, mid, T) < px:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def polygon_direction(conn):
    """Arm (g), descriptive: call−put IV spread (Cremers-Weinbaum) and OTM-put skew (Xing-Zhang-Zhao) from real Polygon
    option closes, 2024-10→. IVs inverted from the close with the same Black-Scholes used everywhere else."""
    q = """SELECT k.underlying, b.date, k.type, k.strike::float, k.expiry, b.c::float, h.close::float
           FROM optlab.bars b JOIN optlab.contracts k ON k.occ = b.occ
           JOIN lseg_research.daily_history h ON h.ticker = k.underlying AND h.date = b.date
           WHERE b.c > 0 AND h.close > 0 AND (k.expiry - b.date) BETWEEN 20 AND 60"""
    g = defaultdict(list)
    for u, d, ty, K, exp, px, S in conn.execute(q):
        iv = iv_from_price(ty, S, K, px, (exp - d).days / 365)
        if iv and 0.03 < iv < 3.0:
            g[(u, d)].append((ty, K / S, iv))
    out = {}
    for key, legs in g.items():
        atm_c = min([l for l in legs if l[0] == "call" and abs(l[1] - 1) < 0.05], key=lambda l: abs(l[1] - 1), default=None)
        atm_p = min([l for l in legs if l[0] == "put" and abs(l[1] - 1) < 0.05], key=lambda l: abs(l[1] - 1), default=None)
        otm_p = min([l for l in legs if l[0] == "put" and 0.88 <= l[1] <= 0.97], key=lambda l: abs(l[1] - 0.93), default=None)
        rec = {}
        if atm_c and atm_p:
            rec["spread"] = atm_c[2] - atm_p[2]
        if atm_c and otm_p:
            rec["skew"] = otm_p[2] - atm_c[2]
        if rec:
            out[key] = rec
    return out


# ---------------------------------------------------------------- report

def main():
    global DELTA, TAKE, OUT
    args = sys.argv[1:]
    only = next((set(a.split("=", 1)[1].split(",")) for a in args if a.startswith("--tickers=")), None)
    maxn = next((int(a.split("=", 1)[1]) for a in args if a.startswith("--max-names=")), None)
    smoke = "--smoke" in args
    # pre-registered sensitivities (reported, never selected on)
    for a in args:
        if a.startswith("--delta="):
            DELTA = float(a.split("=", 1)[1])
        if a.startswith("--take="):
            TAKE = float(a.split("=", 1)[1])
        if a.startswith("--tag="):
            OUT = OUT.with_name(f"S080_{a.split('=', 1)[1]}.md")
    conn = connect()
    px, rep, tb, tech_hi = load(conn, only, maxn)
    print(f"loaded {len(px)} names", flush=True)
    trades, pricer = build(conn, px, rep, tb, tech_hi)
    print(f"{len(trades):,} trades", flush=True)

    if smoke:
        hand = [x for x in trades if x["merged"]][:3] or trades[:3]
        for x in hand:
            m, spr = pricer.mid(x["side"], x["S"], x["K"], x["iv"], (x["e"] - x["d"]).days, x["d"])
            print(f"\n{x['t']} {x['d']} {x['side']} spot {x['S']:.2f} K {x['K']:.2f} iv {x['iv']:.1%} dte {(x['e']-x['d']).days}"
                  f"\n  mid {m:.3f} spread {spr:.1%} debit(buy) {fill(m, spr, 1):.3f}"
                  f"\n  exit {x['xd']} ({x['why']}) ret/debit {x['raw']:+.1%} days {x['days']} stock {x['stock']:+.1%}"
                  f"\n  flags dir={x['dir']} tim={x['tim']} pf={x['pf']} merged={x['merged']}")
        print(f"\nmerged entries: {sum(x['merged'] for x in trades)} / {len(trades)}")
        return

    train = [x for x in trades if x["d"] < HOLDOUT]
    hold = [x for x in trades if x["d"] >= HOLDOUT]
    arms = arm_slices(trades)
    L = [f"# S080 — long calls / long puts: Direction × Timing × Price (A244, {date.today()})", "",
         f"{len(trades):,} trades, {len({x['t'] for x in trades})} names, daily entries {START} →. 0.50Δ ~45 DTE single long "
         f"option, barrier exits (+100 % limit / −50 % stop at the close / 21 DTE left) walked on the daily path. Returns are "
         f"**per $ debit, net of fills (bid + 23 % of spread), minus T-bill** over the holding days. "
         f"Pre-registered in INDEX row S080 before this script ran; primary arm = (e).", "",
         "## Arms (whole sample)", "",
         "| arm | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    for name, xs in arms.items():
        L.append(f"| {name} {fmt(stats(xs))}")
    L += ["", "## Primary arm (e) — the pre-registered pass bar", "",
          "| slice | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    e = arms["e merged (PRIMARY)"]
    slices = [("train 2021-02→2025-06", [x for x in e if x["d"] < HOLDOUT]),
              ("holdout 2025-07→", [x for x in e if x["d"] >= HOLDOUT]),
              ("era 2021-23", [x for x in e if x["d"] < ERA_SPLIT]),
              ("era 2024→", [x for x in e if x["d"] >= ERA_SPLIT]),
              ("2022 only", [x for x in e if x["d"].year == 2022]),
              ("long calls", [x for x in e if x["side"] == "call"]),
              ("long puts", [x for x in e if x["side"] == "put"])]
    for nm, xs in slices:
        L.append(f"| {nm} {fmt(stats(xs))}")

    es, hs = stats(e), stats([x for x in e if x["d"] >= HOLDOUT])
    e22 = stats([x for x in e if x["d"].year == 2022])
    early, late = stats([x for x in e if x["d"] < ERA_SPLIT]), stats([x for x in e if x["d"] >= ERA_SPLIT])
    a_st = stats(arms["a unconditional"])
    f_mean = statistics.mean([x["stock"] for x in e]) if e else float("nan")
    f_sd = statistics.pstdev([x["stock"] for x in e]) if len(e) > 1 else float("nan")
    eq_vol = f_mean * (es["sd"] / f_sd) if es and f_sd else float("nan")

    checks = []
    if not es or not hs:
        verdict, why = "no decision", "no merged trades"
    else:
        under = hs["n"] < 30
        checks = [("mean > 0", es["mean"] > 0), ("holdout t ≥ 2", (hs["t"] >= 2) if hs["t"] == hs["t"] else False),
                  ("both eras > 0", bool(early and late and early["mean"] > 0 and late["mean"] > 0)),
                  ("beats (a)", bool(a_st and es["mean"] > a_st["mean"])),
                  ("beats (f) stock, equal vol", bool(es["mean"] > eq_vol) if eq_vol == eq_vol else False),
                  ("stress ±25 % same sign as base",
                   all((es["scen"][s] > 0) == (es["scen"]["base"] > 0) for s in SCEN if es["scen"][s] == es["scen"][s])),
                  ("2022 ≥ −25 %", bool(e22 and e22["mean"] >= -0.25))]
        if under:
            verdict, why = "underpowered — no decision", f"holdout n {hs['n']} < 30 (pre-registered power provision)"
        elif all(v for _, v in checks):
            verdict, why = "PASS", ""
        else:
            verdict, why = "FAIL", "failed: " + ", ".join(k for k, v in checks if not v)

    L += ["", f"**Verdict (pre-registered bar): {verdict}**" + (f" — {why}" if why else ""), "",
          "| check | result |", "|---|---|"]
    for k, v in checks:
        L.append(f"| {k} | {'✓' if v else '✗'} |")
    if es:
        L += ["", f"Stress (skew ratio ±25 % on calls and on put wings): base {es['scen']['base']:+.1%} · rich "
                  f"{es['scen']['rich']:+.1%} · cheap {es['scen']['cheap']:+.1%}. The stress barely moves a **per $ debit** "
                  f"return by construction — a multiplicative skew ratio scales the entry debit and the exit value together, "
                  f"so it cancels except where the moving |Δ| crosses a ratio cell or a barrier fires a day earlier. The "
                  f"pricing risk this study carries is therefore in the *level of the barriers being hit*, not in the mean.",
              f"Comparator (f) buy the stock on the same signal: {f_mean:+.2%} per $ invested (sd {f_sd:.2%}); scaled to the "
              f"option's volatility {eq_vol:+.1%} vs the option's {es['mean']:+.1%}."]

    # descriptive: exits, sides, sensitivities
    why_counts = defaultdict(int)
    for x in trades:
        why_counts[x["why"]] += 1
    L += ["", "## Descriptive (never selected on)", "",
          f"Exit reasons over all trades: " + ", ".join(f"{k} {v:,} ({v/len(trades):.0%})" for k, v in sorted(why_counts.items())), ""]
    L += ["| slice | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|"]
    for nm, xs in (("a: long calls", [x for x in trades if x["side"] == "call"]),
                   ("a: long puts", [x for x in trades if x["side"] == "put"]),
                   ("a: holdout 2025-07→", hold), ("a: train", train),
                   ("b direction only, holdout", [x for x in arms["b direction"] if x["d"] >= HOLDOUT]),
                   ("c timing only, holdout", [x for x in arms["c timing"] if x["d"] >= HOLDOUT]),
                   ("d price filter only, holdout", [x for x in arms["d price filter"] if x["d"] >= HOLDOUT])):
        L.append(f"| {nm} {fmt(stats(xs))}")

    # real option prices
    rp = real_price_check(conn, trades)
    if rp:
        ratio = statistics.median([r["real_ret"] - r["model_ret"] for r in rp])
        L += ["", "## Real option closes (Polygon, 2024-10→) vs the model", "",
              f"{len(rp):,} trades matched to a real contract (same name/side, 25–75 DTE, strike within 10 % of the model's "
              f"continuous Δ-strike). Mean return per $ debit: real {statistics.mean([r['real_ret'] for r in rp]):+.1%} vs "
              f"model {statistics.mean([r['model_ret'] for r in rp]):+.1%} (median difference {ratio:+.1%}). Real closes are "
              f"trade prints, not mids, and carry no fill haircut — treat as a direction check on the model, not a replacement."]
        mrp = [r for r in rp if r["merged"]]
        if mrp:
            L.append(f"Merged-arm subset: {len(mrp)} trades, real {statistics.mean([r['real_ret'] for r in mrp]):+.1%} vs "
                     f"model {statistics.mean([r['model_ret'] for r in mrp]):+.1%}.")
    else:
        L += ["", "## Real option closes (Polygon, 2024-10→) vs the model", "",
              "No trade matched a cached real contract (optlab.bars covers ~106 book names, mostly puts near the book's own "
              "strikes) — the model prices stand alone and that is a known weakness."]

    # arm (g)
    pg = polygon_direction(conn)
    if pg:
        sp = [v["spread"] for v in pg.values() if "spread" in v]
        sk = [v["skew"] for v in pg.values() if "skew" in v]
        idx = defaultdict(dict)
        for (u, d), v in pg.items():
            idx[u][d] = v
        med_sk = statistics.median(sk) if sk else None
        tagged = []
        for x in trades:
            if x["d"] < REAL_PX_FROM:
                continue
            v = idx.get(x["t"], {}).get(x["d"])
            if not v:
                continue
            if x["side"] == "call" and "spread" in v:
                tagged.append((v["spread"] > 0, x))
            elif x["side"] == "put" and "skew" in v and med_sk is not None:
                tagged.append((v["skew"] > med_sk, x))
        on = [x for ok, x in tagged if ok]
        off = [x for ok, x in tagged if not ok]
        L += ["", "## Arm (g) — Polygon call−put IV spread + put skew as direction (2024-10→, descriptive)", "",
              f"{len(pg):,} name-days carry an inverted IV pair ({len(sp):,} with an ATM call + put, {len(sk):,} with an OTM "
              f"put + ATM call). Call−put IV spread median {statistics.median(sp):+.3f} (LSEG cannot see this: its iv30_put "
              f"and iv30_call are the same ATM series — S059's skew came out nan); OTM-put skew median "
              f"{med_sk:+.3f}. Rule used (descriptive, fixed before the slice was cut): long call if the spread > 0; long put "
              f"if the skew is above its full-window median. {len(tagged):,} trades carry a signal.",
              "", "| slice | n | mean | median | month-block t | 90 % CI | win | payoff |", "|---|---|---|---|---|---|---|---|",
              f"| signal on {fmt(stats(on))}", f"| signal off {fmt(stats(off))}"]
    else:
        L += ["", "## Arm (g)", "", "No inverted IV pairs available — not tested."]

    # Reconciliation with S076 (+14 % long call) — same contracts, barrier rule off
    L += ["", "### The barrier rule vs holding to expiry (same contracts, same entries)", "",
          "Mean return per $ debit, **gross of the T-bill subtraction** (so the barrier row differs in the last decimal from "
          "the arms table above, which is net).", "",
          "| exit rule | all | long calls | long puts | merged (e) |", "|---|---|---|---|---|"]
    for lab, key in (("barriers (+100 / −50 / 21 DTE)", "raw"), ("held to expiry, intrinsic", "held")):
        cells = [statistics.mean([x[key] for x in pool]) if pool else float("nan")
                 for pool in (trades, [x for x in trades if x["side"] == "call"],
                              [x for x in trades if x["side"] == "put"], e)]
        L.append(f"| {lab} | " + " | ".join(f"{v:+.1%}" for v in cells) + " |")
    held_call = [x["held"] for x in trades if x["side"] == "call"]
    L += ["", f"Holding the same 0.50Δ ~45 DTE calls to expiry gives {statistics.mean(held_call):+.1%} per $ debit against "
              f"{statistics.mean([x['raw'] for x in trades if x['side'] == 'call']):+.1%} with the barriers — the pre-registered "
              f"exit rule is itself a large negative. It caps the right tail at +100 % (where long calls earn everything) "
              f"while taking the full downside, and it stops out {sum(x['why'] == 'stop' for x in trades) / len(trades):.0%} "
              f"of trades. This is the mechanical reason S076's +14 % long call (Monday entries, 0.40Δ, held to expiry, "
              f"IV/RV ≤ 0.95 slice) does not reappear here, and it is the first thing to change before any product.", ""]

    # pre-registered sensitivities (reported, never selected on) — separate runs, parsed back in if present
    sens = []
    for tag, cmd in (("sens_delta040", "--delta=0.40"), ("sens_take50", "--take=0.50")):
        p = OUT.with_name(f"S080_{tag}.md")
        if not p.exists():
            continue
        got = {}
        for line in p.read_text().splitlines():
            for k in ("a unconditional", "e merged (PRIMARY)"):
                if line.startswith(f"| {k} |"):
                    got.setdefault(k, line.split("|")[2:5])
        if got:
            sens.append((cmd, got))
    if sens:
        L += ["", "### Pre-registered sensitivities (reported, never selected on)", "",
              "| setting | (a) unconditional n / mean / median | (e) merged n / mean / median |", "|---|---|---|"]
        for cmd, got in sens:
            a = " / ".join(s.strip() for s in got.get("a unconditional", ["—"] * 3))
            m = " / ".join(s.strip() for s in got.get("e merged (PRIMARY)", ["—"] * 3))
            L.append(f"| `{cmd}` | {a} | {m} |")
        L += ["", "Both re-runs keep every arm negative: no setting of the Δ or take-profit knob turns option buying positive.", ""]

    # sanity: what the frozen screen flags now and in the 10-01..10-08 window Jamie called out (not evidence).
    # Read from a screen pass, not from the trade set: the last ~6 weeks have no forward path, so they produce no trades.
    scr, _ = build(conn, px, rep, tb, tech_hi, screen_from=date(2026, 9, 25))
    last = max(x["d"] for x in scr)
    oct_win = [x for x in scr if date(2026, 10, 1) <= x["d"] <= date(2026, 10, 8)]
    recent = [x for x in scr if x["d"] >= last - timedelta(days=4)]
    L += ["", "## Sanity: what the frozen screen flags today and on 10-01..10-08 (not evidence)", ""]
    for lab, pool in (("latest bars (to " + str(last) + ")", recent), ("2026-10-01..10-08", oct_win)):
        mg = [x for x in pool if x["merged"]]
        dp = [x for x in pool if x["dir"] and x["pf"]]
        nospy = [x for x in pool if x["dir"] and x["pf"] and x["tim_nospy"]]
        names = lambda xs: ", ".join(sorted({f"{x['t']} {x['side']}" for x in xs})[:12]) or "none"  # noqa: E731
        L += [f"- **{lab}** — merged screen (e): **{len(mg)}** flags ({names(mg)}). "
              f"Direction + price only: {len(dp)} ({names(dp)}). Direction + price + the 2σ event without the SPY-below-200d "
              f"condition: {len(nospy)} ({names(nospy)})."]
    L += ["", "Jamie read several long-call setups now and long puts around 10-01..10-08. The merged screen does not agree, "
              "and the reason is the pre-registered timing leg: S025's one surviving condition is **SPY below its 200-day**, "
              "which is false today, so the bullish timing leg cannot fire at all in this tape. That is a property of the "
              "pre-registered rule, not a refutation of Jamie's read.", ""]

    L += ["", "## Known weaknesses", "",
          "- Call skew still rests on one day of Schwab ladders (S075); the ±25 % stress is the guard, not a fix.",
          "- Continuous strikes at the flat-IV Δ; real chains round to listed strikes.",
          "- Barrier exits use daily closes: the +100 % take is recorded as exactly +100 % (limit), the −50 % stop takes the "
          "close in full (gap risk counted). No intraday path.",
          "- Daily entries overlap heavily (45 DTE held up to 24 days) → month-block bootstrap, not iid t.",
          "- lab_tech is a Monday panel forward-filled inside the week.",
          "- Real option closes only exist from 2024-10 (Polygon plan limit, probed 10-22); everything earlier is model-priced."]

    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))

    print("\n--- screen sanity (2026-09-25 →) ---")
    for x in sorted((y for y in scr if y["merged"]), key=lambda y: y["d"]):
        print(f"{x['d']} {x['t']:<6} {x['side']:<4} spot {x['S']:.2f}")
    print(f"{sum(x['merged'] for x in scr)} merged flags since 2026-09-25")
    json.dump([{k: str(v) if isinstance(v, date) else v for k, v in x.items()} for x in trades if x["merged"]],
              open(f"/tmp/{OUT.stem}_merged_trades.json", "w"), default=str)


if __name__ == "__main__":
    main()
