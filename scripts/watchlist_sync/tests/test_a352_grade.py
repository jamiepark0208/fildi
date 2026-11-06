"""A352 step 1: dedupe the first snapshot and tercile inside each expiry."""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "analysis"))

import scoreboard as sb  # noqa: E402


class A352Grade(unittest.TestCase):
    def test_dedupe_keeps_first_snapshot(self):
        rows = [
            {"ticker": "KLAC", "expiry": date(2026, 10, 16), "strike": 1000, "snapshot_date": date(2026, 10, 9), "id": 2, "option_score": 80},
            {"ticker": "KLAC", "expiry": date(2026, 10, 16), "strike": 1000.0, "snapshot_date": date(2026, 10, 2), "id": 9, "option_score": 40},
            {"ticker": "KLAC", "expiry": date(2026, 10, 16), "strike": 1000, "snapshot_date": date(2026, 10, 2), "id": 3, "option_score": 55},
            {"ticker": "ONTO", "expiry": date(2026, 10, 16), "strike": 200, "snapshot_date": date(2026, 10, 9), "id": 4, "option_score": 70},
        ]
        kept = sb.dedupe_first_snapshot(rows)
        self.assertEqual(len(kept), 2)
        klac = next(r for r in kept if r["ticker"] == "KLAC")
        self.assertEqual(klac["id"], 3)
        self.assertEqual(klac["option_score"], 55)

    def test_terciles_are_within_expiry(self):
        rows = [
            {"expiry": "A", "option_score": 90, "id": 1},
            {"expiry": "A", "option_score": 80, "id": 2},
            {"expiry": "A", "option_score": 70, "id": 3},
            {"expiry": "B", "option_score": 5, "id": 4},
            {"expiry": "B", "option_score": 4, "id": 5},
            {"expiry": "B", "option_score": 3, "id": 6},
        ]
        out = sb.ntile_partition(rows, "expiry", "option_score")
        by = {(r["expiry"], r["option_score"]): r["tercile"] for r in out}
        self.assertEqual(by[("A", 70)], 1)
        self.assertEqual(by[("A", 90)], 3)
        self.assertEqual(by[("B", 3)], 1)
        self.assertEqual(by[("B", 5)], 3)
        # A score of 5 is the top of its own expiry, not the bottom of the pooled book.
        self.assertGreater(by[("B", 5)], by[("A", 70)])

    def test_ntile_remainder_goes_to_lower_buckets(self):
        rows = [{"expiry": "A", "option_score": i, "id": i} for i in range(1, 6)]
        out = sb.ntile_partition(rows, "expiry", "option_score")
        sizes = {t: sum(1 for r in out if r["tercile"] == t) for t in (1, 2, 3)}
        self.assertEqual(sizes, {1: 2, 2: 2, 3: 1})
        low = sorted(r["option_score"] for r in out if r["tercile"] == 1)
        self.assertEqual(low, [1, 2])

    def test_inverted_when_high_tercile_loses_two_thirds(self):
        weeks = [
            {"t1_excess": -1.0, "t3_excess": -4.0},
            {"t1_excess": -2.0, "t3_excess": -5.0},
            {"t1_excess": -8.0, "t3_excess": -1.0},
        ]
        inv, bad, n = sb.weeks_inverted(weeks)
        self.assertTrue(inv)
        self.assertEqual((bad, n), (2, 3))
        hold = [{"t1_excess": -1.0, "t3_excess": 1.0}, {"t1_excess": -2.0, "t3_excess": 0.5}]
        self.assertFalse(sb.weeks_inverted(hold)[0])


if __name__ == "__main__":
    unittest.main()
