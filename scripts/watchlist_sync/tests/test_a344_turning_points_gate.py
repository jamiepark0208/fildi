import math
import unittest

from turning_points import holdout_gate_failed


class TestA344HoldoutGate(unittest.TestCase):
    def test_nan_blocks_write(self):
        self.assertTrue(holdout_gate_failed(float("nan")))

    def test_below_bar_blocks(self):
        self.assertTrue(holdout_gate_failed(1.4))

    def test_at_bar_passes(self):
        self.assertFalse(holdout_gate_failed(1.5))

    def test_above_bar_passes(self):
        self.assertFalse(holdout_gate_failed(2.0))

    def test_nan_is_not_finite(self):
        self.assertFalse(math.isfinite(float("nan")))


if __name__ == "__main__":
    unittest.main()
