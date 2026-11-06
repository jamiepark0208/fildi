"""A327 stage 3: S151 shadow rules + non-premium posteriors + digest helpers."""
from __future__ import annotations

import copy
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import learn as L  # noqa: E402
import params as PM  # noqa: E402
from grade_weeks import iso_week  # noqa: E402
from rule_posterior import prior_from_promise  # noqa: E402


def _good_week(wi: int, ret: float = 0.02) -> dict:
    d = date(2026, 1, 5) + timedelta(days=7 * wi)
    return {"ret": ret, "week": iso_week(d), "breach": False}


def _bad_week(wi: int) -> dict:
    d = date(2026, 1, 5) + timedelta(days=7 * wi)
    return {"ret": -0.03, "week": iso_week(d), "breach": True}


class A327Stage3(unittest.TestCase):
    def test_shadow_five_good_weeks_no_proposal_six_proposes(self):
        promise_s = {"pnl_wk_bp": 80, "breach_max": 0.01}
        promise_c = {"pnl_wk_bp": 20, "breach_max": 0.15}
        good = [_good_week(i, 0.025) for i in range(6)]
        champ = [_bad_week(i) for i in range(6)]
        ok5, p5 = L.shadow_promotion_decision(good[:5], champ[:5], promise_s, promise_c)
        self.assertFalse(ok5)
        self.assertLess(p5, 0.9)
        ok6, p6 = L.shadow_promotion_decision(good, champ, promise_s, promise_c)
        self.assertTrue(ok6, msg=f"P={p6:.3f}")
        self.assertGreaterEqual(p6, 0.9)

    def test_shadow_bad_stays_shadow(self):
        promise = {"pnl_wk_bp": 40, "breach_max": 0.10}
        shadow = [_bad_week(i) for i in range(8)]
        champ = [_good_week(i, 0.02) for i in range(8)]
        ok, p = L.shadow_promotion_decision(shadow, champ, promise, promise)
        self.assertFalse(ok)
        self.assertLess(p, 0.9)

    def test_street_k_synthetic_promotes(self):
        trades = []
        for wi in range(10):
            d = date(2022, 3, 7) + timedelta(days=7 * wi)
            wk = iso_week(d)
            trades.append(
                {
                    "d": d,
                    "week": wk,
                    "combined_alpha_rank": 0.52,
                    "fwd63_rel": 0.06,
                    "fk_proxy": 0.0,
                    "breach": False,
                }
            )
        cp = copy.deepcopy(PM.SEED)
        np = copy.deepcopy(PM.SEED)
        cp["street"]["k"] = 7.0
        np["street"]["k"] = 11.0
        ok, p = L.street_k_posterior_ok(cp, np, {}, pool=trades)
        self.assertTrue(ok, msg=f"P={p:.3f}")
        self.assertGreaterEqual(p, 0.9)

    def test_learn_digest_line(self):
        line = L.append_learn_digest("unit-test digest line")
        self.assertIn(str(date.today()), line)
        self.assertTrue(L.LEARN_DIGEST.exists())


if __name__ == "__main__":
    unittest.main()
