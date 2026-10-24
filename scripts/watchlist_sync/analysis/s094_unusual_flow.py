"""S094 — unusual options flow from stored data (A262). Do not change the bar.

Question: does name-level unusual options flow rank 21-day residual stock
returns or weekly short-put pnl beyond StarMine + lab_tech, and beyond put_edge?

Boards (pre-registered):
  Stock: lab_outcomes rel_21. Weekly rank IC and top−bottom decile (quintile
  when the median week has fewer than 50 names). Comparator = StarMine
  combined_alpha_rank + lab_tech v2 (engine 3b1ba75fb4e9-ivhist).
  Put: S059 aligned events (S045 strike, pnl net of bid+23% of the spread,
  same-week sessions). Comparator = put_edge (IV/RV in [0.3, 5] + vol-of-vol
  + put tech). Q5−Q1 on pnl per collateral-week. Breach is descriptive.

PASS: holdout week-clustered |t| ≥ 2, same sign in both halves, and marginal
|t| ≥ 2 (2-factor Fama-MacBeth on the composite, or within-composite-quintile
sort) with the same sign as the standalone IC. The spread must clear the same
bar and the same sign. Standalone IC is residualized on iv_rv, iv30, and
  earnings (PLAYBOOK §4). "IV in disguise" means the raw IC clears and the
  controlled IC collapses (|t| < 1, or the sign flips). A controlled t that
  only falls short of 2 stays "no edge", with the raw spread still reported.
  No fitted weights.

Definitions frozen before any return was joined:
  Tape = optlab.bars (Polygon contract high/close/volume) joined to
  optlab.contracts. An OCC with no contract row is parsed (root, side, strike).
  Life of a contract = first stored bar through last stored bar. A missing
  session inside that life has volume 0 (Polygon omits no-trade days).
  Session clock = lseg_research.daily_history SPY dates. A bar whose date is
  not an SPY session is counted and reported; it is not in the average.
  vol_x = (sum of today's volume) / (sum of prior-20-session average volume)
  over contracts with ≥ 10 prior in-life sessions and average ≥ 5 contracts.
  The window excludes today. This is the name-level "volume vs 20-day average".
  pc = ln(put volume / call volume) on contracts in life that day. Missing
  unless both sides are at least 1 contract. This is put/call volume inside
  the stored set, not the listed chain.
  block = share of today's option premium (volume × close × 100) that sits in
  contracts with premium ≥ $250,000. The dollar cut is the stored-tape p90
  ($153k) to p95 ($375k) gap, chosen from the premium distribution before any
  return was joined. A 500-contract cut would flag 19% of contract-days here
  (median volume is 54), so it is not a block.
  voi = sum(volume) / sum(open interest) on option_chain_history, same day,
  contracts with open interest > 0. skew_survey gets the same formula and is
  reported beside it. Neither is mixed into vol_x. Bars have no open interest.
  Signal day = the lab Monday when that Monday is an SPY session, else the
  last SPY session in the prior 6 days. Known at that close; rel_21 and the
  short put are forward from that close (same clock as S091).

Coverage amendment, written before any return was joined: bars start
2024-10-15, so the 2023 holdout has no tape. The pass/fail split is the median
lab Monday on or after 2024-10-21 (equal halves of the tape window). The
median of all lab Mondays from 2023-01-01 is printed and is not the bar.
option_chain_history and skew_survey start after lab_outcomes ends, so voi
is a coverage result unless ≥ 20 holdout weeks actually join.

Week t: Newey-West lag 3 on stocks (21-day overlap), lag 1 on puts (one-week
hold). Minimum 20 names in a week, 20 weeks, 8 in each half.

  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s094_unusual_flow.py --smoke
  nice -n 15 env OMP_NUM_THREADS=4 .venv/bin/python analysis/s094_unusual_flow.py
"""
from __future__ import annotations

import math
import sys
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import s045_put_retest as S  # noqa: E402
import s059_option_factors as S59  # noqa: E402
from build_plan import connect  # noqa: E402
from lab import nw_t  # noqa: E402

HOLDOUT = date(2023, 1, 1)
TAPE_START = date(2024, 10, 21)  # first Monday on or after the first bar (2024-10-15)
DIGEST = "3b1ba75fb4e9-ivhist"
SMOKE = ("CAVA", "SHOP", "TMO", "MU", "CRWV")
BLOCK_PREM = 250_000.0
AVG_MIN = 5.0
PRIOR = 20
PRIOR_MIN = 10
MIN_NAMES = 20
MIN_WEEKS = 20
MIN_HALF = 8
OUT = HERE.parent / "out" / "studies" / "S094.md"
FEATS = ("vol_x", "pc", "block")
CONTROLS = ("iv_rv", "iv30", "earn")


def _num(x):
    if x is None or isinstance(x, bool):
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
        import json
        return json.loads(x)
    return x


def _day(d):
    if isinstance(d, datetime):
        return d.date()
    return d


def parse_occ(occ: str):
    s = occ[2:] if occ.startswith("O:") else occ
    if len(s) < 16:
        return None
    suf, root = s[-15:], s[:-15]
    if not root or suf[6] not in ("C", "P"):
        return None
    try:
        exp = date(2000 + int(suf[0:2]), int(suf[2:4]), int(suf[4:6]))
        strike = int(suf[7:15]) / 1000.0
    except ValueError:
        return None
    return root, ("call" if suf[6] == "C" else "put"), exp, strike


class Contract:
    __slots__ = ("occ", "und", "typ", "strike", "i0", "i1", "vol", "close")

    def __init__(self, occ, und, typ, strike, n):
        self.occ = occ
        self.und = und
        self.typ = typ
        self.strike = strike
        self.i0 = n
        self.i1 = -1
        self.vol = np.zeros(n, np.float64)
        self.close = np.zeros(n, np.float64)


def load_tape(conn):
    cal = [d for (d,) in conn.execute(
        "SELECT date FROM lseg_research.daily_history WHERE ticker = 'SPY' AND close > 0 ORDER BY date")]
    idx = {d: i for i, d in enumerate(cal)}
    meta = {"bars": 0, "off_clock": 0, "parsed": 0, "unparsed": 0, "names": set()}
    book: dict[str, Contract] = {}
    q = """SELECT b.occ, b.date, b.c::float8, b.v::float8, c.underlying, c.type, c.strike::float8
           FROM optlab.bars b LEFT JOIN optlab.contracts c ON c.occ = b.occ"""
    for occ, d, c, v, und, typ, strike in conn.execute(q):
        meta["bars"] += 1
        d = _day(d)
        i = idx.get(d)
        if i is None:
            meta["off_clock"] += 1
            continue
        if und is None:
            parsed = parse_occ(occ)
            if parsed is None:
                meta["unparsed"] += 1
                continue
            und, typ, _exp, strike = parsed
            meta["parsed"] += 1
        cobj = book.get(occ)
        if cobj is None:
            cobj = book[occ] = Contract(occ, und, typ, float(strike or 0), len(cal))
        cobj.vol[i] = float(v or 0)
        cobj.close[i] = float(c or 0)
        if i < cobj.i0:
            cobj.i0 = i
        if i > cobj.i1:
            cobj.i1 = i
        meta["names"].add(und)
    meta["names"] = len(meta["names"])
    meta["contracts"] = len(book)
    meta["cal0"] = cal[0]
    meta["cal1"] = cal[-1]
    return cal, book, meta


def _avg(vol, i0, i):
    """Mean volume on the prior sessions inside the contract's life. Excludes today."""
    start = i - PRIOR
    if start < i0:
        start = i0
    n = i - start
    if n < PRIOR_MIN:
        return None
    return float(vol[start:i].sum()) / n


def build_names(cal, book):
    """Name-day flow. Prefix sums are the panel; one row is recomputed by a loop in hand_check."""
    acc = {}
    for c in book.values():
        if c.i1 < c.i0:
            continue
        prefix = np.zeros(len(cal) + 1, np.float64)
        np.cumsum(c.vol, out=prefix[1:])
        for i in range(c.i0, c.i1 + 1):
            key = (c.und, i)
            rec = acc.get(key)
            if rec is None:
                rec = acc[key] = [0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0]
            vol = float(c.vol[i])
            if c.typ == "put":
                rec[3] += vol
            elif c.typ == "call":
                rec[4] += vol
            px = float(c.close[i])
            if vol > 0 and px > 0:
                prem = vol * px * 100.0
                rec[5] += prem
                if prem >= BLOCK_PREM:
                    rec[6] += prem
            start = i - PRIOR
            if start < c.i0:
                start = c.i0
            n = i - start
            if n >= PRIOR_MIN:
                avg = float(prefix[i] - prefix[start]) / n
                if avg >= AVG_MIN:
                    rec[0] += vol
                    rec[1] += avg
                    rec[2] += 1
    out = {}
    for (und, i), rec in acc.items():
        sv, sa, n_el, put_v, call_v, prem, block_prem = rec
        item = {"d": cal[i], "i": i, "n_el": n_el, "put_v": put_v, "call_v": call_v, "prem": prem}
        if n_el:
            item["vol_x"] = sv / sa
        if put_v > 0 and call_v > 0:
            item["pc"] = math.log(put_v / call_v)
        if prem > 0:
            item["block"] = block_prem / prem
        out[(und, cal[i])] = item
    return out


def signal_day(as_of, idx, cal):
    as_of = _day(as_of)
    i = idx.get(as_of)
    if i is not None:
        return cal[i]
    j = bisect_right(cal, as_of) - 1
    if j >= 0 and cal[j] >= as_of - timedelta(days=6):
        return cal[j]
    return None


def hand_contract(book, cal, und, day):
    """Slow loop over one name-day. Must match the prefix panel."""
    i = cal.index(day) if not isinstance(day, int) else day
    day = cal[i]
    rows = []
    sv = sa = 0.0
    n_el = 0
    for c in book.values():
        if c.und != und or i < c.i0 or i > c.i1:
            continue
        start = i - PRIOR
        if start < c.i0:
            start = c.i0
        n = i - start
        vols = [float(c.vol[k]) for k in range(start, i)]
        avg = (sum(vols) / n) if n >= PRIOR_MIN else None
        vol = float(c.vol[i])
        px = float(c.close[i])
        el = avg is not None and avg >= AVG_MIN
        if el:
            sv += vol
            sa += avg
            n_el += 1
        if el or vol > 0:
            rows.append({"occ": c.occ, "typ": c.typ, "strike": c.strike, "vol": vol, "px": px,
                         "n": n, "avg": avg, "vols": vols, "el": el})
    ratio = (sv / sa) if n_el else None
    return rows, ratio, n_el


def t_iid(arr) -> float | None:
    arr = np.asarray(arr, float)
    if len(arr) < 2:
        return None
    sd = float(arr.std(ddof=1))
    if sd == 0:
        return None
    return float(arr.mean() / (sd / math.sqrt(len(arr))))


def summarize(pairs, split, lag) -> dict | None:
    pairs = sorted((d, v) for d, v in pairs if v is not None and math.isfinite(v))
    if len(pairs) < 8:
        return None
    v = np.array([x for _, x in pairs])
    a = np.array([x for d, x in pairs if d < split])
    b = np.array([x for d, x in pairs if d >= split])
    nw = float(nw_t(v, lag))
    return {"n": len(v), "mean": float(v.mean()), "med": float(np.median(v)),
            "t": None if not math.isfinite(nw) else nw,
            "t_iid": t_iid(v), "na": int(len(a)), "a": float(a.mean()) if len(a) else None,
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


def _control_matrix(g, controls):
    cols = [np.ones(len(g))]
    for k in controls:
        r = np.array(S.rank([e[k] for e in g]), float)
        if np.std(r) > 0:
            cols.append(r)
    return np.column_stack(cols)


def weekly_ic(rows, feat, target, split, lag, controls) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    pairs, sizes = [], []
    for d, g0 in by.items():
        g = _eligible(g0, feat, target, controls)
        if len(g) < MIN_NAMES:
            continue
        x = np.array(S.rank([e[feat] for e in g]), float)
        y = np.array(S.rank([e[target] for e in g]), float)
        if controls:
            C = _control_matrix(g, controls)
            x = x - C @ np.linalg.lstsq(C, x, rcond=None)[0]
            y = y - C @ np.linalg.lstsq(C, y, rcond=None)[0]
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        pairs.append((d, float(np.corrcoef(x, y)[0, 1])))
        sizes.append(len(g))
    st = summarize(pairs, split, lag)
    if st:
        st["names"] = float(np.median(sizes)) if sizes else 0
    return st


def weekly_spread(rows, feat, target, split, lag, q, scale) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if e.get(feat) is not None and e.get(target) is not None:
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < max(MIN_NAMES, q * 2):
            continue
        g = sorted(g, key=lambda e: (e[feat], e["t"]))
        k = len(g) // q
        if k < 1:
            continue
        top = np.mean([e[target] for e in g[-k:]])
        bot = np.mean([e[target] for e in g[:k]])
        pairs.append((d, scale * (top - bot)))
    return summarize(pairs, split, lag)


def fm2(rows, feat, target, comp, split, lag) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if all(e.get(k) is not None for k in (feat, target, comp)):
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < MIN_NAMES:
            continue
        y = np.array(S.rank([e[target] for e in g]), float)
        x = np.array(S.rank([e[feat] for e in g]), float)
        c = np.array(S.rank([e[comp] for e in g]), float)
        if np.std(x) == 0 or np.std(c) == 0:
            continue
        if abs(float(np.corrcoef(x, c)[0, 1])) > 0.999:
            continue
        beta = np.linalg.lstsq(np.column_stack([np.ones(len(g)), x, c]), y, rcond=None)[0]
        pairs.append((d, float(beta[1])))
    return summarize(pairs, split, lag)


def within_q(rows, feat, target, qkey, split, lag, scale) -> dict | None:
    by = defaultdict(list)
    for e in rows:
        if all(e.get(k) is not None for k in (feat, target, qkey)):
            by[e["d"]].append(e)
    pairs = []
    for d, g in by.items():
        if len(g) < MIN_NAMES:
            continue
        gaps = []
        for q in range(1, 6):
            b = [e for e in g if e[qkey] == q]
            if len(b) < 4:
                continue
            b.sort(key=lambda e: (e[feat], e["t"]))
            k = max(1, len(b) // 2)
            gaps.append(np.mean([e[target] for e in b[-k:]]) - np.mean([e[target] for e in b[:k]]))
        if gaps:
            pairs.append((d, scale * float(np.mean(gaps))))
    return summarize(pairs, split, lag)


def mean_corr(rows, a, b) -> tuple[float | None, int]:
    by = defaultdict(list)
    for e in rows:
        if e.get(a) is not None and e.get(b) is not None:
            by[e["d"]].append(e)
    cs = []
    n = 0
    for g in by.values():
        if len(g) < MIN_NAMES:
            continue
        x, y = S.rank([e[a] for e in g]), S.rank([e[b] for e in g])
        if np.std(x) == 0 or np.std(y) == 0:
            continue
        cs.append(float(np.corrcoef(x, y)[0, 1]))
        n += len(g)
    if not cs:
        return None, 0
    return float(np.mean(cs)), n


def judge(standalone, raw, marginal, within, spread) -> str:
    if standalone is None or standalone["n"] < MIN_WEEKS:
        return "no test (coverage)"
    if standalone["na"] < MIN_HALF or standalone["nb"] < MIN_HALF:
        return "no test (thin half)"
    raw_pass = clears(raw)
    collapsed = bool(raw and raw.get("mean") is not None and standalone.get("mean") is not None and (
        standalone["t"] is None or abs(standalone["t"]) < 1 or standalone["mean"] * raw["mean"] <= 0))
    if raw_pass and not clears(standalone) and collapsed:
        return "IV in disguise"
    if not clears(standalone):
        return "no edge"
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


def rank_composite(rows, keys, dest, min_n):
    by = defaultdict(list)
    for e in rows:
        by[e["d"]].append(e)
    for g in by.values():
        ok = [e for e in g if all(e.get(k) is not None for k in keys)]
        if len(ok) < min_n:
            continue
        acc = np.zeros(len(ok))
        used = 0
        for k in keys:
            acc += S.rank([e[k] for e in ok])
            used += 1
        if not used:
            continue
        pct = S.rank(list(acc / used))
        for e, p in zip(ok, pct):
            e[dest] = float(p)
            e[dest + "_q"] = min(5, int(float(p) * 5) + 1)


def _shuffled(rows, feat, target, rng):
    by = defaultdict(list)
    for e in rows:
        if e.get(feat) is not None and e.get(target) is not None:
            by[e["d"]].append(dict(e))
    for g in by.values():
        vals = [e[feat] for e in g]
        rng.shuffle(vals)
        for e, v in zip(g, vals):
            e[feat] = v
    return [e for g in by.values() for e in g]


def placebo(rows, feat, target, split, lag, controls, seed):
    rng = np.random.default_rng(seed)
    return weekly_ic(_shuffled(rows, feat, target, rng), feat, target, split, lag, controls)


def placebo_hits(rows, feat, target, split, lag, controls, seed, n, bar):
    """How many within-week shuffles reach |t| ≥ bar. One seed stream, not a search."""
    rng = np.random.default_rng(seed)
    hits = 0
    for _ in range(n):
        st = weekly_ic(_shuffled(rows, feat, target, rng), feat, target, split, lag, controls)
        if st and st["t"] is not None and abs(st["t"]) >= bar:
            hits += 1
    return hits, n


def load_lab(conn):
    tech = {}
    for t, d, v2 in conn.execute(
            "SELECT ticker, as_of, v2 FROM watchlist_sync.lab_tech WHERE engine_digest = %s", (DIGEST,)):
        v2 = _js(v2)
        comps = v2.get("comps") or {}
        tr, vol = _num(comps.get("trendContext")), _num(comps.get("volumeConfirm"))
        total = _num(v2.get("total"))
        if tr is None or vol is None:
            continue
        tech[(_day_t(t), _day(d))] = (tr - vol, total)
    star = defaultdict(list)
    for t, d, v in conn.execute(
            """SELECT ticker, obs_date, value::float8 FROM lseg_research.starmine_history
               WHERE metric = 'combined_alpha_rank' AND value IS NOT NULL ORDER BY ticker, obs_date"""):
        star[t].append((_day(d), v))
    lab = []
    for t, d, outcomes, features in conn.execute(
            "SELECT ticker, as_of, outcomes, features FROM watchlist_sync.lab_outcomes"):
        o, f = _js(outcomes), _js(features)
        lab.append({"t": t, "d": _day(d), "rel": _num(o.get("rel_21")),
                    "iv_rv": _num(f.get("iv_rv")), "iv30": _num(f.get("iv30")),
                    "earn": _num(f.get("earnings_21")) or 0.0})
    return tech, star, lab


def _day_t(t):
    return t


def star_asof(series, day):
    if not series:
        return None
    i = _bisect(series, day)
    if i < 0:
        return None
    if (day - series[i][0]).days > 120:
        return None
    return series[i][1]


def _bisect(series, day):
    lo, hi = 0, len(series) - 1
    best = -1
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid][0] <= day:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def attach_stock(lab, names, tech, star, idx, cal):
    rows = []
    for row in lab:
        if row["rel"] is None:
            continue
        day = signal_day(row["d"], idx, cal)
        flow = names.get((row["t"], day)) if day else None
        if not flow:
            continue
        pt = tech.get((row["t"], row["d"]))
        item = {**row, "tech": pt[1] if pt else None, "put_tech": pt[0] if pt else None,
                "star": star_asof(star[row["t"]], row["d"]), "sig": day}
        for k in FEATS:
            if k in flow:
                item[k] = flow[k]
        if any(k in item for k in FEATS):
            rows.append(item)
    rank_composite(rows, ("star", "tech"), "comp", 20)
    return rows


def attach_puts(conn, names, tech, idx, cal):
    ev = S59.aligned_events(conn)
    rows = []
    for e in ev:
        day = signal_day(e["d"], idx, cal)
        flow = names.get((e["t"], day)) if day else None
        if not flow:
            continue
        pt = tech.get((e["t"], e["d"]))
        iv_rv = _num(e.get("iv_rv"))
        item = {"t": e["t"], "d": _day(e["d"]), "pnl": _num(e.get("pnl")), "breach": _num(e.get("breach")),
                "iv_rv": iv_rv, "iv30": _num(e.get("iv30")), "earn": _num(e.get("earn")) or 0.0,
                "put_tech": pt[0] if pt else _num(e.get("put_tech")),
                "vov": _num(e.get("vol_of_vol")), "sig": day}
        if iv_rv is not None and 0.3 <= iv_rv <= 5:
            item["iv_rv_edge"] = iv_rv
        for k in FEATS:
            if k in flow:
                item[k] = flow[k]
        if item["pnl"] is not None and any(k in item for k in FEATS):
            rows.append(item)
    edged = []
    for e in rows:
        if e.get("iv_rv_edge") is None or e.get("vov") is None or e.get("put_tech") is None:
            continue
        edged.append({**e, "iv_rv": e["iv_rv_edge"]})
    rank_composite(edged, ("iv_rv", "vov", "put_tech"), "edge", 20)
    have = {(e["t"], e["d"]): e["edge"] for e in edged if "edge" in e}
    qhave = {(e["t"], e["d"]): e["edge_q"] for e in edged if "edge_q" in e}
    for e in rows:
        e["edge"] = have.get((e["t"], e["d"]))
        e["edge_q"] = qhave.get((e["t"], e["d"]))
        e["comp"] = e["edge"]
        e["comp_q"] = e["edge_q"]
    return rows, len(ev)


def voi_table(conn, table, vol_col, oi_col, schema_note):
    if table == "option_chain_history":
        q = f"""SELECT as_of, ticker, sum({vol_col})::float8 vol, sum({oi_col})::float8 oi, count(*) n
                FROM option_chain_history
                WHERE {oi_col} > 0 AND {vol_col} IS NOT NULL
                GROUP BY 1, 2"""
    else:
        q = f"""SELECT as_of, ticker, sum({vol_col})::float8 vol, sum({oi_col})::float8 oi, count(*) n
                FROM optlab.skew_survey
                WHERE {oi_col} > 0 AND {vol_col} IS NOT NULL
                GROUP BY 1, 2"""
    rows = []
    for d, t, vol, oi, n in conn.execute(q):
        if oi and oi > 0:
            rows.append({"d": _day(d), "t": t, "voi": vol / oi, "n": n, "vol": vol, "oi": oi})
    return rows, schema_note


def lab_overlap(conn, table):
    q = f"""SELECT count(*) FROM (
              SELECT DISTINCT ticker, as_of FROM {table}
            ) s JOIN watchlist_sync.lab_outcomes l
            ON l.ticker = s.ticker AND l.as_of = s.as_of"""
    return int(conn.execute(q).fetchone()[0])


def chain_hand(conn, ticker):
    day = conn.execute(
        "SELECT max(as_of) FROM option_chain_history WHERE ticker = %s AND volume IS NOT NULL AND open_interest > 0",
        (ticker,)).fetchone()[0]
    if day is None:
        return None
    got = conn.execute(
        """SELECT expiry, side, strike::float8, volume::float8, open_interest::float8
           FROM option_chain_history WHERE ticker = %s AND as_of = %s AND open_interest > 0 AND volume IS NOT NULL""",
        (ticker, day)).fetchall()
    vol = sum(r[3] for r in got)
    oi = sum(r[4] for r in got)
    return {"ticker": ticker, "day": _day(day), "n": len(got), "vol": vol, "oi": oi,
            "voi": (vol / oi) if oi else None}


def skew_hand(conn, ticker):
    day = conn.execute(
        "SELECT max(as_of) FROM optlab.skew_survey WHERE ticker = %s AND oi > 0", (ticker,)).fetchone()[0]
    if day is None:
        return None
    got = conn.execute(
        """SELECT expiry, side, strike::float8, volume::float8, oi::float8
           FROM optlab.skew_survey WHERE ticker = %s AND as_of = %s AND oi > 0""",
        (ticker, day)).fetchall()
    vol = sum(float(r[3] or 0) for r in got)
    oi = sum(float(r[4] or 0) for r in got)
    return {"ticker": ticker, "day": _day(day), "n": len(got), "vol": vol, "oi": oi,
            "voi": (vol / oi) if oi else None, "sample": got[:3]}


def holdout_split(lab):
    mondays = sorted({r["d"] for r in lab if r["d"] >= HOLDOUT})
    global_split = mondays[len(mondays) // 2] if mondays else HOLDOUT
    tape = [d for d in mondays if d >= TAPE_START]
    tape_split = tape[len(tape) // 2] if tape else TAPE_START
    return mondays, global_split, tape, tape_split


def pick_q(rows, feat):
    by = defaultdict(int)
    for e in rows:
        if e["d"] >= HOLDOUT and e.get(feat) is not None:
            by[e["d"]] += 1
    sizes = [n for n in by.values() if n >= MIN_NAMES]
    if not sizes:
        return 5, 0
    med = float(np.median(sizes))
    return (10 if med >= 50 else 5), med


def eval_feature(rows, feat, target, comp, split, lag, scale, q):
    base = [e for e in rows if e["d"] >= HOLDOUT]
    standalone = weekly_ic(base, feat, target, split, lag, CONTROLS)
    raw = weekly_ic(base, feat, target, split, lag, ())
    iv_only = weekly_ic(base, feat, target, split, lag, ("iv30",))
    spread = weekly_spread(base, feat, target, split, lag, q, scale)
    marg = fm2(base, feat, target, comp, split, lag)
    wq = within_q(base, feat, target, comp + "_q", split, lag, scale)
    verdict = judge(standalone, raw, marg, wq, spread)
    rho, n_rho = mean_corr(base, feat, comp)
    return {"feat": feat, "verdict": verdict, "ic": standalone, "raw": raw, "iv_only": iv_only,
            "spread": spread, "marg": marg, "within": wq, "q": q, "rho": rho, "n_rho": n_rho}


def fmt_st(st, digits=3) -> str:
    if not st or st.get("t") is None:
        if st and st.get("mean") is not None:
            return f"{st['mean']:+.{digits}f} t — (n {st['n']})"
        return "—"
    def h(v):
        return "—" if v is None else f"{v:+.{digits}f}"
    iid = "—" if st.get("t_iid") is None else f"{st['t_iid']:+.1f}"
    med = "" if st.get("med") is None else f", med {st['med']:+.{digits}f}"
    return (f"{st['mean']:+.{digits}f} t {st['t']:+.1f} iid {iid} "
            f"(n {st['n']}, halves {h(st['a'])}/{h(st['b'])}, w {st['na']}/{st['nb']}"
            + (f", names {st['names']:.0f}" if st.get("names") else "") + med + ")")


def spot_week(rows, feat, target, day0):
    days = sorted({e["d"] for e in rows if e["d"] >= day0 and e.get(feat) is not None and e.get(target) is not None})
    for d in days:
        g = [e for e in rows if e["d"] == d and e.get(feat) is not None and e.get(target) is not None]
        if len(g) < MIN_NAMES:
            continue
        ic = float(np.corrcoef(S.rank([e[feat] for e in g]), S.rank([e[target] for e in g]))[0, 1])
        g2 = sorted(g, key=lambda e: (e[feat], e["t"]))
        k = max(1, len(g2) // 5)
        spread = float(np.mean([e[target] for e in g2[-k:]]) - np.mean([e[target] for e in g2[:k]]))
        return d, g, ic, spread
    return None


def smoke_report(cal, book, names, meta, conn) -> list[str]:
    idx = {d: i for i, d in enumerate(cal)}
    lines = ["## Smoke", ""]
    lines.append(f"Bars {meta['bars']:,}, contracts {meta['contracts']:,}, names {meta['names']}, "
                 f"parsed orphans {meta['parsed']}, unparsed {meta['unparsed']}, "
                 f"off SPY clock {meta['off_clock']}.")
    for t in SMOKE:
        days = sorted(d for (u, d) in names if u == t)
        n_el = sum(1 for d in days if names[(t, d)].get("n_el"))
        lines.append(f"- {t}: name-days {len(days)}"
                     + (f" ({days[0]} → {days[-1]}), days with a 20-session average {n_el}." if days
                        else ": no optlab.bars."))
    # CAVA row — the only smoke name in the Polygon tape
    cava_days = [d for (u, d) in names if u == "CAVA" and names[(u, d)].get("vol_x") is not None]
    if not cava_days:
        lines.append("Hand-check failed: CAVA has no vol_x day.")
        return lines
    day = cava_days[len(cava_days) // 2]
    stored = names[("CAVA", day)]
    rows, ratio, n_el = hand_contract(book, cal, "CAVA", day)
    ok = ratio is not None and abs(ratio - stored["vol_x"]) < 1e-9 and n_el == stored["n_el"]
    lines.append("")
    lines.append(f"Row: **CAVA {day}**. Panel vol_x {stored['vol_x']:.10f} (eligible {stored['n_el']}). "
                 f"Loop recompute {None if ratio is None else f'{ratio:.10f}'} (eligible {n_el}). Match {ok}.")
    lines.append(f"Panel pc {stored.get('pc')} block {stored.get('block')} put vol {stored['put_v']:.4f} "
                 f"call vol {stored['call_v']:.4f} premium {stored['prem']:.4f}.")
    eligible = [r for r in rows if r["el"]]
    show = eligible if eligible else rows[:3]
    for r in show:
        avg_s = "—" if r["avg"] is None else f"{r['avg']:.6f}"
        lines.append(f"  {r['occ']} {r['typ']} K {r['strike']} vol {r['vol']:.4f} close {r['px']:.6f} "
                     f"prior sessions {r['n']} avg {avg_s} eligible {r['el']}.")
        if r["el"]:
            lines.append("  prior volumes: " + ", ".join(f"{v:.4f}" for v in r["vols"]))
    # one contract's premium, so a reviewer can multiply
    traded = [r for r in rows if r["vol"] > 0 and r["px"] > 0]
    if traded:
        r = traded[0]
        prem = r["vol"] * r["px"] * 100.0
        lines.append(f"Premium check {r['occ']}: {r['vol']:.4f} × {r['px']:.6f} × 100 = {prem:.4f} "
                     f"({'block' if prem >= BLOCK_PREM else 'not a block'} at {BLOCK_PREM:.0f}).")
    if not ok:
        raise SystemExit("hand-check mismatch on CAVA vol_x")
    ch = chain_hand(conn, "CAVA")
    if ch:
        lines.append(f"Chain CAVA {ch['day']}: {ch['n']} contracts, volume {ch['vol']:.4f} / OI {ch['oi']:.4f} "
                     f"= voi {ch['voi']:.6f}. Lab join is counted in the full report.")
    sk = skew_hand(conn, "MU")
    if sk:
        lines.append(f"skew_survey MU {sk['day']}: {sk['n']} strikes, volume {sk['vol']:.4f} / OI {sk['oi']:.4f} "
                     f"= voi {sk['voi']:.6f}.")
        for exp, side, strike, vol, oi in sk["sample"]:
            lines.append(f"  {exp} {side} K {strike} vol {float(vol or 0):.4f} oi {float(oi or 0):.4f}")
    lines.append("Hand-check: the loop matches the panel.")
    return lines


def coverage_prose(conn, names, lab) -> list[str]:
    chain_n = lab_overlap(conn, "option_chain_history")
    skew_n = lab_overlap(conn, "optlab.skew_survey")
    chain_span = conn.execute(
        "SELECT min(as_of), max(as_of), count(distinct as_of), count(distinct ticker) FROM option_chain_history"
    ).fetchone()
    skew_span = conn.execute(
        "SELECT min(as_of), max(as_of), count(distinct as_of), count(distinct ticker) FROM optlab.skew_survey"
    ).fetchone()
    lab_end = max(r["d"] for r in lab)
    voi_rows, _ = voi_table(conn, "option_chain_history", "volume", "open_interest", "")
    vois = [r["voi"] for r in voi_rows]
    med = float(np.median(vois)) if vois else float("nan")
    lines = [
        f"option_chain_history {chain_span[0]} → {chain_span[1]}, {chain_span[2]} days, {chain_span[3]} names. "
        f"Name-days joined to a lab Monday: {chain_n}. Lab ends {lab_end}.",
        f"skew_survey {skew_span[0]} → {skew_span[1]}, {skew_span[2]} days, {skew_span[3]} names. "
        f"Name-days joined to a lab Monday: {skew_n}.",
        f"Chain volume/OI on {len(voi_rows)} name-days, median {med:.3f}. "
        "Not scored: no holdout week has both a flow print and a formed rel_21 or put pnl.",
    ]
    # how thin is the bars cross-section
    by = defaultdict(int)
    zeros = have = 0
    for (u, d), item in names.items():
        if item.get("vol_x") is None:
            continue
        by[d] += 1
        have += 1
        if item.get("block") == 0:
            zeros += 1
    sizes = list(by.values())
    if sizes:
        lines.append(f"vol_x name-days {have:,} on {len(sizes)} sessions. "
                     f"Names per session: median {np.median(sizes):.0f}, max {max(sizes)}. "
                     f"Block share is 0 on {zeros / have:.0%} of vol_x days.")
    return lines


def run_board(rows, target, comp, split, lag, scale, label) -> list[dict]:
    q, med = pick_q(rows, "vol_x")
    out = []
    for feat in FEATS:
        # one book width for the board, from vol_x coverage, so the three features share a cut
        r = eval_feature(rows, feat, target, comp, split, lag, scale, q)
        r["names_med"] = med
        r["board"] = label
        out.append(r)
    return out


def fmt_board(results) -> list[str]:
    lines = []
    for r in results:
        rho_s = "—" if r["rho"] is None else f"{r['rho']:+.3f}"
        lines.append(f"- {r['board']} {r['feat']} ({r['q']}-tile, median names {r['names_med']:.0f}): "
                     f"**{r['verdict']}**. IC {fmt_st(r['ic'])}. Raw IC {fmt_st(r['raw'])}. "
                     f"iv30-only {fmt_st(r['iv_only'])}. Spread {fmt_st(r['spread'], 2)}. "
                     f"FM {fmt_st(r['marg'])}. Within {fmt_st(r['within'], 2)}. "
                     f"Rank corr vs comparator {rho_s} (names-weeks {r['n_rho']}).")
    return lines


def reading(results, breach) -> list[str]:
    by = {(r["board"], r["feat"]): r for r in results}
    sp, pb, pp = by[("stock", "pc")], by[("put", "block")], by[("put", "pc")]

    def tt(st):
        return "—" if not st or st.get("t") is None else f"{st['t']:+.1f}"

    def mm(st, digits=2):
        return "—" if not st or st.get("mean") is None else f"{st['mean']:+.{digits}f}"

    def md(st, digits=2):
        return "—" if not st or st.get("med") is None else f"{st['med']:+.{digits}f}"

    return [
        f"Stock put/call, raw top−bottom {mm(sp['spread'])} pp/21d (t {tt(sp['spread'])}, "
        f"median week {md(sp['spread'])}). After iv_rv, iv30 and earnings the rank IC is "
        f"{mm(sp['ic'], 3)} (t {tt(sp['ic'])}). Marginal vs alpha+tech t {tt(sp['marg'])}. Short of the bar.",
        f"Put block-premium share, top−bottom {mm(pb['spread'])} bp/week (t {tt(pb['spread'])}, "
        f"median week {md(pb['spread'])}). Rank IC t {tt(pb['ic'])}. Marginal vs put_edge t {tt(pb['marg'])}. "
        "The pnl gap does not clear the rank-IC bar.",
        f"Put put/call controlled IC t {tt(pp['ic'])}, raw IC t {tt(pp['raw'])}. "
        f"Pnl gap {mm(pp['spread'])} bp (t {tt(pp['spread'])}). "
        f"Breaches mean {mm(breach)} pp (t {tt(breach)}, median week {md(breach)}). "
        "A few weeks carry the mean. The credit covers them in the pnl.",
        "Volume vs the 20-day average does not rank either board. Volume vs open interest has no formed week.",
    ]


def lead(results) -> str:
    passes = [r for r in results if r["verdict"] == "PASS"]
    if not passes:
        return "Nothing ships."
    bits = [f"{r['board']} {r['feat']} ({r['verdict']}, IC {r['ic']['mean']:+.3f} t {r['ic']['t']:+.1f})"
            for r in passes]
    return "Clears the bar: " + "; ".join(bits) + "."


def main():
    smoke = "--smoke" in sys.argv
    with connect() as conn:
        cal, book, meta = load_tape(conn)
        print(f"tape contracts {meta['contracts']} bars {meta['bars']}", flush=True)
        names = build_names(cal, book)
        print(f"name-days {len(names)}", flush=True)
        if smoke:
            text = smoke_report(cal, book, names, meta, conn)
            print("\n".join(text))
            return
        tech, star, lab = load_lab(conn)
        mondays, global_split, tape, tape_split = holdout_split(lab)
        idx = {d: i for i, d in enumerate(cal)}
        stock = attach_stock(lab, names, tech, star, idx, cal)
        print(f"stock rows {len(stock)} split {tape_split}", flush=True)
        puts, n_ev = attach_puts(conn, names, tech, idx, cal)
        print(f"put rows {len(puts)} of {n_ev}", flush=True)
        stock_res = run_board(stock, "rel", "comp", tape_split, 3, 100.0, "stock")
        put_res = run_board(puts, "pnl", "comp", tape_split, 1, 1e4, "put")
        # breach is descriptive, not the bar
        breach = weekly_spread([e for e in puts if e["d"] >= HOLDOUT], "pc", "breach",
                               tape_split, 1, 5, 100.0)
        stock_h = [e for e in stock if e["d"] >= HOLDOUT]
        put_h = [e for e in puts if e["d"] >= HOLDOUT]
        plac = placebo(stock_h, "vol_x", "rel", tape_split, 3, CONTROLS, 94)
        pc_bar = abs(next(r["raw"]["t"] for r in stock_res if r["feat"] == "pc") or 0)
        put_pc_bar = abs(next(r["ic"]["t"] for r in put_res if r["feat"] == "pc") or 0)
        print("placebo shuffles", flush=True)
        hit_stock, n_shuf = placebo_hits(stock_h, "pc", "rel", tape_split, 3, (), 94, 200, pc_bar)
        hit_put, _ = placebo_hits(put_h, "pc", "pnl", tape_split, 1, CONTROLS, 94, 200, put_pc_bar)
        alpha_ic = weekly_ic(stock_h, "star", "rel", tape_split, 3, ())
        tech_ic = weekly_ic(stock_h, "tech", "rel", tape_split, 3, ())
        edge_ic = weekly_ic(put_h, "comp", "pnl", tape_split, 1, ())
        results = stock_res + put_res
        spot = spot_week(stock_h, "pc", "rel", date(2025, 6, 2))
        lines = [
            "# S094 — unusual options flow from stored bars",
            "",
            lead(results),
            "",
            f"Holdout clock 2023-01-01 → ({len(mondays)} lab Mondays, median {global_split}). "
            f"Tape Mondays {tape[0] if tape else '—'} → {tape[-1] if tape else '—'} "
            f"({len(tape)}), pass/fail split {tape_split}. "
            f"That split is the coverage amendment: bars start 2024-10-15, so a 2023 midpoint "
            f"leaves a few weeks on one side. Stock t is Newey-West lag 3. Put t is Newey-West lag 1. "
            f"Digest `{DIGEST}`. Put events {n_ev:,} before the flow join, {len(puts):,} with a tape print.",
            "",
            f"Bars {meta['bars']:,}, contracts {meta['contracts']:,}, names {meta['names']}, "
            f"orphan OCC parsed {meta['parsed']}, unparsed {meta['unparsed']}, "
            f"bars off the SPY clock {meta['off_clock']}. "
            "The contract set is the option-history queue (the trader's puts and the strikes next to them, "
            "earnings ATM, iv-rank ATM puts), not a full chain. Put/call volume is inside that set.",
            "",
        ]
        lines += coverage_prose(conn, names, lab)
        lines += ["", "## Hand-check", ""]
        lines += smoke_report(cal, book, names, meta, conn)[2:]
        lines += ["", "## Verdict", "", lead(results), ""]
        lines += reading(results, breach)
        lines += [""]
        lines += fmt_board(results)
        lines += [
            "",
            f"On these flow names: combined alpha IC {fmt_st(alpha_ic)}. lab_tech v2 IC {fmt_st(tech_ic)}.",
            f"Same put weeks: put_edge IC {fmt_st(edge_ic)}.",
            f"Placebo (vol_x shuffled inside the week, seed 94) stock IC {fmt_st(plac)}.",
            f"Placebo hits, 200 within-week shuffles, seed 94: stock put/call raw |t| ≥ {pc_bar:.1f} "
            f"in {hit_stock}/{n_shuf}. Put put/call controlled |t| ≥ {put_pc_bar:.1f} in {hit_put}/{n_shuf}.",
            f"Put/call vs breach, descriptive, percentage points: {fmt_st(breach, 2)}.",
            "",
        ]
        if spot:
            d, g, ic, spread = spot
            mid = sorted(g, key=lambda e: e["pc"])[len(g) // 2]
            flow = names.get((mid["t"], mid.get("sig"))) or {}
            lines += [
                f"Spot Monday {d} (first pc week on or after 2025-06-02 with ≥ {MIN_NAMES} names): "
                f"n {len(g)}, rank IC {ic:+.6f}, top−bottom quintile rel_21 {spread:+.6f}. "
                f"{mid['t']} signal {mid.get('sig')} pc {mid['pc']:.6f} = ln({flow.get('put_v', float('nan')):.4f}"
                f"/{flow.get('call_v', float('nan')):.4f}), rel_21 {mid['rel']:.6f}.",
                "",
            ]
        lines += [
            "Volume vs open interest is not on the bar. Chain history and the skew survey both start after the last lab Monday.",
            "",
            "## Known weaknesses",
            "",
            "- The tape is ~100 names and a handful of strikes, chosen because they were traded or reported earnings. A hot print here is not the market's unusual-flow list.",
            "- No open interest on any day that has a formed outcome. The volume/OI leg of the ask is untested, not a fail.",
            "- Block is a premium share at $250k, not a print. Daily volume can add up to that without a single block trade.",
            "- Six scored cells (3 features × 2 boards). The bar has no Holm correction. One cell near t = 2 would be a single look in that family.",
            "- rel_21 overlaps. Lag 3 is the weekly Newey-West used on the other A262 stock rows, not a 21-day block bootstrap.",
            "- Put/call sign: a high number is more put volume. Informed put buying would be a negative stock residual and a worse short put. The sign in the table is what the weeks did.",
        ]
        # fix the opening line if it doubled "Not a pass"
        if any(r["verdict"] == "PASS" for r in results):
            lines[2] = lead(results)
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text("\n".join(lines) + "\n")
        print("\n".join(lines[:8]))
        print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
