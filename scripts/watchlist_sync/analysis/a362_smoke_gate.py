#!/usr/bin/env python3
"""A362 mandatory smoke gate — ≤2 min slice before full survivor-tail."""
from __future__ import annotations

import sys
import time
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from build_plan import connect  # noqa: E402
from conditional_engine import (  # noqa: E402
    ConditionSet,
    ExitRules,
    IndicatorCondition,
    PutInstrument,
    SpreadCalibration,
    _intraday_rsi_by_session,
    iv_intraday_path,
    load_bars_5m_db,
    load_conditional_context,
    load_spread_calibration,
    run_conditional_strategy,
    simulate_session_puts,
)

TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]
N_SESSIONS = 20


def _last_n_sessions(df, n: int):
    sess = sorted(df["session_date"].unique())
    keep = set(sess[-n:])
    return df[df["session_date"].isin(keep)].copy()


def main() -> int:
    t0 = time.perf_counter()
    with connect() as conn:
        raw = load_bars_5m_db(conn, TICKERS)
        spread = load_spread_calibration(conn)
    ok = True

    # 1) RSI warm-up
    tk = "SPY"
    df = _last_n_sessions(raw[tk], N_SESSIONS)
    df2, rsi_full = _intraday_rsi_by_session(df)
    r14 = rsi_full[14]
    bars_per_sess = df2.groupby("session_date").size()
    first_sess_len = int(bars_per_sess.iloc[0])
    i0 = 0
    print(f"SANITY H1a: RSI14 NaN count first session bars 0:{first_sess_len} = {int(np.sum(np.isnan(r14[:first_sess_len])))} (expect ≈{min(13, first_sess_len-1)} first bars)")
    sess_keys = list(df2.groupby("session_date").groups.keys())
    for si in (1, 2, 3):
        if si >= len(sess_keys):
            break
        idx = df2.index[df2["session_date"] == sess_keys[si]].to_numpy()
        i0s, i1s = int(idx[0]), int(idx[-1]) + 1
        print(f"SANITY H1b sess{si} bar0 RSI={r14[i0s]:.2f} prior_last={r14[i0s-1]:.2f} (continuation)")

    # 2) threshold trade count
    trimmed = {t: _last_n_sessions(raw[t], N_SESSIONS) for t in TICKERS if t in raw}
    ctx = load_conditional_context(list(trimmed.keys()))
    ctx.bars_map = trimmed
    ctx.rsi_by_ticker = {}
    for t, dff in trimmed.items():
        _, rf = _intraday_rsi_by_session(dff)
        ctx.rsi_by_ticker[t] = rf
    exits = ExitRules(take_profit_frac=0.50, time_stop="overnight")
    inst = PutInstrument(target_delta=-0.15)
    counts = {}
    for thr in (10.0, 30.0):
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", thr, "5m")])
        pay = run_conditional_strategy(
            list(trimmed.keys()), entry, exits, inst, ctx=ctx,
        )
        counts[thr] = pay["conditional"]["n"]
        print(f"SANITY H1c RSI<{thr:.0f} n={counts[thr]}")
    n10, n30 = counts[10.0], counts[30.0]
    if n10 == n30:
        print("SANITY FAIL H1c: identical trade count RSI10 vs RSI30 — stop")
        ok = False

    # 3) hand-check IV path
    iv_down = iv_intraday_path(25.0, 100.0, 98.0, -2.0)
    iv_up = iv_intraday_path(25.0, 100.0, 102.0, -2.0)
    print(f"SANITY H2: spot 100→98 IV {25.0:.2f}→{iv_down:.2f} (rise); 100→102 IV→{iv_up:.2f} (fall)")

    # 4) spread rt
    spot = 200.0
    strike = 0.97 * spot
    for sym, px in (("AAPL", 190.0), ("QQQ", 500.0), ("SPY", 580.0)):
        rt = spread.round_trip_frac(px, 0.97 * px, 30, ticker=sym, mid=2.5)
        print(f"SANITY spread {sym} 0.97 30-DTE rt (mid=$2.50 model) = {rt:.4f}")

    print(f"SANITY wall_s={time.perf_counter()-t0:.1f}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
