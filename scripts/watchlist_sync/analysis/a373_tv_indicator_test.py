#!/usr/bin/env python3
"""A373 item 3: known answers for TradingView indicator conventions.

EMA seeds with the SMA of the first n bars (alpha 2/(n+1)). RSI is Wilder's RMA
with bar-0 change left na. Bollinger uses population sigma (divide by n).
SuperTrend is ta.supertrend: direction −1 up / +1 down, ATR = RMA of TR with TR[0] na.

Expected numbers below are the formulas expanded by hand, not a second call to the same code.
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from indicators import bbands_tv, ema_tv, rsi_tv, supertrend_tv  # noqa: E402


def _close(got, want, eps=1e-9):
    got = np.asarray(got, float)
    assert len(got) == len(want), (len(got), len(want))
    for i, (g, w) in enumerate(zip(got, want)):
        if w != w:
            assert g != g, f"idx {i}: want nan got {g}"
        else:
            assert abs(g - w) < eps, f"idx {i}: {g} vs {w}"


N = float("nan")


class TestEma(unittest.TestCase):
    def test_constant(self):
        _close(ema_tv([5, 5, 5, 5], 3), [N, N, 5, 5])

    def test_monotonic(self):
        # seed (1+2+3)/3 = 2; alpha 1/2 → 3, 4
        _close(ema_tv([1, 2, 3, 4, 5], 3), [N, N, 2, 3, 4])

    def test_three_reference_values(self):
        # [1,2,3,4,5,8], n=3, alpha=1/2. Seed bar 2 = 2; bar 3 = 3; bar 5 = 0.5*8+0.5*4 = 6
        out = ema_tv([1, 2, 3, 4, 5, 8], 3)
        self.assertTrue(math.isnan(out[0]) and math.isnan(out[1]))
        self.assertAlmostEqual(out[2], 2.0)
        self.assertAlmostEqual(out[3], 3.0)
        self.assertAlmostEqual(out[5], 6.0)


class TestRsi(unittest.TestCase):
    def test_constant_is_100(self):
        # every change is 0, so down == 0 and Pine returns 100 once the RMA exists (bar n)
        _close(rsi_tv([7, 7, 7, 7, 7], 3), [N, N, N, 100, 100])

    def test_monotonic_up_is_100(self):
        _close(rsi_tv([1, 2, 3, 4, 5], 3), [N, N, N, 100, 100])

    def test_three_reference_values(self):
        # closes 10,11,10,12,11,13; n=3
        # changes na,+1,-1,+2,-1,+2
        # up  na,1,0,2,0,2   dn na,0,1,0,1,0
        # bar 3 seed up=(1+0+2)/3=1, dn=(0+1+0)/3=1/3 → RS=3 → 75
        # bar 4 up=(1*2+0)/3=2/3, dn=((1/3)*2+1)/3=5/9 → RS=1.2 → 100-100/2.2 = 600/11
        # bar 5 up=((2/3)*2+2)/3=10/9, dn=((5/9)*2)/3=10/27 → RS=3 → 75
        out = rsi_tv([10, 11, 10, 12, 11, 13], 3)
        self.assertTrue(all(math.isnan(out[i]) for i in range(3)))
        self.assertAlmostEqual(out[3], 75.0)
        self.assertAlmostEqual(out[4], 600 / 11)
        self.assertAlmostEqual(out[5], 75.0)


class TestBollinger(unittest.TestCase):
    def test_constant_bands_collapse(self):
        mid, up, lo = bbands_tv([5, 5, 5, 5], 3, 2)
        _close(mid, [N, N, 5, 5])
        _close(up, [N, N, 5, 5])
        _close(lo, [N, N, 5, 5])

    def test_monotonic_population_sigma(self):
        # window 1,2,3: mean 2, ss=2, pop σ = sqrt(2/3)
        mid, up, lo = bbands_tv([1, 2, 3, 4, 5], 3, 2)
        sig = math.sqrt(2 / 3)
        _close(mid, [N, N, 2, 3, 4])
        _close(up, [N, N, 2 + 2 * sig, 3 + 2 * sig, 4 + 2 * sig])
        _close(lo, [N, N, 2 - 2 * sig, 3 - 2 * sig, 4 - 2 * sig])

    def test_three_reference_values(self):
        # last windows of length 3: (1,2,3), (2,3,4), (2,3,6)
        _, up_a, lo_a = bbands_tv([1, 2, 3], 3, 2)
        _, up_b, lo_b = bbands_tv([1, 2, 3, 4], 3, 2)
        mid_c, up_c, lo_c = bbands_tv([1, 2, 3, 6], 3, 2)
        sig = math.sqrt(2 / 3)
        self.assertAlmostEqual(up_a[2], 2 + 2 * sig)
        self.assertAlmostEqual(lo_a[2], 2 - 2 * sig)
        self.assertAlmostEqual(up_b[3], 3 + 2 * sig)
        self.assertAlmostEqual(lo_b[3], 3 - 2 * sig)
        # mean (2+3+6)/3 = 11/3; ss = 25/9+4/9+49/9 = 26/3; pop σ = sqrt(26)/3
        dev = 2 * math.sqrt(26) / 3
        self.assertAlmostEqual(mid_c[3], 11 / 3)
        self.assertAlmostEqual(up_c[3], 11 / 3 + dev)
        self.assertAlmostEqual(lo_c[3], 11 / 3 - dev)


class TestSuperTrend(unittest.TestCase):
    def test_constant_sits_on_price(self):
        # TR after bar 0 is 0, so ATR is 0 and both bands equal the close. First finite bar
        # has na ATR[1], so direction stays +1 (down) and the line is the upper band.
        h = l = c = [10, 10, 10, 10, 10, 10]
        d, line = supertrend_tv(h, l, c, n=3, f=3)
        _close(d, [N, N, N, 1, 1, 1])
        _close(line, [N, N, N, 10, 10, 10])

    def test_monotonic_rising_flips(self):
        # h = l = c = 1,2,3,... so TR[i>=1] = 1 and ATR(3) = 1 from bar 3 on.
        # bar 3: bands 1 and 7, dir +1, line 7
        # bar 6: upper still 7 (ratchet), close 7 does not break it, line 7
        # bar 7: close 8 > upper 7 → dir −1, line = lower = 5
        c = [1, 2, 3, 4, 5, 6, 7, 8]
        d, line = supertrend_tv(c, c, c, n=3, f=3)
        self.assertAlmostEqual(line[3], 7.0)
        self.assertEqual(d[3], 1.0)
        self.assertAlmostEqual(line[6], 7.0)
        self.assertEqual(d[6], 1.0)
        self.assertAlmostEqual(line[7], 5.0)
        self.assertEqual(d[7], -1.0)

    def test_three_reference_values(self):
        # factor 3, ATR 3. TR: na, 2, 2, 3, 2, 4, 20
        # ATR bar 3 = 7/3; bar 5 = 76/27; bar 6 = 692/81
        # bar 3 line = hl2 + 3*(7/3) = 19, dir +1 (ATR[1] still na)
        # bar 5 upper ratchets to 341/18, close 10 does not cross, dir +1
        # bar 6 close 28 > 341/18, dir −1, line = carried lower band 19/3
        h = [10, 12, 11, 13, 14, 12, 30]
        l = [10, 10, 9, 11, 12, 9, 20]
        c = [10, 11, 10, 12, 13, 10, 28]
        d, line = supertrend_tv(h, l, c, n=3, f=3)
        self.assertAlmostEqual(line[3], 19.0)
        self.assertEqual(d[3], 1.0)
        self.assertAlmostEqual(line[5], 341 / 18)
        self.assertEqual(d[5], 1.0)
        self.assertAlmostEqual(line[6], 19 / 3)
        self.assertEqual(d[6], -1.0)


if __name__ == "__main__":
    unittest.main()
