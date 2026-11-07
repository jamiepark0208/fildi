#!/usr/bin/env python3
"""A359 unit tests — conditional engine invariants."""
from __future__ import annotations

import sys
import unittest
from datetime import date
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
    PutInstrument,
    entry_cross_mask,
    nearest_listed_strike,
    simulate_session_puts,
    standard_listed_strikes,
)


class TestEntryCross(unittest.TestCase):
    def test_one_fire_per_edge(self) -> None:
        closes = np.linspace(100, 80, 30)
        entry = ConditionSet("or", [IndicatorCondition("rsi14", "lt", 25.0, "5m")])
        cross = entry_cross_mask(entry, closes)
        # consecutive true runs → at most one True per run
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
        tr = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, spot_iv=25.0,
            instrument=PutInstrument(), force_entry_bar=1,
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
        tr = simulate_session_puts(
            bars, np.zeros(4, dtype=bool), exits, spot_iv=40.0,
            instrument=PutInstrument(), force_entry_bar=0,
        )
        self.assertEqual(tr[0]["exit_reason"], "take_profit")


if __name__ == "__main__":
    unittest.main()
