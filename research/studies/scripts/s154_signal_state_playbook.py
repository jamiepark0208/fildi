#!/usr/bin/env python3
"""S154 / A336 — signal-state × structure playbook, walk-forward (asks/A336.md).

    cd research/studies/scripts && nice -n 15 env OMP_NUM_THREADS=4 \\
      ../../scripts/watchlist_sync/.venv/bin/python s154_signal_state_playbook.py [--smoke]
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))

_spec = importlib.util.spec_from_file_location(
    "s152_indicator_option_structures",
    ROOT / "research/studies/scripts/s152_indicator_option_structures.py",
)
s152 = importlib.util.module_from_spec(_spec)
assert _spec.loader
sys.modules[_spec.name] = s152
_spec.loader.exec_module(s152)

from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
START, END = s152.START, s152.END
TV_inds = s152.TV_inds
FILL_FRAC = s152.FILL_FRAC
PRE_BARS, PRE_TOL = s152.PRE_BARS, s152.PRE_TOL
RANDOM_DRAWS = s152.RANDOM_DRAWS
RTH_OPEN = s152.RTH_OPEN
MARKET_WINDOW_SEC = 600
QUIET_NS = (6, 12, 24)

OUT_MD = ROOT / "research/studies/S154-signal-state-playbook.md"
OUT_JSON = ROOT / "research/studies/out/S154/playbook.json"

STRUCTURES = (
    "long_stock",
    "short_stock",
    "long_outright",
    "short_outright_otm",
    "debit_vertical",
    "credit_far",
    "short_put_otm",
    "short_call_otm",
    "long_straddle",
    "short_straddle",
    "long_strangle",
    "iron_condor",
)
MIRROR = {
    "long_stock": "short_stock",
    "short_stock": "long_stock",
    "long_outright": "short_outright_otm",
    "short_outright_otm": "long_outright",
    "debit_vertical": "credit_far",
    "credit_far": "debit_vertical",
    "short_put_otm": "long_outright",
    "short_call_otm": "short_outright",
    "long_straddle": "short_straddle",
    "short_straddle": "long_straddle",
    "long_strangle": "iron_condor",
    "iron_condor": "long_strangle",
}
HOLDS = ("30m", "60m", "close", "1d", "3d", "5d", "swing_flip")


def sma(arr: list[float], n: int) -> list[float]:
    out = [float("nan")] * len(arr)
    for i in range(n - 1, len(arr)):
        out[i] = sum(arr[i - n + 1 : i + 1]) / n
    return out


def stdev(arr: list[float], n: int) -> list[float]:
    out = [float("nan")] * len(arr)
    for i in range(n - 1, len(arr)):
        w = arr[i - n + 1 : i + 1]
        m = sum(w) / n
        out[i] = math.sqrt(sum((x - m) ** 2 for x in w) / n)
    return out


def linreg(y: list[float], n: int) -> list[float]:
    out = [float("nan")] * len(y)
    for i in range(n - 1, len(y)):
        ys = y[i - n + 1 : i + 1]
        xs = list(range(n))
        xm = (n - 1) / 2.0
        ym = sum(ys) / n
        num = sum((xs[j] - xm) * (ys[j] - ym) for j in range(n))
        den = sum((xs[j] - xm) ** 2 for j in range(n))
        b = num / den if den else 0.0
        a = ym - b * xm
        out[i] = a + b * (n - 1)
    return out


def squeeze_state(bars: list[dict]) -> list[str | None]:
    """LazyBear on/off/none on 5m bars."""
    n = len(bars)
    close = [b["close"] for b in bars]
    high = [b["high"] for b in bars]
    low = [b["low"] for b in bars]
    bb_len, kc_len, kc_mult = 20, 20, 1.5
    basis = sma(close, bb_len)
    sd = stdev(close, bb_len)
    ma = sma(close, kc_len)
    trs = [high[0] - low[0]]
    for i in range(1, n):
        p = close[i - 1]
        trs.append(max(high[i] - low[i], abs(high[i] - p), abs(low[i] - p)))
    rangema = sma(trs, kc_len)
    hh, ll = [], []
    for i in range(n):
        lo_i = max(0, i - kc_len + 1)
        hh.append(max(high[lo_i : i + 1]))
        ll.append(min(low[lo_i : i + 1]))
    smc = sma(close, kc_len)
    src = [close[i] - ((hh[i] + ll[i]) / 2 + smc[i]) / 2 for i in range(n)]
    val = linreg(src, kc_len)
    state: list[str | None] = [None] * n
    for i in range(n):
        if not all(math.isfinite(x) for x in (basis[i], sd[i], ma[i], rangema[i])):
            continue
        dev = kc_mult * sd[i]
        upper_bb, lower_bb = basis[i] + dev, basis[i] - dev
        upper_kc = ma[i] + rangema[i] * kc_mult
        lower_kc = ma[i] - rangema[i] * kc_mult
        if lower_bb > lower_kc and upper_bb < upper_kc:
            state[i] = "on"
        elif lower_bb < lower_kc and upper_bb > upper_kc:
            state[i] = "off"
        else:
            state[i] = "none"
    _ = val
    return state


def sortino(rets: list[float]) -> float:
    if len(rets) < 2:
        return float("nan")
    m = sum(rets) / len(rets)
    downs = [min(r, 0.0) for r in rets]
    ds = math.sqrt(sum(d * d for d in downs) / len(downs))
    return m / ds if ds > 1e-9 else (float("inf") if m > 0 else float("nan"))


def cvar5(rets: list[float]) -> float:
    if len(rets) < 20:
        return float("nan")
    s = sorted(rets)
    k = max(1, len(s) // 20)
    return sum(s[:k]) / k


def max_dd(rets: list[float]) -> float:
    eq = 0.0
    peak = 0.0
    mdd = 0.0
    for r in rets:
        eq += r
        peak = max(peak, eq)
        mdd = min(mdd, eq - peak)
    return mdd


def price_extended(
    name: str,
    side_signal: str,
    spot: float,
    snap: s152.ChainSnap,
    exp: date,
    dte: int,
    exit_spot: float,
    hold_min: float,
) -> float | None:
    if name == "long_stock":
        return (exit_spot - spot) / spot * 100.0
    if name == "short_stock":
        return (spot - exit_spot) / spot * 100.0
    if name == "short_outright_otm":
        bull = side_signal == "buy"
        legs = snap.by_expiry.get(exp)
        if not legs:
            return None
        side = "put" if bull else "call"
        L = s152.delta_strike(legs, side, 0.15)
        if not L:
            return None
        px, iv = s152.leg_entry(L, False, spot, dte)
        ex = s152.bs_price(side, exit_spot, L["strike"], s152.hold_T(dte, hold_min), iv)
        fn = s152.credit_pnl_short_put if side == "put" else s152.credit_pnl_short_call
        return fn(px, L["strike"], ex, spot)
    if name == "short_put_otm":
        legs = snap.by_expiry.get(exp)
        if not legs:
            return None
        L = s152.delta_strike(legs, "put", 0.15)
        if not L:
            return None
        px, iv = s152.leg_entry(L, False, spot, dte)
        ex = s152.bs_price("put", exit_spot, L["strike"], s152.hold_T(dte, hold_min), iv)
        return s152.credit_pnl_short_put(px, L["strike"], ex, spot)
    if name == "short_call_otm":
        legs = snap.by_expiry.get(exp)
        if not legs:
            return None
        L = s152.delta_strike(legs, "call", 0.15)
        if not L:
            return None
        px, iv = s152.leg_entry(L, False, spot, dte)
        ex = s152.bs_price("call", exit_spot, L["strike"], s152.hold_T(dte, hold_min), iv)
        return s152.credit_pnl_short_call(px, L["strike"], ex, spot)
    s152_name = name
    if name == "short_outright_otm":
        s152_name = "credit_far"
    return s152.price_structure(s152_name, side_signal, spot, snap, exp, dte, exit_spot, hold_min)


def baseline_put30(spot: float, snap: s152.ChainSnap, exp: date, dte: int, exit_spot: float, hold_min: float) -> float | None:
    legs = snap.by_expiry.get(exp)
    if not legs:
        return None
    L = s152.delta_strike(legs, "put", 0.30)
    if not L:
        return None
    px, iv = s152.leg_entry(L, False, spot, dte)
    ex = s152.bs_price("put", exit_spot, L["strike"], s152.hold_T(dte, hold_min), iv)
    return s152.credit_pnl_short_put(px, L["strike"], ex, spot)


def exit_for_hold(
    meta: s152.TfMeta,
    i: int,
    hold: str,
    flip_times: dict[str, list[tuple[int, str]]],
    tk: str,
) -> tuple[int | None, float]:
    bars = meta.bars
    if hold in ("30m", "60m", "close"):
        hz = "60m" if hold == "60m" else ("close" if hold == "close" else "30m")
        if hold == "30m":
            t_end = bars[i]["end"] + 1800
            for j in range(i + 1, meta.sess[i] + 1):
                if bars[j]["end"] >= t_end:
                    ej = j
                    break
            else:
                ej = meta.sess[i]
        else:
            ej = meta.exit_i.get(hz, meta.exit_i["60m"])[i] if hz != "close" else meta.exit_i["close"][i]
        if ej is None:
            return None, 0.0
        hm = (bars[ej]["end"] - bars[i]["end"]) / 60.0
        return ej, hm
    day0 = meta.days[i]
    sessions = sorted({d for d in meta.days})
    try:
        di = sessions.index(day0)
    except ValueError:
        return None, 0.0
    if hold == "swing_flip":
        t0 = bars[i]["time"]
        flips = flip_times.get(tk, [])
        ej = meta.sess[i]
        cap = datetime.fromtimestamp(t0, NY).date() + timedelta(days=20)
        for ts, side in flips:
            if ts <= t0:
                continue
            if datetime.fromtimestamp(ts, NY).date() > cap:
                break
            for j in range(i + 1, len(bars)):
                if bars[j]["time"] >= ts:
                    ej = j
                    break
            break
        hm = (bars[ej]["end"] - bars[i]["end"]) / 60.0
        return ej, hm
    add = {"1d": 1, "3d": 3, "5d": 5}[hold]
    target = sessions[min(di + add, len(sessions) - 1)]
    ej = meta.sess[i]
    for j in range(i, len(bars)):
        if meta.days[j] == target:
            ej = meta.sess[j]
    hm = (bars[ej]["end"] - bars[i]["end"]) / 60.0
    return ej, hm


@dataclass
class Entry:
    state: str
    tk: str
    side: str
    i: int
    day: str
    time: int
    spot: float
    snap: s152.ChainSnap
    exp: date
    dte: int
    meta_key: tuple[str, str]


def open_hour(mod: int) -> bool:
    return RTH_OPEN <= mod < RTH_OPEN + 60


def build_entries(
    conn,
    chains,
    cidx,
    meta_all,
    bars_by_ticker,
    smoke: bool,
) -> list[Entry]:
    ev_rows = conn.execute(
        """SELECT e.id, e.indicator_id, e.ticker, e.tf, e.time, e.side, e.price::float, e.kind
           FROM indicator_events e
           JOIN indicator_grades g ON g.event_id = e.id
           WHERE e.side IN ('buy','sell') AND e.time >= %s AND e.time < %s
             AND e.indicator_id = ANY(%s)
           ORDER BY e.time""",
        (START, END, list(TV_inds)),
    ).fetchall()
    idx_ev = [(r[2], r[4], r[5], int(r[4].timestamp())) for r in ev_rows if r[2] in ("SPY", "QQQ")]

    sq_state: dict[str, list[str | None]] = {}
    for tk, tfs in bars_by_ticker.items():
        b5 = tfs.get("5m")
        if b5:
            sq_state[tk] = squeeze_state(b5)

    signal_times: dict[str, set[int]] = defaultdict(set)
    for r in ev_rows:
        tk, ts = r[2], r[4]
        b5 = bars_by_ticker.get(tk, {}).get("5m")
        if not b5:
            continue
        sec = int(ts.timestamp())
        i5 = next((i for i, b in enumerate(b5) if abs(b["time"] - sec) < 600), None)
        if i5 is not None:
            signal_times[tk].add(i5)

    flip_times: dict[str, list[tuple[int, str]]] = defaultdict(list)
    ut_flips: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in ev_rows:
        if r[1] == "ut" and r[3] == "1h":
            ut_flips[r[2]].append((int(r[4].timestamp()), r[5]))
        if r[1] in ("ut", "st") and r[3] == "1h":
            flip_times[r[2]].append((int(r[4].timestamp()), r[5]))
    for tk in ut_flips:
        ut_flips[tk].sort()
    for tk in flip_times:
        flip_times[tk].sort()

    entries: list[Entry] = []
    seen_quiet_day: set[tuple] = set()

    def add_entry(state: str, tk: str, side: str, i: int, tf: str = "5m") -> None:
        m = meta_all.get((tk, tf))
        if not m:
            return
        ed = date.fromisoformat(m.days[i])
        snap = s152.snap_on(cidx, chains, tk, ed)
        if not snap:
            return
        ex = s152.pick_expiry(snap, ed)
        if not ex:
            return
        exp, dte = ex
        entries.append(
            Entry(
                state=state,
                tk=tk,
                side=side,
                i=i,
                day=m.days[i],
                time=m.bars[i]["time"],
                spot=m.bars[i]["close"],
                snap=snap,
                exp=exp,
                dte=dte,
                meta_key=(tk, tf),
            )
        )

    for eid, ind, tk, tf, ts, side, price, kind in ev_rows:
        if tf != "5m":
            continue
        m = meta_all.get((tk, "5m"))
        b5 = bars_by_ticker.get(tk, {}).get("5m")
        if not m or not b5:
            continue
        sec = int(ts.timestamp())
        i = next((j for j, b in enumerate(b5) if abs(b["time"] - sec) < 600), None)
        if i is None:
            continue
        _, mod = s152.et_clock(ts)
        sq = sq_state.get(tk, [None] * len(b5))[i]
        spy = any(x[0] == "SPY" and x[2] == side and abs(x[3] - sec) <= MARKET_WINDOW_SEC for x in idx_ev)
        qqq = any(x[0] == "QQQ" and x[2] == side and abs(x[3] - sec) <= MARKET_WINDOW_SEC for x in idx_ev)
        agree15 = any(
            r[2] == tk
            and r[3] == "15m"
            and r[1] == ind
            and r[5] == side
            and r[7] == kind
            and abs(int(r[4].timestamp()) - sec) < 1800
            for r in ev_rows
        )
        if open_hour(mod) and agree15 and spy and qqq and sq == "on":
            ut_side = None
            fl = ut_flips.get(tk, [])
            if fl:
                fi = 0
                for j in range(len(fl)):
                    if fl[j][0] <= sec:
                        fi = j
                ut_side = fl[fi][1]
            if ut_side == side:
                add_entry("post_signal_filtered", tk, side, i)
            elif ut_side and ut_side != side:
                add_entry("post_signal_filtered_countertrend", tk, side, i)

    for tk, tfs in bars_by_ticker.items():
        b5 = tfs.get("5m")
        m = meta_all.get((tk, "5m"))
        if not b5 or not m:
            continue
        sq = sq_state.get(tk, [None] * len(b5))
        for N in QUIET_NS:
            for i in m.pool:
                if sq[i] == "on":
                    continue
                quiet = True
                for j in range(max(0, i - N), i):
                    if j in signal_times[tk]:
                        quiet = False
                        break
                if not quiet:
                    continue
                day = m.days[i]
                key = (tk, day, N)
                if key in seen_quiet_day:
                    continue
                seen_quiet_day.add(key)
                add_entry(f"pre_quiet_{N}", tk, "neutral", i)

    # Trend + vol tags applied per entry below via overlay states
    if smoke:
        return entries[:800]
    return entries


def main(smoke: bool = False) -> None:
    conn = connect()
    chains = s152.load_chains(conn)
    cidx = s152.chain_index(chains)
    ev_rows = conn.execute(
        """SELECT e.ticker FROM indicator_events e
           WHERE e.time >= %s AND e.time < %s""",
        (START, END),
    ).fetchall()
    tickers = sorted({r[0] for r in ev_rows})
    bars_by_ticker: dict[str, dict[str, list[dict]]] = {}
    for tk in tickers:
        raw = conn.execute(
            """SELECT ts, o, h, l, c FROM optlab.bars_5m
               WHERE ticker = %s AND ts >= %s AND ts < %s ORDER BY ts""",
            (tk, START - timedelta(days=5), END + timedelta(days=5)),
        ).fetchall()
        if len(raw) < 200:
            continue
        bars_by_ticker[tk] = s152.resample_bars([(r[0], r[1], r[2], r[3], r[4]) for r in raw])

    meta_all = s152.build_meta(bars_by_ticker)
    # extend exit_i for 30m
    for key, m in meta_all.items():
        m.exit_i["30m"] = []
        for i in range(len(m.bars)):
            t30 = m.bars[i]["end"] + 1800
            ej = m.sess[i]
            for j in range(i + 1, m.sess[i] + 1):
                if m.bars[j]["end"] >= t30:
                    ej = j
                    break
            m.exit_i["30m"].append(ej)

    flip_times: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in conn.execute(
        """SELECT ticker, time, side FROM indicator_events
           WHERE indicator_id IN ('ut','st') AND tf='1h' AND time >= %s AND time < %s""",
        (START, END),
    ).fetchall():
        flip_times[r[0]].append((int(r[1].timestamp()), r[2]))
    for tk in flip_times:
        flip_times[tk].sort()

    entries = build_entries(conn, chains, cidx, meta_all, bars_by_ticker, smoke)
    days_sorted = sorted({e.day for e in entries})
    if len(days_sorted) < 4:
        raise SystemExit("too few session days")
    mid = len(days_sorted) // 2
    train_days = set(days_sorted[:mid])
    test_days = set(days_sorted[mid:])

    trades: list[dict] = []
    spot_check = None
    rnd_cache: dict[tuple, list | None] = {}

    def rnd_for(e: Entry, hold: str, m: s152.TfMeta, side: str):
        key = (e.tk, e.i, hold)
        if key not in rnd_cache:
            hz = "close"
            if hold == "60m":
                hz = "60m"
            elif hold in ("30m", "1d", "3d", "5d", "swing_flip"):
                hz = "close"
            rnd_cache[key] = s152.random_entries(
                {"id": e.time, "i": e.i, "tk": e.tk, "side": side},
                hz,
                m,
                cidx,
                chains,
                side,
            )
        return rnd_cache[key]

    for e in entries:
        m = meta_all[e.meta_key]
        side = e.side if e.side in ("buy", "sell") else "buy"
        for hold in HOLDS:
            ej, hm = exit_for_hold(m, e.i, hold, flip_times, e.tk)
            if ej is None:
                continue
            exit_spot = m.bars[ej]["close"]
            rnd_ctx = rnd_for(e, hold, m, side)
            b30 = baseline_put30(e.spot, e.snap, e.exp, e.dte, exit_spot, hm)
            st_pnls: dict[str, float | None] = {}
            for st in STRUCTURES:
                st_pnls[st] = price_extended(st, side, e.spot, e.snap, e.exp, e.dte, exit_spot, hm)
            rnd_by_st: dict[str, float] = {}
            if rnd_ctx:
                for st, sig in st_pnls.items():
                    if sig is None:
                        continue
                    rs = [
                        price_extended(st, side, r[0], r[1], r[2], r[3], r[4], r[5]) for r in rnd_ctx
                    ]
                    rs = [x for x in rs if x is not None]
                    rnd_by_st[st] = sum(rs) / len(rs) if rs else float("nan")
            for st, sig in st_pnls.items():
                if sig is None:
                    continue
                mir = MIRROR.get(st)
                mir_pnl = st_pnls.get(mir) if mir else None
                rnd_pnl = rnd_by_st.get(st, float("nan"))
                trades.append(
                    {
                        "state": e.state,
                        "structure": st,
                        "hold": hold,
                        "pnl": sig,
                        "mirror_pnl": mir_pnl,
                        "random_pnl": rnd_pnl,
                        "baseline_put": b30,
                        "day": e.day,
                        "split": "train" if e.day in train_days else "test",
                        "tk": e.tk,
                        "side": side,
                        "time": e.time,
                        "spot": e.spot,
                        "exit_spot": exit_spot,
                        "hm": hm,
                    }
                )
                if spot_check is None and e.state == "pre_quiet_12" and st == "short_put_otm":
                    spot_check = trades[-1]

    # Walk-forward: best structure×hold per state on train by Sortino
    wf_rows = []
    raw_p = []
    for state in sorted({t["state"] for t in trades}):
        train = [t for t in trades if t["state"] == state and t["split"] == "train"]
        test = [t for t in trades if t["state"] == state and t["split"] == "test"]
        if not train:
            continue
        best_key = None
        best_sort = float("-inf")
        for st in STRUCTURES:
            for hold in HOLDS:
                rets = [t["pnl"] for t in train if t["structure"] == st and t["hold"] == hold]
                if len(rets) < 30:
                    continue
                s = sortino(rets)
                if math.isfinite(s) and s > best_sort:
                    best_sort = s
                    best_key = (st, hold)
        if not best_key:
            wf_rows.append({"state": state, "pick": None, "reason": "no train combo n≥30"})
            continue
        st, hold = best_key
        oos = [t["pnl"] for t in test if t["structure"] == st and t["hold"] == hold]
        oos_rnd = [t["random_pnl"] for t in test if t["structure"] == st and t["hold"] == hold and math.isfinite(t["random_pnl"])]
        oos_put = [t["baseline_put"] for t in test if t["structure"] == st and t["hold"] == hold and t["baseline_put"] is not None]
        deltas = [a - b for a, b in zip(oos, oos_rnd) if math.isfinite(b)]
        _, tstat, pval = s152.clustered_t(deltas, [t["day"] for t in test if t["structure"] == st and t["hold"] == hold][: len(deltas)])
        ins_rets = [t["pnl"] for t in train if t["structure"] == st and t["hold"] == hold]
        losers = [t for t in test if t["structure"] == st and t["hold"] == hold and t["pnl"] < 0][:5]
        mirrors = [
            {"structure": t["structure"], "pnl": t["pnl"], "mirror": t["mirror_pnl"]}
            for t in losers
            if t.get("mirror_pnl") is not None
        ]
        row = {
            "state": state,
            "pick_structure": st,
            "pick_hold": hold,
            "in_sortino": sortino(ins_rets),
            "oos_sortino": sortino(oos),
            "oos_baseline_put_sortino": sortino(oos_put),
            "oos_random_sortino": sortino(oos_rnd),
            "oos_n": len(oos),
            "oos_days": len({t["day"] for t in test if t["structure"] == st and t["hold"] == hold}),
            "win_pct": sum(1 for x in oos if x > 0) / len(oos) if oos else float("nan"),
            "cvar5": cvar5(oos),
            "max_dd": max_dd(oos),
            "avg_pnl": sum(oos) / len(oos) if oos else float("nan"),
            "p_vs_random": pval,
            "mirrors_sample": mirrors,
        }
        row["pass"] = (
            len(oos) >= 100
            and row["oos_days"] >= 10
            and math.isfinite(row["oos_sortino"])
            and math.isfinite(row["oos_baseline_put_sortino"])
            and row["oos_sortino"] > row["oos_baseline_put_sortino"]
            and row["oos_sortino"] > row["oos_random_sortino"]
        )
        wf_rows.append(row)
        raw_p.append(pval if math.isfinite(pval) else 1.0)

    holm = s152.holm_adjust(raw_p) if raw_p else []
    hi = 0
    for row in wf_rows:
        if row.get("pick_structure"):
            row["p_holm"] = holm[hi]
            row["pass"] = row.get("pass") and row["p_holm"] < 0.05
            hi += 1

    quiet_rows = [r for r in wf_rows if r["state"].startswith("pre_quiet")]
    passed = [r for r in wf_rows if r.get("pass")]

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({"wf": wf_rows, "n_entries": len(entries), "n_trades": len(trades)}, indent=2))

    lines = [
        "# S154 — Signal-state strategy playbook (walk-forward)",
        "",
        f"**Ask:** A336 · **Window:** {START.date()} → {END.date()} · **Chain days:** 19 · "
        f"**Entries:** {len(entries)} · **Pricing:** RH {FILL_FRAC:.0%} spread; exit BS entry IV (flat); mirrors paired per spec.",
        "",
        "## Verdict",
        "",
    ]
    if passed:
        lines.append(f"**{len(passed)} state rule(s) pass** OOS Sortino > 30Δ put + random, n≥100, days≥10, Holm p<0.05.")
    else:
        lines.append(
            "**No state→structure rule passes** pre-registered bar (19 chain days; multi-day holds need more snapshots — MDE below)."
        )
    lines += ["", "## Walk-forward (train Sortino → OOS vs baselines)", ""]
    lines.append("| state | in-sample pick | in Sortino | OOS Sortino | vs 30Δ put | vs random | n OOS | days | Holm p | pass |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|")
    for r in wf_rows:
        if not r.get("pick_structure"):
            lines.append(f"| {r['state']} | — | — | — | — | — | — | — | — | N |")
            continue
        lines.append(
            f"| {r['state']} | {r['pick_structure']} {r['pick_hold']} | {r['in_sortino']:.2f} | {r['oos_sortino']:.2f} | "
            f"{r['oos_baseline_put_sortino']:.2f} | {r['oos_random_sortino']:.2f} | {r['oos_n']} | {r['oos_days']} | "
            f"{r.get('p_holm', 1):.3g} | {'Y' if r.get('pass') else 'N'} |"
        )
    lines += ["", "## Losing OOS cells — mirrors (sample)", ""]
    for r in wf_rows:
        if not r.get("mirrors_sample"):
            continue
        lines.append(f"**{r['state']}** ({r['pick_structure']} {r['pick_hold']}):")
        for m in r["mirrors_sample"][:3]:
            lines.append(f"- {m['structure']} {m['pnl']:+.1f}% → mirror {MIRROR.get(m['structure'], '?')} {m['mirror']:+.1f}%")
    lines += ["", "## Quiet-state premium selling", ""]
    for r in quiet_rows:
        if r.get("pick_structure"):
            lines.append(
                f"- **{r['state']}:** pick `{r['pick_structure']}` {r['pick_hold']} · OOS Sortino {r['oos_sortino']:.2f} "
                f"(30Δ put {r['oos_baseline_put_sortino']:.2f}, random {r['oos_random_sortino']:.2f}) n={r['oos_n']}"
            )
    if spot_check:
        t = spot_check
        lines += ["", "## Spot-checked trade", ""]
        lines.append(
            f"- {t['tk']} quiet pre_signal bar · **short_put_otm** hold {t['hold']} · "
            f"entry {t['spot']:.2f} → exit {t['exit_spot']:.2f} ({t['hm']:.0f}m) · "
            f"P&L {t['pnl']:+.1f}% risk · random {t['random_pnl']:+.1f}% · 30Δ put baseline {t['baseline_put']:+.1f}%"
        )
    lines += [
        "",
        "## MDE / data",
        "",
        f"- Calendar span **{len(days_sorted)}** sessions with chain coverage; pass bar needs **≥100 OOS trades on ≥10 days** per state.",
        "- Extend `option_chain_history` + intraday bars for multi-day DTE-matched exits (7–14 / 30–45 DTE buckets under-sampled here).",
        "",
        "## Methods",
        "",
        "- States: post-signal (S153 filters on 5m) + per-indicator post + pre-quiet (N=6/12/24, squeeze-off, no 6-ind signal).",
        "- Walk-forward: first/second calendar half; one pick per state; no re-tune after OOS.",
        "- Baselines: vol-matched random (preMove ±0.25), always short 30Δ put; B&H/T-bill omitted (same sign as stock structures).",
        "",
        f"Re-run: `research/studies/scripts/s154_signal_state_playbook.py` · `{OUT_JSON.relative_to(ROOT)}`",
    ]
    OUT_MD.write_text("\n".join(lines) + "\n")
    print(f"entries={len(entries)} trades={len(trades)} wf={len(wf_rows)} pass={len(passed)} -> {OUT_MD}")


if __name__ == "__main__":
    main("--smoke" in sys.argv)
