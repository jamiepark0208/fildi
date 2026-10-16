"""A129: forecast ledger pure helpers. Run: .venv/bin/python -m unittest tests.test_forecast_ledger"""
import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from forecast_ledger import brier, put_otm, reliability, week_friday, weekly_up_rate  # noqa: E402


class ForecastLedger(unittest.TestCase):
    def test_brier(self):
        self.assertIsNone(brier([]))
        self.assertAlmostEqual(brier([(1.0, True), (0.0, False)]), 0.0)
        self.assertAlmostEqual(brier([(0.8, True), (0.8, False)]), (0.04 + 0.64) / 2)
        self.assertAlmostEqual(brier([(0.5, True)] * 3), 0.25)

    def test_put_otm_rule_matches_scoreboard(self):
        self.assertTrue(put_otm(10.0, 10.0))   # at strike = not assigned (scoreboard: close < strike = assigned)
        self.assertTrue(put_otm(10.5, 10.0))
        self.assertFalse(put_otm(9.99, 10.0))

    def test_week_friday(self):
        self.assertEqual(week_friday(dt.date(2026, 10, 12)), dt.date(2026, 10, 16))  # Mon
        self.assertEqual(week_friday(dt.date(2026, 10, 16)), dt.date(2026, 10, 16))  # Fri
        self.assertEqual(week_friday(dt.date(2026, 10, 17)), dt.date(2026, 10, 23))  # Sat → next week

    def test_weekly_up_rate_uses_last_close_of_week(self):
        d = dt.date(2026, 9, 7)  # Monday
        closes = [(d, 100), (d + dt.timedelta(4), 101),            # wk1 ends 101
                  (d + dt.timedelta(7), 99), (d + dt.timedelta(11), 103),   # wk2 ends 103 (up)
                  (d + dt.timedelta(14), 104), (d + dt.timedelta(18), 102)]  # wk3 ends 102 (down)
        self.assertEqual(weekly_up_rate(closes), (0.5, 2))
        self.assertEqual(weekly_up_rate([]), (0.5, 0))

    def test_reliability_bins(self):
        b = reliability([(0.9, True), (0.95, False), (0.1, False), (1.0, True)])
        self.assertEqual([x["n"] for x in b], [1, 3])
        self.assertAlmostEqual(b[1]["real"], 2 / 3)


if __name__ == "__main__":
    unittest.main()
