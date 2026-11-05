#!/usr/bin/env python3
"""S152 / A334 — option structures on indicator_events vs vol-matched random (pre-registered in asks/A334.md).

    cd research/studies/scripts && nice -n 15 env OMP_NUM_THREADS=4 \\
      ../../scripts/watchlist_sync/.venv/bin/python s152_indicator_option_structures.py [--smoke]
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402
from option_pricing import (  # noqa: E402
    FILL_FRAC,
    MIN_PREMIUM,
    atm_straddle_strike,
    bs_price,
    credit_pnl,
    credit_pnl_short_call,
    credit_pnl_short_put,
    debit_pnl,
    delta_strike,
    find_leg,
    hold_T,
    leg_entry,
    nearest_leg,
    nearest_strike,
    price_structure,
    rh_fill,
    strike_step,
    straddle_legs,
)

NY = ZoneInfo("America/New_York")
START = datetime(2026, 10, 8, tzinfo=NY)
END = datetime(2026, 11, 5, tzinfo=NY)
TV_inds = ("ut", "st", "ichimoku", "lsh", "squeeze", "mso")
TF_MIN = {"5m": 5, "15m": 15, "1h": 60}
PRE_BARS, PRE_TOL = 3, 0.25
RANDOM_DRAWS = 20
RTH_OPEN = 9 * 60 + 30
STRUCTURES = (
    "long_outright",
    "debit_vertical",
    "credit_far",
    "long_straddle",
    "long_strangle",
    "short_straddle",
    "iron_condor",
)
HORIZONS = ("60m", "close")
OUT_MD = ROOT / "research" / "studies" / "S152-indicator-option-structures.md"
OUT_JSON = ROOT / "research" / "studies" / "out" / "S152" / "cells.json"


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def et_clock(ts: datetime) -> tuple[str, int]:
    t = ts.astimezone(NY)
    return t.strftime("%Y-%m-%d"), t.hour * 60 + t.minute


def resample_bars(raw: list[tuple[datetime, float, float, float, float]]) -> dict[str, list[dict]]:
    """raw ascending (ts, o,h,l,c) -> resampled per tf."""
    out: dict[str, list[dict]] = {tf: [] for tf in TF_MIN}
    b5: list[dict] = []
    key = ""
    for ts, o, h, l, c in raw:
        sec = int(ts.timestamp())
        b5.append({"time": sec, "lastTime": sec, "end": sec + 300, "open": o, "high": h, "low": l, "close": c})
    out["5m"] = b5
    for tf, minutes in TF_MIN.items():
        if tf == "5m":
            continue
        bars: list[dict] = []
        key = ""
        for b in b5:
            day, m = et_clock(datetime.fromtimestamp(b["time"], NY))
            idx = (m - RTH_OPEN) // minutes
            k = f"{day}|{idx}"
            if k != key or not bars:
                key = k
                start = b["time"] - (m - RTH_OPEN - idx * minutes) * 60
                bars.append(
                    {
                        "time": b["time"],
                        "lastTime": b["time"],
                        "end": start + minutes * 60,
                        "open": b["open"],
                        "high": b["high"],
                        "low": b["low"],
                        "close": b["close"],
                    }
                )
            else:
                r = bars[-1]
                r["high"] = max(r["high"], b["high"])
                r["low"] = min(r["low"], b["low"])
                r["close"] = b["close"]
                r["lastTime"] = b["time"]
        out[tf] = bars
    return out


def atr_series(bars: list[dict], period: int = 14) -> list[float]:
    trs: list[float] = []
    out: list[float] = [float("nan")] * len(bars)
    for i, b in enumerate(bars):
        if i == 0:
            trs.append(b["high"] - b["low"])
        else:
            p = bars[i - 1]["close"]
            trs.append(max(b["high"] - b["low"], abs(b["high"] - p), abs(b["low"] - p)))
        if i >= period:
            out[i] = sum(trs[i - period + 1 : i + 1]) / period
    return out


def pre_move(bars: list[dict], atrs: list[float]) -> list[float]:
    pre = [float("nan")] * len(bars)
    for i in range(PRE_BARS, len(bars)):
        a = atrs[i]
        if a > 0 and math.isfinite(a):
            pre[i] = abs(bars[i]["close"] - bars[i - PRE_BARS]["close"]) / a
    return pre


def bar_ctx(bars: list[dict]) -> tuple[list[str], list[int], list[int]]:
    days, mods, sess_end = [], [], [0] * len(bars)
    for b in bars:
        d, m = et_clock(datetime.fromtimestamp(b["time"], NY))
        days.append(d)
        mods.append(m)
    for i in range(len(bars) - 1, -1, -1):
        sess_end[i] = sess_end[i + 1] if i + 1 < len(bars) and days[i + 1] == days[i] else i
    return days, mods, sess_end


def mulberry32(a: int):
    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rnd


def hash_str(s: str) -> int:
    h = 2166136261
    for c in s.encode():
        h ^= c
        h = (h * 16777619) & 0xFFFFFFFF
    return h


@dataclass
class ChainSnap:
    as_of: date
    spot: float
    by_expiry: dict[date, list[dict]]


def load_chains(conn) -> dict[tuple[str, date], ChainSnap]:
    rows = conn.execute(
        """SELECT ticker, as_of, expiry, side, strike::float, dte, spot::float, bid::float, ask::float,
                  iv::float, delta::float, fetched_at
           FROM option_chain_history WHERE as_of >= %s AND as_of <= %s""",
        (START.date(), END.date()),
    ).fetchall()
    out: dict[tuple[str, date], ChainSnap] = {}
    tmp: dict[tuple[str, date], list] = defaultdict(list)
    for r in rows:
        tmp[(r[0], r[1])].append(r)
    for (tk, as_of), rs in tmp.items():
        by_exp: dict[date, list[dict]] = defaultdict(list)
        spot = float(rs[0][6])
        for r in rs:
            leg = {
                "expiry": r[2],
                "side": r[3],
                "strike": r[4],
                "dte": r[5],
                "bid": r[7],
                "ask": r[8],
                "iv": r[9],
                "delta": r[10],
            }
            by_exp[r[2]].append(leg)
        out[(tk, as_of)] = ChainSnap(as_of=as_of, spot=spot, by_expiry=dict(by_exp))
    return out


def chain_asof(chains: dict[tuple[str, date], ChainSnap], ticker: str, entry: datetime) -> ChainSnap | None:
    cands = [(d, snap) for (t, d), snap in chains.items() if t == ticker]
    if not cands:
        return None
    cands.sort(key=lambda x: x[0])
    # latest as_of with fetched_at <= entry — we only have as_of date; use as_of <= entry ET date
    ed = entry.astimezone(NY).date()
    best = None
    for d, snap in cands:
        if d <= ed:
            best = snap
    return best


def pick_expiry(snap: ChainSnap, ed: date) -> tuple[date, int] | None:
    best = None
    for exp, legs in snap.by_expiry.items():
        dte = (exp - ed).days
        if dte < 1:
            continue
        if best is None or dte < (best[0] - ed).days:
            best = (exp, dte)
    return best


def exit_bar_index(bars: list[dict], i: int, sess_end: int, horizon: str) -> int | None:
    if horizon == "close":
        return sess_end
    t60 = bars[i]["end"] + 3600
    for j in range(i + 1, sess_end + 1):
        b = bars[j]
        if b["lastTime"] + 300 >= b["end"] and b["end"] >= t60:
            return j
    return sess_end


def clustered_t(deltas: list[float], days: list[str]) -> tuple[float, float, float]:
    n = len(deltas)
    if n < 3:
        return float("nan"), float("nan"), float("nan")
    mean = sum(deltas) / n
    by: dict[str, float] = defaultdict(float)
    cnt: dict[str, int] = defaultdict(int)
    for d, x in zip(days, deltas):
        by[d] += x
        cnt[d] += 1
    D = len(by)
    if D < 3:
        return mean, float("nan"), float("nan")
    ss = sum((by[d] - cnt[d] * mean) ** 2 for d in by)
    se = math.sqrt((ss * D) / (D - 1)) / n
    t = mean / se if se > 0 else 0.0
    p = 2 * (1 - norm_cdf(abs(t))) if se > 0 else 1.0
    return mean, t, p


def both_halves(deltas: list[float], times: list[int]) -> bool:
    order = sorted(range(len(times)), key=lambda k: times[k])
    h = len(order) // 2
    m1 = sum(deltas[order[i]] for i in order[:h]) / max(h, 1)
    m2 = sum(deltas[order[i]] for i in order[h:]) / max(len(order) - h, 1)
    return (m1 > 0 and m2 > 0) or (m1 < 0 and m2 < 0)


def holm_adjust(pvals: list[float]) -> list[float]:
    m = len(pvals)
    idx = sorted(range(m), key=lambda i: pvals[i])
    adj = [1.0] * m
    prev = 0.0
    for rank, i in enumerate(idx):
        val = min(1.0, pvals[i] * (m - rank))
        prev = max(prev, val)
        adj[i] = prev
    return adj


def chain_index(chains: dict[tuple[str, date], ChainSnap]) -> dict[str, list[date]]:
    idx: dict[str, list[date]] = defaultdict(list)
    for t, d in chains:
        idx[t].append(d)
    for t in idx:
        idx[t].sort()
    return idx


def snap_on(idx: dict[str, list[date]], chains: dict, ticker: str, ed: date) -> ChainSnap | None:
    ds = idx.get(ticker)
    if not ds:
        return None
    lo, hi = 0, len(ds) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if ds[mid] <= ed:
            best = ds[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return chains[(ticker, best)] if best else None


@dataclass
class TfMeta:
    bars: list[dict]
    pre: list[float]
    days: list[str]
    sess: list[int]
    pool: list[int]
    exit_i: dict[str, list[int | None]]  # horizon -> exit index per bar


def build_meta(bmap: dict[str, list[dict]]) -> dict[tuple[str, str], TfMeta]:
    meta: dict[tuple[str, str], TfMeta] = {}
    for tk, tfs in bmap.items():
        for tf, bars in tfs.items():
            if tf not in TF_MIN:
                continue
            days, _, sess = bar_ctx(bars)
            pre = pre_move(bars, atr_series(bars))
            pool = list(range(PRE_BARS, len(bars)))
            ex: dict[str, list[int | None]] = {}
            for hz in HORIZONS:
                ex[hz] = [exit_bar_index(bars, i, sess[i], hz) for i in range(len(bars))]
            meta[(tk, tf)] = TfMeta(bars, pre, days, sess, pool, ex)
    return meta


def random_entries(
    ev: dict,
    hz: str,
    meta: TfMeta,
    idx: dict[str, list[date]],
    chains: dict,
    side: str,
) -> list[tuple[float, ChainSnap, date, int, float, float]] | None:
    """Each tuple: entry spot, snap, exp, dte, exit spot, hold_min."""
    i = ev["i"]
    ej = meta.exit_i[hz][i]
    if ej is None:
        return None
    bars = meta.bars
    hold_min = (bars[ej]["end"] - bars[i]["end"]) / 60.0
    exit_spot = bars[ej]["close"]
    p0 = meta.pre[i]
    pool = meta.pool
    if not pool:
        return None
    rnd = mulberry32(hash_str(f"s152|{ev['id']}|{hz}"))
    out = []
    tries = 0
    while len(out) < RANDOM_DRAWS and tries < RANDOM_DRAWS * 40:
        tries += 1
        a = pool[int(rnd() * len(pool))]
        if a == i or not math.isfinite(meta.pre[a]):
            continue
        if p0 is not None and math.isfinite(p0) and abs(meta.pre[a] - p0) > PRE_TOL:
            continue
        ej2 = meta.exit_i[hz][a]
        if ej2 is None:
            continue
        ed2 = date.fromisoformat(meta.days[a])
        snap2 = snap_on(idx, chains, ev["tk"], ed2)
        if not snap2:
            continue
        ex2 = pick_expiry(snap2, ed2)
        if not ex2:
            continue
        hm2 = (bars[ej2]["end"] - bars[a]["end"]) / 60.0
        out.append((bars[a]["close"], snap2, ex2[0], ex2[1], bars[ej2]["close"], hm2))
    return out if len(out) >= RANDOM_DRAWS // 2 else None


def main(smoke: bool = False) -> None:
    conn = connect()
    chains = load_chains(conn)
    cidx = chain_index(chains)
    ev_rows = conn.execute(
        """SELECT e.id, e.indicator_id, e.ticker, e.tf, e.time, e.side, e.price::float
           FROM indicator_events e
           JOIN indicator_grades g ON g.event_id = e.id
           WHERE e.side IN ('buy','sell') AND e.time >= %s AND e.time < %s
             AND e.indicator_id = ANY(%s)
           ORDER BY e.time""",
        (START, END, list(TV_inds)),
    ).fetchall()
    if smoke:
        ev_rows = ev_rows[:500]
    tickers = sorted({r[2] for r in ev_rows})
    bars_by_ticker: dict[str, dict[str, list[dict]]] = {}
    for tk in tickers:
        raw = conn.execute(
            """SELECT ts, o, h, l, c FROM optlab.bars_5m
               WHERE ticker = %s AND ts >= %s AND ts < %s ORDER BY ts""",
            (tk, START - timedelta(days=1), END),
        ).fetchall()
        if len(raw) < 200:
            continue
        bars_by_ticker[tk] = resample_bars([(r[0], r[1], r[2], r[3], r[4]) for r in raw])

    meta_all = build_meta(bars_by_ticker)

    events = []
    for eid, ind, tk, tf, ts, side, price in ev_rows:
        bmap = bars_by_ticker.get(tk)
        m = meta_all.get((tk, tf))
        if not bmap or not m:
            continue
        bars = m.bars
        sec = int(ts.timestamp())
        idx = next((i for i, b in enumerate(bars) if b["time"] == sec), None)
        if idx is None:
            idx = next((i for i, b in enumerate(bars) if abs(b["time"] - sec) < 600), None)
        if idx is None:
            continue
        ed = ts.astimezone(NY).date()
        snap = snap_on(cidx, chains, tk, ed)
        if not snap:
            continue
        exp_d = pick_expiry(snap, ed)
        if not exp_d:
            continue
        exp, dte = exp_d
        events.append(
            {
                "id": eid,
                "ind": ind,
                "tk": tk,
                "tf": tf,
                "side": side,
                "price": price,
                "ts": ts,
                "i": idx,
                "day": m.days[idx],
                "time": bars[idx]["time"],
                "snap": snap,
                "exp": exp,
                "dte": dte,
            }
        )

    cell_sig: dict[tuple, list[float]] = defaultdict(list)
    cell_rnd: dict[tuple, list[float]] = defaultdict(list)
    cell_days: dict[tuple, list[str]] = defaultdict(list)
    cell_times: dict[tuple, list[int]] = defaultdict(list)
    spot_check = None

    for ev in events:
        m = meta_all[(ev["tk"], ev["tf"])]
        i = ev["i"]
        for hz in HORIZONS:
            ej = m.exit_i[hz][i]
            if ej is None:
                continue
            hold_min = (m.bars[ej]["end"] - m.bars[i]["end"]) / 60.0
            exit_spot = m.bars[ej]["close"]
            rnd_ctx = random_entries(ev, hz, m, cidx, chains, ev["side"])
            rnd_by_st: dict[str, float] = {}
            for st in STRUCTURES:
                sig = price_structure(st, ev["side"], ev["price"], ev["snap"], ev["exp"], ev["dte"], exit_spot, hold_min)
                if sig is None:
                    continue
                key = (ev["ind"], ev["tf"], st, hz)
                if st not in rnd_by_st:
                    if not rnd_ctx:
                        rnd_by_st[st] = float("nan")
                    else:
                        rs = [
                            price_structure(st, ev["side"], r[0], r[1], r[2], r[3], r[4], r[5])
                            for r in rnd_ctx
                        ]
                        rs = [x for x in rs if x is not None]
                        rnd_by_st[st] = sum(rs) / len(rs) if rs else float("nan")
                cell_sig[key].append(sig)
                cell_rnd[key].append(rnd_by_st[st])
                cell_days[key].append(ev["day"])
                cell_times[key].append(ev["time"])
                if spot_check is None and st == "long_straddle" and ev["ind"] == "lsh":
                    spot_check = (ev, st, hz, sig, rnd_ctx, hold_min)

    rows = []
    raw_p = []
    keys = []
    for key in cell_sig:
        sigs = cell_sig[key]
        rnds = cell_rnd[key]
        deltas = [s - r for s, r in zip(sigs, rnds) if math.isfinite(r)]
        if len(deltas) < 10:
            continue
        days_u = len(set(cell_days[key][: len(deltas)]))
        lift, t, p = clustered_t(deltas, cell_days[key][: len(deltas)])
        bh = both_halves(deltas, cell_times[key][: len(deltas)])
        keys.append(key)
        raw_p.append(p if math.isfinite(p) else 1.0)
        rows.append(
            {
                "ind": key[0],
                "tf": key[1],
                "structure": key[2],
                "horizon": key[3],
                "n": len(deltas),
                "days": days_u,
                "lift": lift,
                "t": t,
                "p": p,
                "both": bh,
                "sig_mean": sum(sigs) / len(sigs),
                "rnd_mean": sum(r for r in rnds if math.isfinite(r)) / max(1, sum(1 for r in rnds if math.isfinite(r))),
            }
        )
    holm = holm_adjust(raw_p) if raw_p else []
    for i, r in enumerate(rows):
        r["p_holm"] = holm[i]
        r["pass"] = (
            r["lift"] >= 5.0
            and r["p_holm"] < 0.05
            and r["both"]
            and r["n"] >= 100
            and r["days"] >= 10
        )

    rows.sort(key=lambda r: (-r["lift"] if math.isfinite(r["lift"]) else -999, -r["n"]))
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(rows, indent=2))

    passed = [r for r in rows if r["pass"]]
    top5 = rows[:5]
    lsh_st = [r for r in rows if r["structure"] == "long_straddle" and r["ind"] in ("lsh", "st")]

    lines = [
        "# S152 — Option structures on indicator signals vs vol-matched random",
        "",
        f"**Ask:** A334 · **Window:** {START.date()} → {END.date()} · **Chain days:** 19 · **Pricing:** RH entry fill; IV inverted from fill; BS exit (years, entry IV); ±10% IV in JSON.",
        "",
        "## Verdict",
        "",
    ]
    if passed:
        lines.append(f"**{len(passed)} cell(s) pass** pre-registered bar (lift ≥ +5% risk, Holm p<0.05, both halves, n≥100, days≥10).")
    else:
        lines.append("**No option edge yet** — no structure×indicator cell passes the pre-registered bar.")
    lines += ["", "## Top cells by lift", ""]
    lines.append("| ind | tf | structure | hz | n | days | lift | t | Holm p | both |")
    lines.append("|---|---|---|---|---:|---:|---:|---:|---:|:---:|")
    for r in top5:
        lines.append(
            f"| {r['ind']} | {r['tf']} | {r['structure']} | {r['horizon']} | {r['n']} | {r['days']} | {r['lift']:+.2f} | {r['t']:.2f} | {r['p_holm']:.3g} | {'Y' if r['both'] else 'N'} |"
        )
    lines += ["", "## LSH / ST long straddle", ""]
    for r in lsh_st:
        lines.append(
            f"- **{r['ind']} {r['tf']} {r['horizon']}:** n={r['n']} lift {r['lift']:+.2f}% t={r['t']:.2f} Holm={r['p_holm']:.3g} both={'Y' if r['both'] else 'N'}"
        )
    if spot_check:
        ev, st, hz, sig, rnd_ctx, hm = spot_check
        rnd_vals = []
        if rnd_ctx:
            rnd_vals = [
                x
                for x in (
                    price_structure(st, ev["side"], r[0], r[1], r[2], r[3], r[4], r[5]) for r in rnd_ctx
                )
                if x is not None
            ]
        rmean = sum(rnd_vals) / len(rnd_vals) if rnd_vals else float("nan")
        legs = ev["snap"].by_expiry.get(ev["exp"], [])
        try:
            cL, pL, k = straddle_legs(legs, ev["price"])
        except LookupError:
            cL = pL = k = None
        leg_txt = ""
        if cL and pL:
            ce, pe = leg_entry(cL, True, ev["price"], ev["dte"]), leg_entry(pL, True, ev["price"], ev["dte"])
            leg_txt = (
                f" legs: C{cL['strike']:.0f}/P{pL['strike']:.0f}"
                f"{' same K' if k else ' nearest OTM'} · debit {ce[0]+pe[0]:.2f}"
            )
        lines += ["", "## Spot-checked trade (LSH straddle)", ""]
        lines.append(
            f"- {ev['tk']} {ev['side']} @ {ev['ts'].astimezone(NY).isoformat()} entry spot {ev['price']:.2f}{leg_txt} · "
            f"{st} {hz} hold {hm:.0f}m · signal P&L {sig:+.1f}% of premium · random mean {rmean:+.1f}% (n={len(rnd_vals)} draws)"
        )
    lines += [
        "",
        f"**Events priced:** {len(events)} (6 TV indicators, buy/sell, chain as_of ≤ entry day, `optlab.bars_5m` exit bars).",
        "**Caveat:** `option_chain_history` is 1–35% OTM only; ATM straddle uses nearest strike with both call+put at same K (~1% OTM).",
        "**IV:** per-leg IV inverted from RH entry fill (stored chain IV ignored when inconsistent); exit BS holds that IV flat.",
        "",
        "## MDE (no pass)",
        "",
    ]
    big = [r for r in rows if r["n"] >= 100 and r["structure"] == "long_straddle"]
    if big:
        b = max(big, key=lambda r: abs(r["t"]))
        se = abs(b["lift"] / b["t"]) if b["t"] else float("nan")
        mde = 1.96 * se if math.isfinite(se) else float("nan")
        need = max(0, int(math.ceil(b["n"] * ((mde / 5.0) ** 2 - 1)))) if mde > 5 else "many more days"
        lines.append(
            f"- Largest-|t| straddle cell with n≥100: **{b['ind']} {b['tf']} {b['horizon']}** n={b['n']} lift {b['lift']:+.1f}% t={b['t']:.2f} · "
            f"MDE≈{mde:.1f} pp/trade · need ≈{need} similar events for +5 pp lift at current noise (pre-reg bar)."
        )
    lines += [
        "",
        "## Methods",
        "",
        "- Events: indicator_events ⨝ grades, 6 TV indicators, buy/sell only, chain as_of ≤ entry ET day, DTE≥1 nearest expiry.",
        "- Comparator: ≥20 vol-matched random bars (|3-bar move|/ATR within ±0.25), same ticker/tf/structure/side/hold.",
        "- Stop rule: one grid pass, no re-tuning (A334).",
        "",
        f"Re-run: `research/studies/scripts/s152_indicator_option_structures.py` · cells: `{OUT_JSON.relative_to(ROOT)}`",
    ]
    OUT_MD.write_text("\n".join(lines) + "\n")
    print(f"events priced {len(events)} cells {len(rows)} pass {len(passed)} -> {OUT_MD}")


if __name__ == "__main__":
    main("--smoke" in sys.argv)
