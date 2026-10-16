"""A134: pure parser + derive for the SqueezeMetrics dealer-gamma line. Run: .venv/bin/python -m unittest tests.test_dealer_gamma"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pm_alerts import gex_context, parse_gex_csv  # noqa: E402


def csv(vals, start=1):
    return "date,price,dix,gex\n" + "\n".join(f"2026-09-{start + i:02d},7000,0.4,{v}" for i, v in enumerate(vals))


class DealerGamma(unittest.TestCase):
    def test_parse_skips_bad_lines_and_keeps_tail(self):
        rows = parse_gex_csv("date,price,dix,gex\n2026-01-01,1,0.4,5e9\nbad,line\n2026-01-02,1,0.4,x\n2026-01-03,1,0.4,-2e9", keep=5)
        self.assertEqual(rows, [("2026-01-01", 5e9), ("2026-01-03", -2e9)])
        self.assertEqual(len(parse_gex_csv(csv([1e9] * 30), keep=10)), 10)

    def test_parse_rejects_wrong_header(self):
        self.assertEqual(parse_gex_csv("<html>blocked</html>"), [])

    def test_negative_since_flip_and_percentile(self):
        vals = [3e9] * 20 + [-1e9, -1.2e9]
        c = gex_context(parse_gex_csv(csv(vals)), "2026-09-23")
        self.assertTrue(c["negative"])
        self.assertEqual(c["since"], "2026-09-21")
        self.assertEqual(c["gex_bn"], -1.2)
        self.assertEqual(c["pct_1y"], 5)  # lowest of 22
        self.assertFalse(c["stale"])

    def test_positive_whole_window_and_stale(self):
        c = gex_context(parse_gex_csv(csv([2e9] * 25)), "2026-10-05")
        self.assertFalse(c["negative"])
        self.assertEqual(c["since"], "2026-09-01")
        self.assertTrue(c["stale"])  # as_of 09-25, 10 days old

    def test_too_short_is_none(self):
        self.assertIsNone(gex_context(parse_gex_csv(csv([1e9] * 5)), "2026-09-06"))


if __name__ == "__main__":
    unittest.main()
