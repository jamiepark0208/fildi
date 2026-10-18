#!/usr/bin/env python3
"""Unit tests for etf_flows_ssga (stdlib only)."""
from __future__ import annotations

import unittest

from etf_flows_ssga import NavRow, flows_from_nav, parse_ssga_date


class TestParse(unittest.TestCase):
    def test_date(self):
        self.assertEqual(parse_ssga_date("15-Oct-2026"), "2026-10-15")
        self.assertEqual(parse_ssga_date("09-Jan-1998"), "1998-01-09")
        self.assertIsNone(parse_ssga_date("Date"))

    def test_flow(self):
        rows = [
            NavRow("2026-10-14", 100.0, 1_000_000.0, 1e8),
            NavRow("2026-10-15", 101.0, 1_100_000.0, 1.111e8),  # +100k shares
        ]
        flows = flows_from_nav(rows)
        self.assertEqual(flows[0][3], 0.0)
        self.assertAlmostEqual(flows[1][3], 100_000.0 * 101.0)


if __name__ == "__main__":
    unittest.main()
