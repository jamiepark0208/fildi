#!/usr/bin/env python3
"""Unit tests for fetch_guard (no DB)."""
from __future__ import annotations

import unittest
from datetime import date

from fetch_guard import plan_key


class PlanKeyTests(unittest.TestCase):
    def test_skip_when_current(self):
        p = plan_key("SPY", date(2026, 11, 6), cadence="daily", now=date(2026, 11, 7))
        self.assertEqual(p.mode, "skip")

    def test_tail_with_overlap(self):
        p = plan_key("SPY", date(2026, 11, 4), overlap_days=2, now=date(2026, 11, 7))
        self.assertEqual(p.mode, "tail")
        self.assertEqual(p.tail_from, date(2026, 11, 3))
        self.assertIsNotNone(p.tail_to)

    def test_backfill_requires_flag(self):
        p = plan_key("NEW", None, allow_backfill=False)
        self.assertEqual(p.mode, "skip")
        p2 = plan_key("NEW", None, allow_backfill=True, now=date(2026, 11, 7))
        self.assertEqual(p2.mode, "backfill")


if __name__ == "__main__":
    unittest.main()
