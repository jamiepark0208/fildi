#!/usr/bin/env python3
"""One-off packet metrics for A336 (S154 OOS breakdown) and A334 (S152 straddle fallback share)."""
from __future__ import annotations

import importlib.util
import json
import math
import statistics
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))

import option_pricing as op  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "s152_indicator_option_structures",
    _SCRIPTS / "s152_indicator_option_structures.py",
)
s152 = importlib.util.module_from_spec(_spec)
assert _spec.loader
sys.modules[_spec.name] = s152
_spec.loader.exec_module(s152)

_spec154 = importlib.util.spec_from_file_location(
    "s154_signal_state_playbook",
    _SCRIPTS / "s154_signal_state_playbook.py",
)
s154 = importlib.util.module_from_spec(_spec154)
assert _spec154.loader
sys.modules[_spec154.name] = s154
_spec154.loader.exec_module(s154)

from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
RTH_OPEN = s152.RTH_OPEN
RTH_CLOSE = 16 * 60  # 4pm ET


def tod_bucket(mod: int) -> str:
    if RTH_OPEN <= mod < RTH_OPEN + 60:
        return "first_hour"
    if mod >= RTH_CLOSE - 60:
        return "last_hour"
    return "midday"


def summarize(rets: list[float]) -> dict:
    if not rets:
        return {"n": 0}
    s = sorted(rets)
    return {
        "n": len(rets),
        "avg": sum(rets) / len(rets),
        "med": statistics.median(rets),
        "win_pct": 100.0 * sum(1 for x in rets if x > 0) / len(rets),
        "cvar5": s154.cvar5(rets),
        "max_dd": s154.max_dd(rets),
    }


def s154_oos_breakdown() -> dict:
    conn = connect()
    chains = s152.load_chains(conn)
    cidx = s152.chain_index(chains)
    ev_rows = conn.execute(
        """SELECT e.ticker FROM indicator_events e WHERE e.time >= %s AND e.time < %s""",
        (s154.START, s154.END),
    ).fetchall()
    tickers = sorted({r[0] for r in ev_rows})
    bars_by_ticker: dict[str, dict[str, list[dict]]] = {}
    for tk in tickers:
        raw = conn.execute(
            """SELECT ts, o, h, l, c FROM optlab.bars_5m
               WHERE ticker = %s AND ts >= %s AND ts < %s ORDER BY ts""",
            (tk, s154.START - timedelta(days=5), s154.END + timedelta(days=5)),
        ).fetchall()
        if len(raw) < 200:
            continue
        bars_by_ticker[tk] = s152.resample_bars([(r[0], r[1], r[2], r[3], r[4]) for r in raw])

    meta_all = s152.build_meta(bars_by_ticker)
    for _key, m in meta_all.items():
        m.exit_i["30m"] = []
        for i in range(len(m.bars)):
            t30 = m.bars[i]["end"] + 1800
            ej = m.sess[i]
            for j in range(i + 1, m.sess[i] + 1):
                if m.bars[j]["end"] >= t30:
                    ej = j
                    break
            m.exit_i["30m"].append(ej)

    entries = s154.build_entries(conn, chains, cidx, meta_all, bars_by_ticker, False)
    days_sorted = sorted({e.day for e in entries})
    mid = len(days_sorted) // 2
    train_days = set(days_sorted[:mid])
    test_days = set(days_sorted[mid:])

    trades: list[dict] = []
    rnd_cache: dict[tuple, list | None] = {}

    def rnd_for(e: s154.Entry, hold: str, m: s152.TfMeta, side: str):
        key = (e.tk, e.i, hold)
        if key not in rnd_cache:
            rnd_cache[key] = s152.random_entries(
                {"id": e.time, "i": e.i, "tk": e.tk, "side": side},
                "close",
                m,
                cidx,
                chains,
                side,
            )
        return rnd_cache[key]

    for e in entries:
        m = meta_all[e.meta_key]
        side = e.side if e.side in ("buy", "sell") else "buy"
        hold = "30m"
        ej, hm = s154.exit_for_hold(m, e.i, hold, {}, e.tk)
        if ej is None:
            continue
        exit_spot = m.bars[ej]["close"]
        rnd_ctx = rnd_for(e, hold, m, side)
        st_pnls: dict[str, float | None] = {}
        for st in ("long_strangle",):
            st_pnls[st] = s154.price_extended(st, side, e.spot, e.snap, e.exp, e.dte, exit_spot, hm)
        sig = st_pnls.get("long_strangle")
        if sig is None:
            continue
        rnd_by_st = float("nan")
        if rnd_ctx:
            rs = [
                s154.price_extended("long_strangle", side, r[0], r[1], r[2], r[3], r[4], r[5])
                for r in rnd_ctx
            ]
            rs = [x for x in rs if x is not None]
            rnd_by_st = sum(rs) / len(rs) if rs else float("nan")
        _, mod = s152.et_clock(datetime.fromtimestamp(e.time, NY))
        trades.append(
            {
                "state": e.state,
                "pnl": sig,
                "random_pnl": rnd_by_st,
                "day": e.day,
                "split": "test" if e.day in test_days else "train",
                "tk": e.tk,
                "tod": tod_bucket(mod),
            }
        )

    out: dict = {"oos_days": len(test_days), "by_N": {}}
    for N in (6, 12, 24):
        state = f"pre_quiet_{N}"
        oos = [t["pnl"] for t in trades if t["state"] == state and t["split"] == "test"]
        out["by_N"][str(N)] = {
            "all": summarize(oos),
            "by_ticker": {tk: summarize([t["pnl"] for t in trades if t["state"] == state and t["split"] == "test" and t["tk"] == tk])
            for tk in sorted({t["tk"] for t in trades if t["state"] == state and t["split"] == "test"})},
            "by_tod": {b: summarize([t["pnl"] for t in trades if t["state"] == state and t["split"] == "test" and t["tod"] == b])
            for b in ("first_hour", "midday", "last_hour")},
        }
    return out


def s152_straddle_fallback() -> dict:
    conn = connect()
    chains = s152.load_chains(conn)
    cidx = s152.chain_index(chains)
    ev_rows = conn.execute(
        """SELECT e.id, e.indicator_id, e.ticker, e.tf, e.time, e.side, e.price::float
           FROM indicator_events e
           JOIN indicator_grades g ON g.event_id = e.id
           WHERE e.side IN ('buy','sell') AND e.time >= %s AND e.time < %s
             AND e.indicator_id = ANY(%s)
           ORDER BY e.time""",
        (s152.START, s152.END, list(s152.TV_inds)),
    ).fetchall()
    tickers = sorted({r[2] for r in ev_rows})
    bars_by_ticker: dict[str, dict[str, list[dict]]] = {}
    for tk in tickers:
        raw = conn.execute(
            """SELECT ts, o, h, l, c FROM optlab.bars_5m
               WHERE ticker = %s AND ts >= %s AND ts < %s ORDER BY ts""",
            (tk, s152.START - timedelta(days=1), s152.END),
        ).fetchall()
        if len(raw) < 200:
            continue
        bars_by_ticker[tk] = s152.resample_bars([(r[0], r[1], r[2], r[3], r[4]) for r in raw])
    meta_all = s152.build_meta(bars_by_ticker)

    same_k = 0
    fallback = 0
    for _eid, _ind, tk, tf, ts, side, price in ev_rows:
        m = meta_all.get((tk, tf))
        if not m:
            continue
        bars = m.bars
        sec = int(ts.timestamp())
        idx = next((i for i, b in enumerate(bars) if abs(b["time"] - sec) < 600), None)
        if idx is None:
            continue
        ed = ts.astimezone(NY).date()
        snap = s152.snap_on(cidx, chains, tk, ed)
        if not snap:
            continue
        exp_d = s152.pick_expiry(snap, ed)
        if not exp_d:
            continue
        exp, dte = exp_d
        legs = snap.by_expiry.get(exp)
        if not legs:
            continue
        for hz in s152.HORIZONS:
            ej = m.exit_i[hz][idx]
            if ej is None:
                continue
            hold_min = (m.bars[ej]["end"] - m.bars[idx]["end"]) / 60.0
            exit_spot = m.bars[ej]["close"]
            for st in ("long_straddle", "short_straddle"):
                pnl = op.price_structure(st, side, price, snap, exp, dte, exit_spot, hold_min)
                if pnl is None:
                    continue
                try:
                    _cL, _pL, k = op.straddle_legs(legs, price)
                except LookupError:
                    continue
                if k is not None:
                    same_k += 1
                else:
                    fallback += 1
    total = same_k + fallback
    return {
        "same_strike_quotes": same_k,
        "nearest_otm_fallback": fallback,
        "total_straddle_legs_priced": total,
        "fallback_pct": 100.0 * fallback / total if total else float("nan"),
    }


def main() -> None:
    s154_out = s154_oos_breakdown()
    s152_out = s152_straddle_fallback()
    out = ROOT / "research/studies/out/A336_A334/packet_supplement.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"s154": s154_out, "s152_fallback": s152_out}, indent=2))
    print(json.dumps({"s154": s154_out, "s152_fallback": s152_out}, indent=2))


if __name__ == "__main__":
    main()
