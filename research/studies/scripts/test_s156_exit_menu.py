#!/usr/bin/env python3
"""Unit tests for S156 known-at agree filter (A353 Claude review 9e3c5889)."""
from __future__ import annotations

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from s156_exit_menu import COST_STOCK, simulate, tf15_agree

NY = ZoneInfo("America/New_York")


class TestS156KnownAt(unittest.TestCase):
    def test_0930_15m_rejects_0935_5m_entry(self) -> None:
        t15 = int(datetime(2026, 11, 6, 9, 30, tzinfo=NY).timestamp())
        sec = int(datetime(2026, 11, 6, 9, 35, tzinfo=NY).timestamp())
        self.assertFalse(tf15_agree(t15, sec))

    def test_0930_15m_accepts_0940_5m_entry(self) -> None:
        t15 = int(datetime(2026, 11, 6, 9, 30, tzinfo=NY).timestamp())
        sec = int(datetime(2026, 11, 6, 9, 40, tzinfo=NY).timestamp())
        self.assertTrue(tf15_agree(t15, sec))

    def test_entry_price_is_signal_bar_close(self) -> None:
        bars = [{"o": 100.0, "h": 106.0, "l": 99.0, "c": 105.0, "atr": 1.0}]
        bars += [{"o": 105.0, "h": 105.1, "l": 104.9, "c": 105.0, "atr": 1.0} for _ in range(5)]
        # Enter at close 105, exit at bar+6 close 105 → only the 4 bp cost.
        net = simulate(bars, 0, 5, 1, 1.0, "t_30", None)
        self.assertIsNotNone(net)
        self.assertAlmostEqual(net, -COST_STOCK, places=6)


if __name__ == "__main__":
    unittest.main()
