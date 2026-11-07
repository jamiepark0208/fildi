#!/usr/bin/env python3
"""A359 fix4 smoke gate — QQQ, 5 sessions of 1m bars."""
from __future__ import annotations

import json
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WATCH))

from bar_resample import resample_bars  # noqa: E402
from build_plan import connect  # noqa: E402
from conditional_engine import (  # noqa: E402
    ConditionSet,
    ExitRules,
    IndicatorCondition,
    PutInstrument,
    load_bars_5m_db,
    run_conditional_strategy,
    simulate_session_puts,
)
from a359_bars_1m import fetch_range_1m, load_parquet_1m  # noqa: E402


def main() -> int:
    t0 = time.perf_counter()
    ok = True
    with connect() as conn:
        df1 = load_parquet_1m("QQQ")
        if df1.empty:
            d1 = date.today()
            d0 = d1
            for _ in range(10):
                df1 = fetch_range_1m(conn, "QQQ", d0, d1)
                if not df1.empty:
                    break
                d0 = d0.replace(day=d0.day - 7) if d0.day > 7 else d0.replace(month=d0.month - 1, day=28)
        poly5 = load_bars_5m_db(conn, ["QQQ"]).get("QQQ")
    if df1.empty:
        print("SANITY FAIL: no QQQ 1m")
        return 1
    bars1 = resample_bars(df1, "1m")
    ts = pd.to_datetime(bars1["ts"], utc=True)
    bars1 = bars1.assign(session_date=ts.dt.tz_convert("America/New_York").dt.tz_localize(None).dt.date)
    sess = sorted(bars1["session_date"].unique())[-5:]
    bars1 = bars1[bars1["session_date"].isin(sess)]
    per_sess = bars1.groupby("session_date").size()
    print(f"SANITY 1m bars/session (last 5): {dict(per_sess)} expect ~390±")
    if not all(350 <= int(n) <= 420 for n in per_sess):
        print("SANITY FAIL: bar count")
        ok = False
    r5 = resample_bars(bars1, "5m")
    ts5 = pd.to_datetime(r5["ts"], utc=True)
    samples = r5.head(3)
    for _, row in samples.iterrows():
        pt = pd.to_datetime(poly5["ts"], utc=True)
        m = poly5[pt == pd.to_datetime(row["ts"], utc=True)]
        if m.empty:
            continue
        diff = abs(float(row["c"]) - float(m["c"].iloc[0]))
        print(f"SANITY 5m match ts={row['ts']} close diff={diff:.4f}")
        if diff > 0.02:
            ok = False
    tk = ["QQQ"]
    inst = PutInstrument(target_delta=-0.15)
    exits = ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)], time_stop="same_day")
    ctx_1m = run_conditional_strategy(
        tk, ConditionSet("and", [IndicatorCondition("rsi14", "lt", 10.0, "1m")]),
        exits, inst, bar_tf="1m", session_filter=lambda d: d in sess,
    )
    ctx_5m = run_conditional_strategy(
        tk, ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "5m")]),
        exits, inst, bar_tf="5m", session_filter=lambda d: d in sess,
    )
    n10 = run_conditional_strategy(
        tk, ConditionSet("and", [IndicatorCondition("rsi14", "lt", 10.0, "5m")]),
        exits, inst, bar_tf="5m", session_filter=lambda d: d in sess,
    )["conditional"]["n"]
    n30 = run_conditional_strategy(
        tk, ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "5m")]),
        exits, inst, bar_tf="5m", session_filter=lambda d: d in sess,
    )["conditional"]["n"]
    print(f"SANITY trade n 1m RSI<10={ctx_1m['conditional']['n']} 5m RSI<30={ctx_5m['conditional']['n']} "
          f"5m RSI10={n10} RSI30={n30}")
    if n10 == n30:
        ok = False
    # hand-check one trade
    payload = run_conditional_strategy(
        tk, ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "1m")]),
        exits, inst, bar_tf="1m", session_filter=lambda d: d in sess, keep_trades=True,
    )
    if payload.get("cond_trades"):
        tr = payload["cond_trades"][0]
        print(f"SANITY hand trade session={tr['session']} signal_bar={tr['signal_bar']} fill={tr['fill_bar']} exit={tr['exit_bar']} reason={tr['exit_reason']}")
    print(f"SANITY wall_s={time.perf_counter()-t0:.1f} ok={ok}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
