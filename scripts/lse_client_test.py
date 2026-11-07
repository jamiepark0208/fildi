#!/usr/bin/env python3
"""Unit tests for LSE OCC formatting and resume helpers (A357)."""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lse_client import occ_symbol, parse_export_rows


class TestOcc(unittest.TestCase):
    def test_aapl_put(self) -> None:
        occ = occ_symbol("AAPL", date(2026, 11, 27), 300.0, "put")
        self.assertEqual(occ, "AAPL  261127P00300000")
        self.assertEqual(len(occ[:6]), 6)
        self.assertTrue(occ.endswith("P00300000"))

    def test_root_pad_short(self) -> None:
        occ = occ_symbol("SPY", date(2025, 10, 17), 225.5, "put")
        self.assertTrue(occ.startswith("SPY   "))

    def test_strike_times_1000(self) -> None:
        occ = occ_symbol("MSFT", date(2025, 1, 17), 412.375, "put")
        strike_field = occ.split("P")[-1]
        self.assertEqual(len(strike_field), 8)
        self.assertEqual(int(strike_field), 412375)


class TestCsv(unittest.TestCase):
    def test_parse_sample(self) -> None:
        sample = (
            '"time","open","high","low","close","volume","trades","date"\n'
            '"2025-10-08 13:30:00",0.11,0.11,0.07,0.08,786,43,"2025-10-08"\n'
        )
        rows = parse_export_rows(sample)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["date"], date(2025, 10, 8))
        self.assertAlmostEqual(rows[0]["close"], 0.08)


class TestResume(unittest.TestCase):
    def test_should_skip_logic(self) -> None:
        sys.path.insert(0, str(Path(__file__).resolve().parent / "watchlist_sync"))
        sys.path.insert(0, str(Path(__file__).resolve().parent / "watchlist_sync" / "analysis"))
        from a357_lse_option_backfill import should_skip_occ, skip_occ

        self.assertTrue(skip_occ({"X"}, set(), "X"))
        self.assertTrue(skip_occ(set(), {"Y"}, "Y"))
        self.assertTrue(should_skip_occ(set(), True))
        self.assertFalse(should_skip_occ(set(), False))


if __name__ == "__main__":
    unittest.main()
