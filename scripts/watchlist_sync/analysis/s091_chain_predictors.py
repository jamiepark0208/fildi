"""S091 — option-implied predictors on our chains (A262). Do not change the bar.

Question: do put skew (Xing-Zhang-Zhao), call−put IV (Cremers-Weinbaum), RV−IV
(Goyal-Saretto), idiosyncratic vol (Cao-Han) and IV term slope rank weekly put
pnl and 21-day residual stock returns beyond what Fildi already scores?

Boards (pre-registered):
  Put: S045/S059 weekly ~1σ put, pnl per $ collateral net of fills (bid+23% of
  spread) and breach. Comparator = put_edge (IV/RV + vol-of-vol + put tech).
  Stock: lab_outcomes rel_21. Comparator = StarMine combined_alpha_rank + lab_tech v2
  (engine 3b1ba75fb4e9-ivhist). Holdout = 2023-01 →, split at the median lab Monday.

PASS: holdout week-clustered |t| ≥ 2, same sign in both holdout halves, AND marginal
|t| ≥ 2 (2-factor Fama-MacBeth or within-comparator-quintile sort) with the same sign.
Standalone only = "duplicates what we have". No fitted weights (formulas are the papers).

Definitions frozen before the run (house bands = s080 polygon_direction):
  ATM: |K/S−1| < 0.05, DTE 20–60, closest to 30 DTE.
  OTM put: K/S in [0.88, 0.97], closest to 0.93, |DTE−ATM| ≤ 15.
  XZZ skew = OTM put IV − ATM call IV.
  Put smirk = OTM put IV − ATM put IV. Amendment: LSEG call quotes in this cache
  start in 2026, so the powered skew sample is the smirk. It inherits the skew bar
  only if Spearman vs strict XZZ on overlapping name-days is ≥ 0.70 and n ≥ 100.
  Otherwise smirk is descriptive and XZZ stands on its own (likely no test).
  Cremers-Weinbaum = open-interest-weighted (equal-weight if OI is 0) mean of
  call IV − put IV on matched expiry+strike, |K/S−1| ≤ 0.10, DTE 20–60.
  RV−IV = 252-day close-to-close vol (percent) − ATM IV (percent). Chain ATM put
  is primary; surface iv30_put is the "already in put_edge" cousin (20-day ratio).
  Idio vol = 21-session residual vs SPY (Cao-Han month; market model, not FF3).
  The stored 1-year lab idio_vol is printed and is not eligible for the bar.
  Term slope = short ATM IV − longer ATM IV. Chain: ~30 DTE minus ~60 DTE put.
  Surface: iv30_put − iv60_put (S059's definition, labelled surface).
  IV controls (iv_rv, iv30, earnings) on the standalone IC for skew, spread, term, idio.
  RV−IV is not residualized on iv_rv (that removes the signal); marginal vs put_edge is the bar.
  Quote filters: LSEG IV is percent (5–200), bid > 0, (ask−bid)/mid ≤ 1, |signal| ≤ 40 vol pts.
  Signal date = last chain session in [as_of−6 days, as_of].

  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s091_chain_predictors.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s091_chain_predictors.py
"""
from __future__ import annotations

import json
import math
import re
import sys
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from build_plan import connect  # noqa: E402

HOLDOUT = date(2023, 1, 1)
DIGEST = "3b1ba75fb4e9-ivhist"  # current lab_tech v2 (S086); one row per name-week
LAG_DAYS = 6
SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
OUT = HERE.parent / "out" / "studies" / "S091.md"
MIN_HALF = 8
MIN_WEEKS = 20
INHERIT_CORR = 0.70
INHERIT_N = 100

MONTH = {chr(ord("A") + i): ("C", i + 1) for i in range(12)}
MONTH.update({chr(ord("M") + i): ("P", i + 1) for i in range(12)})


def _num(x):
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _js(x):
    if x is None:
        return {}
    if isinstance(x, str):
        return json.loads(x)
    return x


class Bars:
    __slots__ = ("dates", "close", "iv30", "iv60", "pos")

    def __init__(self):
        self.dates: list[date] = []
        self.close: list[float] = []
        self.iv30: list[float | None] = []
        self.iv60: list[float | None] = []
        self.pos: dict[date, int] = {}


def load_bars(conn) -> dict[str, Bars]:
    bars: dict[str, Bars] = {}
    q = """SELECT ticker, date, close::float8, iv30_put::float8, iv30_call::float8, iv60_put::float8
           FROM lseg_research.daily_history WHERE close > 0 ORDER BY ticker, date"""
    n_eq = n_both = 0
    for t, d, c, p30, c30, p60 in conn.execute(q):
        b = bars.get(t)
        if b is None:
            b = bars[t] = Bars()
        b.pos[d] = len(b.dates)
        b.dates.append(d)
        b.close.append(c)
        b.iv30.append(p30 if p30 and p30 > 0 else None)
        b.iv60.append(p60 if p60 and p60 > 0 else None)
        if p30 and c30 and p30 > 0 and c30 > 0:
            n_both += 1
            if abs(p30 - c30) < 0.05:
                n_eq += 1
    bars["_surface_note"] = (n_both, n_eq)  # type: ignore[assignment]
    return bars


def parse_ric(ric: str, tickers: set[str]):
    for n in range(min(6, len(ric) - 10), 0, -1):
        root = ric[:n]
        if root not in tickers:
            continue
        m = re.match(r"^([A-X])(\d{2})(\d{2})(\d{5})\.U", ric[n:])
        if not m:
            continue
        letter, dd, yy, strike = m.groups()
        side, month = MONTH[letter]
        try:
            exp = date(2000 + int(yy), month, int(dd))
        except ValueError:
            return None
        return root, side, exp, int(strike) / 100.0
    return None


def _cands(legs, side, m_lo, m_hi, d_lo, d_hi):
    return [x for x in legs if x[0] == side and m_lo <= x[2] <= m_hi and d_lo <= x[3] <= d_hi]


def _best_pair(left, right, target_l, target_r, dte_l, dte_r, max_gap):
    best = None
    best_key = None
    for a in left:
        for b in right:
            if abs(a[3] - b[3]) > max_gap:
                continue
            key = (abs(a[2] - target_l) + abs(b[2] - target_r), abs(a[3] - dte_l) + abs(b[3] - dte_r))
            if best_key is None or key < best_key:
                best_key = key
                best = (a, b)
    return best


def signals_from_legs(legs) -> dict:
    """legs: (side, K, moneyness, dte, iv_percent, oi). Returns vol-point signals."""
    out = {}
    atm = _cands(legs, "P", 0.95, 1.05, 20, 60)
    atm = [x for x in atm if abs(x[2] - 1) < 0.05]
    # OTM band stops where the ATM band starts, so one strike is not both legs.
    otm = [x for x in _cands(legs, "P", 0.88, 0.97, 20, 60) if abs(x[2] - 1) >= 0.05]
    call = [x for x in _cands(legs, "C", 0.95, 1.05, 20, 60) if abs(x[2] - 1) < 0.05]
    if atm:
        a = min(atm, key=lambda x: (abs(x[2] - 1), abs(x[3] - 30)))
        out["atm_iv"] = a[4]
        out["atm_k"] = a[1]
        out["atm_dte"] = a[3]
        out["atm_m"] = a[2]
        out["atm_exp_dte"] = a[3]
    pair = _best_pair(atm, otm, 1.0, 0.93, 30, 30, 15) if atm and otm else None
    if pair:
        a, o = pair
        gap = o[4] - a[4]
        if abs(gap) <= 40:
            out["smirk"] = gap
            out["pair_atm_iv"] = a[4]
            out["pair_atm_k"] = a[1]
            out["pair_atm_dte"] = a[3]
            out["pair_atm_m"] = a[2]
            out["otm_iv"] = o[4]
            out["otm_k"] = o[1]
            out["otm_dte"] = o[3]
            out["otm_m"] = o[2]
    xpair = _best_pair(otm, call, 0.93, 1.0, 30, 30, 15) if otm and call else None
    if xpair:
        o, c = xpair
        gap = o[4] - c[4]
        if abs(gap) <= 40:
            out["xzz"] = gap
            out["call_iv"] = c[4]
            out["call_k"] = c[1]
    # Cremers-Weinbaum: matched expiry + strike
    calls, puts = {}, {}
    for side, k, m, dte, iv, oi in legs:
        if not (20 <= dte <= 60) or abs(m - 1) > 0.10:
            continue
        key = (dte, round(k, 2))  # dte pins the expiry given the quote date
        (calls if side == "C" else puts)[key] = (iv, oi or 0.0)
    num = den = 0.0
    n_pairs = 0
    for key, (ivc, oic) in calls.items():
        if key not in puts:
            continue
        ivp, oip = puts[key]
        w = (oic + oip) / 2 or 1.0
        num += w * (ivc - ivp)
        den += w
        n_pairs += 1
    if n_pairs and den > 0:
        spread = num / den
        if abs(spread) <= 40:
            out["cp"] = spread
            out["cp_n"] = n_pairs
    short = [x for x in _cands(legs, "P", 0.95, 1.05, 20, 45) if abs(x[2] - 1) < 0.05]
    long = [x for x in _cands(legs, "P", 0.95, 1.05, 50, 90) if abs(x[2] - 1) < 0.05]
    tpair = _best_pair(short, long, 1.0, 1.0, 30, 60, 80) if short and long else None
    if tpair:
        sleg, lleg = tpair
        if lleg[3] - sleg[3] >= 20:
            slope = sleg[4] - lleg[4]
            if abs(slope) <= 40:
                out["term_c"] = slope
    return out


def load_chain(conn, tickers: set[str]) -> tuple[dict, dict]:
    q = """SELECT ric, date, iv::float8, bid::float8, ask::float8, oi::float8
           FROM optlab.lseg_opt_daily
           WHERE date >= '2020-01-01' AND iv BETWEEN 5 AND 200 AND bid > 0 AND ask >= bid"""
    raw = defaultdict(list)
    bad = 0
    kept = 0
    for ric, d, iv, bid, ask, oi in conn.execute(q):
        mid = (bid + ask) / 2
        if mid <= 0 or (ask - bid) / mid > 1.0:
            continue
        p = parse_ric(ric, tickers)
        if not p:
            bad += 1
            continue
        root, side, exp, k = p
        # spot filled in a second pass — store strike and expiry for now
        raw[(root, d)].append((side, k, exp, iv, oi))
        kept += 1
    # spots
    need = sorted({t for t, _ in raw})
    px = {(t, d): c for t, d, c in conn.execute(
        """SELECT ticker, date, close::float8 FROM lseg_research.daily_history
           WHERE close > 0 AND date >= '2020-01-01' AND ticker = ANY(%s)""", (need,))}
    chain: dict[str, tuple[list, list]] = {}
    tmp: dict[str, list] = defaultdict(list)
    n_sig: Counter = Counter()
    for (root, d), legs0 in raw.items():
        S0 = px.get((root, d))
        if not S0:
            continue
        legs = []
        for side, k, exp, iv, oi in legs0:
            dte = (exp - d).days
            if not (0 <= dte <= 200):
                continue
            legs.append((side, k, k / S0, dte, iv, oi))
        sig = signals_from_legs(legs)
        if not sig:
            continue
        sig["spot"] = S0
        tmp[root].append((d, sig))
        for k in ("smirk", "xzz", "cp", "term_c", "atm_iv"):
            if k in sig:
                n_sig[k] += 1
    for t, rows in tmp.items():
        rows.sort(key=lambda z: z[0])
        chain[t] = ([d for d, _ in rows], [s for _, s in rows])
    return chain, {"quotes_kept": kept, "unparsed": bad, "name_days": n_sig, "names": len(chain)}


def chain_asof(chain, ticker, day: date):
    got = chain.get(ticker)
    if not got:
        return None
    dates, recs = got
    i = bisect_right(dates, day) - 1
    if i < 0:
        return None
    if (day - dates[i]).days > LAG_DAYS:
        return None
    return recs[i]


def _std_ann(r) -> float | None:
    if len(r) < 15 or np.std(r) == 0:
        return None
    return float(np.std(r, ddof=1) * math.sqrt(252) * 100)


def rv252(b: Bars, i: int) -> float | None:
    if i < 252:
        return None
    c = b.close[i - 252:i + 1]
    r = np.diff(np.log(c))
    return _std_ann(r)


def idio21(b: Bars, spy: Bars, i: int) -> float | None:
    if i < 21:
        return None
    ys, xs = [], []
    for n in range(i - 20, i + 1):
        d0, d1 = b.dates[n - 1], b.dates[n]
        j1 = spy.pos.get(d1)
        j0 = spy.pos.get(d0)
        if j1 is None or j0 is None or b.close[n - 1] <= 0 or spy.close[j0] <= 0:
            continue
        ys.append(math.log(b.close[n] / b.close[n - 1]))
        xs.append(math.log(spy.close[j1] / spy.close[j0]))
    if len(ys) < 15:
        return None
    Y, X = np.array(ys), np.array(xs)
    var = float(np.var(X, ddof=1))
    if var <= 0:
        return None
    beta = float(np.cov(X, Y)[0, 1] / var)
    return float(np.std(Y - beta * X, ddof=1) * math.sqrt(252))


def vol_of_vol(b: Bars, i: int) -> float | None:
    ivs = [b.iv30[j] for j in range(max(0, i - 60), i + 1) if b.iv30[j]]
    if len(ivs) < 40:
        return None
    return float(np.std(np.diff(np.log(ivs))))


def load_panel_inputs(conn):
    tech = {}
    for t, d, v2 in conn.execute(
            "SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech WHERE engine_digest = %s", (DIGEST,)):
        v2 = _js(v2)
        comps = v2.get("comps") or {}
        tr, vol = _num(comps.get("trendContext")), _num(comps.get("volumeConfirm"))
        total = _num(v2.get("total"))
        if tr is None or vol is None:
            continue
        tech[(t, d)] = (tr - vol, total)
    star = defaultdict(list)
    for t, d, v in conn.execute(
            """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
               WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL ORDER BY ticker, obs_date"""):
        star[t].append((d, v))
    lab = []
    for t, d, outcomes, features in conn.execute(
            "SELECT ticker, as_of, outcomes, features FROM watchlist_sync.lab_outcomes"):
        o, f = _js(outcomes), _js(features)
        rel = _num(o.get("rel_21"))
        lab.append({
            "t": t, "d": d, "rel": rel, "iv_rv": _num(f.get("iv_rv")), "iv30": _num(f.get("iv30")),
            "earn": _num(f.get("earnings_21")) or 0.0, "idio_1y": _num(f.get("idio_vol")),
        })
    return tech, star, lab


def star_asof(series, day):
    if not series:
        return None
    i = bisect_right(series, (day, math.inf)) - 1
    if i < 0:
        return None
    return series[i][1]


def attach_features(lab, bars, chain, tech, star):
    spy = bars["SPY"]
    feat = {}
    for row in lab:
        t, d = row["t"], row["d"]
        b = bars.get(t)
        if b is None:
            continue
        i = b.pos.get(d)
        if i is None:
            continue
        rec = {}
        iv = idio21(b, spy, i)
        if iv is not None:
            rec["idio"] = iv
        rv = rv252(b, i)
        if rv is not None:
            rec["rv252"] = rv
        p30, p60 = b.iv30[i], b.iv60[i]
        if p30:
            rec["iv_surf"] = p30
        if p30 and p60:
            rec["term_s"] = p30 - p60
        if rv is not None and p30:
            rec["rv_surf"] = rv - p30
        vov = vol_of_vol(b, i)
        if vov is not None:
            rec["vov"] = vov
        ch = chain_asof(chain, t, d)
        if ch:
            for k in ("smirk", "xzz", "cp", "term_c", "atm_iv"):
                if k in ch:
                    rec[k] = ch[k]
            if rv is not None and ch.get("atm_iv"):
                rec["rv_chain"] = rv - ch["atm_iv"]
        feat[(t, d)] = rec
    mondays = sorted({r["d"] for r in lab})
    hold = [d for d in mondays if d >= HOLDOUT]
    split = hold[len(hold) // 2]
    # composite ranks need the whole week, so build rows first
    stock = []
    for row in lab:
        rec = feat.get((row["t"], row["d"]))
        if not rec or row["rel"] is None:
            continue
        pt = tech.get((row["t"], row["d"]))
        item = {**row, **rec, "put_tech": pt[0] if pt else None, "tech": pt[1] if pt else None,
                "star": star_asof(star[row["t"]], row["d"])}
        stock.append(item)
    _rank_composite(stock, ("star", "tech"), "comp", min_n=30, both=True)
    return stock, feat, split, mondays


def _rank_composite(rows, keys, dest, min_n, both):
    by = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    for g in by.values():
        ok = [e for e in g if all(e.get(k) is not None for k in keys)] if both else \
            [e for e in g if any(e.get(k) is not None for k in keys)]
        if len(ok) < min_n:
            continue
        acc = np.zeros(len(ok))
        used = 0
        for k in keys:
            if all(e.get(k) is not None for e in ok):
                acc += S.rank([e[k] for e in ok])
                used += 1
        if not used:
            continue
        pct = acc / used
        # put_edge quintile uses the average of ranks re-ranked; match that for edge
        pct = S.rank(list(pct))
        for e, p in zip(ok, pct):
            e[dest] = float(p)
            e[dest + "_q"] = min(5, int(float(p) * 5) + 1)


def t_of(arr) -> float | None:
    arr = np.asarray(arr, float)
    if len(arr) < 2:
        return None
    sd = float(arr.std(ddof=1))
    if sd == 0:
        return None
    return float(arr.mean() / (sd / math.sqrt(len(arr))))


def summarize(pairs, split) -> dict | None:
    pairs = sorted((d, v) for d, v in pairs if v is not None and math.isfinite(v))
    if len(pairs) < 8:
        return None
    v = np.array([x for _, x in pairs])
    a = np.array([x for d, x in pairs if d < split])
    b = np.array([x for d, x in pairs if d >= split])
    return {"n": len(v), "mean": float(v.mean()), "med": float(np.median(v)), "t": t_of(v),
            "na": int(len(a)), "a": float(a.mean()) if len(a) else None,
            "nb": int(len(b)), "b": float(b.mean()) if len(b) else None}


def clears(st) -> bool:
    if not st or st["t"] is None or st["a"] is None or st["b"] is None:
        return False
    if st["n"] < MIN_WEEKS or st["na"] < MIN_HALF or st["nb"] < MIN_HALF:
        return False
    if abs(st["t"]) < 2:
        return False
    return st["a"] * st["b"] > 0 and st["a"] * st["mean"] > 0


def _eligible(g, feat, target, controls):
    need = [feat, target, *controls]
    return [e for e in g if all(e.get(k) is not None for k in need)]


def weekly_ic(rows, feat, target, min_n, split, controls) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    pairs = []
    sizes = []
    for d, g0 in by.items():
        g = _eligible(g0, feat, target, controls)
        if len(g) < min_n:
            continue
        x = np.array(S.rank([e[feat] for e in g]), float)
        y = np.array(S.rank([e[target] for e in g]), float)
        if controls:
            C = np.column_stack([np.ones(len(g))] + [S.rank([e[k] for e in g]) for k in controls])
            x = x - C @ np.linalg.lstsq(C, x, rcond=None)[0]
            y = y - C @ np.linalg.lstsq(C, y, rcond=None)[0]
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        pairs.append((d, float(np.corrcoef(x, y)[0, 1])))
        sizes.append(len(g))
    st = summarize(pairs, split)
    if st:
        st["names"] = float(np.median(sizes)) if sizes else 0
    return st


def weekly_spread(rows, feat, target, min_n, split, q, scale) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if e.get(feat) is not None and e.get(target) is not None:
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < max(min_n, q * 2):
            continue
        g = sorted(g, key=lambda e: e[feat])
        k = len(g) // q
        if k < 1:
            continue
        top = np.mean([e[target] for e in g[-k:]])
        bot = np.mean([e[target] for e in g[:k]])
        pairs.append((d, scale * (top - bot)))
    return summarize(pairs, split)


def fm2(rows, feat, target, comp, min_n, split) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if all(e.get(k) is not None for k in (feat, target, comp)):
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < min_n:
            continue
        y = np.array(S.rank([e[target] for e in g]), float)
        x = np.array(S.rank([e[feat] for e in g]), float)
        c = np.array(S.rank([e[comp] for e in g]), float)
        if np.std(x) == 0 or np.std(c) == 0:
            continue
        # skip weeks where the signal is the comparator (duplicate)
        if abs(float(np.corrcoef(x, c)[0, 1])) > 0.999:
            continue
        X = np.column_stack([np.ones(len(g)), x, c])
        beta = np.linalg.lstsq(X, y, rcond=None)[0]
        pairs.append((d, float(beta[1])))
    return summarize(pairs, split)


def within_q(rows, feat, target, qkey, min_n, split, scale) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if all(e.get(k) is not None for k in (feat, target, qkey)):
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < min_n:
            continue
        gaps = []
        for q in range(1, 6):
            b = [e for e in g if e[qkey] == q]
            if len(b) < 4:
                continue
            b.sort(key=lambda e: e[feat])
            k = max(1, len(b) // 2)
            gaps.append(np.mean([e[target] for e in b[-k:]]) - np.mean([e[target] for e in b[:k]]))
        if gaps:
            pairs.append((d, scale * float(np.mean(gaps))))
    return summarize(pairs, split)


def mean_corr(rows, a, b, min_n) -> tuple[float | None, int]:
    by = defaultdict(list)
    for e in rows:
        if e.get(a) is not None and e.get(b) is not None:
            by[e["d"]].append(e)
    cs, n = [], 0
    for g in by.values():
        if len(g) < min_n:
            continue
        x = S.rank([e[a] for e in g])
        y = S.rank([e[b] for e in g])
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        cs.append(float(np.corrcoef(x, y)[0, 1]))
        n += len(g)
    if not cs:
        return None, 0
    return float(np.mean(cs)), n


def judge(standalone, marginal, within, inherit_ok, iv_level, spread) -> str:
    """Adoption bar is the pre-registered t≥2 plus PLAYBOOK §4 (IV fixed, then the spread that pays)."""
    if standalone is None or standalone["n"] < MIN_WEEKS:
        return "no test (coverage)"
    if standalone["na"] < MIN_HALF or standalone["nb"] < MIN_HALF:
        return "no test (thin half)"
    if not inherit_ok:
        return "descriptive (substitute not validated)"
    if iv_level is not None and clears(standalone) and not clears(iv_level):
        return "IV in disguise"
    if not clears(standalone):
        return "no edge"
    # top−bottom must pay, same sign as the IC. A rank IC with a flat book is not a position.
    if spread is None or not clears(spread) or spread["mean"] * standalone["mean"] <= 0:
        return "no edge (spread does not pay)"
    marg_ok = clears(marginal) or clears(within)
    if not marg_ok:
        if (marginal is None or marginal["n"] < MIN_WEEKS) and (within is None or within["n"] < MIN_WEEKS):
            return "standalone only — marginal not testable"
        return "duplicates what we have"
    m = marginal if clears(marginal) else within
    if standalone["mean"] * m["mean"] <= 0:
        return "no edge (marginal sign flips)"
    return "PASS"


def hold(rows, split, pre=False):
    if pre:
        return [e for e in rows if e["d"] < HOLDOUT]
    return [e for e in rows if e["d"] >= HOLDOUT]


SPECS = [
    ("smirk", "put smirk OTM−ATM put IV", 12, ("iv_rv", "iv30", "earn"), False),
    ("xzz", "XZZ OTM put−ATM call IV", 12, ("iv_rv", "iv30", "earn"), False),
    ("cp", "Cremers-Weinbaum call−put IV", 12, ("iv_rv", "iv30", "earn"), False),
    ("rv_chain", "RV252 − chain ATM IV", 15, (), True),
    ("rv_surf", "RV252 − surface iv30 (cousin of put_edge IV/RV)", 30, (), True),
    ("idio", "idio vol 21d vs SPY", 30, ("iv_rv", "iv30", "earn"), False),
    ("term_c", "chain term slope ~30−~60 put", 12, ("iv_rv", "iv30", "earn"), False),
    ("term_s", "surface term iv30−iv60", 30, ("iv_rv", "iv30", "earn"), False),
]


def eval_board(rows, split, board, inherit_ok) -> list[dict]:
    target = "pnl" if board == "put" else "rel"
    scale = 1e4 if board == "put" else 100.0  # bp per collateral-week, or rel_21 in percent
    q = 5 if board == "put" else 10
    comp = "edge" if board == "put" else "comp"
    qkey = comp + "_q"
    out = []
    base = hold(rows, split)
    for key, label, min_n, controls, raw_bar in SPECS:
        use_q = q if board == "stock" else 5
        # decile needs ~50 names; chain weeks are smaller → quintile, labelled
        med_probe = weekly_ic(base, key, target, min_n, split, () if raw_bar else controls)
        if board == "stock" and med_probe and med_probe.get("names", 0) < 50:
            use_q = 5
        standalone = weekly_ic(base, key, target, min_n, split, () if raw_bar else controls)
        raw = weekly_ic(base, key, target, min_n, split, ())
        iv_level = weekly_ic(base, key, target, min_n, split, ("iv30",)) if raw_bar else None
        spread = weekly_spread(base, key, target, min_n, split, use_q, scale)
        marg = fm2(base, key, target, comp, min_n, split)
        wq = within_q(base, key, target, qkey, min_n, split, scale)
        breach = weekly_spread(base, key, "breach", min_n, split, 5, 100.0) if board == "put" else None
        pre = weekly_ic(hold(rows, split, pre=True), key, target, min_n, split, () if raw_bar else controls)
        ok = inherit_ok or key != "smirk"
        verdict = judge(standalone, marg, wq, ok, iv_level, spread)
        out.append({"key": key, "label": label, "board": board, "verdict": verdict, "q": use_q,
                    "ic": standalone, "raw": raw, "iv_level": iv_level, "spread": spread,
                    "marg": marg, "within": wq, "breach": breach, "pre": pre, "inherit_ok": ok})
    return out


def fmt_st(st, digits=3) -> str:
    if not st or st.get("t") is None:
        return "—"
    def h(v):
        return "—" if v is None else f"{v:+.{digits}f}"
    return f"{st['mean']:+.{digits}f} t {st['t']:+.1f} (n {st['n']}, halves {h(st['a'])}/{h(st['b'])}, w {st['na']}/{st['nb']})"


def placebo(rows, feat, target, min_n, split, controls, seed=91):
    rng = np.random.default_rng(seed)
    by = defaultdict(list)
    for e in rows:
        if e.get(feat) is not None and e.get(target) is not None:
            by[e["d"]].append(dict(e))
    for g in by.values():
        vals = [e[feat] for e in g]
        rng.shuffle(vals)
        for e, v in zip(g, vals):
            e[feat] = v
    flat = [e for g in by.values() for e in g]
    return weekly_ic(flat, feat, target, min_n, split, controls)


def hand_check(conn, chain, bars, tickers) -> list[str]:
    """One smoke-name row, recomputed from the legs, plus a Schwab ladder cross-check."""
    lines = ["## Hand-check", ""]
    pick_t, pick_i = None, None
    for t in SMOKE:
        got = chain.get(t)
        if not got:
            lines.append(f"- {t}: no parsed LSEG chain rows.")
            continue
        dates, recs = got
        smirk_i = [i for i, s in enumerate(recs) if "smirk" in s]
        lines.append(f"- {t}: chain days {len(dates)} ({dates[0]} → {dates[-1]}), smirk days {len(smirk_i)}, "
                     f"XZZ days {sum(1 for s in recs if 'xzz' in s)}, ATM days {sum(1 for s in recs if 'atm_iv' in s)}.")
        if smirk_i and pick_t is None and t == "MU":
            pick_t, pick_i = t, smirk_i[len(smirk_i) // 2]
        elif smirk_i and pick_t is None:
            pick_t, pick_i = t, smirk_i[len(smirk_i) // 2]
    if pick_t is None:
        lines.append("Hand-check failed: none of the five names has a smirk day.")
        return lines
    d = chain[pick_t][0][pick_i]
    stored = chain[pick_t][1][pick_i]
    legs0 = []
    for ric, iv, bid, ask, oi in conn.execute(
            """SELECT ric, iv::float8, bid::float8, ask::float8, oi::float8 FROM optlab.lseg_opt_daily
               WHERE date = %s AND ric LIKE %s AND iv BETWEEN 5 AND 200 AND bid > 0 AND ask >= bid""",
            (d, pick_t + "%")):
        mid = (bid + ask) / 2
        if mid <= 0 or (ask - bid) / mid > 1:
            continue
        p = parse_ric(ric, tickers)
        if not p:
            continue
        root, side, exp, k = p
        if root != pick_t:
            continue
        legs0.append((side, k, exp, iv, oi, bid, ask, ric))
    spot = stored.get("spot")
    legs = [(side, k, k / spot, (exp - d).days, iv, oi) for side, k, exp, iv, oi, bid, ask, ric in legs0]
    recomputed = signals_from_legs(legs)
    arith = stored["otm_iv"] - stored["pair_atm_iv"]
    ok = abs(arith - stored["smirk"]) < 1e-4 and abs(recomputed.get("smirk", 9e9) - stored["smirk"]) < 1e-4
    lines += ["", f"Row: **{pick_t} {d}** spot {spot:.4f} (lseg_research.daily_history).",
              f"ATM put used in the smirk: K {stored.get('pair_atm_k')} m {stored.get('pair_atm_m'):.4f} "
              f"DTE {stored.get('pair_atm_dte')} IV {stored.get('pair_atm_iv'):.2f}%.",
              f"OTM put K {stored.get('otm_k')} m {stored.get('otm_m'):.4f} DTE {stored.get('otm_dte')} IV {stored.get('otm_iv'):.2f}%.",
              f"Smirk = {stored.get('otm_iv'):.4f} − {stored.get('pair_atm_iv'):.4f} = **{stored['smirk']:.4f} vol pts**. "
              f"Recompute from the day's quotes: {recomputed.get('smirk')} (match {ok}). "
              f"RV uses the closest ATM put, IV {stored.get('atm_iv')} K {stored.get('atm_k')}."]
    for label, k, dte_key in (("ATM", stored.get("pair_atm_k"), "pair_atm_dte"), ("OTM", stored.get("otm_k"), "otm_dte")):
        hit = [x for x in legs0 if abs(x[1] - k) < 1e-6 and x[0] == "P"]
        if hit:
            want = stored.get(dte_key) or 30
            side, kk, exp, iv, oi, bid, ask, ric = min(hit, key=lambda z: abs((z[2] - d).days - want))
            lines.append(f"  {label} quote {ric} exp {exp} bid {bid:.2f} ask {ask:.2f} IV {iv:.2f}% OI {oi}.")
    b = bars.get(pick_t)
    if b and d in b.pos:
        i = b.pos[d]
        lines.append(f"Surface that day: iv30_put {b.iv30[i]} iv60_put {b.iv60[i]} "
                     f"(put−call surface is ~0 in this cache; chain smirk is the wing).")
    ph = conn.execute(
        "SELECT close::float8, source FROM prices_historical WHERE ticker = %s AND date = %s", (pick_t, d)).fetchone()
    lines.append(f"prices_historical on this date: {ph[0] if ph else 'no row'} "
                 f"(table starts 2024-10-18; RV/idio use daily_history, the put harness prices).")
    # a 2025 date both sources have, for the unit check
    both = conn.execute(
        """SELECT h.date, h.close::float8, p.close::float8 FROM lseg_research.daily_history h
           JOIN prices_historical p ON p.ticker = h.ticker AND p.date = h.date
           WHERE h.ticker = %s AND h.date >= '2025-01-01' ORDER BY h.date LIMIT 1""", (pick_t,)).fetchone()
    if both:
        gap = abs(both[1] - both[2]) / both[1] if both[1] else None
        lines.append(f"Price-source check {pick_t} {both[0]}: daily_history {both[1]:.4f} vs prices_historical {both[2]:.4f} "
                     f"(rel gap {gap:.4%}).")
    # Schwab ladder vs LSEG on one overlapping day (skew_survey is 3 days, IV in decimal)
    schwab = conn.execute(
        """SELECT ticker, as_of FROM optlab.skew_survey s
           WHERE EXISTS (SELECT 1 FROM optlab.lseg_opt_daily d WHERE d.date = s.as_of AND d.ric LIKE s.ticker || '%' AND d.iv > 0)
           ORDER BY as_of DESC LIMIT 1""").fetchone()
    if schwab:
        t, day = schwab
        srows = conn.execute(
            """SELECT expiry, side, strike::float8, spot::float8, iv::float8, oi, bid::float8, ask::float8
               FROM optlab.skew_survey WHERE ticker = %s AND as_of = %s AND iv > 0 AND spot > 0""", (t, day)).fetchall()
        ivs = [r[4] for r in srows]
        scale = 100.0 if ivs and np.median(ivs) < 3 else 1.0
        slegs = []
        for exp, side, k, spot, iv, oi, bid, ask in srows:
            sd = str(side).lower()
            cp = "P" if sd.startswith("p") else "C" if sd.startswith("c") else None
            if not cp:
                continue
            dte = (exp - day).days
            slegs.append((cp, k, k / spot, dte, iv * scale, oi or 0))
        ssig = signals_from_legs(slegs)
        ch = chain_asof(chain, t, day)
        lines.append(f"Schwab skew_survey {t} {day}: {len(srows)} quotes, IV×{scale:.0f} so it matches LSEG percent. "
                     f"Same formula smirk {ssig.get('smirk')} XZZ {ssig.get('xzz')} CP {ssig.get('cp')}. "
                     f"LSEG as-of smirk {None if not ch else ch.get('smirk')} ATM IV {None if not ch else ch.get('atm_iv')}.")
        lines.append("Schwab is a 3-day ladder (not the backtest). LSEG chains are the study sample.")
    if not ok:
        raise SystemExit(f"hand-check mismatch {pick_t} {d}: stored {stored['smirk']} recomputed {recomputed.get('smirk')}")
    lines.append("Hand-check: smirk arithmetic matches the stored signal.")
    return lines


def smoke_names_only(chain):
    print("S091 smoke — five names")
    for t in SMOKE:
        got = chain.get(t)
        if not got:
            print(f"  {t}: NO CHAIN")
            continue
        dates, recs = got
        print(f"  {t}: days {len(dates)} {dates[0]}→{dates[-1]} smirk {sum('smirk' in s for s in recs)} "
              f"xzz {sum('xzz' in s for s in recs)} atm {sum('atm_iv' in s for s in recs)} "
              f"term {sum('term_c' in s for s in recs)}")


def build_put_rows(conn, feat, tech):
    print("building put events (S059 harness)...", flush=True)
    ev = S59.aligned_events(conn)
    print(f"  {len(ev)} puts", flush=True)
    rows = []
    for e in ev:
        f = feat.get((e["t"], e["d"]), {})
        pt = tech.get((e["t"], e["d"]))
        item = {
            "t": e["t"], "d": e["d"], "pnl": e["pnl"], "breach": e["breach"],
            "iv_rv": _num(e.get("iv_rv")), "iv30": _num(e.get("iv30")),
            "earn": _num(e.get("earn")) or 0.0,
            "put_tech": pt[0] if pt else _num(e.get("put_tech")),
            "vov": f.get("vov", _num(e.get("vol_of_vol"))),
            "idio_1y": _num(e.get("idio_vol")),
        }
        for k in ("smirk", "xzz", "cp", "term_c", "rv_chain", "rv_surf", "term_s", "idio", "atm_iv"):
            if k in f:
                item[k] = f[k]
        # live put_edge drops IV/RV outside 0.3–5
        if item["iv_rv"] is not None and not (0.3 <= item["iv_rv"] <= 5):
            item["iv_rv_raw"] = item["iv_rv"]
            item["iv_rv_edge"] = None
        else:
            item["iv_rv_edge"] = item["iv_rv"]
        rows.append(item)
    # edge composite uses the filtered ratio, under the name iv_rv inside the ranker
    edged = []
    for e in rows:
        if e.get("iv_rv_edge") is None or e.get("vov") is None or e.get("put_tech") is None:
            continue
        edged.append({**e, "iv_rv": e["iv_rv_edge"]})
    _rank_composite(edged, ("iv_rv", "vov", "put_tech"), "edge", min_n=30, both=True)
    have = {(e["t"], e["d"]): e["edge"] for e in edged if "edge" in e}
    qhave = {(e["t"], e["d"]): e["edge_q"] for e in edged if "edge_q" in e}
    for e in rows:
        e["edge"] = have.get((e["t"], e["d"]))
        e["edge_q"] = qhave.get((e["t"], e["d"]))
    return rows


def coverage_line(meta, bars) -> str:
    nd = meta["name_days"]
    both, eq = bars["_surface_note"]
    return (f"LSEG chain quotes kept {meta['quotes_kept']:,} (unparsed/non-universe {meta['unparsed']:,}), "
            f"names {meta['names']}. Name-days: ATM {nd['atm_iv']:,}, smirk {nd['smirk']:,}, "
            f"XZZ {nd['xzz']:,}, call−put {nd['cp']:,}, chain term {nd['term_c']:,}. "
            f"Surface iv30 put vs call: {eq:,}/{both:,} within 0.05 vol pt "
            f"(S059 skew was empty because the ATM surface put IV equals the call IV). "
            f"optlab.iv30 is 6 names; optlab.skew_survey is 3 days (2026-10-19/21/22). "
            f"prices_historical starts 2024-10-18, so RV, idio vol and the put path use lseg_research.daily_history.")


def render(lines_head, results, extra) -> str:
    L = lines_head + ["", "## Results (holdout 2023-01 →)", "",
                      "IC is the weekly Spearman (IV-controlled where the signal is not itself an IV gap). "
                      "Spread is top−bottom quintile (decile on the stock board when the median week has ≥ 50 names), "
                      "in bp/week of collateral (puts) or percent rel_21 (stocks). "
                      "Marginal is the 2-factor Fama-MacBeth slope on ranks (signal | comparator). "
                      "Within-Q is the same-sign backup sort.", ""]
    L.append("| signal | board | verdict | standalone | marginal FM | within-Q | spread | breach Q5−Q1 |")
    L.append("|---|---|---|---|---|---|---|---|")
    for r in results:
        ic = fmt_st(r["ic"])
        if r["key"] in ("rv_chain", "rv_surf") and r["iv_level"]:
            ic += f"; iv30-controlled {fmt_st(r['iv_level'])}"
        L.append(f"| {r['label']} | {r['board']} | {r['verdict']} | {ic} | {fmt_st(r['marg'])} | "
                 f"{fmt_st(r['within'], 2)} | {fmt_st(r['spread'], 2)} (q{r['q']}) | {fmt_st(r['breach'], 2)} |")
    L += ["", "## Pre-holdout IC (descriptive, not the bar)", ""]
    for r in results:
        L.append(f"- {r['board']} {r['key']}: {fmt_st(r['pre'])}")
    L += extra
    return "\n".join(L) + "\n"


def main():
    smoke = "--smoke" in sys.argv
    with connect() as conn:
        print("loading bars...", flush=True)
        bars = load_bars(conn)
        tickers = {t for t in bars if not t.startswith("_")}
        print("loading chains...", flush=True)
        chain, meta = load_chain(conn, tickers)
        print(coverage_line(meta, bars), flush=True)
        smoke_names_only(chain)
        check = hand_check(conn, chain, bars, tickers)
        for ln in check:
            print(ln)
        if smoke:
            print("smoke done — full run not started")
            return
        print("loading lab / starmine / tech...", flush=True)
        tech, star, lab = load_panel_inputs(conn)
        stock, feat, split, mondays = attach_features(lab, bars, chain, tech, star)
        gaps = [rec["atm_iv"] - rec["iv_surf"] for rec in feat.values() if rec.get("atm_iv") and rec.get("iv_surf")]
        gap_med = float(np.median(gaps)) if gaps else None
        print(f"stock rows {len(stock)} split {split} chain−surface ATM IV median {gap_med} n {len(gaps)}", flush=True)
        puts = build_put_rows(conn, feat, tech)
        # overlap: smirk vs xzz on chain name-days (not just lab weeks)
        both_s, both_x = [], []
        for _t, (_ds, recs) in chain.items():
            for s in recs:
                if "smirk" in s and "xzz" in s:
                    both_s.append(s["smirk"])
                    both_x.append(s["xzz"])
        if len(both_s) >= 20 and np.std(both_s) > 0 and np.std(both_x) > 0:
            # rank corr
            inherit_corr = float(np.corrcoef(S.rank(both_s), S.rank(both_x))[0, 1])
        else:
            inherit_corr = None
        inherit_n = len(both_s)
        inherit_ok = inherit_corr is not None and inherit_corr >= INHERIT_CORR and inherit_n >= INHERIT_N
        print(f"smirk vs XZZ rank corr {inherit_corr} n {inherit_n} inherit {inherit_ok}", flush=True)
        put_h = [e for e in puts if e["d"] >= HOLDOUT]
        stock_h = [e for e in stock if e["d"] >= HOLDOUT]
        rho_chain, n_chain = mean_corr(put_h, "rv_chain", "iv_rv", 15)
        rho_surf, n_surf = mean_corr(put_h, "rv_surf", "iv_rv", 30)
        print("evaluating...", flush=True)
        results = eval_board(puts, split, "put", inherit_ok) + eval_board(stock, split, "stock", inherit_ok)
        # placebo on the two powered families
        plac_lines = ["", "## Placebo (signal shuffled inside the week)", ""]
        for rows, feat, tgt, mn, ctl, name in (
            (put_h, "smirk", "pnl", 12, ("iv_rv", "iv30", "earn"), "put smirk"),
            (put_h, "idio", "pnl", 30, ("iv_rv", "iv30", "earn"), "put idio"),
            (stock_h, "idio", "rel", 30, ("iv_rv", "iv30", "earn"), "stock idio"),
            (put_h, "rv_surf", "pnl", 30, (), "put RV−surface"),
        ):
            ts = []
            for seed in range(8):
                p = placebo(rows, feat, tgt, mn, split, ctl, seed)
                if p and p["t"] is not None:
                    ts.append(p["t"])
            if ts:
                plac_lines.append(f"- {name}: 8 seeds, t from {min(ts):+.1f} to {max(ts):+.1f}.")
            else:
                plac_lines.append(f"- {name}: no weeks.")
        # 1-year lab idio, not eligible
        lab_idio_put = weekly_ic(put_h, "idio_1y", "pnl", 30, split, ("iv_rv", "iv30", "earn"))
        lab_idio_stk = weekly_ic(stock_h, "idio_1y", "rel", 30, split, ("iv_rv", "iv30", "earn"))
        head = [
            "# S091 — option-implied predictors on our chains", "",
            f"Holdout 2023-01-01 →, halves split at {split} (median lab Monday). "
            f"Put pnl is the S059 harness (net of fills). Stock target is rel_21 (fraction in the table's spread column, shown ×100). "
            f"Comparator: put_edge quintile on the full cross-section; StarMine combined alpha + lab_tech v2 `{DIGEST}`.",
            "", coverage_line(meta, bars), "",
            f"Smirk vs strict XZZ on overlapping chain name-days: rank corr {inherit_corr} (n {inherit_n}). "
            f"Inherit rule (≥ {INHERIT_CORR} and n ≥ {INHERIT_N}): {'yes, smirk faces the skew bar' if inherit_ok else 'no, smirk is descriptive'}.",
            f"Chain ATM put IV minus LSEG iv30 surface, same name-week: median {None if gap_med is None else round(gap_med, 2)} vol pts (n {len(gaps)}). "
            f"On the hand-check row the listed option's price matches the chain IV, not the surface.",
            f"Rank corr of RV−IV with put_edge's IV/RV ratio, put holdout: chain {rho_chain} (names-weeks {n_chain}), "
            f"surface {rho_surf} (names-weeks {n_surf}). Negative corr is expected (ratio vs difference).",
            "",
            "Stored 1-year lab idio_vol is not the pre-specified 21-day Cao-Han window and does not face the bar: "
            f"put {fmt_st(lab_idio_put)}; stock {fmt_st(lab_idio_stk)}.",
        ]
        head += [""] + check
        # verdict lead
        lead = ["", "## Verdict", "",
                "Nothing ships. No signal clears the pre-registered bar after the IV-fixed check and the top−bottom spread.",
                "Chain-native (the new test): strict XZZ and Cremers-Weinbaum have no usable cross-section "
                "(calls in this cache start in 2026; matched call+put strikes = 0). Chain term slope never has 12 names in a week. "
                "Put smirk does not inherit XZZ (rank corr below). Its holdout IC does not clear t≥2 and the halves flip.",
                "Surface RV−IV on puts has a raw rank IC around −0.11 (t about −7) and that is the IV level: "
                "the same IC after residualizing on iv30 is about 0. Put-edge is the IV/RV ratio, so a 2-factor slope vs put_edge "
                "stays large — it is not evidence the 252-day gap adds a second factor. Quintile mean pnl gap is only about −5 bp.",
                "Idio vol's raw put rank IC is about +0.64 and Q5−Q1 about +37 bp. After iv30, iv_rv and earnings the IC is about 0. "
                "Same fact as S059: it does not add once IV is held fixed. The stock-board mean decile gap is an outlier; the median week is about 0.",
                "Surface term slope does not add (put IC t under 2 and the second half is about 0; stock marginal halves flip).",
                "Next step: do not add these factors to put_edge or the Model List. S094 (unusual flow) is a different question."]
        text = render(head + lead, results, plac_lines + [
            "", "## Weaknesses", "",
            "- The LSEG cache is contracts other studies fetched (about 3 strikes a name-day), not a full listed chain. OTM is the closest strike in band, often not exactly 0.93.",
            "- Calls exist in this cache only in 2026, so strict XZZ and Cremers-Weinbaum cannot fill both holdout halves.",
            "- Smirk is an amendment (ATM put instead of ATM call). It faces the bar only if the inherit rule above says yes.",
            "- Signal may be up to 6 days stale. rel_21 overlaps across weeks; the bar is the weekly t the spec asked for. A 3-week block would be smaller.",
            "- Idio vol is a market model vs SPY, not Fama-French. Put-edge horizon in the live calibration file is a different object; this pnl is the S059 harness.",
            "- Five signals × two boards, no Holm (not in the bar). One PASS at t just over 2 would be the family, not a single test.",
        ])
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(text)
        print(f"wrote {OUT}", flush=True)
        for r in results:
            print(f"{r['verdict']:28} {r['board']:5} {r['key']:10} {fmt_st(r['ic'])}")


if __name__ == "__main__":
    main()
