"""A327 stage 2: posteriors + replay look-ahead."""
from __future__ import annotations

import copy
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis import a327_replay as R  # noqa: E402
from grade_weeks import iso_week  # noqa: E402
from rule_posterior import (  # noqa: E402
    hand_beta_posterior_mean,
    observe_live,
    prior_from_promise,
    prior_from_trades,
    promotion_allowed,
    should_demote,
)


class A327Stage2(unittest.TestCase):
    def test_beta_posterior_hand_value(self):
        trades = []
        for i in range(20):
            d = date(2019, 1, 15) + timedelta(days=30 * i)
            trades.append({"d": d, "ret": 0.01, "breach": False, "week": iso_week(d), "month": (d.year, d.month)})
        prior = prior_from_trades(trades, use_month_blocks=True)
        self.assertEqual(prior.breach.alpha, 20.0)
        self.assertEqual(prior.breach.beta, 0.5)
        post = observe_live(
            prior,
            [{"d": date(2021, 1, 4), "ret": -0.02, "breach": True, "week": iso_week(date(2021, 1, 4))}],
        )
        expect = hand_beta_posterior_mean(post.breach.alpha, post.breach.beta)
        self.assertAlmostEqual(post.breach.mean(), expect, places=9)
        self.assertAlmostEqual(post.breach.alpha, 20.0)
        self.assertAlmostEqual(post.breach.beta, 1.5)
        self.assertAlmostEqual(expect, 1.5 / 21.5, places=9)

    def test_six_bad_weeks_demotes_five_does_not(self):
        floor = {"pnl_wk_bp": 50, "breach_max": 0.12}
        prior = prior_from_promise({"pnl_wk_bp": 80, "breach_max": 0.10})
        bad = []
        for i in range(6):
            d = date(2026, 1, 5) + timedelta(days=7 * i)
            bad.append({"d": d, "ret": -0.01, "breach": True, "week": iso_week(d)})
        post6 = observe_live(copy.deepcopy(prior), bad)
        post6.n_live_weeks = 6
        self.assertTrue(should_demote(post6, floor))
        post5 = observe_live(copy.deepcopy(prior), bad[:5])
        post5.n_live_weeks = 5
        self.assertFalse(should_demote(post5, floor))

    def test_challenger_p085_not_promoted(self):
        self.assertFalse(promotion_allowed(0.85))
        self.assertTrue(promotion_allowed(0.90))

    def test_replay_lookahead_two_weeks(self):
        rules = {
            "put_edge_q5": [
                {"d": date(2022, 3, 1), "ret": 0.004, "breach": False, "week": iso_week(date(2022, 3, 1)), "month": (2022, 3)},
                {"d": date(2022, 9, 1), "ret": -0.02, "breach": True, "week": iso_week(date(2022, 9, 1)), "month": (2022, 9)},
            ],
            "rich_puts": [
                {"d": date(2022, 4, 1), "ret": -0.001, "breach": True, "week": iso_week(date(2022, 4, 1)), "month": (2022, 4)},
            ],
        }
        spec = {
            "put_edge_q5": {"floor": {"pnl_wk_bp": 15, "breach_max": 0.28}, "promise": {"pnl_wk_bp": 34, "breach_max": 0.18}},
            "rich_puts": {"floor": {"pnl_wk_bp": 45, "breach_max": 0.30}, "promise": {"pnl_wk_bp": 90, "breach_max": 0.22}},
        }
        w1 = date(2022, 6, 6)
        w2 = date(2022, 10, 3)
        for w in (w1, w2):
            full = R.decision_at_week(w, rules, spec)
            cut = {
                k: [t for t in v if t["d"] < w + timedelta(days=30)]
                for k, v in rules.items()
            }
            trimmed = R.decision_at_week(w, cut, spec)
            self.assertEqual(full["active"], trimmed["active"])
            self.assertEqual(full["shadow"], trimmed["shadow"])


if __name__ == "__main__":
    unittest.main()
