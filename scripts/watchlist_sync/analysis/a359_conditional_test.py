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
    entry_cross_mask,
    nearest_listed_strike,
    prior_business_iv,
    simulate_session_puts,
    standard_listed_strikes,
)


class TestEntryCross(unittest.TestCase):
    def test_one_fire_per_edge(self) -> None:
        closes = np.linspace(100, 80, 30)
        entry = ConditionSet("or", [IndicatorCondition("rsi14", "lt", 25.0, "5m")])
        cross = entry_cross_mask(entry, closes)
        idx = np.where(cross)[0]
        for i in range(1, len(idx)):
            self.assertGreater(idx[i], idx[i - 1])


class TestNearestStrike(unittest.TestCase):
    def test_abs_nearest(self) -> None:
        listed = [90.0, 95.0, 100.0, 105.0]
        self.assertAlmostEqual(nearest_listed_strike(99.2, listed), 100.0)
        self.assertAlmostEqual(nearest_listed_strike(92.6, listed), 95.0)


class TestLookAhead(unittest.TestCase):
    def test_fill_after_signal(self) -> None:
        bars = pd.DataFrame({
            "o": [100, 99, 98, 99, 100],
            "c": [100, 99, 98, 99, 100],
            "session_date": [date(2025, 6, 2)] * 5,
        })
        exits = ExitRules(time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=1,
        )
        self.assertEqual(len(tr), 1)
        self.assertGreater(tr[0]["fill_bar"], tr[0]["signal_bar"])


class TestFirstHitExit(unittest.TestCase):
    def test_tp_beats_later_rules(self) -> None:
        bars = pd.DataFrame({
            "o": [100.0, 100.0, 100.0, 100.0],
            "c": [100.0, 95.0, 130.0, 130.0],
            "session_date": [date(2025, 6, 3)] * 4,
        })
        exits = ExitRules(take_profit_frac=0.01, stop_loss_mult=2.0, time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(4, dtype=bool), exits, iv_anchor=40.0, iv_beta=-2.0,
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


if __name__ == "__main__":
    unittest.main()
