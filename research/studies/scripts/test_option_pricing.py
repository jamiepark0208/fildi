"""Sanity tests for research/studies/scripts/option_pricing.py (A334 / A336 Claude review)."""
from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "research" / "studies" / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))

import option_pricing as op  # noqa: E402
import s152_indicator_option_structures as s152  # noqa: E402
from build_plan import connect  # noqa: E402


class TestOptionPricing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = connect()
        cls.chains = s152.load_chains(cls.conn)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def test_put_call_parity_within_spread(self):
        fails = 0
        checked = 0
        for (_tk, _d), snap in self.chains.items():
            spot = snap.spot
            for legs in snap.by_expiry.values():
                strikes = {L["strike"] for L in legs}
                for k in strikes:
                    cL, pL = op.find_leg(legs, "call", k), op.find_leg(legs, "put", k)
                    if not cL or not pL:
                        continue
                    gap = op.put_call_parity_gap(spot, cL, pL, k)
                    max_sp = op.quote_spread(cL) + op.quote_spread(pL) + 0.05 * spot
                    checked += 1
                    if gap > max_sp * 1.5 + 0.05:
                        fails += 1
        self.assertGreaterEqual(checked, 4, "need same-strike call+put rows in chain history")
        self.assertEqual(fails, 0, f"parity gaps beyond spread on {fails}/{checked} legs")

    def test_random_long_straddle_60m_mean_negative(self):
        rng = random.Random(152)
        keys = list(self.chains.keys())
        pnls: list[float] = []
        for _ in range(400):
            tk, d = rng.choice(keys)
            snap = self.chains[(tk, d)]
            ex = s152.pick_expiry(snap, d)
            if not ex:
                continue
            exp, dte = ex
            spot = snap.spot
            move = rng.uniform(-0.008, 0.008)
            exit_spot = spot * (1.0 + move)
            p = op.price_structure("long_straddle", "buy", spot, snap, exp, dte, exit_spot, 60.0)
            if p is not None:
                pnls.append(p)
        self.assertGreater(len(pnls), 50)
        mean = sum(pnls) / len(pnls)
        self.assertLess(mean, 0.0, f"random 60m long straddle mean P&L {mean:.2f}% should be < 0")

    def test_long_short_straddle_sum_near_negative_spread(self):
        rng = random.Random(154)
        keys = list(self.chains.keys())
        diffs: list[float] = []
        for _ in range(200):
            tk, d = rng.choice(keys)
            snap = self.chains[(tk, d)]
            ex = s152.pick_expiry(snap, d)
            if not ex:
                continue
            exp, dte = ex
            spot = snap.spot
            exit_spot = spot * (1.0 + rng.uniform(-0.005, 0.005))
            row = op.straddle_dollar_pnls(spot, snap, exp, dte, exit_spot, 60.0)
            if row is None:
                continue
            long_d, short_d, rt = row
            diffs.append((long_d + short_d) + rt)
        self.assertGreater(len(diffs), 30)
        med = sorted(diffs)[len(diffs) // 2]
        self.assertLess(abs(med), 0.15, f"long+short $ P&L + round-trip spread median {med:.4f}")

    def test_short_15d_put_small_gain_on_rally(self):
        """30-min short ~15Δ put: +0.4% spot move → P&L well under 20% of max risk."""
        best_pnl = None
        for (_tk, d), snap in self.chains.items():
            spot = snap.spot
            ex = s152.pick_expiry(snap, d)
            if not ex:
                continue
            exp, dte = ex
            exit_spot = spot * 1.004
            legs = snap.by_expiry.get(exp)
            if not legs:
                continue
            L = op.delta_strike(legs, "put", 0.15)
            if not L:
                continue
            px, iv = op.leg_entry(L, False, spot, dte)
            T = op.hold_T(dte, 30.0)
            ex = op.bs_price("put", exit_spot, L["strike"], T, iv)
            pnl = op.credit_pnl_short_put(px, L["strike"], ex, spot)
            if pnl is None:
                continue
            if best_pnl is None or pnl > best_pnl:
                best_pnl = pnl
        self.assertIsNotNone(best_pnl)
        self.assertLess(best_pnl, 20.0, f"max short 15Δ put P&L on +0.4% was {best_pnl:.1f}% of risk")

if __name__ == "__main__":
    unittest.main(verbosity=2)
