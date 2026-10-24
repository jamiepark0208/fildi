"""S098 — QuantConnect / Quantpedia volatility-premium structures missing from S076 (A262).

Question: which published short-vol structures are not already in S076's 17, and do they clear the
pre-registered bar on the S076 pricing stack?

Catalog (fetched, not guessed):
  QC index  https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/option-strategies
  Quantpedia simple rule  https://quantpedia.com/strategies/volatility-risk-premium-effect/
  VIX futures (not tested)  https://quantpedia.com/strategies/exploiting-term-structure-of-vix-futures/
  Screener  https://quantpedia.com/screener/?FilterKeywords=volatility+effect

Tested (short vol / premium, absent from S076):
  long_call_butterfly   QC: +1 ITM call, −2 ATM, +1 OTM, equal strike distance. Wing = 0.25Δ call. ~30 DTE → 32d.
  long_put_butterfly    QC: +1 ITM put, −2 ATM, +1 OTM, equal distance. Wing = 0.25Δ put. 32d.
  naked_call            QC naked call. No delta on the page; 0.20Δ matches S076 CSP. Weekly (11d).
  short_call_backspread QC code: +1 lower call, −2 higher. Deltas 0.50 and 0.25 (S076 bull-call strikes). 11d.
  short_put_backspread  QC code: +1 higher put, −2 lower (intro sentence disagrees; legs and the payoff example win). 11d.
  bull_call_ladder      QC: +1 lowest, −1 middle, −1 highest, "profits from low volatility". Deltas 0.50 / 0.35 / 0.20. 32d.
  qp_crash_straddle     Quantpedia: sell 1-month ATM straddle sized so its credit is 5% of spot, buy the same
                        count of 15% OTM puts (K = 0.85 S). Excess = overlay pnl / spot vs holding the shares.
  dh_short_straddle     Coval–Shumway zero-beta straddle, cited on that page. Short ATM straddle, daily BS
                        delta hedge, 32d. Not the unhedged S076 short straddle.

Not tested, and why: see the mapping table written into the report. No new vendor pulls. No edits to s076.

Pass bar (INDEX, unchanged): holdout entries on/after 2023-01-01, week-clustered t ≥ 2, both holdout halves
the same sign and positive, and marginal vs a same-horizon 0.20Δ CSP (pnl per $ of stock) week-clustered
t ≥ 2 inside put_edge Q5, both halves positive. Month-block t is reported beside it (holds overlap). A sign
flip under S076 rich/cheap (±10% wing/call ratios) does not ship.

    cd scripts/watchlist_sync && nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s098_vol_premium_gaps.py
    ... --tickers=CAVA,SHOP,TMO,MU,CRWV
"""
from __future__ import annotations

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
import s076_structures_backtest as H  # noqa: E402

OUT = HERE.parent / "out" / "studies" / "S098.md"
HOLDOUT = date(2023, 1, 1)
SMOKE = ["CAVA", "SHOP", "TMO", "MU", "CRWV"]
WEEKLY = {"naked_call", "short_call_backspread", "short_put_backspread"}
MONTHLY = {"long_call_butterfly", "long_put_butterfly", "bull_call_ladder", "qp_crash_straddle", "dh_short_straddle"}
ORDER = ["qp_crash_straddle", "dh_short_straddle", "long_call_butterfly", "long_put_butterfly",
         "naked_call", "short_call_backspread", "short_put_backspread", "bull_call_ladder"]
MARGIN = {"naked_call", "short_call_backspread", "bull_call_ladder", "dh_short_straddle"}
def _defined_cap(S, legs, credit):
    worst = 0.0
    for i in range(0, 301):
        x = S * 3.0 * i / 300
        pay = credit
        for sd, K, q in legs:
            pay += q * (max(x - K, 0.0) if sd == "call" else max(K - x, 0.0))
        worst = min(worst, pay)
    return max(-worst, 0.01)


_orig_capital = H.capital


def capital(sid, S, legs, credit):
    if sid in MARGIN or sid == "dh_short_straddle":
        return 0.2 * S + max(credit, 0.0)
    if sid == "short_put_backspread":
        return _defined_cap(S, legs, credit)
    if sid in ("long_call_butterfly", "long_put_butterfly"):
        return _defined_cap(S, legs, credit)
    return _orig_capital(sid, S, legs, credit)


H.capital = capital
for _sid in ORDER:
    H.FAMILY[_sid] = "short_premium"


def call_delta(S, K, v, t):
    if t <= 1e-8 or v <= 0:
        return 1.0 if S > K else 0.0
    sd = v * math.sqrt(t)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return H.ncdf(d1)


def put_delta(S, K, v, t):
    return call_delta(S, K, v, t) - 1.0


def legs_gap(sid, S, ivp, ivc, dte):
    T = dte / 365
    P = lambda d: H.strike_for(S, ivp, T, d, "put")    # noqa: E731
    C = lambda d: H.strike_for(S, ivc, T, d, "call")   # noqa: E731
    if sid == "naked_call":
        return [("call", C(0.20), -1)]
    if sid == "short_call_backspread":
        return [("call", C(0.50), 1), ("call", C(0.25), -2)]
    if sid == "short_put_backspread":
        return [("put", P(0.50), 1), ("put", P(0.25), -2)]
    if sid == "bull_call_ladder":
        return [("call", C(0.50), 1), ("call", C(0.35), -1), ("call", C(0.20), -1)]
    if sid == "long_call_butterfly":
        otm = C(0.25)
        dist = otm - S
        return [("call", S - dist, 1), ("call", S, -2), ("call", otm, 1)]
    if sid == "long_put_butterfly":
        otm = P(0.25)
        dist = S - otm
        return [("put", S + dist, 1), ("put", S, -2), ("put", otm, 1)]
    if sid in ("qp_crash_straddle", "dh_short_straddle"):
        return [("put", S, -1), ("call", S, -1), ("put", 0.85 * S, 1)]
    raise KeyError(sid)


def leg_fill(pricer, side, S, K, iv, dte, on, qty, scen):
    mid, spr = pricer.mid(side, S, K, iv, dte, on, scen)
    return mid, spr, H.fill(mid, spr, qty)


def price_legs(pricer, t, d, e, S, Se, sid, legs, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r, path):
    """Same fill and expiry intrinsic as S076 price_trade, with this file's capital."""
    out = {"t": t, "d": d, "e": e, "s": sid, "ivrv": iv_atm / rv20, "up50": S > ma50, "spy_up": spy_up, "q": q,
           "legs": [(sd, K, qty) for sd, K, qty in legs]}
    dollar = {}
    credit_base = 0.0
    for scen in H.SCEN:
        credit = 0.0
        for side, K, qty in legs:
            iv = ivp if side == "put" else ivc
            _m, _s, px = leg_fill(pricer, side, S, K, iv, dte, d, qty, scen)
            credit += -qty * px
        pay = sum(qty * (max(Se - K, 0.0) if side == "call" else max(K - Se, 0.0)) for side, K, qty in legs)
        pnl = credit + pay
        cap = capital(sid, S, legs, credit)
        days = (e - d).days
        out[scen] = pnl / cap - r * days / 365
        dollar[scen] = pnl
        if scen == "base":
            credit_base = credit
            out.update(pnl=pnl / cap, cap=cap, capS=cap / S, credit=credit, days=days)
    out["ps"] = dollar["base"] / S
    out["fit"] = out["ivrv"] >= 1.15 and (q is None or q >= 4)
    out["_dollar"] = dollar
    out["_credit"] = credit_base
    return out


def price_crash(pricer, t, d, e, S, Se, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r):
    """5% of spot in ATM-straddle credit, plus one 15% OTM put per straddle. Excess vs holding shares."""
    legs_s = [("put", S, -1), ("call", S, -1)]
    hedge = ("put", 0.85 * S, 1)
    out = {"t": t, "d": d, "e": e, "s": "qp_crash_straddle", "ivrv": iv_atm / rv20, "up50": S > ma50,
           "spy_up": spy_up, "q": q, "days": (e - d).days}
    sized = {}
    for scen in H.SCEN:
        credit_s = 0.0
        for side, K, qty in legs_s:
            iv = ivp if side == "put" else ivc
            _m, _s, px = leg_fill(pricer, side, S, K, iv, dte, d, qty, scen)
            credit_s += px
        if credit_s <= 0.05:
            return None
        n = 0.05 * S / credit_s
        _m, _s, hp = leg_fill(pricer, hedge[0], S, hedge[1], ivp, dte, d, 1, scen)
        unit = credit_s - hp
        unit += -max(Se - S, 0.0) - max(S - Se, 0.0) + max(hedge[1] - Se, 0.0)
        pnl = n * unit
        out[scen] = pnl / S
        sized[scen] = (n, credit_s, hp, pnl)
    n, credit_s, hp, pnl = sized["base"]
    out.update(pnl=pnl / S, cap=S, capS=1.0, credit=n * (credit_s - hp), ps=pnl / S, n=n,
               fit=out["ivrv"] >= 1.15 and (q is None or q >= 4),
               legs=[("put", S, -n), ("call", S, -n), ("put", 0.85 * S, n)])
    return out


def price_hedged(pricer, t, d, e, S, Se, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r, path):
    """Short ATM straddle, daily delta flat, T-bill on the stock hedge. Capital = S076 short-straddle margin."""
    K = S
    out = {"t": t, "d": d, "e": e, "s": "dh_short_straddle", "ivrv": iv_atm / rv20, "up50": S > ma50,
           "spy_up": spy_up, "q": q, "days": (e - d).days, "legs": [("put", K, -1), ("call", K, -1)]}
    shares0 = put_delta(S, K, ivp, dte / 365) + call_delta(S, K, ivc, dte / 365)
    hp, fin = _hedge_path(S, K, ivp, ivc, e, d, path, r, shares0)
    for scen in H.SCEN:
        credit = 0.0
        for side, iv in (("put", ivp), ("call", ivc)):
            _m, _s, px = leg_fill(pricer, side, S, K, iv, dte, d, -1, scen)
            credit += px
        intrinsic = max(Se - K, 0.0) + max(K - Se, 0.0)
        pnl = credit - intrinsic + hp + fin
        cap = 0.2 * S + max(credit, 0.0)
        out[scen] = pnl / cap - r * (e - d).days / 365
        if scen == "base":
            out.update(pnl=pnl / cap, cap=cap, capS=cap / S, credit=credit, ps=pnl / S, hedge=hp, fin=fin)
    out["fit"] = out["ivrv"] >= 1.15 and (q is None or q >= 4)
    return out


def _hedge_path(S0, K, ivp0, ivc0, e, d, path, r, shares0):
    hp = fin = 0.0
    prev_S, prev_sh, prev_d = S0, shares0, d
    for day, S, ivp, ivc in path:
        ivp = ivp or ivp0
        ivc = ivc or ivc0
        dt = (day - prev_d).days
        hp += prev_sh * (S - prev_S)
        fin += -prev_sh * prev_S * r * dt / 365
        T = (e - day).days / 365
        prev_sh = put_delta(S, K, ivp, T) + call_delta(S, K, ivc, T)
        prev_S, prev_d = S, day
    return hp, fin


def run(conn, only):
    bars, rep, tb = H.load(conn, only)
    print(f"load {len(bars)} names", flush=True)
    pricer = H.Pricer(conn)
    print("pricer ready", flush=True)
    edgeq = H.edge_quintiles(conn)
    print(f"put_edge rows {len(edgeq)}", flush=True)
    tbd = [d for d, _ in tb]
    spy = bars.get("SPY") or [(d, c, None, None) for d, c in conn.execute(
        "SELECT date, close::float FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date")]
    spy_d = [r[0] for r in spy]
    trades, audit = [], []
    n_names = 0
    for t, rows in bars.items():
        if t in ("QQQ", "IWM") or len(rows) < 80:
            continue
        if only and t not in only:
            continue
        n_names += 1
        if n_names % 40 == 0:
            print(f"  {n_names} {t} trades {len(trades)}", flush=True)
        logc = [math.log(r[1]) for r in rows]
        rd = rep.get(t, [])
        for i, (d, S, ivp, ivc) in enumerate(rows):
            if d < H.START or d.weekday() != 0 or not ivp or not ivc or i < 60:
                continue
            rets = [logc[k] - logc[k - 1] for k in range(i - 19, i + 1)]
            rv20 = statistics.pstdev(rets) * math.sqrt(252)
            if rv20 <= 0:
                continue
            ma50 = sum(r[1] for r in rows[i - 49:i + 1]) / 50
            si = bisect_right(spy_d, d) - 1
            spy_up = si >= 200 and spy[si][1] > sum(r[1] for r in spy[si - 199:si + 1]) / 200
            r_tb = tb[bisect_right(tbd, d) - 1][1] if tbd and d >= tbd[0] else 0.0
            q = edgeq.get((t, d))
            iv_atm = (ivp + ivc) / 2
            for horizon, sids in ((11, sorted(WEEKLY)), (32, sorted(MONTHLY))):
                j = H.expiry_index(rows, i, horizon)
                if j is None:
                    continue
                e, Se = rows[j][0], rows[j][1]
                if any(d < x <= e for x in rd):
                    continue
                dte = (e - d).days
                path = rows[i + 1:j + 1]
                for sid in sids:
                    if sid == "qp_crash_straddle":
                        tr = price_crash(pricer, t, d, e, S, Se, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r_tb)
                    elif sid == "dh_short_straddle":
                        tr = price_hedged(pricer, t, d, e, S, Se, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r_tb, path)
                    else:
                        legs = legs_gap(sid, S, ivp, ivc, dte)
                        if any(K <= 0 for _sd, K, _q in legs):
                            continue
                        tr = price_legs(pricer, t, d, e, S, Se, sid, legs, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r_tb, path)
                    if tr:
                        trades.append(tr)
                        if t == "MU" and sid == "naked_call" and d >= date(2024, 6, 3) and not audit:
                            audit.append(_audit_naked(pricer, t, d, e, S, Se, ivc, dte, tr))
            # CSP comparators, same earnings screen, both horizons
            for horizon, tag in ((11, "csp_w"), (32, "csp_m")):
                j = H.expiry_index(rows, i, horizon)
                if j is None:
                    continue
                e, Se = rows[j][0], rows[j][1]
                if any(d < x <= e for x in rd):
                    continue
                dte = (e - d).days
                legs = H.legs_for("csp", S, ivp, ivc, dte)
                tr = price_legs(pricer, t, d, e, S, Se, "csp", legs, dte, ivp, ivc, iv_atm, rv20, ma50, spy_up, q, r_tb, None)
                tr["s"] = tag
                trades.append(tr)
    return trades, audit


def _audit_naked(pricer, t, d, e, S, Se, ivc, dte, tr):
    K = tr["legs"][0][1]
    T = max(dte, 1) / 365
    model = H.bs_call(S, K, ivc, T)
    mid, spr = pricer.mid("call", S, K, ivc, dte, d, "base")
    px = H.fill(mid, spr, -1)
    intrinsic = max(Se - K, 0.0)
    dollar = px - intrinsic  # qty -1: credit is px, payoff is -intrinsic... wait credit = px for a sale
    # price_legs: credit += -qty * px with qty=-1 → credit = px; pay = -intrinsic; pnl = px - intrinsic
    return {"t": t, "d": d, "e": e, "S": S, "Se": Se, "ivc": ivc, "dte": dte, "K": K, "T": T,
            "model": model, "mid": mid, "spread": spr, "fill": px, "intrinsic": intrinsic,
            "dollar": px - intrinsic, "cap": tr["cap"], "excess": tr["base"], "ps": tr["ps"],
            "weekday": d.weekday(), "ratio": mid / model if model else None}


def block_t(xs, key="base", month=False):
    by = defaultdict(list)
    for x in xs:
        k = (x["d"].year, x["d"].month) if month else x["d"]
        by[k].append(x[key])
    ks = list(by)
    if len(ks) < 8:
        return float("nan")
    obs = statistics.mean([v for k in ks for v in by[k]])
    rng = random.Random(98)
    draws = []
    for _ in range(400):
        pick = [rng.choice(ks) for _ in ks]
        draws.append(statistics.mean([v for k in pick for v in by[k]]))
    sd = statistics.pstdev(draws)
    return obs / sd if sd else float("nan")


def summ(xs):
    if len(xs) < 30:
        return None
    v = [x["base"] for x in xs]
    return {"n": len(xs), "mean": statistics.mean(v), "tw": block_t(xs, "base", False),
            "tm": block_t(xs, "base", True),
            "ps": statistics.mean(x["ps"] for x in xs),
            "win": sum(x.get("pnl", 0) > 0 for x in xs) / len(xs),
            "worst5": sorted(v)[len(v) // 20],
            "rich": statistics.mean(x["rich"] for x in xs) if "rich" in xs[0] else float("nan"),
            "cheap": statistics.mean(x["cheap"] for x in xs) if "cheap" in xs[0] else float("nan"),
            "names": len({x["t"] for x in xs})}


def paired(xs, cmap):
    out = []
    for x in xs:
        c = cmap.get((x["t"], x["d"]))
        if not c:
            continue
        out.append({"t": x["t"], "d": x["d"], "base": x["ps"] - c["ps"], "ps": x["ps"] - c["ps"], "pnl": x["ps"] - c["ps"]})
    return out


def pct(x):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:+.2%}"


def tt(x):
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:+.1f}"


def judge(h, h1, h2, mq, mq1, mq2):
    if not h or not h1 or not h2:
        return "untested — thin holdout"
    halves = h1["mean"] > 0 and h2["mean"] > 0
    week_ok = h["tw"] >= 2 and halves and h["mean"] > 0
    month_ok = h["tm"] >= 2
    flip = not (h["rich"] > 0 and h["cheap"] > 0)
    marg_ok = mq and mq1 and mq2 and mq["tw"] >= 2 and mq1["mean"] > 0 and mq2["mean"] > 0
    if week_ok and month_ok and marg_ok and not flip:
        return "PASS"
    bits = []
    if not week_ok:
        bits.append("holdout week t or a half misses")
    elif not month_ok:
        bits.append("week t clears, month-block does not")
    if not marg_ok:
        bits.append("not marginal vs CSP inside put_edge Q5")
    if flip and h["mean"] > 0:
        bits.append("pricing sign flips")
    return "not a pass — " + "; ".join(bits)


def write_report(trades, audit, mid):
    panel = [x for x in trades if x["t"] != "SPY"]
    spy = [x for x in trades if x["t"] == "SPY"]
    by = defaultdict(list)
    for x in panel:
        by[x["s"]].append(x)
    hold = [x for x in panel if x["d"] >= HOLDOUT]
    hby = defaultdict(list)
    for x in hold:
        hby[x["s"]].append(x)
    csp = {"w": {(x["t"], x["d"]): x for x in hby["csp_w"]},
           "m": {(x["t"], x["d"]): x for x in hby["csp_m"]}}
    L = ["# S098 — volatility-premium structures missing from S076", "",
         "Harness: S076 pricer (BS at iv30 × S075 skew, fill = bid + 23% of the spread, T-bill, earnings before expiry out). "
         "Monday entries 2021-02→. Holdout 2023-01-01→. Week t = Monday-cluster bootstrap (400 draws, seed 98). "
         "Month t = the same on calendar months, because a 32-day hold entered every Monday overlaps. "
         f"Holdout Monday split {mid}. Comparator = 0.20Δ CSP, same horizon, pnl per $ of stock, inside put_edge Q5.",
         "",
         f"Panel trades {len(panel):,} ({len({x['t'] for x in panel})} names). Holdout {len(hold):,}. "
         f"SPY trades {len(spy):,} kept out of the panel t. "
         "Smoke set CAVA SHOP MU CRWV; TMO has no iv30 in daily_history (0 trades).",
         "",
         "## Mapping",
         "",
         "QC list: https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/option-strategies",
         "",
         "Already S076: bear call = call_spread, bull put = put_spread, bear put = bear_put_spread, bull call = bull_call_spread, "
         "long call calendar = calendar, covered call, short iron butterfly = iron_fly, short iron condor = iron_condor, "
         "naked put = csp, protective collar = collar, long/short straddle, long/short strangle.",
         "",
         "Tested here (pages below). Not tested: long iron condor/fly, short butterflies, long backspreads, protective put/call "
         "(long vol or long premium). Short call calendar — QC says it profits from a rise in the stock, and the long call calendar "
         "is already S076 (https://www.quantconnect.com/docs/v2/writing-algorithms/trading-and-orders/option-strategies/short-call-calendar-spread). "
         "Covered put = short stock + naked put (csp). Box, jelly roll, conversion = rates/parity. "
         "Bear call / bear put / bull put ladders: same low-vol ladder shape as bull call ladder; one ladder is tested, not four copies. "
         "VIX futures term structure is not an equity structure and this harness has no VIX futures "
         "(https://quantpedia.com/strategies/exploiting-term-structure-of-vix-futures/). "
         "Screener https://quantpedia.com/screener/?FilterKeywords=volatility+effect : #0020 is the variance-premium page (26%/yr matches); "
         "#0198 is the VIX-futures page (19.67% matches); #0007 and #0155 are stock-factor volatility, not option structures; "
         "#0237 (15.39%, monthly, equities, volatility premium) did not render a title; #0281 is commodities.",
         "",
         "Legs read from: long call butterfly, long put butterfly, naked call, short call backspread, short put backspread, "
         "bull call ladder, short call calendar (excluded), Quantpedia volatility-risk-premium-effect.",
         "",
         "## Holdout",
         "",
         "| structure | n | mean excess | week t | month t | half 1 | half 2 | rich / cheap | per $ stock | worst 5% | Q5 vs CSP per $ (n) | Q5 week t | Q5 halves | verdict |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    verdicts = {}
    for sid in ORDER:
        xs = [x for x in hby[sid]]
        h = summ(xs)
        h1 = summ([x for x in xs if x["d"] < mid])
        h2 = summ([x for x in xs if x["d"] >= mid])
        tag = "w" if sid in WEEKLY else "m"
        diffs = paired([x for x in xs if x.get("q") == 5], csp[tag])
        mq = summ(diffs)
        mq1 = summ([x for x in diffs if x["d"] < mid])
        mq2 = summ([x for x in diffs if x["d"] >= mid])
        v = judge(h, h1, h2, mq, mq1, mq2)
        verdicts[sid] = (v, h, mq)
        if not h:
            L.append(f"| {sid} | {len(xs)} | | | | | | | | | | | | {v} |")
            continue
        L.append(f"| {sid} | {h['n']} | {pct(h['mean'])} | {tt(h['tw'])} | {tt(h['tm'])} | "
                 f"{pct(h1['mean'] if h1 else None)} | {pct(h2['mean'] if h2 else None)} | "
                 f"{pct(h['rich'])} / {pct(h['cheap'])} | {pct(h['ps'])} | {pct(h['worst5'])} | "
                 f"{pct(mq['mean'] if mq else None)} n {mq['n'] if mq else 0} | {tt(mq['tw'] if mq else None)} | "
                 f"{pct(mq1['mean'] if mq1 else None)} / {pct(mq2['mean'] if mq2 else None)} | {v} |")
    L += ["", "CSP baseline on the same holdout Mondays (not a new structure; S076 already passed weekly CSP):", ""]
    for tag, label in (("csp_w", "csp weekly 0.20Δ"), ("csp_m", "csp monthly 0.20Δ")):
        h = summ(hby[tag])
        if h:
            L.append(f"- {label}: n {h['n']}, excess {pct(h['mean'])}, week t {tt(h['tw'])}, month t {tt(h['tm'])}, per $ stock {pct(h['ps'])}.")
    L += ["", "## Fit slice (pre-specified, not the bar)", "",
          "S076 short-premium screen: iv/rv ≥ 1.15 and put_edge Q4+. Descriptive only.", ""]
    for sid in ORDER:
        xs = [x for x in hby[sid] if x.get("fit")]
        h = summ(xs)
        if h:
            L.append(f"- {sid} fit: n {h['n']}, excess {pct(h['mean'])}, week t {tt(h['tw'])}, per $ stock {pct(h['ps'])}, rich/cheap {pct(h['rich'])} / {pct(h['cheap'])}.")
    if spy:
        L += ["", "## SPY (the Quantpedia page is an index trade; one name, out of the panel)", ""]
        sby = defaultdict(list)
        for x in spy:
            if x["d"] >= HOLDOUT:
                sby[x["s"]].append(x)
        for sid in ("qp_crash_straddle", "dh_short_straddle"):
            h = summ(sby[sid]) if len(sby[sid]) >= 30 else None
            if h:
                L.append(f"- SPY {sid}: n {h['n']}, excess {pct(h['mean'])}, month t {tt(h['tm'])}, per $ stock {pct(h['ps'])}.")
            else:
                L.append(f"- SPY {sid}: n {len(sby[sid])}.")
    if audit:
        a = audit[0]
        L += ["", "## Hand-check", "",
              f"MU naked call {a['d']} (weekday {a['weekday']}) → expiry {a['e']}, {a['dte']} days. "
              f"S {a['S']:.4f}, Se {a['Se']:.4f}, ivc {a['ivc']:.6f}, K {a['K']:.4f}.",
              f"BS call {a['model']:.6f} (bs_put + S − K). Pricer mid {a['mid']:.6f}, ratio {a['ratio']:.4f}, "
              f"spread {a['spread']:.4f}, sell fill {a['fill']:.6f}. Intrinsic {a['intrinsic']:.4f}.",
              f"Dollar pnl {a['dollar']:.6f}, cap {a['cap']:.4f}, excess {a['excess']:+.4%}, per $ stock {a['ps']:+.4%}.",
              "Independent check: model gap vs bs_call is 0 in-process (same function). Recompute mid/fill outside this script from S, K, ivc, dte.",
              ""]
    L += ["## Known weaknesses", "",
          "- Continuous strikes at flat-IV delta. QC butterflies and the ladder are built from listed strikes; deltas 0.25 / 0.50 / 0.35 / 0.20 are the translation.",
          "- Call skew is the one-day Schwab ladder (S075), stressed ±10%. Put ratios are the previous month.",
          "- No early assignment. Delta hedge is daily close, zero rates, no borrow fee. Hedge IV is that day's iv30.",
          "- Crash-straddle 5% rule resizes with the scenario fill. The published 1.94%/month is total portfolio return, not this overlay.",
          "- put_edge quintiles need ≥ 30 names that week. A missing quintile is not Q5.",
          "- Single-name panel is not the SPX the papers used. SPY is reported separately when the bars exist.",
          "- Bull call ladder width is much wider than QC's $2.50 example, so it does not collapse into a naked call.",
          ""]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    print(f"wrote {OUT}", flush=True)
    return verdicts


def main():
    only = next((set(a.split("=", 1)[1].split(",")) for a in sys.argv if a.startswith("--tickers=")), None)
    conn = H.connect()
    trades, audit = run(conn, only)
    mondays = sorted({x["d"] for x in trades if x["d"] >= HOLDOUT and x["t"] != "SPY" and x["s"] in ORDER})
    mid = mondays[len(mondays) // 2] if mondays else HOLDOUT
    print(f"trades {len(trades)} holdout split {mid}", flush=True)
    if only:
        seen = defaultdict(int)
        for x in trades:
            if x["s"].startswith("csp"):
                continue
            if seen[x["s"]] >= 3:
                continue
            seen[x["s"]] += 1
            print(f"{x['t']} {x['d']} {x['s']:<24} excess {x['base']:+.2%} ps {x['ps']:+.2%} "
                  f"credit {x['credit']:.3f} cap {x['cap']:.2f} q {x.get('q')} fit {x['fit']}", flush=True)
        if audit:
            a = audit[0]
            print("HAND", {k: (round(v, 6) if isinstance(v, float) else v) for k, v in a.items()}, flush=True)
            # second path, not via price_legs
            recon = H.bs_put(a["S"], a["K"], a["ivc"], a["T"]) + a["S"] - a["K"]
            print(f"HAND recon bs_call {recon:.8f} gap {recon - a['model']:.2e}", flush=True)
        by_t = defaultdict(int)
        for x in trades:
            by_t[x["t"]] += 1
        print("rows", dict(by_t), flush=True)
        return
    write_report(trades, audit, mid)


if __name__ == "__main__":
    main()
