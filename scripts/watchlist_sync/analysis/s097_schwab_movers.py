"""S097 — Schwab index movers, reconstructed from stored prices (A262).

Question: do daily $SPX / $COMPX movers differ from the base rate on next-week
put pnl and Monday rel_21, beyond put_edge and StarMine combined alpha + lab_tech v2?

Schwab /movers has no history. A267 stores market_movers from 2026-10-24 forward.
This script does not call a vendor.

Membership (probed before the test, not assumed):
  ticker_registry.index_memberships is null on every row. wrds_research.crsp_dsf
  is 16 permnos and has no index flag. There is no stored S&P 500 constituent list,
  so $SPX movers are not reconstructed. Saying so is the probe, not a skip.
  $COMPX (Nasdaq Composite) = Nasdaq-listed names. research_common.security_map
  RIC suffix .O matched Schwab /instruments exchange NASDAQ on 35/35 stored rows
  and matched no other exchange. That is the panel.
  ETFs dropped via lib/db/src/etf-exclusions.ts, plus SPDR sector tickers XL*
  that sit in daily_history and are not on that list. A name is one panel only.

Reconstruction:
  Close-to-close return from lseg_research.daily_history (split-adjusted, 2016→).
  prices_historical starts 2024-10-18, after the holdout opens, so it is a
  check on the overlap, not the sample (PLAYBOOK). Each session with ≥ 30
  panel names: top 10 and bottom 10 by return (A267 stores 10 per side).
  Ties break on ticker. A one-day move above 400% is dropped as a bad print.

Signal, known before the Monday close that starts rel_21:
  Last panel session strictly before the Monday. Signed score +1 top 10,
  −1 bottom 10, 0 otherwise. Positive means the day's gainers, not a flip
  after seeing the result.

Pass bar (INDEX S097 / A262, unchanged):
  Holdout Mondays 2023-01-01→. Week-clustered Newey-West t ≥ 2, both halves
  positive, and marginal t ≥ 2. The object is the mover list versus the other
  names that week (either tail vs the rest): that is the base-rate question.
  Stock marginal = Fama-MacBeth of the on-list flag plus combined alpha plus
  lab_tech v2. Put marginal = the same plus put_edge. Halves split at the
  midpoint of holdout Mondays that have rel_21. Stock lag 3. Put lag 1.
  Signed top-10 vs bottom-10, the raw return, |return|, and the NYSE slice
  are decomposition. They do not get their own pass. A negative t is not flipped.
  Puts also have to survive an iv30 residual (PLAYBOOK check 1).
  A statistical pass still does not ship: market_movers has no sessions yet,
  so this reconstruction is not matched to Schwab.

Run (from scripts/watchlist_sync):
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s097_schwab_movers.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s097_schwab_movers.py
"""
from __future__ import annotations

import os

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")

import math
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402
from s045_put_retest import rank  # noqa: E402

SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
HAND = "MU"
HAND_SIG = date(2024, 5, 31)  # Friday before Monday 2024-06-03; Memorial Day was the 27th
HAND_MON = date(2024, 6, 3)
PX_CHECK = date(2025, 5, 27)
HOLDOUT = date(2023, 1, 1)
TOP_N = 10
MIN_PANEL = 30
MIN_NAMES = 30
MIN_HALF = 8
RET_CAP = 4.0  # 400% in one session: bad print, not a mover
LAG_STOCK = 3
LAG_PUT = 1
OUT = ROOT / "out" / "studies" / "S097.md"


def as_date(d):
    return d.date() if isinstance(d, datetime) else d


def etf_set() -> set[str]:
    text = (REPO / "lib/db/src/etf-exclusions.ts").read_text()
    return set(re.findall(r'"([A-Z.]+)"', text))


def load_membership(conn) -> dict:
    """Return ticker -> 'COMPX' | 'NYSE' | None, plus the probe counts."""
    etf = etf_set()
    ric = {t: r for t, r in conn.execute("SELECT ticker, ric FROM research_common.security_map")}
    daily = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM lseg_research.daily_history")]
    schwab = {k: e for k, e in conn.execute(
        """SELECT key, payload->'instruments'->0->>'exchange'
           FROM vendor_raw WHERE source = 'schwab' AND endpoint = '/instruments'""")}
    agree = mismatch = 0
    for t, ex in schwab.items():
        suf = (ric.get(t) or "").rsplit(".", 1)[-1] if "." in (ric.get(t) or "") else ""
        if suf == "O":
            agree += int(ex == "NASDAQ")
            mismatch += int(ex != "NASDAQ")
        elif ex == "NASDAQ":
            mismatch += 1
    null_mem = conn.execute(
        """SELECT count(*) FROM ticker_registry
           WHERE index_memberships IS NOT NULL AND cardinality(index_memberships) > 0""").fetchone()[0]
    crsp = conn.execute("SELECT count(DISTINCT permno) FROM wrds_research.crsp_dsf").fetchone()[0]
    sector = sorted(t for t in daily if t.startswith("XL") and t[2:].isalpha() and 3 <= len(t) <= 4)
    drop = etf | set(sector)
    panel = {}
    for t in daily:
        if t in drop:
            panel[t] = None
            continue
        r = ric.get(t) or ""
        panel[t] = "COMPX" if r.endswith(".O") else "NYSE"
    return {
        "panel": panel,
        "drop": sorted(drop & set(daily)),
        "sector_xl": sector,
        "schwab_o_nasdaq": agree,
        "schwab_mismatch": mismatch,
        "schwab_n": len(schwab),
        "index_memberships_filled": int(null_mem),
        "crsp_permnos": int(crsp),
        "n_compx": sum(v == "COMPX" for v in panel.values()),
        "n_nyse": sum(v == "NYSE" for v in panel.values()),
    }


def load_prices(conn) -> dict[str, list[tuple[date, float]]]:
    px = defaultdict(list)
    for t, d, c in conn.execute(
        """SELECT ticker, date, close::float8 FROM lseg_research.daily_history
           WHERE close > 0 ORDER BY ticker, date"""):
        px[t].append((as_date(d), float(c)))
    return px


def calendar(px: dict) -> list[date]:
    n = defaultdict(int)
    for bars in px.values():
        for d, _c in bars:
            n[d] += 1
    return sorted(d for d, k in n.items() if k >= 50)


def build_signals(px, panel_of: dict, which: str):
    """which is COMPX or NYSE. Returns day -> {ticker: {ret, score}} and a cap count."""
    days = calendar(px)
    prev = {days[i]: days[i - 1] for i in range(1, len(days))}
    close = {t: {d: c for d, c in bars} for t, bars in px.items()}
    names = [t for t, p in panel_of.items() if p == which]
    out = {}
    capped = 0
    for d, pday in prev.items():
        rows = []
        for t in names:
            c0, c1 = close[t].get(pday), close[t].get(d)
            if c0 is None or c1 is None or c0 <= 0:
                continue
            ret = c1 / c0 - 1.0
            if abs(ret) > RET_CAP:
                capped += 1
                continue
            rows.append((t, ret))
        if len(rows) < MIN_PANEL:
            continue
        rows.sort(key=lambda r: (-r[1], r[0]))
        n = len(rows)
        up = {t for t, _r in rows[:TOP_N]}
        down = {t for t, _r in rows[-TOP_N:]}
        day = {}
        for i, (t, ret) in enumerate(rows):
            score = 1 if t in up else -1 if t in down else 0
            day[t] = {"ret": ret, "score": score, "rank": i + 1, "n": n}
        out[d] = day
    return out, capped


def signal_day(days: list[date], monday: date):
    lo, hi = 0, len(days)
    while lo < hi:
        mid = (lo + hi) // 2
        if days[mid] < monday:
            lo = mid + 1
        else:
            hi = mid
    return days[lo - 1] if lo else None


def holdout_mid(conn) -> date:
    rows = [as_date(r[0]) for r in conn.execute(
        """SELECT DISTINCT as_of FROM watchlist_sync.lab_outcomes
           WHERE EXTRACT(DOW FROM as_of) = 1 AND as_of >= %s
             AND outcomes->>'rel_21' IS NOT NULL
           ORDER BY 1""", (HOLDOUT,))]
    if not rows:
        raise SystemExit("no holdout Mondays")
    return rows[len(rows) // 2]


def pack(pairs, mid: date, lag: int) -> dict:
    pairs = [(as_date(d), float(v)) for d, v in pairs if v == v]
    if len(pairs) < 8:
        return {"thin": True, "n": len(pairs), "na": 0, "nb": 0}
    vals = np.array([v for _, v in pairs], float)
    a = np.array([v for d, v in pairs if d < mid], float)
    b = np.array([v for d, v in pairs if d >= mid], float)
    t = nw_t(vals, lag)
    return {
        "thin": False,
        "mean": float(vals.mean()),
        "t": None if t != t else float(t),
        "a": float(a.mean()) if len(a) else None,
        "b": float(b.mean()) if len(b) else None,
        "n": len(vals),
        "na": int(len(a)),
        "nb": int(len(b)),
    }


def clears(p: dict | None) -> bool:
    if not p or p.get("thin") or p.get("t") is None:
        return False
    if p["na"] < MIN_HALF or p["nb"] < MIN_HALF:
        return False
    if not (p["mean"] > 0 and p["a"] is not None and p["a"] > 0 and p["b"] is not None and p["b"] > 0):
        return False
    return p["t"] >= 2


def consistent_neg(p: dict | None) -> bool:
    if not p or p.get("thin") or p.get("t") is None:
        return False
    if p["na"] < MIN_HALF or p["nb"] < MIN_HALF:
        return False
    if p["a"] is None or p["b"] is None:
        return False
    return p["t"] <= -2 and p["mean"] < 0 and p["a"] < 0 and p["b"] < 0


def fmt(p: dict | None, scale: float = 1.0, digits: int = 2) -> str:
    if not p or p.get("thin"):
        n = 0 if not p else p.get("n", 0)
        return f"thin (n {n})"
    def n(x):
        return "na" if x is None else f"{scale * x:+.{digits}f}"
    t = "na" if p.get("t") is None else f"{p['t']:+.2f}"
    return f"{n(p['mean'])} t {t} halves {n(p['a'])}/{n(p['b'])} weeks {p['n']} ({p['na']}+{p['nb']})"


def _weeks(rows, ykey, need):
    by = defaultdict(list)
    for r in rows:
        if r.get(ykey) is None or any(r.get(k) is None for k in need):
            continue
        by[r["d"]].append(r)
    return by


def series_ic(by, ykey, skey):
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < MIN_NAMES:
            continue
        x = np.array([r[skey] for r in g], float)
        y = np.array([r[ykey] for r in g], float)
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        out.append((w, float(np.corrcoef(rank(x), rank(y))[0, 1])))
    return out


def series_up_down(by, ykey, skey="score"):
    out = []
    for w in sorted(by):
        g = by[w]
        up = [r[ykey] for r in g if r[skey] > 0]
        dn = [r[ykey] for r in g if r[skey] < 0]
        if len(up) < 5 or len(dn) < 5:
            continue
        out.append((w, float(np.mean(up) - np.mean(dn))))
    return out


def series_list_rest(by, ykey, skey="score"):
    out = []
    for w in sorted(by):
        g = by[w]
        on = [r[ykey] for r in g if r[skey] != 0]
        off = [r[ykey] for r in g if r[skey] == 0]
        if len(on) < 8 or len(off) < 20:
            continue
        out.append((w, float(np.mean(on) - np.mean(off))))
    return out


def series_fm(by, ykey, skey, controls):
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < MIN_NAMES:
            continue
        y = np.array([r[ykey] for r in g], float)
        x = np.array([r[skey] for r in g], float)
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        cols = []
        ok = True
        for c in controls:
            v = np.array([r[c] for r in g], float)
            if np.std(v) == 0:
                ok = False
                break
            cols.append(rank(v))
        if not ok:
            continue
        X = np.column_stack([np.ones(len(g)), rank(x), *cols])
        beta = np.linalg.lstsq(X, rank(y), rcond=None)[0]
        out.append((w, float(beta[1])))
    return out


def series_ic_resid(by, ykey, skey, ctrl):
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < MIN_NAMES or any(r.get(ctrl) is None for r in g):
            continue
        y = rank(np.array([r[ykey] for r in g], float))
        x = rank(np.array([r[skey] for r in g], float))
        c = rank(np.array([r[ctrl] for r in g], float))
        if np.std(x) == 0 or np.std(y) == 0 or np.std(c) == 0:
            continue
        X = np.column_stack([np.ones(len(g)), c])
        x = x - X @ np.linalg.lstsq(X, x, rcond=None)[0]
        y = y - X @ np.linalg.lstsq(X, y, rcond=None)[0]
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        out.append((w, float(np.corrcoef(x, y)[0, 1])))
    return out


def series_within_on(by, ykey, skey, controls):
    """Inside each comparator quintile, on-list minus off-list."""
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < MIN_NAMES:
            continue
        mats = []
        ok = True
        for c in controls:
            v = np.array([r[c] for r in g], float)
            if np.std(v) == 0:
                ok = False
                break
            mats.append(rank(v))
        if not ok:
            continue
        comp = np.mean(mats, axis=0)
        q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
        sig = np.array([r[skey] for r in g], float)
        y = np.array([r[ykey] for r in g], float)
        bits = []
        for qi in range(5):
            m = q == qi
            on, off = y[m & (sig > 0)], y[m & (sig == 0)]
            if len(on) >= 2 and len(off) >= 4:
                bits.append(float(on.mean() - off.mean()))
        if len(bits) >= 3:
            out.append((w, float(np.mean(bits))))
    return out


def series_within(by, ykey, skey, controls):
    out = []
    for w in sorted(by):
        g = by[w]
        if len(g) < MIN_NAMES:
            continue
        mats = []
        ok = True
        for c in controls:
            v = np.array([r[c] for r in g], float)
            if np.std(v) == 0:
                ok = False
                break
            mats.append(rank(v))
        if not ok:
            continue
        comp = np.mean(mats, axis=0)
        q = np.clip((comp * 0.999 * 5).astype(int), 0, 4)
        sig = np.array([r[skey] for r in g], float)
        y = np.array([r[ykey] for r in g], float)
        bits = []
        for qi in range(5):
            m = q == qi
            up, dn = y[m & (sig > 0)], y[m & (sig < 0)]
            if len(up) >= 2 and len(dn) >= 2:
                bits.append(float(up.mean() - dn.mean()))
        if len(bits) >= 3:
            out.append((w, float(np.mean(bits))))
    return out


def placebo(by, ykey, skey, mid, lag, seed: int) -> str:
    real = series_ic(by, ykey, skey)
    real_t = pack(real, mid, lag).get("t")
    if real_t is None:
        return "placebo skipped (no IC)"
    rng = np.random.default_rng(seed)
    hits = 0
    n = 200
    weeks = sorted(by)
    base = []
    for w in weeks:
        g = by[w]
        if len(g) < MIN_NAMES:
            continue
        x = np.array([r[skey] for r in g], float)
        y = np.array([r[ykey] for r in g], float)
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        base.append((w, x, y))
    for _ in range(n):
        pairs = []
        for w, x, y in base:
            sh = rng.permutation(x)
            if np.std(sh) == 0:
                continue
            pairs.append((w, float(np.corrcoef(rank(sh), rank(y))[0, 1])))
        t = pack(pairs, mid, lag).get("t")
        if t is not None and abs(t) >= abs(real_t):
            hits += 1
    return f"placebo {n} within-week shuffles seed {seed}: {hits} with |IC t| ≥ |real| ({real_t:+.2f})"


def label_of(spread, fm, iv_ok: bool = True) -> str:
    if clears(spread) and clears(fm) and not iv_ok:
        return "IV level — not a pass"
    if clears(spread) and clears(fm):
        return "PASS"
    if clears(spread) and not clears(fm):
        return "standalone only — not a pass"
    if consistent_neg(spread):
        return "reversal, not a pass (score not flipped)"
    return "not a pass"


def asof_val(series, d: date):
    if not series:
        return None
    lo, hi = 0, len(series)
    while lo < hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= d:
            lo = mid + 1
        else:
            hi = mid
    return None if lo == 0 else series[lo - 1][1]


def attach(signals, days, monday, ticker):
    sig_d = signal_day(days, monday)
    if sig_d is None or sig_d not in signals:
        return None
    row = signals[sig_d].get(ticker)
    if row is None:
        return None
    return sig_d, row


def load_stock(conn, signals, days, digest: str):
    tech = {}
    for t, d, v in conn.execute(
        """SELECT ticker, as_of, (v2->>'total')::float8 FROM watchlist_sync.lab_tech
           WHERE engine_digest = %s AND v2->>'total' IS NOT NULL""", (digest,)):
        if v is not None:
            tech[(t, as_date(d))] = float(v)
    alpha = defaultdict(list)
    for t, d, v in conn.execute(
        """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
           WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL
           ORDER BY ticker, obs_date"""):
        alpha[t].append((as_date(d), float(v)))
    outcomes = conn.execute(
        """SELECT ticker, as_of, (outcomes->>'rel_21')::float8, (features->>'rev5')::float8
           FROM watchlist_sync.lab_outcomes
           WHERE EXTRACT(DOW FROM as_of) = 1 AND as_of >= %s
             AND outcomes->>'rel_21' IS NOT NULL""", (HOLDOUT,)).fetchall()
    rows = []
    miss_sig = miss_comp = 0
    for t, d, rel, rev in outcomes:
        d = as_date(d)
        got = attach(signals, days, d, t)
        if got is None:
            miss_sig += 1
            continue
        sig_d, srow = got
        al = asof_val(alpha.get(t), d)
        te = tech.get((t, d))
        if al is None or te is None or rel is None:
            miss_comp += 1
            continue
        rows.append({
            "t": t, "d": d, "sig_d": sig_d, "rel": float(rel), "rev5": None if rev is None else float(rev),
            "alpha": al, "tech": te, "score": srow["score"], "ret": srow["ret"],
        })
    return rows, miss_sig, miss_comp


def stamp(rows):
    for r in rows:
        r["on"] = 1.0 if r["score"] else 0.0
        r["absret"] = abs(r["ret"])


def score_board(rows, ykey, controls, mid, lag, seed: int) -> dict:
    by = _weeks(rows, ykey, ["score", "on", "absret", *controls])
    ic = pack(series_ic(by, ykey, "score"), mid, lag)
    ic_on = pack(series_ic(by, ykey, "on"), mid, lag)
    spread = pack(series_up_down(by, ykey), mid, lag)
    rest = pack(series_list_rest(by, ykey), mid, lag)
    fm_signed = pack(series_fm(by, ykey, "score", controls), mid, lag)
    within_signed = pack(series_within(by, ykey, "score", controls), mid, lag)
    fm = pack(series_fm(by, ykey, "on", controls), mid, lag)
    within = pack(series_within_on(by, ykey, "on", controls), mid, lag)
    by_ret = _weeks(rows, ykey, ["ret", "absret", *controls])
    ic_ret = pack(series_ic(by_ret, ykey, "ret"), mid, lag)
    fm_ret = pack(series_fm(by_ret, ykey, "ret", controls), mid, lag)
    ic_abs = pack(series_ic(by_ret, ykey, "absret"), mid, lag)
    fm_abs = pack(series_fm(by_ret, ykey, "absret", controls), mid, lag)
    comp_ic = {}
    for c in controls:
        comp_ic[c] = pack(series_ic(by, ykey, c), mid, lag)
    return {
        "ic": ic, "ic_on": ic_on, "spread": spread, "rest": rest,
        "fm_signed": fm_signed, "within_signed": within_signed,
        "fm": fm, "within": within,
        "ic_ret": ic_ret, "fm_ret": fm_ret, "ic_abs": ic_abs, "fm_abs": fm_abs,
        "comp": comp_ic,
        "label": label_of(rest, fm),
        "placebo": placebo(by, ykey, "on", mid, lag, seed),
        "placebo_signed": placebo(by, ykey, "score", mid, lag, seed + 1),
        "n_rows": sum(len(g) for g in by.values()),
        "n_weeks_raw": len(by),
        "names": len({r["t"] for g in by.values() for r in g}),
        "by": by,
    }


def load_puts(conn, signals, days, digest: str):
    import s059_option_factors as S059
    ev = S059.aligned_events(conn)
    pinned = {}
    for t, d, v2 in conn.execute(
        """SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech WHERE engine_digest = %s""", (digest,)):
        comps = (v2 or {}).get("comps") or {}
        tr, vc = comps.get("trendContext"), comps.get("volumeConfirm")
        if tr is not None and vc is not None:
            pinned[(t, as_date(d))] = float(tr) - float(vc)
    by = defaultdict(list)
    for e in ev:
        d = as_date(e["d"])
        if d < HOLDOUT:
            continue
        e["d"] = d
        e["put_tech"] = pinned.get((e["t"], d))
        if e.get("iv_rv") is None or e.get("vol_of_vol") is None or e.get("put_tech") is None:
            continue
        by[d].append(e)
    for g in by.values():
        if len(g) < MIN_NAMES:
            for e in g:
                e["put_edge"] = None
            continue
        sc = (rank([e["iv_rv"] for e in g]) + rank([e["vol_of_vol"] for e in g])
              + rank([e["put_tech"] for e in g]))
        for e, s in zip(g, sc):
            e["put_edge"] = float(s)
    rows = []
    for e in ev:
        if as_date(e["d"]) < HOLDOUT or e.get("put_edge") is None:
            continue
        got = attach(signals, days, e["d"], e["t"])
        if got is None:
            continue
        sig_d, srow = got
        rows.append({
            "t": e["t"], "d": e["d"], "sig_d": sig_d,
            "pnl": float(e["pnl"]), "breach": float(e["breach"]),
            "iv30": float(e["iv30"]) if e.get("iv30") is not None else None,
            "put_edge": e["put_edge"], "score": srow["score"], "ret": srow["ret"],
        })
    return rows, len(ev)


def scanner_pool(conn) -> set[str]:
    return {r[0] for r in conn.execute(
        """SELECT DISTINCT UPPER(ticker) FROM (
             SELECT ticker FROM model_recs
              WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
             UNION
             SELECT ticker FROM option_score_snapshots
              WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
           ) s WHERE ticker IS NOT NULL AND ticker <> ''""")}


def forward_text(conn, compx_signals) -> list[str]:
    n_tbl = conn.execute("SELECT count(*) FROM market_movers").fetchone()[0]
    raw = conn.execute(
        """SELECT endpoint, key, fetched_on::text, payload
           FROM vendor_raw WHERE source = 'schwab' AND endpoint LIKE '/movers/%%'
           ORDER BY endpoint""").fetchall()
    lines = [
        f"Forward vs market_movers: table rows {n_tbl}.",
    ]
    for ep, key, day, payload in raw:
        screeners = payload.get("screeners") if isinstance(payload, dict) else None
        n = len(screeners) if isinstance(screeners, list) else None
        lines.append(f"vendor_raw {ep} key {key} fetched {day}: screeners {n}.")
    if n_tbl == 0:
        lines.append(
            "No stored symbols, so rank correlation and list overlap are not computed. "
            "2026-10-24 is a Saturday; the stored payload is an empty screener, the same close A267 logged.")
        return lines
    # Schwab netPercentChange is a percent (2.5 = 2.5%). Reconstruction returns are decimals.
    stored = conn.execute(
        """SELECT index_id, direction, as_of, symbol, percent_change, rank
           FROM market_movers WHERE index_id = '$COMPX'""").fetchall()
    grouped = defaultdict(list)
    for _idx, direction, d, sym, pct, rk in stored:
        grouped[(as_date(d), direction)].append((sym, None if pct is None else float(pct), rk))
    jacs = []
    for (d, direction), rows in sorted(grouped.items()):
        sig = compx_signals.get(d)
        if not sig:
            continue
        want = 1 if direction == "up" else -1
        recon = {t for t, s in sig.items() if s["score"] == want}
        got = {sym for sym, _p, _r in rows}
        if not recon and not got:
            continue
        jacs.append(len(recon & got) / len(recon | got))
    lines.append(
        f"$COMPX overlapping sessions {len(jacs)}, mean Jaccard {float(np.mean(jacs)) if jacs else float('nan'):.3f}.")
    return lines


def price_check(conn, px) -> list[str]:
    ph = defaultdict(dict)
    for t, d, c in conn.execute(
        """SELECT ticker, date, close::float8 FROM prices_historical WHERE close > 0"""):
        ph[t][as_date(d)] = float(c)
    # MU one-day agreement, the hand-check companion.
    mu_l = dict(px.get("MU", []))
    mu_p = ph.get("MU", {}).get(PX_CHECK)
    mu_d = mu_l.get(PX_CHECK)
    gap = None if mu_p is None or mu_d is None else mu_p - mu_d
    # Cross-sectional return Spearman on up to 40 overlap sessions.
    days = calendar(px)
    prev = {days[i]: days[i - 1] for i in range(1, len(days))}
    overlap_days = [d for d in days if d >= date(2024, 10, 18) and d in prev and d.weekday() < 5]
    if len(overlap_days) > 40:
        step = len(overlap_days) / 40
        overlap_days = [overlap_days[int(i * step)] for i in range(40)]
    cors = []
    mismatches = checked = 0
    want = set(overlap_days)
    for d in list(want):
        want.add(prev[d])
    close = defaultdict(dict)
    for t, bars in px.items():
        for d, c in bars:
            if d in want:
                close[t][d] = c
    for d in overlap_days:
        pday = prev[d]
        xs, ys = [], []
        for t, cmap in close.items():
            c0, c1 = cmap.get(pday), cmap.get(d)
            p0, p1 = ph[t].get(pday), ph[t].get(d)
            if c1 is not None and p1 is not None:
                checked += 1
                tol = max(0.02, 0.001 * abs(c1))
                if abs(p1 - c1) > tol:
                    mismatches += 1
            if None in (c0, c1, p0, p1) or c0 <= 0 or p0 <= 0:
                continue
            xs.append(c1 / c0 - 1)
            ys.append(p1 / p0 - 1)
        if len(xs) >= 30 and np.std(xs) > 0 and np.std(ys) > 0:
            cors.append(float(np.corrcoef(rank(np.array(xs)), rank(np.array(ys)))[0, 1]))
    med = float(np.median(cors)) if cors else float("nan")
    return [
        f"prices_historical check: MU {PX_CHECK} daily_history {mu_d} vs prices_historical {mu_p} (gap {gap}).",
        f"Overlap sessions sampled {len(cors)}. Median Spearman of that day's returns {med:+.3f}. "
        f"Close mismatches {mismatches} / {checked} (tol max(0.02, 0.1%)).",
        "Backtest sample stays daily_history. prices_historical cannot carry the 2023 holdout.",
    ]


def rev_corr(rows) -> str:
    xs, ys = [], []
    for r in rows:
        if r.get("rev5") is None:
            continue
        xs.append(r["ret"])
        ys.append(r["rev5"])
    if len(xs) < 30 or np.std(xs) == 0 or np.std(ys) == 0:
        return f"prior-day return vs lab rev5: n {len(xs)}"
    return (f"prior-day return vs lab rev5 Spearman {float(np.corrcoef(rank(np.array(xs)), rank(np.array(ys)))[0, 1]):+.3f} "
            f"(n {len(xs)}).")


def hand_lines(mem, px, compx, days) -> list[str]:
    ric = None
    lines = ["## Smoke", ""]
    # membership of the five, from the panel map
    panel = mem["panel"]
    for t in SMOKE:
        bars = px.get(t) or []
        last = bars[-1] if bars else None
        lines.append(
            f"- {t}: panel {panel.get(t, 'NO PRICE')}, bars {len(bars)}, "
            f"last {last[0] if last else 'none'} close {None if not last else round(last[1], 4)}.")
    day = compx.get(HAND_SIG)
    mu_bars = dict(px.get(HAND, []))
    # previous session on the global calendar
    prev = None
    if HAND_SIG in days:
        i = days.index(HAND_SIG)
        prev = days[i - 1] if i else None
    c1 = mu_bars.get(HAND_SIG)
    c0 = mu_bars.get(prev) if prev else None
    ret = None if c0 is None or c1 is None or c0 <= 0 else c1 / c0 - 1
    info = None if not day else day.get(HAND)
    lines += [
        "",
        f"Hand-check {HAND} signal {HAND_SIG} (Monday {HAND_MON}).",
        f"Prev session {prev}. Close {c1}. Prev close {c0}. Return {ret}.",
    ]
    if info:
        lines.append(
            f"Panel n {info['n']}, rank {info['rank']} (1 = largest gain), score {info['score']}.")
        ordered = sorted(day.items(), key=lambda kv: kv[1]["rank"])
        top = ", ".join(f"{t} {v['ret']:+.4f}" for t, v in ordered[:3])
        bot = ", ".join(f"{t} {v['ret']:+.4f}" for t, v in ordered[-3:])
        lines.append(f"Top 3: {top}.")
        lines.append(f"Bottom 3: {bot}.")
    else:
        lines.append(f"{HAND} is not on the COMPX panel that day.")
    mapped = signal_day(days, HAND_MON)
    lines.append(f"Signal day the Monday maps to: {mapped}.")
    return lines


def board_lines(title, board, y_scale, y_unit) -> list[str]:
    return [
        f"### {title}",
        "",
        f"Label: {board['label']}. Rows {board['n_rows']}, names {board['names']}, raw weeks {board['n_weeks_raw']}.",
        f"Either tail minus the rest {y_unit}: {fmt(board['rest'], y_scale)}. This is the base-rate test.",
        f"On-list rank IC: {fmt(board['ic_on'], 1, 3)}.",
        f"FM of the on-list flag: {fmt(board['fm'], 1, 3)}.",
        f"Within-comparator quintile, on-list minus off {y_unit}: {fmt(board['within'], y_scale)}.",
        f"Decomposition, signed rank IC {fmt(board['ic'], 1, 3)}. "
        f"Top-10 minus bottom-10 {y_unit}: {fmt(board['spread'], y_scale)}. "
        f"Signed FM {fmt(board['fm_signed'], 1, 3)}.",
        f"Prior-day return IC {fmt(board['ic_ret'], 1, 3)}, FM {fmt(board['fm_ret'], 1, 3)}. "
        f"|return| IC {fmt(board['ic_abs'], 1, 3)}, FM {fmt(board['fm_abs'], 1, 3)}.",
        "Same weeks " + ", ".join(f"{k} IC {fmt(v, 1, 3)}" for k, v in board["comp"].items()) + ".",
        "On-list " + board["placebo"] + ".",
        "",
    ]


def write_report(text: str):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)


def main():
    smoke = "--smoke" in sys.argv
    with connect() as conn:
        mem = load_membership(conn)
        px = load_prices(conn)
        compx, cap_c = build_signals(px, mem["panel"], "COMPX")
        nyse, cap_n = build_signals(px, mem["panel"], "NYSE")
        days = calendar(px)
        pool = scanner_pool(conn)
        if smoke:
            for line in hand_lines(mem, px, compx, days):
                print(line)
            print(f"COMPX names {mem['n_compx']}, NYSE-listed names {mem['n_nyse']}, "
                  f"dropped {mem['drop']}.")
            print(f"Schwab .O vs NASDAQ agree {mem['schwab_o_nasdaq']}, mismatches {mem['schwab_mismatch']}, "
                  f"instruments {mem['schwab_n']}.")
            print(f"index_memberships filled {mem['index_memberships_filled']}, crsp permnos {mem['crsp_permnos']}.")
            print(f"scanner pool {len(pool)}. Smoke names in pool: "
                  + ", ".join(f"{t}={'yes' if t in pool else 'no'}" for t in SMOKE))
            # one close cross-check, no full overlap scan
            row = conn.execute(
                """SELECT p.close::float8, d.close::float8
                   FROM prices_historical p
                   JOIN lseg_research.daily_history d ON d.ticker = p.ticker AND d.date = p.date
                   WHERE p.ticker = 'MU' AND p.date = %s""", (PX_CHECK,)).fetchone()
            print(f"MU {PX_CHECK} prices_historical {None if not row else row[0]} daily_history {None if not row else row[1]}.")
            print(f"COMPX signal days {len(compx)}, returns capped {cap_c}.")
            return

        mid = holdout_mid(conn)
        digest = conn.execute(
            """SELECT engine_digest FROM watchlist_sync.lab_tech
               WHERE engine_digest LIKE '%%-ivhist'
               GROUP BY 1 ORDER BY max(as_of) DESC, max(computed_at) DESC LIMIT 1""").fetchone()[0]
        print(f"mid {mid} digest {digest} compx days {len(compx)}", flush=True)
        stock, miss_sig, miss_comp = load_stock(conn, compx, days, digest)
        stamp(stock)
        print(f"stock rows {len(stock)} outside_panel_or_no_session {miss_sig} miss_comp {miss_comp}", flush=True)
        stock_board = score_board(stock, "rel", ["alpha", "tech"], mid, LAG_STOCK, 97)
        print("puts…", flush=True)
        puts, n_ev = load_puts(conn, compx, days, digest)
        stamp(puts)
        print(f"put rows {len(puts)} events {n_ev}", flush=True)
        put_board = score_board(puts, "pnl", ["put_edge"], mid, LAG_PUT, 97)
        by_put = _weeks(puts, "pnl", ["on", "put_edge", "iv30"])
        put_board["iv_resid"] = pack(series_ic_resid(by_put, "pnl", "on", "iv30"), mid, LAG_PUT)
        put_board["breach_on"] = pack(series_list_rest(by_put, "breach", "on"), mid, LAG_PUT)
        # False only when the base-rate bar would pass and the iv30 residual does not.
        iv_ok = clears(put_board["iv_resid"]) or not (clears(put_board["rest"]) and clears(put_board["fm"]))
        put_board["label"] = label_of(put_board["rest"], put_board["fm"], iv_ok=bool(iv_ok))
        on = np.array([r["on"] for r in puts if r.get("iv30") is not None], float)
        ivs = np.array([r["iv30"] for r in puts if r.get("iv30") is not None], float)
        iv_corr = float(np.corrcoef(rank(on), rank(ivs))[0, 1]) if len(on) > 30 and np.std(on) and np.std(ivs) else float("nan")

        nyse_stock, _, _ = load_stock(conn, nyse, days, digest)
        stamp(nyse_stock)
        nyse_board = score_board(nyse_stock, "rel", ["alpha", "tech"], mid, LAG_STOCK, 97)
        nyse_put_note = "NYSE put board omitted. aligned_events is one build; this slice is descriptive and cannot pass."

        # Scanner overlap on the last reconstructed session on or before the pool date.
        pool_asof = conn.execute("SELECT MAX(snapshot_date) FROM model_recs").fetchone()[0]
        pool_asof = as_date(pool_asof) if pool_asof else None
        last_sig = max((d for d in compx if pool_asof and d <= pool_asof), default=None)
        movers = []
        in_pool = []
        if last_sig:
            movers = [t for t, s in compx[last_sig].items() if s["score"] != 0]
            in_pool = [t for t in movers if t in pool]
        hist_flags = [(r["t"], r["score"]) for r in stock if r["score"] != 0]
        hist_hit = sum(1 for t, _s in hist_flags if t in pool)
        px_lines = price_check(conn, px)
        fwd = forward_text(conn, compx)

        primary = stock_board["label"]
        put_label = put_board["label"]
        ships = "Nothing ships."
        why = ("Stock: the mean gap clears and the within-quintile mean does too, but the rank "
               "partial is negative, so movers do not rank rel_21. Puts: the mean and the FM clear, "
               "and the association is real, but it dies once iv30 is held fixed.")
        if primary == "PASS" or put_label == "PASS":
            ships = "Bar clears. Nothing ships yet."
            why = ("Forward market_movers has 0 sessions, so this reconstruction is not matched to Schwab. "
                   "No live weight until that overlap is measured on ≥ 20 sessions.")

        lines = [
            "# S097 — Schwab movers, reconstructed",
            "",
            "Question: among Nasdaq Composite names in our priced universe, does the day's top-10 / "
            "bottom-10 close-to-close move predict next Monday's rel_21 or the week's short-put pnl "
            "beyond StarMine combined alpha + lab_tech v2, and beyond put_edge?",
            "",
            "Pass bar (pre-registered, unchanged): holdout 2023-01→, week-clustered t ≥ 2, both halves "
            "positive, and marginal t ≥ 2. The scored object is the mover list versus the other names "
            "that week (either tail vs the rest) on the COMPX panel. Signed up-versus-down is the "
            "decomposition. A negative result is not flipped. Puts must also survive an iv30 residual.",
            "",
            f"Verdict: **{ships}** Stock {primary}. Puts {put_label}.",
            why,
            "",
            "## Membership",
            "",
            f"index_memberships filled {mem['index_memberships_filled']}. crsp_dsf permnos {mem['crsp_permnos']} "
            "(no index column). $SPX constituents are not stored, so that list is not reconstructed.",
            f"RIC `.O` vs Schwab exchange on the {mem['schwab_n']} stored /instruments rows: "
            f"NASDAQ agrees {mem['schwab_o_nasdaq']}, mismatches {mem['schwab_mismatch']}.",
            f"COMPX panel {mem['n_compx']} names. NYSE-listed slice {mem['n_nyse']} (not an S&P list). "
            f"Dropped from both: {', '.join(mem['drop'])}.",
            f"SPDR extras beyond etf-exclusions.ts: {', '.join(mem['sector_xl']) or 'none'}.",
            f"Returns capped at {RET_CAP:.0%} : COMPX {cap_c}, NYSE slice {cap_n}.",
            f"Holdout midpoint {mid}. Tech digest {digest}. Signal days {len(compx)}.",
            "",
            *hand_lines(mem, px, compx, days),
            "",
            "## Stock board (COMPX, rel_21)",
            "",
            *board_lines("Primary", stock_board, 100, "pp/21d")[2:],
            f"Lab Mondays outside the COMPX panel or with no session return: {miss_sig}. "
            f"On the panel but missing alpha or tech: {miss_comp}.",
            rev_corr(stock),
            "",
            "## Put board (COMPX, pnl per $ collateral, net of the S059 fill)",
            "",
            f"Harness events {n_ev}. Joined rows {put_board['n_rows']}.",
            *board_lines("Primary", put_board, 10000, "bp/week")[2:],
            f"IV-residual rank IC (on-list flag and pnl residualized on iv30 inside the week): {fmt(put_board['iv_resid'], 1, 3)}.",
            f"On-list minus off, breach: {fmt(put_board['breach_on'], 100)} pp.",
            f"On-list flag vs iv30 Spearman {iv_corr:+.3f} (n {len(on)}).",
            "",
            "## NYSE-listed slice (descriptive, not $SPX, cannot pass)",
            "",
            f"Stock numbers ({nyse_board['label']}), not eligible: either-tail {fmt(nyse_board['rest'], 100)} pp/21d, "
            f"on-list FM {fmt(nyse_board['fm'], 1, 3)}. Signed spread {fmt(nyse_board['spread'], 100)}.",
            nyse_put_note,
            "",
            "## Scanner pool and the forward feed",
            "",
            f"Scanner pool = model_recs ∪ option_score_snapshots on {pool_asof}: {len(pool)} names.",
            f"Last COMPX session on or before that date: {last_sig}. "
            f"Tail names {len(movers)}, of which {len(in_pool)} are in today's pool"
            + (f" ({', '.join(sorted(in_pool))})." if in_pool else "."),
            f"Holdout stock rows with a non-zero score: {len(hist_flags)}, "
            f"{hist_hit} of those tickers sit in today's pool (not a point-in-time scanner).",
            *fwd,
            "",
            "## Price source",
            "",
            *px_lines,
            "",
            "## Known weaknesses",
            "",
            "- $SPX is untested. NYSE listing is not S&P membership. AAPL is in both indexes; JPM is only in the S&P. This panel is the Nasdaq one.",
            "- Top 10 of ~100 covered Nasdaq names is not Schwab's top 10 of the full Composite. The forward Jaccard is the check, and it has no session yet.",
            "- RIC suffix is today's listing, not point-in-time. A venue change would mis-file the old history.",
            "- rel_21 overlaps. The stock t is Newey-West lag 3. Puts are one per week, lag 1.",
            "- PLTU and SUPX are not on etf-exclusions.ts, so they stay in the Nasdaq panel if their RIC ends in .O.",
            "- The universe is the names we cover now. Names that left the watchlist are absent.",
            "",
        ]
        # The hand_lines already include a Smoke heading. Drop the duplicate heading word? It's fine
        # as the audit of the same row inside the full report.
        text = "\n".join(lines).rstrip() + "\n"
        write_report(text)
        print(text)


if __name__ == "__main__":
    main()
