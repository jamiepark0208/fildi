#!/usr/bin/env python3
"""A384 unit test — stock_surface lse_trades WLS weight grows with trade count (not 1/trades^2)."""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from stock_surface import GroupKey, Quote, fit_group  # noqa: E402


class TestStockSurfaceLseTradesWeight(unittest.TestCase):
    def test_high_trade_atm_outweighs_1trade_noisy_wing(self) -> None:
        """Claude A384 spec item 3: synthetic smile (true IV = 0.30 flat), 400-trade near-ATM points
        at 0.30 vs one 1-trade wing outlier at +0.10 vol (0.40) -> fitted `a` stays within 0.005 (0.5 vol pt)
        and high-trade points move fitted `a`/`b` far more than a 1-trade wing."""
        key = GroupKey(ticker="TEST", as_of=date(2026, 11, 2), expiry=date(2026, 12, 4))
        spot = 100.0
        quotes = [
            Quote(strike=99.0, side="put", bid=2.8, ask=2.9, iv=0.30, oi=500, delta=-0.46, trades=400),
            Quote(strike=97.0, side="put", bid=2.1, ask=2.2, iv=0.30, oi=500, delta=-0.38, trades=350),
            Quote(strike=95.0, side="put", bid=1.5, ask=1.6, iv=0.30, oi=500, delta=-0.30, trades=300),
            Quote(strike=101.0, side="call", bid=2.9, ask=3.0, iv=0.30, oi=500, delta=0.48, trades=400),
            Quote(strike=103.0, side="call", bid=2.1, ask=2.2, iv=0.30, oi=500, delta=0.39, trades=350),
            Quote(strike=105.0, side="call", bid=1.5, ask=1.6, iv=0.30, oi=500, delta=0.30, trades=300),
            # Noisy 1-trade wing print +10 vol pts off
            Quote(strike=85.0, side="put", bid=0.35, ask=0.45, iv=0.40, oi=200, delta=-0.10, trades=1),
        ]
        fit = fit_group(key, "lse_trades", quotes, spot=spot, r=0.045, put_only=False)
        self.assertIsNotNone(fit)
        assert fit is not None
        self.assertLess(abs(fit.a - 0.30), 0.005)

        # Muse pass/fail #2: bumping a 400-trade ATM quote by +0.05 moves `a` more than bumping the 1-trade wing by +0.05
        q_atm_bump = [Quote(q.side, q.strike, q.bid, q.ask, (q.iv or 0) + (0.05 if q.strike == 99.0 else 0.0), q.delta, q.oi, q.trades) for q in quotes]
        q_wing_bump = [Quote(q.side, q.strike, q.bid, q.ask, (q.iv or 0) + (0.05 if q.strike == 85.0 else 0.0), q.delta, q.oi, q.trades) for q in quotes]
        f_atm = fit_group(key, "lse_trades", q_atm_bump, spot=spot, r=0.045, put_only=False)
        f_wing = fit_group(key, "lse_trades", q_wing_bump, spot=spot, r=0.045, put_only=False)
        assert f_atm is not None and f_wing is not None
        self.assertGreater(abs(f_atm.a - fit.a), abs(f_wing.a - fit.a))


if __name__ == "__main__":
    unittest.main()
