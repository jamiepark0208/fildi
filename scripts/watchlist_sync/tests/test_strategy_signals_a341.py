"""A341 shadow challengers — screen helpers + SHADOW / grade_ledger ids."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT), str(ROOT / "analysis")]

from grade_ledger import SHADOW_STRATEGY_IDS  # noqa: E402
from screen_signals import sig_gap_variant, sig_z_variant  # noqa: E402
import strategy_signals as SS  # noqa: E402


class A341Shadow(unittest.TestCase):
    def test_shadow_ids_include_a341(self):
        self.assertIn("put_gap_up_5pct_d20", SHADOW_STRATEGY_IDS)
        self.assertIn("put_z50_dip_d20", SHADOW_STRATEGY_IDS)
        self.assertIn("put_gap_up_5pct_d20", SS.SHADOW)
        self.assertIn("put_z50_dip_d20", SS.SHADOW)
        self.assertEqual(SS.SHADOW["put_gap_up_5pct_d20"]["delta"], -0.20)
        self.assertEqual(SS.SHADOW["put_z50_dip_d20"]["delta"], -0.20)

    def test_gap_up_5pct_fires(self):
        # prior close 100 → open 105 = +5%
        c = np.array([100.0, 105.0])[:, None]
        o = np.array([99.0, 105.0])[:, None]
        g = sig_gap_variant(o, c, 0.05, "up")
        self.assertFalse(bool(g[0, 0]))
        self.assertTrue(bool(g[1, 0]))
        o_miss = np.array([99.0, 104.9])[:, None]
        self.assertFalse(bool(sig_gap_variant(o_miss, c, 0.05, "up")[1, 0]))

    def test_z50_dip_fires(self):
        rng = np.random.default_rng(0)
        base = 100 + np.cumsum(rng.normal(0, 0.5, 60))
        # deep dip on last bar vs SMA50
        base[-1] = base[-50:-1].mean() - 3.0 * base[-50:-1].std()
        c = base.astype(float)[:, None]
        z = sig_z_variant(c, 50, -2.5)
        self.assertTrue(bool(z[-1, 0]))
        # flat series never fires
        flat = np.full((60, 1), 100.0)
        self.assertFalse(bool(sig_z_variant(flat, 50, -2.5)[-1, 0]))


if __name__ == "__main__":
    unittest.main()
