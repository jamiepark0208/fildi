"""S076 — backtest every Rankings › Structures structure (A192 Phase 2, Jamie 10-20: "so many untested, so little detail").

Same definitions as the live board (structures.py build_all / evaluate / regime_fit): legs and |Δ| targets, weekly (next-week
Friday, ~11 days) vs monthly (~32 days) expiries, capital rule, earnings before expiry excluded, and the board's regime-fit rule.
Entries: every Monday close 2021-02 →, every name with LSEG iv30 (put + call) and 20-day realized vol; held to expiry (intrinsic).
Calendar: front weekly call sold, back monthly call valued at the front expiry and sold.

Pricing (0 vendor requests, S075): leg mid = Black-Scholes at the stock's iv30_<side> × skew ratio for (side, DTE bucket, |Δ| bucket).
Put ratios point-in-time = previous calendar month's LSEG median for the cell (fallback: whole-history cell); call ratios = the
one-day Schwab ladder (no call history — an assumption, stressed below). Fills: sell = mid × (1 − 0.27 × spread), buy = mid ×
(1 + 0.27 × spread) (bid + 23 % of the spread, RH median), spread = S075 cell median.
Strikes are continuous at the flat-iv30 Δ (real chains round to listed strikes and pick by skewed Δ → slightly closer strikes).

Outcome per trade: pnl ÷ capital (board rule). Excess = pnl/capital − T-bill (FRED DTB3) over the holding days; covered call and
collar are judged vs simply holding the shares (same capital). Long premium: the debit would otherwise earn T-bill.

Pre-registered verdict (per structure, on the slice the board would show = regime fit true):
  works      mean excess > 0, month-block bootstrap t ≥ 2, positive in 2021–23 and 2024 →, same sign in all 3 pricing scenarios
  promising  mean excess > 0 in both eras and all scenarios, t < 2
  fails      otherwise
Pricing scenarios: base · rich (put |Δ| < 0.175 ratios × 1.10, call ratios × 1.10) · cheap (× 0.90): a verdict that flips is
pricing-sensitive and says so.

Out: out/opt/S076.md · watchlist_sync.structure_backtest (one row per structure: summary, eras, regimes, equity, histogram) →
GET /api/options/structures/backtest → Rankings › Structures.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s076_structures_backtest.py [--tickers=CAVA,SHOP] [--no-write]
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from build_plan import connect  # noqa: E402
from s045_put_retest import bs_put, ncdf  # noqa: E402
from s075_skew_calibration import DELTA_B, DTE_B, RIC, bucket  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S076.md"
RATIOS = HERE.parent / "out" / "opt" / "s075_ratios.json"
START, SPLIT = date(2021, 2, 1), date(2024, 1, 1)
FILL_K = 0.27   # mid − fill = (0.5 − 0.23) × spread
rng = random.Random(76)

WEEKLY = {"csp", "covered_call", "put_spread", "call_spread", "iron_condor", "jade_lizard", "short_straddle", "iron_fly",
          "short_strangle"}
FAMILY = {"csp": "short_premium", "covered_call": "short_premium", "put_spread": "short_premium", "call_spread": "short_premium",
          "iron_condor": "short_premium", "iron_fly": "short_premium", "jade_lizard": "short_premium",
          "short_strangle": "short_premium", "short_straddle": "short_premium", "long_call": "long_premium",
          "long_put": "long_premium", "long_straddle": "long_premium", "long_strangle": "long_premium",
          "bull_call_spread": "directional", "bear_put_spread": "directional", "calendar": "time", "collar": "hedge"}
SCEN = {"base": (1.0, 1.0), "rich": (1.10, 1.10), "cheap": (0.90, 0.90)}


def bs_call(S, K, v, t):
    return bs_put(S, K, v, t) + S - K


def strike_for(S, v, t, target, side):
    """Strike whose flat-iv |Δ| = target."""
    sd = v * math.sqrt(t)
    lo, hi = S * 0.2, S * 3
    for _ in range(50):
        k = (lo + hi) / 2
        d1 = (math.log(S / k) + 0.5 * sd * sd) / sd
        dl = ncdf(d1) if side == "call" else 1 - ncdf(d1)
        if side == "call":
            lo, hi = (k, hi) if dl > target else (lo, k)
        else:
            lo, hi = (lo, k) if dl > target else (k, hi)
    return (lo + hi) / 2


class Pricer:
    def __init__(self, conn):
        cal = json.loads(RATIOS.read_text())["cells"]
        self.static = cal   # whole-history LSEG puts / one-day Schwab calls
        # point-in-time put ratios: previous month's median per cell
        hist = defaultdict(list)
        closes = defaultdict(dict)
        for t, d, c, ivp in conn.execute("SELECT ticker, date, close::float, iv30_put::float FROM lseg_research.daily_history "
                                         "WHERE close > 0 AND iv30_put IS NOT NULL AND date >= '2020-12-01'"):
            closes[t][d] = (c, ivp / 100 if ivp > 3 else ivp)
        for ric, d, bid, ask, mid in conn.execute("SELECT ric, date, bid::float, ask::float, mid::float FROM optlab.lseg_opt_daily "
                                                  "WHERE bid > 0 AND ask >= bid"):
            m = RIC.match(ric)
            if not m or m.group(2) <= "L":
                continue
            root, let, dd, yy, k = m.groups()
            try:
                exp = date(2000 + int(yy), (ord(let) - ord("A")) % 12 + 1, int(dd))
            except ValueError:
                continue
            h = closes.get(root, {}).get(d)
            dte = (exp - d).days
            if not h or not bucket(dte, DTE_B):
                continue
            S, iv = h
            K, T = int(k) / 100, dte / 365
            if not 0.4 < K / S < 1.6:
                continue
            model = bs_put(S, K, iv, T)
            if model < 0.01:
                continue
            sd = iv * math.sqrt(T)
            db = bucket(1 - ncdf((math.log(S / K) + 0.5 * sd * sd) / sd), DELTA_B)
            if db:
                hist[(d.year, d.month, bucket(dte, DTE_B), db)].append((mid if mid and mid > 0 else (bid + ask) / 2) / model)
        self.monthly = {k: statistics.median(v) for k, v in hist.items() if len(v) >= 20}

    def cell(self, side, dte, dl):
        dtb, db = bucket(max(dte, 1), DTE_B) or DTE_B[-1], bucket(dl, DELTA_B)
        if db is None:
            db = DELTA_B[0] if dl < DELTA_B[0][0] else DELTA_B[-1]
        return dtb, db

    def mid(self, side, S, K, iv, dte, on, scen="base"):
        """(estimated real mid, relative spread) for one contract."""
        T = max(dte, 1) / 365
        model = (bs_call if side == "call" else bs_put)(S, K, iv, T)
        sd = iv * math.sqrt(T)
        d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
        dl = ncdf(d1) if side == "call" else 1 - ncdf(d1)
        dtb, db = self.cell(side, dte, dl)
        st = self.static.get(side, {}).get(f"{dtb[0]}-{dtb[1]}", {}).get(f"{db[0]}-{db[1]}")
        ratio, spread = (st["ratio"], st["spread"]) if st else (1.0, 0.15)
        if side == "put":
            pm = (on.year, on.month - 1) if on.month > 1 else (on.year - 1, 12)
            ratio = self.monthly.get((*pm, dtb, db), ratio)
        pr, cr = SCEN[scen]
        if side == "put" and dl < 0.175:
            ratio *= pr
        if side == "call":
            ratio *= cr
        return max(model * ratio, 0.0), spread


def load(conn, only):
    bars = defaultdict(list)
    q = ("SELECT ticker, date, close::float, iv30_put::float, iv30_call::float FROM lseg_research.daily_history "
         "WHERE close > 0 AND date >= '2020-09-01' ORDER BY ticker, date")
    for t, d, c, ivp, ivc in conn.execute(q):
        if only and t not in only:
            continue
        f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
        bars[t].append((d, c, f(ivp), f(ivc)))
    rep = defaultdict(list)
    for t, d in conn.execute("SELECT ticker, report_date FROM lseg_research.earnings_moves ORDER BY report_date"):
        rep[t].append(d)
    tb = {}
    for line in (HERE.parent / "out" / "opt" / "dtb3.csv").read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            tb[date.fromisoformat(dd)] = float(v) / 100
    return bars, rep, sorted(tb.items())


def edge_quintiles(conn):
    """S059/S069 live put-edge quintile per (ticker, Monday) — the board's short-premium fit uses Q4+."""
    try:
        import s059_option_factors as S9
        from s069_gate_audit import rank
    except Exception:
        return {}
    ev = S9.aligned_events(conn)
    byw, out = defaultdict(list), {}
    for e in ev:
        byw[e["d"]].append(e)
    for w, xs in byw.items():
        ok = [e for e in xs if all(e.get(k) is not None for k in ("iv_rv", "vol_of_vol", "put_tech"))]
        if len(ok) >= 30:
            comp = rank(sum(rank([e[k] for e in ok]) for k in ("iv_rv", "vol_of_vol", "put_tech")))
            for e, p in zip(ok, comp):
                out[(e["t"], e["d"])] = min(5, int(p * 5) + 1)
    return out


def legs_for(sid, S, ivp, ivc, dte):
    """[(side, K, qty)] qty −1 = sold, +1 = bought; mirrors structures.build_all."""
    T = dte / 365
    P = lambda d: strike_for(S, ivp, T, d, "put")   # noqa: E731
    C = lambda d: strike_for(S, ivc, T, d, "call")  # noqa: E731
    return {
        "csp": [("put", P(0.20), -1)],
        "covered_call": [("call", C(0.20), -1)],
        "put_spread": [("put", P(0.25), -1), ("put", P(0.10), 1)],
        "call_spread": [("call", C(0.25), -1), ("call", C(0.10), 1)],
        "iron_condor": [("put", P(0.25), -1), ("put", P(0.10), 1), ("call", C(0.25), -1), ("call", C(0.10), 1)],
        "jade_lizard": [("put", P(0.25), -1), ("call", C(0.25), -1), ("call", C(0.10), 1)],
        "short_straddle": [("put", S, -1), ("call", S, -1)],
        "iron_fly": [("put", S, -1), ("call", S, -1), ("put", P(0.16), 1), ("call", C(0.16), 1)],
        "short_strangle": [("put", P(0.16), -1), ("call", C(0.16), -1)],
        "long_call": [("call", C(0.40), 1)],
        "long_put": [("put", P(0.40), 1)],
        "long_straddle": [("put", S, 1), ("call", S, 1)],
        "long_strangle": [("put", P(0.25), 1), ("call", C(0.25), 1)],
        "bull_call_spread": [("call", C(0.50), 1), ("call", C(0.25), -1)],
        "bear_put_spread": [("put", P(0.50), 1), ("put", P(0.25), -1)],
        "collar": [("put", P(0.20), 1), ("call", C(0.20), -1)],
    }[sid]


def capital(sid, S, legs, credit):
    if sid == "csp":
        return legs[0][1]
    if sid in ("covered_call", "collar"):
        return S
    if sid in ("short_strangle", "short_straddle"):
        return 0.2 * S + max(credit, 0)
    if sid == "calendar":
        return max(-credit, 0.01)
    grid = [S * (0.2 + 2.8 * i / 400) for i in range(401)]
    pay = [credit + sum(q * (max(x - K, 0) if sd == "call" else max(K - x, 0)) for sd, K, q in legs) for x in grid]
    return max(-min(pay), 0.01)


def expiry_index(rows, i, days):
    target = rows[i][0] + timedelta(days=days)
    ds = [r[0] for r in rows]
    j = bisect_right(ds, target) - 1
    return j if j > i else None


def run(conn, only):
    bars, rep, tb = load(conn, only)
    pricer = Pricer(conn)
    edgeq = edge_quintiles(conn)
    tbd = [d for d, _ in tb]
    spy = bars.get("SPY") or [(d, c, None, None) for d, c in conn.execute(
        "SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date")]
    spy_d = [r[0] for r in spy]
    trades = []
    for t, rows in bars.items():
        if t in ("SPY", "QQQ", "IWM") or len(rows) < 80:
            continue
        logc = [math.log(r[1]) for r in rows]
        rd = rep.get(t, [])
        for i, (d, S, ivp, ivc) in enumerate(rows):
            if d < START or d.weekday() != 0 or not ivp or not ivc or i < 60:
                continue
            rets = [logc[k] - logc[k - 1] for k in range(i - 19, i + 1)]
            rv20 = statistics.pstdev(rets) * math.sqrt(252)
            if rv20 <= 0:
                continue
            ma50 = sum(r[1] for r in rows[i - 49:i + 1]) / 50
            si = bisect_right(spy_d, d) - 1
            spy_up = si >= 200 and spy[si][1] > sum(r[1] for r in spy[si - 199:si + 1]) / 200
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            for horizon, sids in ((11, sorted(WEEKLY)), (32, ["long_call", "long_put", "long_straddle", "long_strangle",
                                                              "bull_call_spread", "bear_put_spread", "collar"])):
                j = expiry_index(rows, i, horizon)
                if j is None:
                    continue
                e, Se = rows[j][0], rows[j][1]
                if any(d < x <= e for x in rd):      # earnings before expiry → board excludes
                    continue
                dte = (e - d).days
                iv_atm = (ivp + ivc) / 2
                for sid in sids:
                    legs = legs_for(sid, S, ivp, ivc, dte)
                    trades.append(price_trade(pricer, t, d, e, S, Se, sid, legs, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up,
                                              edgeq.get((t, d)), r_tb, rows[i + 1:j + 1]))
            # calendar: weekly front call sold, monthly back call bought, back valued at front expiry
            jf, jb = expiry_index(rows, i, 11), expiry_index(rows, i, 32)
            if jf and jb and not any(d < x <= rows[jb][0] for x in rd) and rows[jf][3]:
                ef, eb = rows[jf][0], rows[jb][0]
                trades.append(price_calendar(pricer, t, d, ef, eb, S, rows[jf][1], ivc, rows[jf][3], rv20, ma50, spy_up, r_tb))
    return [x for x in trades if x]


def fill(px, spread, qty):
    return px * (1 - FILL_K * spread) if qty < 0 else px * (1 + FILL_K * spread)


def price_trade(pricer, t, d, e, S, Se, sid, legs, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r_tb, path):
    out = {"t": t, "d": d, "s": sid, "ivrv": iv_atm / rv20, "up50": S > ma50, "spy_up": spy_up}
    for scen in SCEN:
        credit = 0.0
        for side, K, qty in legs:
            m, spr = pricer.mid(side, S, K, ivp if side == "put" else ivc, dte, d, scen)
            credit += -qty * fill(m, spr, qty)
        pay = sum(qty * (max(Se - K, 0) if side == "call" else max(K - Se, 0)) for side, K, qty in legs)
        pnl = credit + pay
        cap = capital(sid, S, legs, credit)
        days = (e - d).days
        if sid in ("covered_call", "collar"):
            exc = pnl / S        # vs just holding the shares: the option overlay's pnl is the whole difference
        else:
            exc = pnl / cap - r_tb * days / 365
        out[scen] = exc
        if scen == "base":
            out.update(pnl=pnl / cap, cap=cap, capS=cap / S, credit=credit, days=days,
                       mdd=min([0.0] + [(x[1] - S) / S for x in path]))
    out["fit"] = fit(sid, out["ivrv"], out["up50"], q)
    return out


def price_calendar(pricer, t, d, ef, eb, S, Sf, ivc, ivc_f, rv20, ma50, spy_up, r_tb):
    out = {"t": t, "d": d, "s": "calendar", "ivrv": ivc / rv20, "up50": S > ma50, "spy_up": spy_up}
    for scen in SCEN:
        mf, sf = pricer.mid("call", S, S, ivc, (ef - d).days, d, scen)
        mb, sb = pricer.mid("call", S, S, ivc, (eb - d).days, d, scen)
        credit = fill(mf, sf, -1) - fill(mb, sb, 1)
        back_left = (eb - ef).days
        mb2, sb2 = pricer.mid("call", Sf, S, ivc_f, back_left, ef, scen)
        pnl = credit - max(Sf - S, 0) + fill(mb2, sb2, -1)
        cap = max(-credit, 0.01)
        out[scen] = pnl / cap - r_tb * (ef - d).days / 365
        if scen == "base":
            out.update(pnl=pnl / cap, cap=cap, capS=cap / S, credit=credit, days=(ef - d).days, mdd=0.0)
    out["fit"] = out["ivrv"] >= 1.0
    return out


def fit(sid, ivrv, up, q):
    fam = FAMILY[sid]
    if fam == "short_premium":
        return ivrv >= 1.15 and (q is None or q >= 4)
    if fam == "long_premium":
        return ivrv <= 0.95
    if fam == "directional":
        return (up if sid == "bull_call_spread" else not up) and ivrv <= 1.3
    return True


def month_t(xs, key="base"):
    by = defaultdict(list)
    for x in xs:
        by[(x["d"].year, x["d"].month)].append(x[key])
    ks = list(by)
    if len(ks) < 6:
        return float("nan")
    m = lambda s: statistics.mean([v for k in s for v in by[k]])  # noqa: E731
    obs = m(ks)
    bs = [m([rng.choice(ks) for _ in ks]) for _ in range(400)]
    sd = statistics.pstdev(bs)
    return obs / sd if sd else float("nan")


def summarize(xs):
    if len(xs) < 30:
        return None
    v = sorted(x["base"] for x in xs)
    n = len(v)
    return {"n": n, "mean": statistics.mean(v), "median": v[n // 2], "win": sum(x["pnl"] > 0 for x in xs) / n,
            "worst5": v[n // 20], "worst1": v[n // 100], "best5": v[-(n // 20) - 1], "t": month_t(xs),
            "days": statistics.mean(x["days"] for x in xs),
            # same-risk view (rule 2): return-on-capital flatters margin structures (strangle capital = 20 % of the stock)
            "sd": statistics.pstdev(v), "sharpe": statistics.mean(v) / statistics.pstdev(v) if statistics.pstdev(v) else 0.0,
            "per_stock": statistics.mean(x["base"] * x["capS"] for x in xs),
            "scen": {s: statistics.mean(x[s] for x in xs) for s in SCEN}}


def verdict(sm, early, late):
    if not sm or not early or not late:
        return "untested", "too few trades"
    signs = [sm["scen"][s] > 0 for s in SCEN]
    if sm["mean"] > 0 and sm["t"] >= 2 and early["mean"] > 0 and late["mean"] > 0 and all(signs):
        return "works", ""
    if sm["mean"] > 0 and early["mean"] > 0 and late["mean"] > 0 and all(signs):
        return "promising", "positive in both eras and all pricing scenarios, not yet significant"
    if sm["mean"] > 0 and not all(signs):
        return "fails", "pricing-sensitive: sign flips under the rich/cheap pricing scenarios"
    return "fails", ""


def histogram(xs, nb=24):
    v = sorted(x["base"] for x in xs)
    lo, hi = v[len(v) // 100], v[-(len(v) // 100) - 1]
    if hi <= lo:
        hi = lo + 1e-6
    w = (hi - lo) / nb
    bins = [0] * nb
    for x in v:
        bins[min(nb - 1, max(0, int((x - lo) / w)))] += 1
    return {"lo": lo, "w": w, "counts": bins}


def equity(xs):
    by = defaultdict(list)
    for x in xs:
        by[f"{x['d'].year}-{x['d'].month:02d}"].append(x["base"])
    cum, out = 0.0, []
    for m in sorted(by):
        cum += statistics.mean(by[m])
        out.append({"m": m, "ret": statistics.mean(by[m]), "cum": cum, "n": len(by[m])})
    return out


def templates(pricer):
    """Payoff-diagram template per structure: spot 100, iv30 50 % both sides, board legs, base pricing + fills (UI draws P/L at
    expiry from these legs; one home for the definitions = this file + structures.py)."""
    S, iv, today = 100.0, 0.50, date.today()
    out = {}
    for sid in FAMILY:
        if sid == "calendar":
            dte_f, dte_b = 11, 32
            mf, sf = pricer.mid("call", S, S, iv, dte_f, today)
            mb, sb = pricer.mid("call", S, S, iv, dte_b, today)
            out[sid] = {"spot": S, "iv": iv, "dte": dte_f, "legs": [{"side": "call", "strike": S, "qty": -1, "px": round(fill(mf, sf, -1), 3), "dte": dte_f},
                                                                    {"side": "call", "strike": S, "qty": 1, "px": round(fill(mb, sb, 1), 3), "dte": dte_b}],
                        "credit": round(fill(mf, sf, -1) - fill(mb, sb, 1), 3), "stock": False}
            continue
        dte = 11 if sid in WEEKLY else 32
        legs = legs_for(sid, S, iv, iv, dte)
        lg, credit = [], 0.0
        for side, K, qty in legs:
            m, spr = pricer.mid(side, S, K, iv, dte, today)
            px = fill(m, spr, qty)
            credit += -qty * px
            lg.append({"side": side, "strike": round(K, 2), "qty": qty, "px": round(px, 3), "dte": dte})
        out[sid] = {"spot": S, "iv": iv, "dte": dte, "legs": lg, "credit": round(credit, 3),
                    "capital": round(capital(sid, S, legs, credit), 2), "stock": sid in ("covered_call", "collar")}
    return out


def main():
    if "--templates-only" in sys.argv:
        conn = connect()
        for sid, tp in templates(Pricer(conn)).items():
            conn.execute("UPDATE watchlist_sync.structure_backtest SET payload = payload || jsonb_build_object('template', %s::jsonb) "
                         "WHERE structure = %s", (json.dumps(tp), sid))
        conn.commit()
        print("templates written")
        return
    only = next((set(a.split("=", 1)[1].split(",")) for a in sys.argv if a.startswith("--tickers=")), None)
    conn = connect()
    trades = run(conn, only)
    if only:
        for x in trades[:25]:
            print(f"{x['t']} {x['d']} {x['s']:<17} credit {x['credit']:+.3f} cap {x['cap']:.2f} pnl/cap {x['pnl']:+.2%} "
                  f"excess {x['base']:+.2%} fit {x['fit']} ivrv {x['ivrv']:.2f}")
    by = defaultdict(list)
    for x in trades:
        by[x["s"]].append(x)
    L = ["# S076 — every Structures-board structure backtested (2021-02 →, Monday entries, held to expiry, skew + fills from S075)", "",
         f"{len(trades):,} trades, {len({x['t'] for x in trades})} names. Excess = pnl ÷ capital − T-bill (covered call / collar: vs holding "
         "the shares). 'As shown' = the board's regime-fit slice. t = month-block bootstrap.", "",
         "| structure | as shown: n | mean excess | per $ stock | mean ÷ sd | win | median | worst 5 % | t | 2021–23 | 2024 → | rich / cheap pricing | all entries mean | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    rows_out = []
    tps = templates(Pricer(conn)) if not only else {}
    for sid in sorted(by, key=lambda s: (FAMILY[s], s)):
        xs = by[sid]
        shown = [x for x in xs if x["fit"]]
        sm, sa = summarize(shown), summarize(xs)
        early, late = summarize([x for x in shown if x["d"] < SPLIT]), summarize([x for x in shown if x["d"] >= SPLIT])
        v, why = verdict(sm, early, late)
        regimes = {}
        for lab, f in (("IV rich (IV/RV ≥ 1.15)", lambda x: x["ivrv"] >= 1.15), ("IV cheap (IV/RV ≤ 0.95)", lambda x: x["ivrv"] <= 0.95),
                       ("SPY above 200-day", lambda x: x["spy_up"]), ("SPY below 200-day", lambda x: not x["spy_up"]),
                       ("stock above 50-day", lambda x: x["up50"]), ("stock below 50-day", lambda x: not x["up50"])):
            s = summarize([x for x in xs if f(x)])
            if s:
                regimes[lab] = {"n": s["n"], "mean": s["mean"], "win": s["win"], "worst5": s["worst5"]}
        if sm:
            L.append(f"| {sid} | {sm['n']} | {sm['mean']:+.2%} | {sm['per_stock']:+.2%} | {sm['sharpe']:+.3f} | {sm['win']:.0%} | {sm['median']:+.2%} | {sm['worst5']:+.1%} | {sm['t']:.1f} | "
                     f"{early['mean'] if early else float('nan'):+.2%} | {late['mean'] if late else float('nan'):+.2%} | "
                     f"{sm['scen']['rich']:+.2%} / {sm['scen']['cheap']:+.2%} | {sa['mean']:+.2%} | {v}{' — ' + why if why else ''} |")
        else:
            L.append(f"| {sid} | {len(shown)} | — | | | | | | | | {sa['mean'] if sa else float('nan'):+.2%} | {v} |")
        rows_out.append((sid, {"structure": sid, "verdict": v, "why": why, "as_shown": sm, "all": sa,
                               "eras": {"2021–23": early, "2024 →": late}, "regimes": regimes,
                               "equity": equity(shown or xs), "template": tps.get(sid), "hist": histogram(shown if len(shown) >= 30 else xs),
                               "method": "S076: Monday entries 2021-02→, held to expiry, BS at iv30 × S075 skew ratio, fills bid+23 % "
                                         "of spread, earnings excluded, excess over T-bill (covered call/collar vs holding shares)"}))
    L += ["", "Known weaknesses: call skew from one day of Schwab ladders (stressed ±10 %); continuous strikes at flat-IV Δ; "
               "no early assignment / early exit; equal weight per trade (capital differs by structure)."]
    OUT.write_text("\n".join(L) + "\n")
    print("\n".join(L))
    if not only and "--no-write" not in sys.argv:
        conn.execute("""CREATE TABLE IF NOT EXISTS watchlist_sync.structure_backtest (structure text PRIMARY KEY, as_of date,
                        payload jsonb, updated_at timestamptz DEFAULT now())""")
        for sid, p in rows_out:
            conn.execute("""INSERT INTO watchlist_sync.structure_backtest (structure, as_of, payload) VALUES (%s, current_date, %s)
                            ON CONFLICT (structure) DO UPDATE SET as_of = excluded.as_of, payload = excluded.payload, updated_at = now()""",
                         (sid, json.dumps(p, default=str)))
        conn.commit()


if __name__ == "__main__":
    main()
