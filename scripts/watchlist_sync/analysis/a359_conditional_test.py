#!/usr/bin/env python3
"""A359 unit tests — conditional engine invariants."""
from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from conditional_engine import (  # noqa: E402
    ConditionSet,
    ExitRules,
    IndicatorCondition,
    OpenPut,
    PutInstrument,
    SpreadCalibration,
    aggregate_trades,
    daily_entry_cross_mask,
    entry_cross_mask,
    iv_intraday_path,
    nearest_listed_strike,
    prior_business_iv,
    rsi_series,
    simulate_session_puts,
    standard_listed_strikes,
)


class TestEntryCross(unittest.TestCase):
    def test_one_fire_per_edge(self) -> None:
        closes = np.linspace(100, 80, 30)
        entry = ConditionSet("or", [IndicatorCondition("rsi14", "lt", 25.0, "5m")])
        cross = entry_cross_mask(entry, closes)
        idx = np.where(cross)[0]
        self.assertEqual(len(idx), 1)
        for i in range(1, len(idx)):
            self.assertGreater(idx[i], idx[i - 1])


class TestNearestStrike(unittest.TestCase):
    def test_abs_nearest(self) -> None:
        listed = [90.0, 95.0, 100.0, 105.0]
        self.assertAlmostEqual(nearest_listed_strike(99.2, listed), 100.0)
        self.assertAlmostEqual(nearest_listed_strike(92.6, listed), 95.0)


class TestRsiWarmup(unittest.TestCase):
    def test_nan_before_n_bars(self) -> None:
        closes = 100 + np.sin(np.linspace(0, 4, 40))
        r = rsi_series(closes, 14)
        self.assertTrue(np.all(np.isnan(r[:13])))
        self.assertGreater(np.sum(np.isfinite(r[13:])), 10)


class TestIvBetaSign(unittest.TestCase):
    def test_iv_rises_when_spot_falls(self) -> None:
        iv0 = iv_intraday_path(30.0, 100.0, 99.0, -2.0)
        self.assertGreater(iv0, 30.0)


class TestLookAhead(unittest.TestCase):
    def test_fill_after_signal(self) -> None:
        bars = pd.DataFrame({
            "o": [100, 99, 98, 99, 100, 101],
            "h": [100, 99, 98, 99, 100, 101],
            "l": [100, 99, 98, 99, 100, 101],
            "c": [100, 99, 98, 99, 100, 101],
            "session_date": [date(2025, 6, 2)] * 6,
        })
        exits = ExitRules(time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=1,
        )
        self.assertEqual(len(tr), 1)
        self.assertGreater(tr[0]["fill_bar"], tr[0]["signal_bar"])


class TestFillOpenNotClose(unittest.TestCase):
    def test_entry_uses_next_open(self) -> None:
        bars = pd.DataFrame({
            "o": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "h": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "l": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "c": [100.0, 100.0, 98.0, 99.0, 100.0, 101.0],
            "session_date": [date(2025, 6, 4)] * 6,
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(6, dtype=bool), ExitRules(time_stop="same_day"),
            iv_anchor=25.0, iv_beta=-2.0, instrument=PutInstrument(), spread=sp,
            force_entry_bar=0,
        )
        self.assertEqual(tr[0]["fill_bar"], 1)
        self.assertAlmostEqual(tr[0]["spot_entry"], 88.0)


class TestFirstHitExit(unittest.TestCase):
    def test_tp_beats_later_rules(self) -> None:
        bars = pd.DataFrame({
            "o": [100.0, 100.0, 108.0, 108.0, 108.0],
            "h": [100.0, 100.0, 108.0, 108.0, 108.0],
            "l": [100.0, 100.0, 108.0, 108.0, 108.0],
            "c": [100.0, 100.0, 108.0, 108.0, 108.0],
            "session_date": [date(2025, 6, 3)] * 5,
        })
        exits = ExitRules(take_profit_frac=0.01, stop_loss_mult=50.0, time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, iv_anchor=40.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertEqual(tr[0]["exit_reason"], "take_profit")


class TestNoSameDayEodIv(unittest.TestCase):
    def test_prior_iv_anchor_not_same_day(self) -> None:
        session = date(2025, 6, 10)
        iv_by_date = {
            session - timedelta(days=1): 22.0,
            session: 99.0,  # same-day EOD must not be used intraday
        }
        anchor = prior_business_iv(iv_by_date, session)
        self.assertEqual(anchor, 22.0)
        self.assertNotEqual(anchor, 99.0)

    def test_simulation_uses_iv_anchor_not_session_eod(self) -> None:
        """Trade record iv_anchor must not equal same-day EOD when only prior exists."""
        session = date(2025, 6, 10)
        bars = pd.DataFrame({
            "o": [100.0, 100.0, 100.0, 101.0, 101.0],
            "c": [100.0, 99.0, 98.0, 99.0, 100.0],
            "session_date": [session] * 5,
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars,
            np.array([False, True, False, False, False]),
            ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)], time_stop="same_day"),
            iv_anchor=25.0,
            iv_beta=-2.0,
            instrument=PutInstrument(),
            spread=sp,
        )
        self.assertTrue(tr)
        self.assertEqual(tr[0]["iv_anchor"], 25.0)
        self.assertNotEqual(tr[0]["iv_anchor"], 99.0)


class TestDailyIndexEntry(unittest.TestCase):
    def test_one_cross_per_event(self) -> None:
        rsi = np.array([50.0, 40.0, 24.0, 22.0, 30.0, 24.0, 35.0])
        cross = daily_entry_cross_mask(rsi, 25.0)
        self.assertEqual(cross.sum(), 2)
        self.assertTrue(cross[2])
        self.assertTrue(cross[5])

    def test_fill_day_after_signal(self) -> None:
        rsi = np.array([60.0, 50.0, 24.0, 28.0, 40.0])
        cross = daily_entry_cross_mask(rsi, 25.0)
        sig = int(np.where(cross)[0][0])
        fill = sig + 1
        self.assertEqual(sig, 2)
        self.assertEqual(fill, 3)


class TestSpreadLiquidity(unittest.TestCase):
    def test_high_oi_ticker_uses_high_liq_spread(self) -> None:
        buckets = {
            ("near_otm", "short", "low"): 0.72,
            ("near_otm", "short", "high"): 0.06,
            ("near_otm", "short", "mid"): 0.18,
        }
        sp = SpreadCalibration(
            buckets=buckets,
            n_obs=3,
            source="test",
            ticker_liq_bin={"SPY": "high", "ILLIQ": "low"},
        )
        rt_spy = sp.round_trip_frac(100.0, 95.0, 7, ticker="SPY")
        rt_illiq = sp.round_trip_frac(100.0, 95.0, 7, ticker="ILLIQ")
        rt_unknown = sp.round_trip_frac(100.0, 95.0, 7, ticker="", volume=0, open_interest=0)
        self.assertAlmostEqual(rt_spy, 0.06)
        self.assertAlmostEqual(rt_illiq, 0.72)
        self.assertGreater(rt_illiq, rt_spy)
        self.assertAlmostEqual(rt_unknown, 0.18)  # default mid, not vol=0 → low



class TestClusterEff(unittest.TestCase):
    def test_n_eff_distinct_clusters(self) -> None:
        trades = [
            {"session": "2025-06-01", "ticker": "AAPL", "pnl_coll_frac": 0.01, "pnl_coll_frac_cross": 0.01, "win": True, "exit_reason": "tp"},
        ] * 10
        stats = aggregate_trades(trades, {"AAPL": "TECH"})
        self.assertEqual(stats["n"], 10)
        self.assertAlmostEqual(stats["n_eff"], 1.0)


class TestCloseConditionExit(unittest.TestCase):
    def test_rsi_close_exit_fires(self) -> None:
        warmup = np.linspace(100, 70, 20)
        session = np.array([70, 68, 66, 72, 80, 85, 90, 55])
        closes = np.concatenate([warmup, session])
        rsi = rsi_series(closes, 14)
        rsi_sess = rsi[-len(session) :]
        bars = pd.DataFrame({
            "o": session.astype(float),
            "h": session.astype(float) + 1,
            "l": session.astype(float) - 1,
            "c": session.astype(float),
            "session_date": [date(2025, 6, 5)] * len(session),
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(
            close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)],
            take_profit_frac=5.0,
            stop_loss_mult=50.0,
            time_stop="same_day",
        )
        tr, _ = simulate_session_puts(
            bars, np.zeros(len(session), dtype=bool), exits,
            iv_anchor=25.0, iv_beta=-2.0, instrument=PutInstrument(), spread=sp,
            force_entry_bar=0, rsi14=rsi_sess,
        )
        self.assertEqual(tr[0]["exit_reason"], "close_condition")


class TestOvernightCloses(unittest.TestCase):
    """Claude 11-07: tp50_overnight must close next session if TP not hit (was: carried until TP, past expiry)."""
    def test_loser_closes_next_session(self) -> None:
        d1, d2 = date(2025, 6, 2), date(2025, 6, 3)
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(take_profit_frac=0.50, time_stop="overnight")
        day1 = pd.DataFrame({
            "o": [100.0] * 4, "h": [100.0] * 4, "l": [100.0] * 4,
            "c": [100.0, 100.0, 99.0, 98.0], "session_date": [d1] * 4,
        })
        tr, carry = simulate_session_puts(
            day1, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertEqual(tr, [])
        self.assertIsNotNone(carry)
        day2 = pd.DataFrame({
            "o": [90.0] * 4, "h": [92.0] * 4, "l": [89.0] * 4,
            "c": [90.0, 91.0, 99.0, 104.0], "session_date": [d2] * 4,
        })
        tr2, carry2 = simulate_session_puts(
            day2, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, carry=carry,
        )
        self.assertIsNone(carry2)
        self.assertEqual(len(tr2), 1)
        self.assertEqual(tr2[0]["exit_reason"], "time_stop")
        self.assertLess(tr2[0]["pnl_frac"], 0)
        self.assertEqual(tr2[0]["exit_bar"], 0)


class TestCarriedStopBarZero(unittest.TestCase):
    def test_gap_stop_at_open_bar0(self) -> None:
        d1, d2 = date(2025, 6, 2), date(2025, 6, 3)
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(stop_loss_mult=0.1, time_stop="overnight")
        day1 = pd.DataFrame({
            "o": [100.0] * 4, "h": [100.0] * 4, "l": [100.0] * 4,
            "c": [100.0, 100.0, 100.0, 100.0], "session_date": [d1] * 4,
        })
        _, carry = simulate_session_puts(
            day1, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertIsNotNone(carry)
        day2 = pd.DataFrame({
            "o": [70.0, 71.0, 72.0, 73.0], "h": [71.0, 72.0, 73.0, 74.0],
            "l": [69.0, 70.0, 71.0, 72.0], "c": [70.5, 71.5, 72.5, 73.5],
            "session_date": [d2] * 4,
        })
        tr2, _ = simulate_session_puts(
            day2, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, carry=carry,
        )
        self.assertTrue(tr2)
        self.assertEqual(tr2[0]["exit_bar"], 0)
        self.assertEqual(tr2[0]["exit_reason"], "stop_loss")


if __name__ == "__main__":
    unittest.main()
