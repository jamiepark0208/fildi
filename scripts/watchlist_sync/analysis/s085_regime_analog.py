#!/usr/bin/env python3
"""S085 — regime-analog conditioned composite: top-20 long calls / top-20 long puts for TODAY (A244).

Pre-registered in research/studies/INDEX.md (row S085) and committed BEFORE this script was run.
Supersedes S084 (stopped mid-run); the panel/target/alphalens scaffolding is reused, the question is new.

Authority: Jamie 10-22. Build the list on Fildi's OWN scores, point-in-time, and judge it only on weeks whose macro
state looks like today's. No sector cap ("why cap") — sector and beta exposure are reported instead.

WHAT CHANGED vs S080/S081/S083 (all FAIL): those ranked each name against its own history or against the whole
2021-26 sample. Here the evaluation sample is the ~15 % of weeks since 2020-02 that resemble today's macro state,
and the ranking is cross-sectional within each week (memory: cross-sectional-not-own-history).

READ-ONLY DATA INVENTORY FIRST (calibration log 10-22: probe before claiming, plan after the inventory).
What exists, point-in-time, and is therefore IN the backtest:
  - `watchlist_sync.lab_tech`  2020-02-03 → 2026-10-05 weekly, 252 names, 393 weeks. **Must be filtered to one
    engine_digest**: the table holds 2-3 rows per (ticker, as_of) and an unfiltered read silently double-counts
    (194,329 rows for 87,530 ticker-weeks). `71470d4af750-ivhist` is the only digest covering the whole panel and is
    the IV-point-in-time variant (v2 differs from the plain digest by 2.08 points on average; v4_call is identical).
  - `watchlist_sync.lab_outcomes` same grid — `outcomes.rel_21` (21-session forward return minus the peer-group
    median that date, `analysis/lab_outcomes.py:8`) is the TARGET; `features` is trailing-only and is used as the
    independent cross-check on the price factors recomputed here.
  - `watchlist_sync.lab_fund.features` — IBES estimate fields only (sue, drift, drift_3m, disp, breadth, numest).
  - `lseg_research.daily_history` 2016-09 → 2026-10-21, 273 tickers, close + iv30 — the price/IV factors and the
    macro state are recomputed here so the backtest and today's list run through identical code.
  - `research_common.security_class.gics_sector` — sector for 241 of the 252 panel names (`ticker_registry.sector`
    is only 61/872 and is NOT the sector source).
NOT in the backtest, forward-only, because they have no history (each probed, not assumed):
  - `public.option_score_snapshots` starts 2026-09-30 (16 as_of) → Fildi option score is live-only.
  - `public.fair_value_snapshots` starts 2026-10-06 (17 as_of) → fair-value gap is live-only.
  - `public.fund_score_snapshots` starts 2026-10-05 / `ticker_fundamentals.fund_*` is a current snapshot with no
    history (`ticker_fundamentals_history` holds 1 row) → fund_* scores are live-only.
  These three are shown as columns in today's table (they are real information today) and are NEVER in the
  composite, because a factor that cannot be measured on the analog weeks cannot be weighted by analog-week IC.
  - **10-year yield: no stored series in any schema** (probed `information_schema` for yield/dgs/tnx/treasury/fred —
    nothing). The ask said "if a stored series exists"; it does not, so the macro state is 6 variables, not 7.
  - `public.market_breadth_daily` holds 20 rows (2024-10 → 2026-10) → breadth is recomputed from the panel, as the
    ask requires.

METHOD
 1. Macro state per week, from data at or before that week: SPY vs its 200-day, SPY 20-day and 60-day return,
    SPY IV30 level and its 4-week change, and breadth (% of panel names above their own 200-day). Standardised over
    the whole history; analogs = the ANALOG_FRAC nearest weeks to today by Euclidean distance in that space, with
    the last EXCLUDE_RECENT weeks excluded (their rel_21 is unformed or overlaps today).
 2. Factors, all point-in-time: lab_tech v2 / v4_call / v4_put totals and their components, the lab_fund IBES
    family, and IV/RV20, IV rank (252d), 52-week-high proximity, 12-1 momentum, 5-day reversal from the price panel.
 3. Per factor: Spearman IC against rel_21 within each week, on analog weeks and on all weeks; month-block t; Holm
    across factors. A factor enters the composite only if its analog-week |t| >= IC_T_MIN AND its analog IC has the
    same sign as its all-weeks IC (so an analog-only fluke cannot enter).
 4. Composite = mean of sign-weighted cross-sectional z-scores of the selected factors. Selection is done
    **leave-one-analog-cluster-out**: the composite that scores an analog week is fitted only on the other analog
    clusters, so the evaluation weeks are never also the selection weeks.
 5. Backtest on analog weeks only, out of sample: top-TOPN composite → long call, bottom-TOPN → long put, priced in
    the S081 engine (Black-Scholes at iv30_side x the S075 skew ratio, entry fill = bid + 23 % of the spread,
    excess over T-bill), held to expiry, plus the S080 barrier variant (+100 % / -50 % / 21 DTE), real Polygon
    closes where the contract is cached, +-25 % call-cost stress, and the stock-only version of the same list.
 6. TODAY: rank every name, write the top-20 / bottom-20 table with sector, beta, the three driving factors, the
    analog-week hit rate of that composite decile, the real option cost and the break-even move.

Pre-registered bar (analog weeks, out-of-sample composite): long calls mean per $ debit > 0 AND month-block t >= 2
AND beats the unconditional long call on the same weeks AND the sign survives the rich +25 % call-cost stress; the
mirror for long puts. Stop rule: a side that fails is reported as FAIL and its table is marked not-tradeable; the
today-list is still printed (Jamie asked for the names) but carries the side's verdict on every row.

    cd scripts/watchlist_sync && .venv/bin/python analysis/s085_regime_analog.py [--smoke] [--tickers=A,B]
                                                                                [--max-names=N] [--no-backtest]
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
from scipy import stats as sps

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
import s080_long_options as S80  # noqa: E402
from s076_structures_backtest import Pricer, bs_call, bs_put, fill, strike_for  # noqa: E402

OUT = HERE.parent / "out" / "opt" / "S085.md"
TODAY_OUT = HERE.parent / "out" / "opt" / "S085_today.md"

DIGEST = "71470d4af750-ivhist"       # the only digest covering the whole panel; see the inventory above
START = date(2020, 2, 3)             # first lab_tech week
ANALOG_FRAC = 0.15
EXCLUDE_RECENT = 8                   # weeks
TOPN = 20
IC_T_MIN = 2.0
MIN_NAMES_WEEK = 40                  # a week needs this many ranked names to contribute an IC
MIN_FACTOR_COVER = 0.6               # a name needs this share of the selected factors to get a composite
N_CLUSTERS = 5                       # leave-one-analog-cluster-out folds
DELTA, DTE = 0.50, 45
TAKE, STOP, BARRIER_DTE = 1.00, -0.50, 21
BENCH = ("SPY", "QQQ", "IWM")

MACRO_VARS = ("spy_vs_200d", "spy_ret_20d", "spy_ret_60d", "spy_iv30", "spy_iv_chg_4w", "breadth_200d")

TECH_FIELDS = {
    "v2": ("tech_v2", ("trendContext", "oversoldDepth", "volumeConfirm", "reversalSignal", "volatilityState")),
    "v4_call": ("tech_v4call", ("relativePressure",)),
    "v4_put": ("tech_v4put", ("relativePressure",)),
}
IBES = ("ibes_sue", "ibes_drift", "ibes_drift_3m", "ibes_disp", "ibes_breadth", "ibes_numest")
PRICE_FACTORS = ("iv_rv20", "iv_rank252", "prox_52w", "mom_12_1", "rev_5d")


# ---------------------------------------------------------------- helpers

def zscore(vals):
    """Cross-sectional z, robust to a constant slice."""
    a = np.asarray(vals, float)
    ok = np.isfinite(a)
    if ok.sum() < 3:
        return np.full(a.shape, np.nan)
    mu, sd = a[ok].mean(), a[ok].std(ddof=1)
    if not sd or not np.isfinite(sd):
        return np.full(a.shape, np.nan)
    out = np.full(a.shape, np.nan)
    out[ok] = (a[ok] - mu) / sd
    return out


def month_block_t(series):
    """t of a weekly series with overlapping 21-session targets collapsed to monthly blocks."""
    by = defaultdict(list)
    for d, v in series:
        if v == v:
            by[(d.year, d.month)].append(v)
    m = [statistics.mean(v) for v in by.values()]
    n = len(m)
    if n < 3:
        return float("nan"), float("nan"), n
    sd = statistics.stdev(m)
    if not sd:
        return float("nan"), float("nan"), n
    t = statistics.mean(m) / (sd / math.sqrt(n))
    return t, float(2 * sps.t.sf(abs(t), n - 1)), n


def holm(pvals):
    items = sorted([(k, v) for k, v in pvals.items() if v == v], key=lambda x: x[1])
    m, out, run = len(items), {}, 0.0
    for i, (k, p) in enumerate(items):
        run = max(run, min(1.0, p * (m - i)))
        out[k] = run
    for k in pvals:
        out.setdefault(k, float("nan"))
    return out


def fmt_pct(v, dp=1):
    return "n/a" if v is None or v != v else f"{v:+.{dp}%}"


def fmt_num(v, dp=3):
    return "n/a" if v is None or v != v else f"{v:+.{dp}f}"


def fmt_plain(v, dp=2):
    """Unsigned number, 'n/a' for None/NaN — the table cells that are ratios, not changes."""
    return "n/a" if v is None or v != v else f"{v:.{dp}f}"


def fmt_rate(v, dp=0):
    return "n/a" if v is None or v != v else f"{v:.{dp}%}"


# ---------------------------------------------------------------- data

def load_prices(conn):
    """Daily bars per ticker: (date, close, iv30 mid, iv30 put, iv30 call), iv as a decimal (same normalisation as
    S080.load). Always the whole panel — breadth and the SPY state are market-wide and must not shrink with
    --max-names."""
    cur = defaultdict(list)
    q = ("SELECT ticker, date, close::float, iv30_put::float, iv30_call::float "
         "FROM lseg_research.daily_history WHERE close > 0 AND date >= '2017-01-01' ORDER BY ticker, date")
    for t, d, c, ivp, ivc in conn.execute(q):
        f = lambda x: None if x is None else (x / 100 if x > 3 else x)  # noqa: E731
        ivp, ivc = f(ivp), f(ivc)
        iv = ivp if ivc is None else (ivc if ivp is None else (ivp + ivc) / 2)
        cur[t].append((d, c, iv, ivp, ivc))
    return {t: r for t, r in cur.items() if len(r) >= 300}


def bar_index(rows, d):
    """Index of the last bar on or before d (the only bar a decision at d may see). None if there is none."""
    lo, hi = 0, len(rows) - 1
    if not rows or rows[0][0] > d:
        return None
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if rows[mid][0] <= d:
            lo = mid
        else:
            hi = mid - 1
    return lo


def price_factors(rows, i):
    """The five price/IV factors at bar i, from bars <= i only. Returns {} when the history is too short."""
    if i < 252:
        return {}
    c = np.array([r[1] for r in rows[: i + 1]], float)
    ivs = [r[2] for r in rows[: i + 1]]
    iv = ivs[i]
    lr = np.diff(np.log(c[-21:]))
    rv20 = lr.std(ddof=1) * math.sqrt(252) if len(lr) >= 20 else float("nan")
    hist = [v for v in ivs[-252:] if v is not None]
    f = {
        # A137 / S033: what the option costs vs how the stock actually moves.
        "iv_rv20": (iv / rv20) if (iv and rv20 and rv20 > 0) else float("nan"),
        "iv_rank252": (sum(1 for v in hist if v <= iv) / len(hist)) if (iv and len(hist) >= 100) else float("nan"),
        # distance below the 52-week high; 0 = at the high (so "more positive" = nearer the high).
        "prox_52w": float(c[-1] / c[-252:].max() - 1.0),
        "mom_12_1": float(c[-21] / c[-252] - 1.0),
        # signed so that "more positive" = more oversold over the last week (S025's reversal direction).
        "rev_5d": float(-(c[-1] / c[-6] - 1.0)),
    }
    return f


def macro_state(px, names, dates):
    """Weekly macro vector from data at or before each date. Breadth is recomputed from the panel because
    market_breadth_daily holds 20 rows."""
    spy = px.get("SPY")
    if not spy:
        raise SystemExit("SPY missing from lseg_research.daily_history")
    sc = np.array([r[1] for r in spy], float)
    siv = [r[2] for r in spy]
    # forward-fill SPY iv30 (coverage is ~80 % of bars; 2023 is the thin year)
    ff, last = [], None
    for v in siv:
        last = v if v is not None else last
        ff.append(last)
    closes = {t: np.array([r[1] for r in px[t]], float) for t in names if t in px}
    out = {}
    for d in dates:
        i = bar_index(spy, d)
        if i is None or i < 200:
            continue
        ma200 = sc[i - 199: i + 1].mean()
        iv, iv4 = ff[i], ff[i - 20] if i >= 20 else None
        above = tot = 0
        for t, c in closes.items():
            j = bar_index(px[t], d)
            if j is None or j < 200:
                continue
            tot += 1
            above += 1 if c[j] > c[j - 199: j + 1].mean() else 0
        out[d] = {
            "spy_vs_200d": float(sc[i] / ma200 - 1.0),
            "spy_ret_20d": float(sc[i] / sc[i - 20] - 1.0) if i >= 20 else float("nan"),
            "spy_ret_60d": float(sc[i] / sc[i - 60] - 1.0) if i >= 60 else float("nan"),
            "spy_iv30": iv if iv is not None else float("nan"),
            "spy_iv_chg_4w": (iv - iv4) if (iv is not None and iv4 is not None) else float("nan"),
            "breadth_200d": (above / tot) if tot >= 20 else float("nan"),
        }
    return out


def load_lab(conn, names):
    """Point-in-time weekly panel: lab_tech scores (one digest only), lab_fund IBES, lab_outcomes rel_21."""
    tech = defaultdict(dict)
    q = ("SELECT ticker, as_of, v2, v4_call, v4_put FROM watchlist_sync.lab_tech "
         "WHERE engine_digest = %s AND as_of >= %s")
    for t, a, v2, v4c, v4p in conn.execute(q, (DIGEST, START)):
        if t not in names:
            continue
        rec = {}
        for raw, (pref, comps) in zip((v2, v4c, v4p), TECH_FIELDS.values()):
            j = json.loads(raw) if isinstance(raw, str) else (raw or {})
            if j.get("total") is not None:
                rec[f"{pref}_total"] = float(j["total"])
            cj = j.get("comps") or {}
            for k in comps:
                if cj.get(k) is not None:
                    rec[f"{pref}_{k}"] = float(cj[k])
        if rec:
            tech[a][t] = rec

    fund = defaultdict(dict)
    for t, a, feats in conn.execute(
            "SELECT ticker, as_of, features FROM watchlist_sync.lab_fund WHERE as_of >= %s", (START,)):
        if t not in names:
            continue
        j = json.loads(feats) if isinstance(feats, str) else (feats or {})
        rec = {k: float(j[k]) for k in IBES if isinstance(j.get(k), (int, float))}
        if rec:
            fund[a][t] = rec

    tgt, lab_feat = defaultdict(dict), defaultdict(dict)
    for t, a, outc, feats in conn.execute(
            "SELECT ticker, as_of, outcomes, features FROM watchlist_sync.lab_outcomes WHERE as_of >= %s", (START,)):
        if t not in names:
            continue
        o = json.loads(outc) if isinstance(outc, str) else (outc or {})
        if isinstance(o.get("rel_21"), (int, float)):
            tgt[a][t] = float(o["rel_21"])
        fjs = json.loads(feats) if isinstance(feats, str) else (feats or {})
        lab_feat[a][t] = {k: v for k, v in fjs.items() if isinstance(v, (int, float))}
    return tech, fund, tgt, lab_feat


def sectors(conn):
    return {t: s for t, s in conn.execute(
        "SELECT ticker, gics_sector FROM research_common.security_class WHERE gics_sector IS NOT NULL")}


def build_panel(px, names, weeks, tech, fund):
    """{week: {ticker: {factor: value}}} — every value computed from data at or before the week."""
    panel = {}
    for d in weeks:
        row = {}
        tw, fw = tech.get(d, {}), fund.get(d, {})
        for t in names:
            if t not in px:
                continue
            i = bar_index(px[t], d)
            if i is None or (d - px[t][i][0]).days > 7:
                continue
            f = price_factors(px[t], i)
            if not f:
                continue
            f.update(tw.get(t, {}))
            f.update(fw.get(t, {}))
            f["_spot"] = px[t][i][1]
            f["_i"] = i
            row[t] = f
        if len(row) >= MIN_NAMES_WEEK:
            panel[d] = row
    return panel


def factor_names(panel):
    seen = set()
    for row in panel.values():
        for f in row.values():
            seen.update(k for k in f if not k.startswith("_"))
    return sorted(seen)


# ---------------------------------------------------------------- IC

def weekly_ic(panel, tgt, factor, weeks):
    """Spearman IC of one factor against rel_21, per week."""
    out = []
    for d in weeks:
        row, tg = panel.get(d, {}), tgt.get(d, {})
        xs = [(f[factor], tg[t]) for t, f in row.items()
              if factor in f and f[factor] == f[factor] and t in tg]
        if len(xs) < MIN_NAMES_WEEK:
            continue
        a, b = zip(*xs)
        if len(set(a)) < 5:
            continue
        r = sps.spearmanr(a, b).statistic
        if r == r:
            out.append((d, float(r)))
    return out


def select_factors(panel, tgt, facs, fit_weeks, all_weeks):
    """Pre-registered rule: analog-week |t| >= IC_T_MIN and the analog IC agrees in sign with the all-weeks IC."""
    sel = {}
    for f in facs:
        ic_a = weekly_ic(panel, tgt, f, fit_weeks)
        if len(ic_a) < 6:
            continue
        t, _, _ = month_block_t(ic_a)
        mu_a = statistics.mean(v for _, v in ic_a)
        ic_all = weekly_ic(panel, tgt, f, all_weeks)
        mu_all = statistics.mean(v for _, v in ic_all) if ic_all else float("nan")
        if t == t and abs(t) >= IC_T_MIN and mu_all == mu_all and np.sign(mu_a) == np.sign(mu_all):
            sel[f] = float(np.sign(mu_a))
    return sel


def composite(panel, week, sel):
    """Mean sign-weighted cross-sectional z over the selected factors."""
    row = panel.get(week, {})
    if not row or not sel:
        return {}
    tick = sorted(row)
    zs = {}
    for f, sgn in sel.items():
        vals = [row[t].get(f, float("nan")) for t in tick]
        zs[f] = sgn * zscore(vals)
    need = max(1, int(math.ceil(MIN_FACTOR_COVER * len(sel))))
    out = {}
    for k, t in enumerate(tick):
        vs = [zs[f][k] for f in sel if zs[f][k] == zs[f][k]]
        if len(vs) >= need:
            out[t] = float(np.mean(vs))
    return out


def clusters(weeks, k=N_CLUSTERS):
    """Time-ordered contiguous folds over the analog weeks — a calendar-adjacent analog week shares its tape, so a
    random fold would leak."""
    ws = sorted(weeks)
    if len(ws) < k:
        return [[w] for w in ws]
    size = math.ceil(len(ws) / k)
    return [ws[i: i + size] for i in range(0, len(ws), size)]


# ---------------------------------------------------------------- option pricing (S081 engine)

def price_long(pricer, rows, i, side, r_tb, scen="base"):
    """One 0.50Δ ~45 DTE long option bought at bar i. Returns hold-to-expiry and barrier outcomes per $ debit,
    excess over T-bill. None when the bar cannot support the trade."""
    d, S, iv = rows[i][0], rows[i][1], rows[i][3 if side == "put" else 4]
    if iv is None:
        iv = rows[i][2]
    if not iv or iv <= 0 or S <= 0:
        return None
    j = bar_index(rows, d + timedelta(days=DTE))
    if j is None or j <= i:
        return None
    days = (rows[j][0] - d).days
    if days < 25:
        return None
    K = strike_for(S, iv, days / 365, DELTA, side)
    mid, spread = pricer.mid(side, S, K, iv, days, d, scen)
    if mid < 0.05:
        return None
    debit = fill(mid, spread, 1)
    Se = rows[j][1]
    intrinsic = max(Se - K, 0.0) if side == "call" else max(K - Se, 0.0)
    rf = r_tb * days / 365
    expiry_ret = intrinsic / debit - 1.0 - rf

    # barrier variant: walk the daily path, first of +100 % / -50 % / 21 DTE left
    bar_ret = None
    for k in range(i + 1, j + 1):
        left = (rows[j][0] - rows[k][0]).days
        ivk = rows[k][3 if side == "put" else 4] or rows[k][2] or iv
        if left <= 0:
            val = intrinsic
        else:
            m, sp = pricer.mid(side, rows[k][1], K, ivk, left, rows[k][0], scen)
            val = fill(m, sp, -1)
        r = val / debit - 1.0
        if r >= TAKE or r <= STOP or left <= BARRIER_DTE:
            bar_ret = r - r_tb * (rows[k][0] - d).days / 365
            break
    if bar_ret is None:
        bar_ret = expiry_ret
    return {"d": d, "K": K, "debit": debit, "days": days, "spot": S, "exit_spot": Se,
            "expiry": expiry_ret, "barrier": bar_ret, "stock": (Se / S - 1.0) - rf}


def tbill_map(conn):
    tb = {}
    p = HERE.parent / "out" / "opt" / "dtb3.csv"
    if p.is_file():
        for line in p.read_text().splitlines()[1:]:
            dd, v = line.split(",")
            if v not in ("", "."):
                tb[date.fromisoformat(dd)] = float(v) / 100
    return sorted(tb.items())


def tbill_at(tb, d):
    if not tb:
        return 0.0
    lo, hi = 0, len(tb) - 1
    if tb[0][0] > d:
        return tb[0][1]
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if tb[mid][0] <= d:
            lo = mid
        else:
            hi = mid - 1
    return tb[lo][1]


def summarize(vals):
    v = sorted(x for x in vals if x == x)
    n = len(v)
    if n < 5:
        return None
    wins = [x for x in v if x > 0]
    loss = [x for x in v if x <= 0]
    return {"n": n, "mean": statistics.mean(v), "median": v[n // 2],
            "win": len(wins) / n,
            "payoff": (statistics.mean(wins) / abs(statistics.mean(loss))) if wins and loss else float("nan")}


def block_t(rows, key):
    """Month-block t over trades (the 45-day holds overlap)."""
    by = defaultdict(list)
    for x in rows:
        if x[key] == x[key]:
            by[(x["d"].year, x["d"].month)].append(x[key])
    m = [statistics.mean(v) for v in by.values()]
    if len(m) < 3 or statistics.stdev(m) == 0:
        return float("nan")
    return statistics.mean(m) / (statistics.stdev(m) / math.sqrt(len(m)))


# ---------------------------------------------------------------- today's option cost

def today_costs(conn, tickers):
    """Schwab 30-45 DTE near-ATM ask from option_chain_history (2026-10-08 →, the OTM band around current picks, so
    an ATM strike is present for some names only). Returns {(ticker, side): row}."""
    out = {}
    q = """WITH m AS (SELECT max(as_of) a FROM public.option_chain_history)
           SELECT o.ticker, o.side, o.strike::float, o.spot::float, o.bid::float, o.ask::float,
                  o.iv::float, o.delta::float, o.dte, o.expiry
           FROM public.option_chain_history o, m
           WHERE o.as_of = m.a AND o.dte BETWEEN 25 AND 50 AND o.ask > 0 AND o.spot > 0"""
    for t, side, K, S, bid, ask, iv, dl, dte, exp in conn.execute(q):
        if t not in tickers:
            continue
        key = (t, side)
        moneyness = abs(K / S - 1)
        prev = out.get(key)
        if prev is None or moneyness < prev["moneyness"]:
            out[key] = {"K": K, "spot": S, "bid": bid, "ask": ask, "iv": iv, "delta": dl,
                        "dte": dte, "expiry": exp, "moneyness": moneyness, "source": "schwab"}
    return out


def live_extras(conn, tickers):
    """Live-only Fildi scores — shown in today's table, never in the composite (no history to weight them on)."""
    fv, fund, opt = {}, {}, {}
    for t, p2f in conn.execute(
            "SELECT DISTINCT ON (ticker) ticker, price_to_fair::float FROM public.fair_value_snapshots "
            "WHERE price_to_fair IS NOT NULL ORDER BY ticker, as_of DESC"):
        fv[t] = p2f
    for t, tot in conn.execute(
            "SELECT DISTINCT ON (ticker) ticker, fund_total::float FROM public.fund_score_snapshots "
            "WHERE fund_total IS NOT NULL ORDER BY ticker, as_of DESC"):
        fund[t] = tot
    for t, side, sc in conn.execute(
            "SELECT DISTINCT ON (ticker, side) ticker, side, option_score::float FROM public.option_score_snapshots "
            "WHERE option_score IS NOT NULL ORDER BY ticker, side, as_of DESC"):
        opt[(t, side)] = sc
    return ({k: v for k, v in fv.items() if k in tickers},
            {k: v for k, v in fund.items() if k in tickers},
            {k: v for k, v in opt.items() if k[0] in tickers})


def beta_at(px, t, d, win=60):
    spy, rows = px.get("SPY"), px.get(t)
    if not spy or not rows:
        return float("nan")
    i, k = bar_index(rows, d), bar_index(spy, d)
    if i is None or k is None or i < win or k < win:
        return float("nan")
    a = np.diff(np.log([r[1] for r in rows[i - win: i + 1]]))
    b = np.diff(np.log([r[1] for r in spy[k - win: k + 1]]))
    n = min(len(a), len(b))
    if n < 20 or b[-n:].var() == 0:
        return float("nan")
    return float(np.cov(a[-n:], b[-n:], ddof=0)[0, 1] / b[-n:].var())


# ---------------------------------------------------------------- main

def main():
    global MIN_NAMES_WEEK
    args = sys.argv[1:]
    smoke = "--smoke" in args
    no_bt = "--no-backtest" in args
    only = next((set(a.split("=", 1)[1].upper().split(",")) for a in args if a.startswith("--tickers=")), None)
    maxn = next((int(a.split("=", 1)[1]) for a in args if a.startswith("--max-names=")), None)
    if smoke:
        if not (only or maxn):
            maxn = 5
        # the smoke run hand-checks arithmetic on a handful of names; the IC floor would empty the panel
        MIN_NAMES_WEEK = 1

    conn = connect()
    px = load_prices(conn)
    universe = sorted(t for t in px if t not in BENCH)
    names = ([t for t in universe if t in only] if only
             else universe[:maxn] if maxn else universe)
    print(f"panel {len(names)} names (market universe {len(universe)} for breadth), "
          f"bars to {max(px['SPY'])[0]}", flush=True)

    tech, fund, tgt, lab_feat = load_lab(conn, set(names))
    weeks = sorted(set(tech) | set(fund))
    print(f"lab weeks {len(weeks)}  {weeks[0]} → {weeks[-1]}", flush=True)

    macro = macro_state(px, universe, weeks)
    today = max(px["SPY"])[0]
    macro_today = macro_state(px, universe, [today]).get(today)
    if not macro_today:
        raise SystemExit("cannot build today's macro state")

    # ---- step 1: analogs
    mw = [d for d in weeks if d in macro and all(macro[d][v] == macro[d][v] for v in MACRO_VARS)]
    if len(mw) < 30:
        raise SystemExit(f"only {len(mw)} weeks have a complete macro state — cannot pick analogs")
    M = np.array([[macro[d][v] for v in MACRO_VARS] for d in mw], float)
    mu, sd = M.mean(axis=0), M.std(axis=0, ddof=1)
    sd[sd == 0] = 1.0
    Z = (M - mu) / sd
    z_today = (np.array([macro_today[v] for v in MACRO_VARS], float) - mu) / sd
    dist = np.linalg.norm(Z - z_today, axis=1)

    cutoff = mw[-1]
    for _ in range(EXCLUDE_RECENT):
        cutoff = max([d for d in mw if d < cutoff], default=cutoff)
    eligible = [(d, float(x)) for d, x in zip(mw, dist) if d <= cutoff and tgt.get(d)]
    eligible.sort(key=lambda z: z[1])
    k = max(8, int(round(ANALOG_FRAC * len(eligible))))
    analog = sorted(d for d, _ in eligible[:k])
    analog_dist = dict(eligible[:k])
    all_weeks = sorted(d for d, _ in eligible)
    print(f"analogs {len(analog)} of {len(eligible)} eligible weeks (cutoff {cutoff})", flush=True)

    panel = build_panel(px, names, all_weeks + [today], tech, fund)
    facs = [f for f in factor_names(panel)]
    print(f"factors {len(facs)}: {', '.join(facs)}", flush=True)

    if smoke:
        run_smoke(px, panel, tgt, lab_feat, facs, analog, all_weeks, macro, macro_today, today, conn)
        return

    # ---- step 3: IC on analog weeks vs all weeks
    rows = []
    for f in facs:
        ic_a, ic_all = weekly_ic(panel, tgt, f, analog), weekly_ic(panel, tgt, f, all_weeks)
        if len(ic_a) < 6 or len(ic_all) < 6:
            continue
        ta, pa, na = month_block_t(ic_a)
        tl, pl, nl = month_block_t(ic_all)
        rows.append({"f": f, "ic_a": statistics.mean(v for _, v in ic_a), "t_a": ta, "p_a": pa, "n_a": len(ic_a),
                     "ic_all": statistics.mean(v for _, v in ic_all), "t_all": tl, "n_all": len(ic_all),
                     "blocks_a": na})
    hp = holm({r["f"]: r["p_a"] for r in rows})
    for r in rows:
        r["holm"] = hp.get(r["f"], float("nan"))
        r["sel"] = (r["t_a"] == r["t_a"] and abs(r["t_a"]) >= IC_T_MIN
                    and np.sign(r["ic_a"]) == np.sign(r["ic_all"]))
    sel_full = {r["f"]: float(np.sign(r["ic_a"])) for r in rows if r["sel"]}
    print(f"selected (full-sample): {sel_full or 'none'}", flush=True)

    # ---- step 4: leave-one-analog-cluster-out composite on the analog weeks
    folds = clusters(analog)
    oos_comp, fold_sel = {}, []
    for fi, held in enumerate(folds):
        fit = [d for d in analog if d not in set(held)]
        s = select_factors(panel, tgt, facs, fit, all_weeks)
        fold_sel.append((fi, held[0], held[-1], s))
        for d in held:
            oos_comp[d] = composite(panel, d, s)
    print(f"LOCO folds {len(folds)}; sizes {[len(f) for f in folds]}", flush=True)

    bt = {}
    if not no_bt:
        bt = backtest(conn, px, panel, tgt, oos_comp, analog)

    # ---- step 5: today
    today_tbl = build_today(conn, px, panel, tgt, sel_full, analog, oos_comp, today, rows)

    write_reports(rows, sel_full, fold_sel, analog, analog_dist, all_weeks, macro, macro_today,
                  bt, today_tbl, today, names, px)
    print(f"\nwrote {OUT}\nwrote {TODAY_OUT}")


# ---------------------------------------------------------------- smoke

def run_smoke(px, panel, tgt, lab_feat, facs, analog, all_weeks, macro, macro_today, today, conn):
    """5 names: recompute the pieces the long way and print both numbers (memory: smoke-test-small-first)."""
    print("\n=== SMOKE ===")
    print("today's macro state:", {k: round(v, 4) for k, v in macro_today.items()})
    wk = [d for d in sorted(panel) if d != today and tgt.get(d)]
    if not wk:
        print("no usable week in the smoke slice")
        return
    d = wk[len(wk) // 2]
    t = sorted(panel[d])[0]
    f = panel[d][t]
    rows = px[t]
    i = f["_i"]
    c = np.array([r[1] for r in rows[: i + 1]], float)
    print(f"\n{t} @ {d} (bar {rows[i][0]}, spot {c[-1]:.2f})")
    lr = np.diff(np.log(c[-21:]))
    rv20 = lr.std(ddof=1) * math.sqrt(252)
    iv = rows[i][2]
    hand_ivrv = (iv / rv20) if iv else float("nan")
    print(f"  iv30 {fmt_plain(iv, 4)}  rv20 hand {rv20:.4f}  iv_rv20 frame {fmt_plain(f['iv_rv20'], 4)} "
          f"| hand {fmt_plain(hand_ivrv, 4)}")
    print(f"  prox_52w frame {f['prox_52w']:+.4f} | hand {c[-1] / c[-252:].max() - 1:+.4f}")
    print(f"  mom_12_1 frame {f['mom_12_1']:+.4f} | hand {c[-21] / c[-252] - 1:+.4f}")
    print(f"  rev_5d   frame {f['rev_5d']:+.4f} | hand {-(c[-1] / c[-6] - 1):+.4f}")
    lf = lab_feat.get(d, {}).get(t, {})
    if lf:
        print(f"  cross-check vs lab_outcomes.features: iv_rv {lf.get('iv_rv')} (ours {f['iv_rv20']:.4f}), "
              f"iv_rank_1y {lf.get('iv_rank_1y')} (ours {f['iv_rank252']:.4f}), "
              f"mom_12_1 {lf.get('mom_12_1')} (ours {f['mom_12_1']:.4f}), rev5 {lf.get('rev5')} "
              f"(ours {-f['rev_5d']:.4f} un-negated)")
    print(f"  lab_tech v2 total {f.get('tech_v2_total')}  v4_call {f.get('tech_v4call_total')}  "
          f"v4_put {f.get('tech_v4put_total')}")
    print(f"  rel_21 target {tgt[d].get(t)}")

    pricer = Pricer(conn)
    tb = tbill_map(conn)
    for side in ("call", "put"):
        tr = price_long(pricer, rows, i, side, tbill_at(tb, d))
        if tr:
            print(f"  {side}: K {tr['K']:.2f} debit {tr['debit']:.3f} {tr['days']}d  "
                  f"exit spot {tr['exit_spot']:.2f} → expiry {tr['expiry']:+.1%}  barrier {tr['barrier']:+.1%}")
    print(f"\nanalog weeks in slice: {len(analog)} of {len(all_weeks)}")
    for f_ in facs[:6]:
        ic = weekly_ic(panel, tgt, f_, all_weeks)
        print(f"  IC {f_:<26} weeks {len(ic):>3}  mean {statistics.mean(v for _, v in ic):+.4f}"
              if ic else f"  IC {f_:<26} no weeks (needs ≥ {MIN_NAMES_WEEK} names/week)")


# ---------------------------------------------------------------- backtest

def backtest(conn, px, panel, tgt, oos_comp, analog):
    """Top-TOPN / bottom-TOPN of the out-of-sample composite on the analog weeks, priced in the S081 engine."""
    pricer = Pricer(conn)
    tb = tbill_map(conn)
    trades = {"call": [], "put": []}
    uncond = {"call": [], "put": []}
    print("backtesting analog weeks...", flush=True)
    for d in analog:
        comp = oos_comp.get(d, {})
        if len(comp) < 2 * TOPN:
            continue
        ranked = sorted(comp.items(), key=lambda z: -z[1])
        picks = {"call": [t for t, _ in ranked[:TOPN]], "put": [t for t, _ in ranked[-TOPN:]]}
        r_tb = tbill_at(tb, d)
        for side, ts in picks.items():
            for t in ts:
                i = panel[d][t]["_i"]
                for scen in ("base", "rich", "cheap"):
                    tr = price_long(pricer, px[t], i, side, r_tb, scen)
                    if tr is None:
                        break
                    if scen == "base":
                        tr.update({"t": t, "side": side, "z": comp[t], "rel21": tgt.get(d, {}).get(t)})
                        cur = tr
                    else:
                        cur[f"expiry_{scen}"] = tr["expiry"]
                else:
                    trades[side].append(cur)
        # unconditional comparator: every ranked name on the same weeks, base scenario only
        for t in comp:
            i = panel[d][t]["_i"]
            for side in ("call", "put"):
                tr = price_long(pricer, px[t], i, side, r_tb)
                if tr:
                    tr.update({"t": t, "side": side})
                    uncond[side].append(tr)
    real = real_closes(conn, trades)
    return {"trades": trades, "uncond": uncond, "real": real}


def real_closes(conn, trades):
    """Match trades to a cached real Polygon contract (optlab.bars, 2024-10 →). 0 new vendor calls."""
    rows = conn.execute("""SELECT k.underlying, k.type, k.expiry, k.strike::float, b.date, b.c::float
                           FROM optlab.bars b JOIN optlab.contracts k ON k.occ = b.occ
                           WHERE b.c > 0""").fetchall()
    chain, bars = defaultdict(set), defaultdict(dict)
    for u, ty, exp, strike, d, c in rows:
        chain[(u, ty)].add((exp, strike))
        bars[(u, ty, exp, strike)][d] = c
    out = []
    for side, xs in trades.items():
        for x in xs:
            best = None
            for exp, strike in chain.get((x["t"], side), ()):
                dte = (exp - x["d"]).days
                if not 25 <= dte <= 75 or abs(strike / x["K"] - 1) > 0.10:
                    continue
                cost = abs(dte - DTE) / 45 + abs(strike / x["K"] - 1) * 10
                if best is None or cost < best[0]:
                    best = (cost, exp, strike)
            if not best:
                continue
            _, exp, strike = best
            ser = bars[(x["t"], side, exp, strike)]
            p0 = ser.get(x["d"])
            later = [dd for dd in ser if x["d"] < dd <= exp]
            if not p0 or p0 < 0.05 or not later:
                continue
            last = max(later)
            if (exp - last).days > 10:
                continue
            out.append({"side": side, "real": ser[last] / p0 - 1, "model": x["expiry"]})
    return out


# ---------------------------------------------------------------- today's list

def build_today(conn, px, panel, tgt, sel, analog, oos_comp, today, ic_rows):
    if not sel:
        return {"sel": {}, "rows": [], "note": "no factor cleared the analog-IC bar → no composite, no list"}
    comp = composite(panel, today, sel)
    if not comp:
        return {"sel": sel, "rows": [], "note": "today's cross-section has no composite (factor coverage)"}

    # analog-week hit rate by composite decile, from the out-of-sample composites
    dec_hits = defaultdict(lambda: [0, 0])
    for d in analog:
        c, tg = oos_comp.get(d, {}), tgt.get(d, {})
        if len(c) < 10:
            continue
        ranked = sorted(c.items(), key=lambda z: z[1])
        for rank, (t, _) in enumerate(ranked):
            if t not in tg:
                continue
            dec = min(9, int(10 * rank / len(ranked)))
            dec_hits[dec][1] += 1
            dec_hits[dec][0] += 1 if tg[t] > 0 else 0

    sec = sectors(conn)
    ranked = sorted(comp.items(), key=lambda z: -z[1])
    picks = [(t, z, "call") for t, z in ranked[:TOPN]] + [(t, z, "put") for t, z in ranked[-TOPN:]]
    tickers = {t for t, _, _ in picks}
    costs = today_costs(conn, tickers)
    fv, fundsc, optsc = live_extras(conn, tickers)

    # per-factor z today, to name the three drivers
    tick = sorted(comp)
    zs = {f: dict(zip(tick, sgn * zscore([panel[today][t].get(f, float("nan")) for t in tick])))
          for f, sgn in sel.items()}
    n_rank = len(ranked)

    out = []
    for t, z, side in picks:
        rank = [i for i, (tt, _) in enumerate(ranked) if tt == t][0]
        dec = min(9, int(10 * (n_rank - 1 - rank) / n_rank))   # decile in ascending order, matching dec_hits
        hits = dec_hits.get(dec, [0, 0])
        drivers = sorted(((f, zs[f].get(t, float("nan"))) for f in sel),
                         key=lambda x: -(abs(x[1]) if x[1] == x[1] else -1))[:3]
        f_today = panel[today][t]
        spot = f_today["_spot"]
        c = costs.get((t, side))
        if c:
            K, prem, src, dte = c["K"], float(c["ask"]), "Schwab ask", c["dte"]
        else:
            iv = px[t][f_today["_i"]][2]
            K, dte, src = spot, DTE, "BS @ IV30"
            prem = (bs_call if side == "call" else bs_put)(spot, K, iv, dte / 365) if iv else float("nan")
        be = ((K + prem) / spot - 1.0) if side == "call" else (1.0 - (K - prem) / spot)
        out.append({
            "ticker": t, "side": side, "z": z, "rank": rank + 1, "sector": sec.get(t, "Unknown"),
            "beta": beta_at(px, t, today), "drivers": drivers, "decile": dec,
            "hit": (hits[0] / hits[1]) if hits[1] else float("nan"), "hit_n": hits[1],
            "spot": spot, "K": K, "prem": prem, "dte": dte, "src": src, "be": be,
            "iv_rv": f_today.get("iv_rv20"), "iv_rank": f_today.get("iv_rank252"),
            "tech_v2": f_today.get("tech_v2_total"), "tech_call": f_today.get("tech_v4call_total"),
            "tech_put": f_today.get("tech_v4put_total"),
            "p2f": fv.get(t), "fund": fundsc.get(t), "opt": optsc.get((t, side)),
        })
    return {"sel": sel, "rows": out, "note": "", "dec_hits": dict(dec_hits)}


def reason(r):
    """One plain line: what is driving this name."""
    names = {"iv_rv20": "option cheap vs its own realised move", "iv_rank252": "IV low in its 1-year range",
             "prox_52w": "near its 52-week high", "mom_12_1": "12-month momentum",
             "rev_5d": "pulled back this week", "tech_v2_total": "Fildi tech score",
             "tech_v4call_total": "Fildi call score", "tech_v4put_total": "Fildi put score",
             "tech_v2_trendContext": "trend context", "tech_v2_oversoldDepth": "oversold depth",
             "tech_v2_volumeConfirm": "volume confirmation", "tech_v2_reversalSignal": "reversal signal",
             "tech_v2_volatilityState": "volatility state", "tech_v4call_relativePressure": "relative pressure",
             "tech_v4put_relativePressure": "relative pressure", "ibes_sue": "earnings surprise",
             "ibes_drift": "estimate drift", "ibes_drift_3m": "3-month estimate drift",
             "ibes_disp": "estimate dispersion", "ibes_breadth": "estimate breadth",
             "ibes_numest": "analyst coverage"}
    good = [names.get(f, f) for f, z in r["drivers"] if z == z and z > 0][:2]
    bad = [names.get(f, f) for f, z in r["drivers"] if z == z and z <= 0][:1]
    side = "calls" if r["side"] == "call" else "puts"
    lead = f"ranks {r['rank']} of the panel for {side}"
    if good:
        lead += " on " + " and ".join(good)
    if bad:
        lead += f"; {bad[0]} works against it"
    return lead + f"; needs {r['be']:+.1%} to break even."


# ---------------------------------------------------------------- reports

def write_reports(ic_rows, sel, fold_sel, analog, analog_dist, all_weeks, macro, macro_today,
                  bt, today_tbl, today, names, px):
    L = [f"# S085 — regime-analog composite, long calls / long puts (A244, {date.today()})", "",
         f"Pre-registered in INDEX row S085, committed before this run. Supersedes S084. Weekly point-in-time panel "
         f"from `watchlist_sync.lab_tech` (**engine_digest `{DIGEST}` only** — the table holds 2–3 rows per "
         f"ticker-week and an unfiltered read double-counts), `lab_fund`, and price/IV factors recomputed from "
         f"`lseg_research.daily_history`. Target = `lab_outcomes.outcomes.rel_21` (21-session forward return minus "
         f"the peer-group median that date). {len(names)} names, {len(all_weeks)} eligible weeks "
         f"{all_weeks[0]} → {all_weeks[-1]}.", ""]

    # --- macro / analogs
    L += ["## 1. Today's macro state and its analogs", "",
          "| variable | today | analog mean | all-week mean |", "|---|---|---|---|"]
    for v in MACRO_VARS:
        am = statistics.mean(macro[d][v] for d in analog)
        aw = statistics.mean(macro[d][v] for d in all_weeks if d in macro and macro[d][v] == macro[d][v])
        L.append(f"| `{v}` | {macro_today[v]:+.4f} | {am:+.4f} | {aw:+.4f} |")
    L += ["", f"Distance = Euclidean in the standardised 6-variable space; the nearest **{ANALOG_FRAC:.0%}** of "
              f"eligible weeks are the analogs. The last {EXCLUDE_RECENT} weeks are excluded (their `rel_21` is "
              f"unformed or overlaps today). **No 10-year yield variable**: no yield/treasury/FRED series is stored "
              f"in any schema (probed `information_schema`), so the state is 6 variables, not 7. Breadth is "
              f"recomputed from the panel because `market_breadth_daily` holds 20 rows.", "",
          f"**{len(analog)} analog weeks** (distance in brackets):", "",
          "  " + " · ".join(f"{d} ({analog_dist[d]:.2f})" for d in analog), ""]

    # --- IC
    L += ["## 2. Factor IC against `rel_21` — analog weeks vs all weeks", "",
          "| factor | analog IC | analog t | analog weeks | Holm p | all-week IC | all-week t | in composite |",
          "|---|---|---|---|---|---|---|---|"]
    for r in sorted(ic_rows, key=lambda x: -(abs(x["t_a"]) if x["t_a"] == x["t_a"] else -1)):
        hp = "n/a" if r["holm"] != r["holm"] else f"{r['holm']:.3f}"
        L.append(f"| `{r['f']}` | {fmt_num(r['ic_a'], 4)} | {fmt_num(r['t_a'], 2)} | {r['n_a']} | {hp} | "
                 f"{fmt_num(r['ic_all'], 4)} | {fmt_num(r['t_all'], 2)} | "
                 f"{'**yes**' if r['sel'] else 'no'} |")
    L += ["", f"Entry rule (pre-registered): analog-week month-block |t| ≥ {IC_T_MIN} **and** the analog IC agrees in "
              f"sign with the all-week IC. Selected on the full analog set: "
              f"**{', '.join(sel) if sel else 'none'}**.", "",
          "### Leave-one-analog-cluster-out folds (what actually scored each analog week)", "",
          "| fold | held-out weeks | factors selected on the other folds |", "|---|---|---|"]
    for fi, a, b, s in fold_sel:
        L.append(f"| {fi + 1} | {a} → {b} | {', '.join(f'{k}{"+" if v > 0 else "−"}' for k, v in s.items()) or '—'} |")
    L += ["", "The composite that ranks an analog week is fitted only on the other folds, so no evaluation week is "
              "also a selection week. Folds are contiguous in time because calendar-adjacent analog weeks share a "
              "tape.", ""]

    # --- backtest
    L += ["## 3. Backtest on the analog weeks (out-of-sample composite)", ""]
    if not bt or not bt.get("trades") or not any(bt["trades"].values()):
        L += ["**Not run / no trades** — no factor cleared the analog-IC bar, so there is no out-of-sample composite "
              "to rank on. Stop rule: ranking on a factor that failed its own IC bar is exactly the error the "
              "withdrawn 10-22 screen made.", ""]
        verdicts = {}
    else:
        L += [f"Top-{TOPN} composite → long call, bottom-{TOPN} → long put, analog weeks only. S081 engine: "
              f"Black-Scholes at iv30_side × the S075 skew ratio, 0.50Δ ~{DTE} DTE, entry fill = bid + 23 % of the "
              f"spread, excess over T-bill. Per $ debit.", "",
              "| side | exit | n | mean | median | month-block t | win | payoff |", "|---|---|---|---|---|---|---|---|"]
        verdicts = {}
        for side in ("call", "put"):
            xs = bt["trades"][side]
            for key, lab in (("expiry", "hold to expiry"), ("barrier", "+100 % / −50 % / 21 DTE")):
                s = summarize([x[key] for x in xs])
                if not s:
                    continue
                t = block_t(xs, key)
                L.append(f"| long {side} | {lab} | {s['n']:,} | {fmt_pct(s['mean'])} | {fmt_pct(s['median'])} | "
                         f"{fmt_num(t, 2)} | {s['win']:.0%} | {fmt_plain(s['payoff'])} |")
                if key == "expiry":
                    verdicts[side] = (s, t)
        L += ["", "### Comparators and stress on the same weeks", "",
              "| side | unconditional (every name, expiry) | stock only (same picks) | rich +25 % | cheap −25 % |",
              "|---|---|---|---|---|"]
        for side in ("call", "put"):
            xs, us = bt["trades"][side], bt["uncond"][side]
            u = summarize([x["expiry"] for x in us])
            st = summarize([x["stock"] for x in xs])
            rich = summarize([x.get("expiry_rich", float("nan")) for x in xs])
            cheap = summarize([x.get("expiry_cheap", float("nan")) for x in xs])
            ucell = f"{fmt_pct(u['mean'])} (n {u['n']:,})" if u else "n/a"
            L.append(f"| long {side} | {ucell} | {fmt_pct(st['mean']) if st else 'n/a'} | "
                     f"{fmt_pct(rich['mean']) if rich else 'n/a'} | "
                     f"{fmt_pct(cheap['mean']) if cheap else 'n/a'} |")
        real = bt.get("real") or []
        if real:
            for side in ("call", "put"):
                rs = [x for x in real if x["side"] == side]
                if len(rs) >= 5:
                    L += ["", f"**Real Polygon closes, long {side}** (cached `optlab.bars`, 0 new vendor calls): "
                              f"n {len(rs)} — real {statistics.mean(x['real'] for x in rs):+.1%} vs model "
                              f"{statistics.mean(x['model'] for x in rs):+.1%}."]
        else:
            L += ["", "**Real Polygon closes:** no analog-week trade matched a cached contract — `optlab.bars` "
                      "starts 2024-10-15 and the analog weeks mostly predate it."]
        L += ["", "### Verdict vs the pre-registered bar", "",
              "| side | mean > 0 | month-block t ≥ 2 | beats unconditional | survives rich +25 % | verdict |",
              "|---|---|---|---|---|---|"]
        for side in ("call", "put"):
            if side not in verdicts:
                continue
            s, t = verdicts[side]
            u = summarize([x["expiry"] for x in bt["uncond"][side]])
            rich = summarize([x.get("expiry_rich", float("nan")) for x in bt["trades"][side]])
            c1 = s["mean"] > 0
            c2 = t == t and abs(t) >= 2
            c3 = bool(u) and s["mean"] > u["mean"]
            c4 = bool(rich) and np.sign(rich["mean"]) == np.sign(s["mean"]) and rich["mean"] > 0
            ok = all((c1, c2, c3, c4))
            L.append("| long " + side + " | " + " | ".join("ok" if c else "**fail**" for c in (c1, c2, c3, c4))
                     + f" | {'**PASS**' if ok else '**FAIL**'} |")
            verdicts[side] = (s, t, ok)
        L += ["", "Stop rule: a FAIL side's today-table is marked **not tradeable on this evidence** — the names are "
                  "still listed because Jamie asked for them, but the backtest does not support them.", ""]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(L) + "\n")
    write_today(today_tbl, today, verdicts, analog, sel)


def write_today(tbl, today, verdicts, analog, sel):
    v = {s: (x[2] if len(x) > 2 else None) for s, x in (verdicts or {}).items()}
    L = [f"# S085 — today's long calls / long puts ({today})", "",
         f"Ranked by the S085 regime-analog composite built on Fildi's own point-in-time scores "
         f"(factors: {', '.join(sel) if sel else 'none selected'}), judged on the {len(analog)} weeks since 2020-02 "
         f"whose macro state most resembles today's. Full method, IC table and backtest: `out/opt/S085.md`.", ""]
    for side in ("call", "put"):
        if v.get(side) is False:
            L.append(f"> **Long {side}s FAILED the pre-registered backtest bar on the analog weeks — the table below "
                     f"is a ranking, not a tradeable list.**")
    if not tbl["rows"]:
        L += ["", f"**No list.** {tbl['note']}", ""]
        TODAY_OUT.parent.mkdir(parents=True, exist_ok=True)
        TODAY_OUT.write_text("\n".join(L) + "\n")
        return
    L.append("")
    for side, title in (("call", f"Top {TOPN} long calls"), ("put", f"Top {TOPN} long puts")):
        rs = [r for r in tbl["rows"] if r["side"] == side]
        if not rs:
            continue
        rs.sort(key=lambda r: -r["z"] if side == "call" else r["z"])
        L += [f"## {title}", "",
              "| # | ticker | sector | beta | composite z | 3 drivers (z) | tech v2 / call / put | IV÷RV | IV rank | "
              "price÷fair | fund | decile hit rate | contract | cost | break-even | why |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for n, r in enumerate(rs, 1):
            dr = ", ".join(f"{f.replace('tech_', '').replace('_total', '')} {z:+.2f}"
                           for f, z in r["drivers"] if z == z)
            tech = " / ".join("n/a" if r[k] is None else f"{r[k]:.0f}"
                              for k in ("tech_v2", "tech_call", "tech_put"))
            hit = "n/a" if r["hit"] != r["hit"] else f"{r['hit']:.0%} (n {r['hit_n']:,})"
            cost = "n/a" if r["prem"] != r["prem"] else f"{r['prem']:.2f} ({r['src']})"
            L.append(
                f"| {n} | **{r['ticker']}** | {r['sector']} | {fmt_num(r['beta'], 2)} | {r['z']:+.2f} | {dr} | "
                f"{tech} | {fmt_plain(r['iv_rv'])} | {fmt_rate(r['iv_rank'])} | {fmt_plain(r['p2f'])} | "
                f"{fmt_plain(r['fund'], 0)} | {hit} | "
                f"{r['dte']}d K {r['K']:.2f} vs spot {r['spot']:.2f} | {cost} | "
                f"{fmt_pct(r['be'])} | {reason(r)} |")
        L.append("")
    # exposure, in place of a sector cap (Jamie: "why cap")
    L += ["## Sector and beta exposure (shown instead of a cap — Jamie 10-22: \"why cap\")", "",
          "| side | sector | names | mean beta |", "|---|---|---|---|"]
    for side in ("call", "put"):
        by = defaultdict(list)
        for r in tbl["rows"]:
            if r["side"] == side:
                by[r["sector"]].append(r)
        for s, rs in sorted(by.items(), key=lambda x: -len(x[1])):
            bs = [r["beta"] for r in rs if r["beta"] == r["beta"]]
            mb = f"{statistics.mean(bs):.2f}" if bs else "n/a"
            L.append(f"| {side} | {s} | {len(rs)} ({', '.join(r['ticker'] for r in rs)}) | {mb} |")
    L += ["", "## Columns that are live-only (never in the composite)", "",
          "`price÷fair` (`fair_value_snapshots`, starts 2026-10-06), `fund` (`fund_score_snapshots`, 2026-10-05) and "
          "the Fildi option score (`option_score_snapshots`, 2026-09-30) have no point-in-time history, so they "
          "cannot be weighted by analog-week IC. They are shown because they are real information today, and they "
          "are excluded from the ranking. Option cost is the Schwab 25–50 DTE near-ATM ask from "
          "`option_chain_history` where the chain band reaches the money, else Black-Scholes at IV30 struck at spot.",
          ""]
    TODAY_OUT.parent.mkdir(parents=True, exist_ok=True)
    TODAY_OUT.write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
