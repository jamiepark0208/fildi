"""10-28 (recurring-bugs B7): a sold put never targets or falls back to a band below the 0.05Δ floor."""
import unittest

import put_recs as PR
import strategy_engine as SE


def put(delta, bid=1.0, strike=100.0):
    return {"delta": -delta, "bid": bid, "strike": strike, "open_interest": 5000, "volume": 500}


class BandFloor(unittest.TestCase):
    def test_floor_band_is_first_at_or_above_005(self):
        bands = SE.ENGINE["strategies"]["sell_put"]["strike"]["bands"]
        self.assertEqual(bands[SE.put_band_floor(bands)], "0.06-0.08")

    def test_empty_band_steps_closer_not_below_floor(self):
        # 0.06–0.08 empty, a 0.04Δ put (old farther fallback) and a 0.09Δ put listed → must take the 0.09Δ one
        p, used = PR.pick_strike([put(0.04), put(0.09)], "0.06-0.08")
        self.assertEqual(used, "0.08-0.10")
        self.assertAlmostEqual(-p["delta"], 0.09)


if __name__ == "__main__":
    unittest.main()
