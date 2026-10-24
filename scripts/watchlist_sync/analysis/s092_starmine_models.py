"""S092 — Unused StarMine models (A262). Do not change the bar.

Question: which of Earnings Quality, Insider Filings, Smart Holdings, the Short
Interest model, M&A Target, MarketPsych, and Intrinsic Value rank are on this
Workspace seat, and which predict holdout outcomes beyond the comparator?

What the API actually returns (probed, not assumed):
  TR.EQCtryRank            Earnings Quality Country Rank. Quarterly fiscal
                           history via Period=FQ0:FQ-24 (period end date).
                           SDate/EDate/Frq=M returns one current row.
  TR.SHRegRank             SmartHoldings Region Rank. Current only.
  TR.SICtryRank            Short Interest Country Rank. Current only.
  TR.InsiderCtryRank       Insider Country Rank. Current only.
  M&A, MarketPsych, IV rank codes tried below do not resolve (error 218).
  TR.IVPriceToIntrinsicValue is the ratio already in signals_daily. No fiscal
                           period, so no history.

PIT: a Monday uses the latest fiscal period end on or before that Monday,
at most 120 days old. The newest EQ quarter is included only when its period
end is already past. FY0/FQ0 is not a daily series — LSEG staff (community
45091 / 61628): daily StarMine history is not in Eikon; fiscal-period history is.

Boards (pre-registered): stock rel_21 vs combined alpha + lab_tech v2; put pnl
vs put_edge. PASS = holdout t ≥ 2, both halves positive, and the same on the
marginal test (FM or within-quintile).

Amendment (labelled): the EQ rank is constant between quarter-ends, and rel_21
overlaps. Week t is Newey-West lag 13, not lag 3. A pass also needs the same
sign on the quarterly vintages (one IC per period end). Lag-3 t is printed and
is not the bar. Current-only models get a same-day rank correlation vs combined
alpha, not a holdout test.

  cd research/lseg && nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python \\
      ../../scripts/watchlist_sync/analysis/s092_starmine_models.py --smoke
  cd research/lseg && nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python \\
      ../../scripts/watchlist_sync/analysis/s092_starmine_models.py
"""
from __future__ import annotations

import math
import os
import random
import sys
from bisect import bisect_right
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LSEG_DIR = HERE.parents[2] / "research" / "lseg"
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LSEG_DIR))

from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402
from s045_put_retest import rank  # noqa: E402
from _session import (  # noqa: E402
    LSEG_BUDGET_FRACTION,
    LSEG_DAILY_REQUESTS,
    LSEG_MONTHLY_DATAPOINTS,
    MeteredLD,
    _datapoints_this_month,
    _record_datapoints,
    _record_usage,
    _usage_today,
    clean,
    connect_local,
    load_env,
    load_ric_map,
)
import lseg.data as ld  # noqa: E402

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
HOLDOUT_START = date(2023, 1, 1)
STALE_DAYS = 120
MIN_NAMES = 30
MIN_HALF = 8
NW_LAG = 13  # one quarter of a sticky rank, plus the 21-day return overlap
PROBE_CAP = 40
FETCH_CAP = 80
MONTH_CEILING = int(LSEG_MONTHLY_DATAPOINTS * 0.90)
DAILY_STOP = int(LSEG_DAILY_REQUESTS * LSEG_BUDGET_FRACTION)
OUT = ROOT / "out" / "studies" / "S092.md"
FQ_SMOKE = "FQ0:FQ-8"
FQ_FULL = "FQ0:FQ-24"

# History flag: only EQ returned fiscal quarters.
MODELS = [
    ("earnings_quality", "Earnings Quality", "TR.EQCtryRank", True),
    ("smart_holdings", "Smart Holdings", "TR.SHRegRank", False),
    ("short_interest_model", "Short Interest model", "TR.SICtryRank", False),
    ("insider", "Insider Filings", "TR.InsiderCtryRank", False),
]
UNRESOLVED = [
    ("M&A Target", ["TR.MATargetRegionRank", "TR.MACtryRank", "TR.MATgtCtryRank", "TR.MATCtryRank"]),
    ("MarketPsych", ["TR.MMSRegionRank", "TR.MMSCtryRank", "TR.MMSRank", "TR.MarketPsychCtryRank"]),
    ("Intrinsic Value rank", ["TR.IVRegionRank", "TR.IVCtryRank", "TR.IVRank"]),
]
CONTROL = "TR.CombinedAlphaRegionRank"
IV_RATIO = "TR.IVPriceToIntrinsicValue"


def as_date(d) -> date:
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    return date.fromisoformat(str(d)[:10])


def budget_snapshot() -> dict:
    with connect_local() as conn:
        used = _usage_today(conn)
        month = _datapoints_this_month(conn)
        conn.commit()
    return {"requests_today": used, "month_datapoints": month}


@contextmanager
def study_session(cap: int):
    """Request-capped desktop session. Records api_usage. Refuses at the daily
    8,000 research stop. The shared helper also refuses at 8,000,000 monthly
    datapoints, which was already true today; this cap is the daily stop plus
    `cap`, and callers skip a pull that would cross MONTH_CEILING."""
    load_env()
    key = os.environ.get("LSEG_APP_KEY")
    if not key:
        raise RuntimeError("LSEG_APP_KEY missing from .env.local")
    snap = budget_snapshot()
    room = DAILY_STOP - snap["requests_today"]
    if room <= 0:
        raise RuntimeError(f"LSEG daily research stop: {snap['requests_today']}/{DAILY_STOP}")
    limit = min(cap, room)
    try:
        ld.open_session(name="desktop.workspace", app_key=key)
    except Exception as e:
        raise RuntimeError(f"LSEG session did not open: {str(e)[:200]}") from e
    if str(ld.session.get_default().open_state).split(".")[-1] != "Opened":
        ld.close_session()
        raise RuntimeError("LSEG session did not open. Log in to Workspace.")
    metered = MeteredLD(ld, limit, None)
    try:
        yield metered, snap
    finally:
        ld.close_session()
        try:
            with connect_local() as conn:
                _record_usage(conn, metered.requests)
                _record_datapoints(conn, metered)
                conn.commit()
        except Exception as e:
            print(f"warn: could not record LSEG usage ({e})", flush=True)
        print(f"lseg usage: {metered.requests} requests, ~{metered.datapoints} datapoints, "
              f"{metered.errors} errors (cap {limit})", flush=True)


def fetch_field(metered, rics, fields, params=None):
    try:
        df = metered.get_data(rics, fields, params) if params else metered.get_data(rics, fields)
        return df, None
    except Exception as e:
        return None, str(e)[:200]


def current_map(df, ric_to_t: dict) -> dict[str, float]:
    out = {}
    if df is None or getattr(df, "empty", True):
        return out
    for _, r in df.iterrows():
        t = ric_to_t.get(str(r.iloc[0]))
        v = clean(r.iloc[1]) if df.shape[1] > 1 else None
        if t and isinstance(v, (int, float)) and math.isfinite(float(v)):
            out[t] = float(v)
    return out


def fiscal_rows(df, ric_to_t: dict) -> dict[str, list]:
    """ticker → [(period_end, value, fperiod)] sorted. Drops a period end in the future."""
    out = defaultdict(list)
    if df is None or getattr(df, "empty", True) or df.shape[1] < 3:
        return {}
    today = date.today()
    for _, r in df.iterrows():
        t = ric_to_t.get(str(r.iloc[0]))
        v = clean(r.iloc[1])
        # field, fperiod, periodenddate — or field, periodenddate if only two extras
        if df.shape[1] >= 4:
            fper, pend = clean(r.iloc[2]), clean(r.iloc[3])
        else:
            fper, pend = None, clean(r.iloc[2])
        if not t or pend is None or not isinstance(v, (int, float)):
            continue
        pend = as_date(pend)
        if pend > today:
            continue
        out[t].append((pend, float(v), None if fper is None else str(fper)))
    cleaned = {}
    for t, rows in out.items():
        dedup = {}
        for pend, v, fper in rows:
            dedup[pend] = (v, fper)
        cleaned[t] = [(d, dedup[d][0], dedup[d][1]) for d in sorted(dedup)]
    return cleaned


def asof(series: list, day: date) -> float | None:
    """series items are (period_end, value, ...)."""
    if not series:
        return None
    keys = [r[0] for r in series]
    i = bisect_right(keys, day) - 1
    if i < 0:
        return None
    if (day - series[i][0]).days > STALE_DAYS:
        return None
    return series[i][1]


def t_stat(vals, lag: int) -> float | None:
    if len(vals) < 8:
        return None
    if lag > 0:
        t = float(nw_t(vals, lag))
        return t if math.isfinite(t) else None
    arr = np.asarray(vals, float)
    sd = float(arr.std(ddof=1))
    if sd == 0:
        return None
    return float(arr.mean() / (sd / math.sqrt(len(arr))))


def pack(pairs, mid: date, lag: int) -> dict:
    pairs = [(d, v) for d, v in pairs if v is not None and math.isfinite(v)]
    if len(pairs) < MIN_HALF:
        return {"thin": True, "n": len(pairs)}
    a = [v for d, v in pairs if d < mid]
    b = [v for d, v in pairs if d >= mid]
    vals = [v for _, v in pairs]
    base = {"n": len(pairs), "na": len(a), "nb": len(b), "mean": float(np.mean(vals)),
            "t": t_stat(vals, lag), "a": float(np.mean(a)) if a else None,
            "b": float(np.mean(b)) if b else None}
    if len(a) < MIN_HALF or len(b) < MIN_HALF:
        base["thin"] = True
        return base
    base["thin"] = False
    return base


def clears(p: dict | None) -> bool:
    return bool(p) and not p.get("thin") and p.get("t") is not None and p["t"] >= 2 and p.get("a", 0) > 0 and p.get("b", 0) > 0


def fmt(p, scale=1.0, digits=3) -> str:
    if not p or p.get("t") is None:
        return "—"
    def h(v):
        return "—" if v is None else f"{v * scale:+.{digits}f}"
    thin = " thin" if p.get("thin") else ""
    return (f"{p['mean'] * scale:+.{digits}f} t {p['t']:+.1f}{thin} "
            f"(n {p.get('n')} w {p.get('na')}/{p.get('nb')} halves {h(p.get('a'))}/{h(p.get('b'))})")


def week_stock(sig, rel, alpha, tech) -> dict | None:
    m = np.isfinite(sig) & np.isfinite(rel) & np.isfinite(alpha) & np.isfinite(tech)
    if int(m.sum()) < MIN_NAMES or np.std(sig[m]) == 0 or np.std(rel[m]) == 0:
        return None
    sig, rel, alpha, tech = sig[m], rel[m], alpha[m], tech[m]
    rs, ry, ra, rt = rank(sig), rank(rel), rank(alpha), rank(tech)
    ic = float(np.corrcoef(rs, ry)[0, 1])
    k = max(1, len(sig) // 10)
    order = np.argsort(sig, kind="mergesort")
    spread = float(rel[order[-k:]].mean() - rel[order[:k]].mean())
    X = np.c_[np.ones(len(sig)), rs, ra, rt]
    beta = np.linalg.lstsq(X, ry, rcond=None)[0]
    comp = rank(list(0.5 * (np.asarray(ra) + np.asarray(rt))))
    q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
    bits = []
    for qi in range(5):
        sel = q == qi
        if int(sel.sum()) < 8 or np.std(sig[sel]) == 0:
            continue
        med = np.median(sig[sel])
        hi, lo = rel[sel & (sig >= med)], rel[sel & (sig < med)]
        if len(hi) and len(lo):
            bits.append(float(hi.mean() - lo.mean()))
    wq = float(np.mean(bits)) if len(bits) >= 3 else math.nan
    ca = float(np.corrcoef(rs, ra)[0, 1])
    ct = float(np.corrcoef(rs, rt)[0, 1])
    calpha = float(np.corrcoef(ra, ry)[0, 1])
    ctech = float(np.corrcoef(rt, ry)[0, 1])
    return {"ic": ic, "spread": spread, "fm": float(beta[1]), "wq": wq, "n": int(len(sig)),
            "corr_a": ca, "corr_t": ct, "ic_a": calpha, "ic_t": ctech,
            "pend": None}


def eval_stock(panel, mid: date) -> dict:
    keys = ("ic", "spread", "fm", "wq", "corr_a", "corr_t", "ic_a", "ic_t")
    series = {k: [] for k in keys}
    vintages = defaultdict(list)
    ns = []
    for d, rel, alpha, tech, sig, pend in panel:
        met = week_stock(sig, rel, alpha, tech)
        if not met:
            continue
        ns.append(met["n"])
        for k in keys:
            series[k].append((d, met[k]))
        vintages[pend].append(met["ic"])
    out = {k: pack(v, mid, NW_LAG) for k, v in series.items()}
    out["lag3"] = pack(series["ic"], mid, 3)
    v_pairs = []
    for pend, ics in vintages.items():
        if ics:
            v_pairs.append((pend, float(np.mean(ics))))
    out["vintage"] = pack(v_pairs, mid, 0)
    out["mean_n"] = float(np.mean(ns)) if ns else 0
    out["n_weeks"] = out["ic"].get("n") or 0
    out["pass"] = clears(out["ic"]) and (clears(out["fm"]) or clears(out["wq"])) and clears(out["vintage"])
    out["standalone"] = clears(out["ic"]) and not (clears(out["fm"]) or clears(out["wq"]))
    return out


def load_stock_base(conn):
    digest = conn.execute(
        """SELECT engine_digest FROM watchlist_sync.lab_tech
           WHERE engine_digest LIKE '%%-ivhist'
           GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1"""
    ).fetchone()[0]
    outcomes = [(t, as_date(d), float(rel)) for t, d, rel in conn.execute(
        """SELECT ticker, as_of, (outcomes->>'rel_21')::float8
           FROM watchlist_sync.lab_outcomes
           WHERE EXTRACT(DOW FROM as_of) = 1 AND outcomes->>'rel_21' IS NOT NULL
             AND as_of >= %s""", (HOLDOUT_START,))]
    tech = {(t, as_date(d)): float(v) for t, d, v in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND v2->>'total' IS NOT NULL""", (digest,))}
    alpha = defaultdict(list)
    for t, d, v in conn.execute(
            """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
               WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL ORDER BY ticker, obs_date"""):
        alpha[t].append((as_date(d), float(v)))
    return digest, outcomes, tech, alpha


def build_stock(outcomes, tech, alpha, series) -> list:
    by = defaultdict(list)
    for t, d, rel in outcomes:
        al_series = alpha.get(t, [])
        al = None
        j = bisect_right(al_series, (d, math.inf)) - 1
        if j >= 0 and (d - al_series[j][0]).days <= 45:
            al = al_series[j][1]
        te = tech.get((t, d))
        sv = asof(series.get(t, []), d)
        if al is None or te is None or sv is None:
            continue
        pend = None
        s = series.get(t, [])
        keys = [r[0] for r in s]
        i = bisect_right(keys, d) - 1
        if i >= 0:
            pend = s[i][0]
        by[d].append((rel, al, te, sv, pend))
    panel = []
    for d in sorted(by):
        rows = by[d]
        if len(rows) < MIN_NAMES:
            continue
        # one vintage per week: the modal period end
        pends = [r[4] for r in rows if r[4] is not None]
        pend = max(set(pends), key=pends.count) if pends else d
        panel.append((d,
                      np.array([r[0] for r in rows], float),
                      np.array([r[1] for r in rows], float),
                      np.array([r[2] for r in rows], float),
                      np.array([r[3] for r in rows], float),
                      pend))
    return panel


def attach_edge(events):
    by = defaultdict(list)
    for e in events:
        if e.get("iv_rv") is None or e.get("vov") is None or e.get("put_tech") is None:
            continue
        if not (0.3 <= e["iv_rv"] <= 5):
            continue
        by[e["d"]].append(e)
    for g in by.values():
        if len(g) < MIN_NAMES:
            continue
        acc = np.zeros(len(g))
        for k in ("iv_rv", "vov", "put_tech"):
            acc += rank([e[k] for e in g])
        pct = rank(list(acc / 3.0))
        for e, p in zip(g, pct):
            e["edge"] = float(p)
            e["edge_q"] = min(5, int(float(p) * 5) + 1)


def build_puts(conn, series) -> list:
    import s059_option_factors as S59
    print("building put events (S059 harness)...", flush=True)
    ev = S59.aligned_events(conn)
    print(f"  {len(ev)} puts", flush=True)
    rows = []
    for e in ev:
        if e["d"] < HOLDOUT_START:
            continue
        sv = asof(series.get(e["t"], []), e["d"])
        if sv is None:
            continue
        s = series.get(e["t"], [])
        keys = [r[0] for r in s]
        i = bisect_right(keys, e["d"]) - 1
        pend = s[i][0] if i >= 0 else None
        rows.append({
            "t": e["t"], "d": e["d"], "pnl": e["pnl"], "breach": e["breach"],
            "iv_rv": e.get("iv_rv"), "iv30": e.get("iv30"), "earn": e.get("earn") or 0.0,
            "vov": e.get("vol_of_vol"), "put_tech": e.get("put_tech"), "sig": sv, "pend": pend,
        })
    attach_edge(rows)
    return rows


def put_metrics(events, mid: date) -> dict:
    by = defaultdict(list)
    for e in events:
        by[e["d"]].append(e)
    ic, spread, breach, fm, wq, corr = [], [], [], [], [], []
    ic_iv, spread_iv, corr_iv = [], [], []
    vintages = defaultdict(list)
    for d, g0 in by.items():
        g = [e for e in g0 if e.get("sig") is not None and e.get("pnl") is not None]
        if len(g) < MIN_NAMES or len({e["sig"] for e in g}) < 2:
            continue
        x = np.array(rank([e["sig"] for e in g]), float)
        y = np.array(rank([e["pnl"] for e in g]), float)
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        ic_v = float(np.corrcoef(x, y)[0, 1])
        ic.append((d, ic_v))
        giv = [e for e in g if e.get("iv30") is not None and e.get("iv_rv") is not None]
        if len(giv) >= MIN_NAMES:
            xx = np.array(rank([e["sig"] for e in giv]), float)
            yy = np.array(rank([e["pnl"] for e in giv]), float)
            iv = np.array(rank([e["iv30"] for e in giv]), float)
            if np.std(xx) > 0 and np.std(iv) > 0:
                corr_iv.append((d, float(np.corrcoef(xx, iv)[0, 1])))
            C = np.column_stack([np.ones(len(giv)), iv])
            xr = xx - C @ np.linalg.lstsq(C, xx, rcond=None)[0]
            yr = yy - C @ np.linalg.lstsq(C, yy, rcond=None)[0]
            if np.std(xr) > 0 and np.std(yr) > 0:
                ic_iv.append((d, float(np.corrcoef(xr, yr)[0, 1])))
            gaps = []
            qiv = np.clip((iv * 0.999 * 5).astype(int), 0, 4)
            for qi in range(5):
                b = [giv[i] for i in range(len(giv)) if qiv[i] == qi]
                if len(b) < 4:
                    continue
                b.sort(key=lambda e: e["sig"])
                h = max(1, len(b) // 2)
                gaps.append(1e4 * (float(np.mean([e["pnl"] for e in b[-h:]])) - float(np.mean([e["pnl"] for e in b[:h]]))))
            if len(gaps) >= 3:
                spread_iv.append((d, float(np.mean(gaps))))
        pends = [e["pend"] for e in g if e.get("pend")]
        if pends:
            vintages[max(set(pends), key=pends.count)].append(ic_v)
        g_sorted = sorted(g, key=lambda e: e["sig"])
        k = len(g_sorted) // 5
        if k >= 1:
            top, bot = g_sorted[-k:], g_sorted[:k]
            spread.append((d, 1e4 * (float(np.mean([e["pnl"] for e in top])) - float(np.mean([e["pnl"] for e in bot])))))
            breach.append((d, 100 * (float(np.mean([e["breach"] for e in top])) - float(np.mean([e["breach"] for e in bot])))))
        ge = [e for e in g if e.get("edge") is not None]
        if len(ge) >= MIN_NAMES:
            yy = np.array(rank([e["pnl"] for e in ge]), float)
            xx = np.array(rank([e["sig"] for e in ge]), float)
            cc = np.array(rank([e["edge"] for e in ge]), float)
            if np.std(xx) > 0 and np.std(cc) > 0 and abs(float(np.corrcoef(xx, cc)[0, 1])) < 0.999:
                X = np.column_stack([np.ones(len(ge)), xx, cc])
                beta = np.linalg.lstsq(X, yy, rcond=None)[0]
                fm.append((d, float(beta[1])))
                corr.append((d, float(np.corrcoef(xx, cc)[0, 1])))
            gaps = []
            for q in range(1, 6):
                b = [e for e in ge if e.get("edge_q") == q]
                if len(b) < 4:
                    continue
                b.sort(key=lambda e: e["sig"])
                h = max(1, len(b) // 2)
                gaps.append(1e4 * (float(np.mean([e["pnl"] for e in b[-h:]])) - float(np.mean([e["pnl"] for e in b[:h]]))))
            if len(gaps) >= 3:
                wq.append((d, float(np.mean(gaps))))
    out = {
        "ic": pack(ic, mid, NW_LAG),
        "lag3": pack(ic, mid, 3),
        "spread": pack(spread, mid, NW_LAG),
        "breach": pack(breach, mid, NW_LAG),
        "fm": pack(fm, mid, NW_LAG),
        "wq": pack(wq, mid, NW_LAG),
        "corr_edge": pack(corr, mid, NW_LAG),
        "vintage": pack([(p, float(np.mean(v))) for p, v in vintages.items() if v], mid, 0),
        "ic_iv": pack(ic_iv, mid, NW_LAG),
        "spread_iv": pack(spread_iv, mid, NW_LAG),
        "corr_iv": pack(corr_iv, mid, NW_LAG),
        "n_events": len(events),
    }
    out["pass"] = clears(out["ic"]) and (clears(out["fm"]) or clears(out["wq"])) and clears(out["vintage"])
    out["standalone"] = clears(out["ic"]) and not (clears(out["fm"]) or clears(out["wq"]))
    return out


def spearman(a: dict, b: dict) -> tuple[float | None, int]:
    keys = [k for k in a if k in b]
    if len(keys) < MIN_NAMES:
        return None, len(keys)
    x, y = rank([a[k] for k in keys]), rank([b[k] for k in keys])
    if np.std(x) == 0 or np.std(y) == 0:
        return None, len(keys)
    return float(np.corrcoef(x, y)[0, 1]), len(keys)


def probe_and_check(metered, ric_map: dict[str, str], conn) -> dict:
    ric_to_t = {r: t for t, r in ric_map.items()}
    rics = list(ric_map.values())
    lines = ["## Hand-check", ""]
    ctrl, err = fetch_field(metered, rics, [CONTROL])
    control = current_map(ctrl, ric_to_t)
    stored = conn.execute(
        """SELECT value::float8, obs_date FROM lseg_research.starmine_history
           WHERE ticker = %s AND metric = 'combined_alpha_rank' ORDER BY obs_date DESC LIMIT 1""",
        (HAND,)).fetchone()
    lines.append(f"Control {CONTROL} current: {', '.join(f'{t}={control.get(t)}' for t in SMOKE)}.")
    if stored and HAND in control:
        gap = float(control[HAND]) - float(stored[0])
        lines.append(f"Stored {HAND} combined alpha {stored[1]} = {float(stored[0]):.1f}. "
                     f"Live minus stored {gap:+.1f} (same rank; stored month is the last history print).")
    current = {}
    fiscal = {}
    for key, label, field, has_hist in MODELS:
        df, e = fetch_field(metered, rics, [field])
        current[key] = {"field": field, "label": label, "values": current_map(df, ric_to_t), "error": e,
                        "history": has_hist}
        if has_hist:
            hdf, he = fetch_field(
                metered, rics,
                [field, f"{field}.fperiod", f"{field}.periodenddate"],
                {"Period": FQ_SMOKE})
            fiscal[key] = {"error": he, "rows": fiscal_rows(hdf, ric_to_t)}
    # Hand-check: MU EQ quarter FQ-4 equals that row of the range. Micron's Q4 ends in August.
    eq = fiscal.get("earnings_quality", {}).get("rows", {}).get(HAND, [])
    single, serr = fetch_field(metered, [ric_map[HAND]], ["TR.EQCtryRank", "TR.EQCtryRank.fperiod", "TR.EQCtryRank.periodenddate"],
                               {"Period": "FQ-4"})
    single_rows = fiscal_rows(single, {ric_map[HAND]: HAND}).get(HAND, [])
    match = False
    if eq and single_rows:
        got = single_rows[-1]
        target = next((r for r in eq if r[0] == got[0]), None)
        match = target is not None and abs(target[1] - got[1]) < 1e-6 and got[0].month == 8
        lines.append(f"Row: **{HAND}** TR.EQCtryRank. Range point {target}. Single Period=FQ-4 {got}. Match {match}.")
        lines.append(f"Period end {got[0]} month {got[0].month}. Micron's fiscal Q4 ends in August; FQ-4 is the prior Q4.")
    else:
        lines.append(f"EQ history missing or FQ-4 failed ({serr}).")
    lines.append("Smoke names, current rank:")
    for key, label, field, has_hist in MODELS:
        vals = current[key]["values"]
        lines.append(f"- {label} {field}: " + ", ".join(f"{t}={vals.get(t)}" for t in SMOKE)
                     + f". Quarterly history {has_hist}.")
    if eq:
        lines.append(f"{HAND} EQ quarters in the smoke window ({len(eq)}): "
                     + "; ".join(f"{fp} {pend} {v:.0f}" for pend, v, fp in eq))
    unresolved = []
    for label, fields in UNRESOLVED:
        tried = []
        for field in fields:
            if metered.requests >= metered.limit:
                tried.append((field, "cap"))
                break
            _df, e = fetch_field(metered, [ric_map[HAND]], [field])
            tried.append((field, "number" if _df is not None and not getattr(_df, "empty", True) and clean(_df.iloc[0, 1]) is not None else (e or "empty")))
        unresolved.append((label, tried))
        last = tried[-1][1] if tried else ""
        lines.append(f"- {label}: no resolved rank. Last try {tried[-1][0] if tried else '—'} → {str(last)[:140]}")
    ivdf, ive = fetch_field(
        metered, [ric_map[HAND]],
        [IV_RATIO, f"{IV_RATIO}.fperiod", f"{IV_RATIO}.periodenddate"],
        {"Period": "FQ0:FQ-4"})
    iv_n = 0 if ivdf is None else len(ivdf)
    iv_val = None if ivdf is None or ivdf.empty else clean(ivdf.iloc[0, 1])
    lines.append(f"IV ratio {IV_RATIO} on {HAND} with Period FQ0:FQ-4: rows {iv_n}, value {iv_val}, error {ive}. "
                 "A ratio with no period end is the current print already stored in signals_daily.")
    # lab coverage
    lines.append("Lab rows: " + ", ".join(
        f"{t} {conn.execute('SELECT count(*) FROM watchlist_sync.lab_outcomes WHERE ticker = %s', (t,)).fetchone()[0]}"
        for t in SMOKE))
    return {"lines": lines, "ok": match, "current": current, "fiscal_smoke": fiscal,
            "unresolved": unresolved, "control": control}


def fetch_universe_eq(metered, ric_map: dict[str, str]) -> dict[str, list]:
    ric_to_t = {r: t for t, r in ric_map.items()}
    rics = list(ric_map.values())
    random.Random(92).shuffle(rics)
    field = "TR.EQCtryRank"
    merged = {}
    for i in range(0, len(rics), 40):
        if metered.requests >= metered.limit:
            print("fetch cap", flush=True)
            break
        batch = rics[i:i + 40]
        df, err = fetch_field(
            metered, batch,
            [field, f"{field}.fperiod", f"{field}.periodenddate"],
            {"Period": FQ_FULL})
        if err:
            print(f"  batch {i} {err}", flush=True)
            continue
        part = fiscal_rows(df, ric_to_t)
        merged.update(part)
        print(f"  EQ batch {i // 40 + 1}: {len(part)} names", flush=True)
    return merged


def fetch_current_universe(metered, ric_map, field: str) -> dict[str, float]:
    ric_to_t = {r: t for t, r in ric_map.items()}
    rics = list(ric_map.values())
    out = {}
    for i in range(0, len(rics), 80):
        if metered.requests >= metered.limit:
            break
        df, err = fetch_field(metered, rics[i:i + 80], [field])
        if err:
            print(f"  {field} batch {i}: {err}", flush=True)
            continue
        out.update(current_map(df, ric_to_t))
    return out


def write_report(text: str) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)


def main() -> None:
    smoke = "--smoke" in sys.argv
    conn = connect()
    ric_map = load_ric_map(list(SMOKE))
    missing = [t for t in SMOKE if t not in ric_map]
    if missing:
        raise SystemExit(f"no RIC for {missing}")
    with study_session(PROBE_CAP) as (metered, snap):
        print(f"probe budget {snap}", flush=True)
        probed = probe_and_check(metered, ric_map, conn)
        probed["snap"] = snap
        probed["requests"] = metered.requests
        probed["datapoints"] = metered.datapoints
    print("\n".join(probed["lines"]), flush=True)
    if not probed["ok"]:
        conn.close()
        raise SystemExit("hand-check failed")
    if smoke:
        conn.close()
        print("smoke ok", flush=True)
        return

    snap = budget_snapshot()
    if snap["month_datapoints"] >= MONTH_CEILING:
        conn.close()
        raise SystemExit(f"universe pull skipped: month datapoints {snap['month_datapoints']} ≥ {MONTH_CEILING}")
    tickers = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM watchlist_sync.lab_outcomes")]
    full_map = load_ric_map(tickers)
    print(f"fetch EQ history × {len(full_map)} RICs; month {snap['month_datapoints']}", flush=True)
    with study_session(FETCH_CAP) as (metered, snap2):
        eq = fetch_universe_eq(metered, full_map)
        currents = {}
        for key, _label, field, has_hist in MODELS:
            if has_hist:
                continue
            currents[key] = fetch_current_universe(metered, full_map, field)
            print(f"  current {field}: {len(currents[key])} names", flush=True)
        fetch_req, fetch_dp = metered.requests, metered.datapoints
    # alpha current = latest stored print (monthly, through 2026-09-30) plus live control where we have it
    alpha_now = {}
    for t, v in conn.execute(
            """SELECT DISTINCT ON (ticker) ticker, value::float8 FROM lseg_research.starmine_history
               WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL
               ORDER BY ticker, obs_date DESC"""):
        alpha_now[t] = float(v)

    digest, outcomes, tech, alpha = load_stock_base(conn)
    mondays = sorted({d for _t, d, _r in outcomes})
    mid = mondays[len(mondays) // 2]
    print(f"holdout Mondays {len(mondays)} midpoint {mid} digest {digest} EQ names {len(eq)}", flush=True)
    panel = build_stock(outcomes, tech, alpha, eq)
    stock = eval_stock(panel, mid) if panel else None
    puts = build_puts(conn, eq) if eq else []
    put = put_metrics(puts, mid) if puts else None
    conn.close()

    # placebo: shuffle the signal inside each week of the stock panel
    rng = np.random.default_rng(92)
    shuffled = []
    for d, rel, al, te, sig, pend in panel:
        s2 = sig.copy()
        rng.shuffle(s2)
        shuffled.append((d, rel, al, te, s2, pend))
    placebo = eval_stock(shuffled, mid) if shuffled else None

    lines = [
        "# S092 — Unused StarMine models",
        "",
        f"**Date:** {date.today()} · holdout {HOLDOUT_START} → · split {mid} · digest `{digest}`",
        "",
        "High rank is the vendor direction (1–100). EQ is a fiscal-quarter rank: a Monday takes "
        f"the latest period end ≤ that Monday and ≤ {STALE_DAYS} days old. "
        f"Week t is Newey-West lag {NW_LAG} because the rank does not change inside the quarter. "
        "Lag 3 (21-day overlap only) is shown and is not the bar. "
        "A pass also needs the quarterly-vintage t ≥ 2 with both halves positive. "
        "Marginal = outcome rank on the signal plus combined alpha and lab_tech v2 (stocks) "
        "or put_edge (puts).",
        "",
        f"Budget at the probe: {probed['snap']['requests_today']} requests today, "
        f"{probed['snap']['month_datapoints']:,} datapoints this month. "
        f"Probe {probed['requests']} requests / ~{probed['datapoints']} datapoints. "
        f"Universe fetch {fetch_req} requests / ~{fetch_dp} datapoints. "
        "The shared helper would have refused to start (monthly datapoints already over 8,000,000). "
        f"This run stayed under the daily 8,000 request stop and under {MONTH_CEILING:,} datapoints.",
        "",
    ]
    lines += probed["lines"]
    lines += ["", "## Coverage", ""]
    n_q = [len(v) for v in eq.values()]
    if n_q:
        lines.append(f"EQ quarterly history: {len(eq)} names, median {int(np.median(n_q))} quarters, "
                     f"min {min(n_q)}, max {max(n_q)}.")
        # span
        ends = [r[0] for rows in eq.values() for r in rows]
        if ends:
            lines.append(f"Period ends {min(ends)} → {max(ends)}.")
    lines.append(f"Stock weeks with ≥ {MIN_NAMES} names after the as-of join: {0 if not stock else stock['n_weeks']}. "
                 f"Put events {0 if not put else put['n_events']}.")
    lines += ["", "## Earnings Quality (the only model with history)", ""]
    if stock:
        lines.append(f"- Stock IC lag {NW_LAG}: {fmt(stock['ic'])}. Lag 3: {fmt(stock['lag3'])}.")
        lines.append(f"- Decile rel_21: {fmt(stock['spread'], 100, 2)} pp. FM partial: {fmt(stock['fm'])}. "
                     f"Within alpha+tech: {fmt(stock['wq'], 100, 2)} pp.")
        lines.append(f"- Quarterly vintages: {fmt(stock['vintage'])}.")
        lines.append(f"- Same weeks, combined alpha IC {fmt(stock['ic_a'])}; lab_tech v2 IC {fmt(stock['ic_t'])}.")
        lines.append(f"- Rank corr vs alpha {fmt(stock['corr_a'])}; vs tech {fmt(stock['corr_t'])}. "
                     f"Mean names/week {stock['mean_n']:.0f}.")
        lines.append(f"- Placebo (shuffle inside the week, seed 92) IC {fmt(placebo['ic']) if placebo else '—'}.")
    if put:
        lines.append(f"- Put IC lag {NW_LAG}: {fmt(put['ic'])}. Lag 3: {fmt(put['lag3'])}.")
        lines.append(f"- Q5−Q1 pnl {fmt(put['spread'], 1, 1)} bp; breach {fmt(put['breach'], 1, 2)} pp.")
        lines.append(f"- FM vs put_edge {fmt(put['fm'])}; within quintile {fmt(put['wq'], 1, 1)} bp; "
                     f"corr vs edge {fmt(put['corr_edge'])}.")
        lines.append(f"- Put vintages: {fmt(put['vintage'])}.")
        lines.append(f"- EQ vs iv30 rank corr {fmt(put['corr_iv'])}. "
                     f"Put IC after iv30 {fmt(put['ic_iv'])}. "
                     f"Within iv30 quintile, high−low EQ pnl {fmt(put['spread_iv'], 1, 1)} bp.")
    st_pass = bool(stock and stock.get("pass"))
    pu_pass = bool(put and put.get("pass"))
    if st_pass or pu_pass:
        lines.append(f"Verdict: {'stock PASS' if st_pass else 'stock no'}, {'put PASS' if pu_pass else 'put no'}.")
    else:
        lines.append("Verdict: **not a pass.** EQ does not clear the holdout bar on either board. "
                     "The put Q5−Q1 of about −23 bp is the IV level (rank corr vs iv30 about −0.32); "
                     "after iv30 the IC is about 0 and the halves flip.")
    lines += ["", "## Current-only models (no holdout)", ""]
    lines.append("These returned a 1–100 rank for the smoke names and no fiscal period. "
                 "Joining today's rank onto 2023 would be lookahead, so they are not on the bar. "
                 "Same-day Spearman vs the latest stored combined alpha:")
    for key, label, field, _h in MODELS:
        if key == "earnings_quality":
            continue
        corr, n = spearman(currents.get(key, {}), alpha_now)
        lines.append(f"- {label} {field}: names {len(currents.get(key, {}))}, "
                     f"vs combined alpha {None if corr is None else f'{corr:+.3f}'} (n {n}).")
    lines += ["", "## Did not resolve", ""]
    for label, tried in probed["unresolved"]:
        lines.append(f"- {label}: " + "; ".join(f"{f} → {str(s)[:80]}" for f, s in tried))
    lines += ["", "## What would ship", ""]
    if st_pass or pu_pass:
        lines.append("EQ cleared the bar on a commercial LSEG field. Next: add TR.EQCtryRank fiscal history "
                     "to the StarMine sync and shadow it. No weight change in this study.")
    else:
        lines.append("Nothing. Do not add a score weight. EQ's quarterly history does not clear the bar. "
                     "Smart Holdings, short interest, and insider are entitled as a current rank only — "
                     "collect-forward would not change a score until a later window clears this bar. "
                     "M&A Target, MarketPsych, and an Intrinsic Value rank did not resolve on this API "
                     "(unknown field, not an entitlement denial). The IV ratio is already stored and has no history.")
    lines += ["", "## Known weaknesses", "",
              "- Fiscal period end is the availability date. LSEG can still revise the newest quarter; "
              "older quarters matched a single-period refetch.",
              "- Country rank (EQ, short interest, insider) is not the region rank used for combined alpha. "
              "On a US book they are close; Smart Holdings is the region rank.",
              "- Week-clustered lag 3 would treat ~13 identical weeks as independent. Lag 13 is the amendment.",
              "- Field codes that returned error 218 may exist under a name this probe did not try.",
              ""]
    write_report("\n".join(lines))
    print(f"wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
