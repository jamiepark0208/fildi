"""A327 stage 2: posteriors + replay look-ahead."""
from __future__ import annotations

import copy
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis import a327_replay as R  # noqa: E402
import learn as L  # noqa: E402
import params as PM  # noqa: E402
from grade_weeks import iso_week, month_block  # noqa: E402
from rule_posterior import (  # noqa: E402
    decide,
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
            "put_edge_q5": {
                "study": "S059",
                "floor": {"pnl_wk_bp": 15, "breach_max": 0.28},
                "promise": {"pnl_wk_bp": 34, "breach_max": 0.18},
            },
            "rich_puts": {
                "study": "S109",
                "floor": {"pnl_wk_bp": 45, "breach_max": 0.30},
                "promise": {"pnl_wk_bp": 90, "breach_max": 0.22},
            },
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

    def test_good_prior_six_bad_live_weeks_demotes_any_rule(self):
        floor = {"pnl_wk_bp": 50, "breach_max": 0.12}
        promise = {"pnl_wk_bp": 80, "breach_max": 0.10}
        bad = []
        for i in range(6):
            d = date(2026, 1, 5) + timedelta(days=7 * i)
            bad.append({"d": d, "ret": -0.01, "breach": True, "week": iso_week(d)})
        for rid in ("put_edge_q5", "rich_puts"):
            with self.subTest(rid=rid):
                prior = prior_from_promise(promise)
                demote, reason, _ = decide(prior, bad, floor)
                self.assertTrue(demote, msg=rid)
                self.assertEqual(reason, "posterior_floor")

    def _synthetic_promotion_trades(self) -> list[dict]:
        trades = []
        prior_end = L.PROMOTION_PRIOR_END
        for wi in range(30):
            d = date(2021, 2, 1) + timedelta(days=7 * wi)
            if d >= date(2022, 1, 1):
                break
            wk = iso_week(d)
            mb = month_block(d)
            for i in range(12):
                iv_rv = 1.0 + 0.06 * i
                iv_rank = max(0.05, 0.95 - 0.06 * i)
                ret = 0.004 * i
                trades.append(
                    {
                        "d": d,
                        "week": wk,
                        "month": mb,
                        "ret": ret,
                        "breach": False,
                        "iv_rv": iv_rv,
                        "iv_rank_1y": iv_rank,
                        "iv_pct": 40 + i,
                    }
                )
        for wi in range(40):
            d = date(2022, 1, 3) + timedelta(days=7 * wi)
            wk = iso_week(d)
            mb = month_block(d)
            for i in range(12):
                iv_rv = 1.0 + 0.06 * i
                iv_rank = max(0.05, 0.95 - 0.06 * i)
                ret = 0.004 * i
                trades.append(
                    {
                        "d": d,
                        "week": wk,
                        "month": mb,
                        "ret": ret,
                        "breach": False,
                        "iv_rv": iv_rv,
                        "iv_rank_1y": iv_rank,
                        "iv_pct": 40 + i,
                    }
                )
        del prior_end
        return trades

    def test_challenger_identical_weights_near_fifty_fifty(self):
        trades = self._synthetic_promotion_trades()
        cp = copy.deepcopy(PM.SEED)
        np = copy.deepcopy(PM.SEED)
        ok, p = L.challenger_posterior_from_pool(trades, cp, np, date(2023, 6, 1))
        self.assertFalse(ok)
        self.assertAlmostEqual(p, 0.5, delta=0.08)

    def test_challenger_iv_rv_weight_beats_rank(self):
        trades = self._synthetic_promotion_trades()
        cp = copy.deepcopy(PM.SEED)
        np = copy.deepcopy(PM.SEED)
        cp["premium"] = {"w_iv_rv": 0.05, "w_iv_rank": 0.95, "w_iv_level": 0.0}
        np["premium"] = {"w_iv_rv": 0.95, "w_iv_rank": 0.05, "w_iv_level": 0.0}
        ok, p = L.challenger_posterior_from_pool(trades, cp, np, date(2023, 6, 1))
        self.assertTrue(p > 0.9, msg=f"P(better)={p:.3f}")
        self.assertTrue(ok)

    def test_two_cycle_promotion_with_clear_challenger(self):
        trades = self._synthetic_promotion_trades()
        cp = copy.deepcopy(PM.SEED)
        cp["premium"] = {"w_iv_rv": 0.05, "w_iv_rank": 0.95, "w_iv_level": 0.0}
        np = copy.deepcopy(cp)
        np["premium"] = {"w_iv_rv": 0.95, "w_iv_rank": 0.05, "w_iv_level": 0.0}
        why = [{"param": "premium.w_iv_rv", "old": 0.05, "new": 0.95, "why": "test"}]
        pending = {w["param"]: L.param_direction(w) for w in why}
        confirmed = [w for w in why if pending.get(w["param"]) == L.param_direction(w)]
        self.assertEqual(len(confirmed), 1)
        ok1, _ = L.challenger_posterior_from_pool(trades, cp, L.apply_rationale(cp, confirmed), date(2023, 6, 1))
        ok2, _ = L.challenger_posterior_from_pool(trades, cp, L.apply_rationale(cp, confirmed), date(2023, 6, 1))
        self.assertTrue(ok1 and ok2)

    def test_threshold_only_passes_live_grade_gate_not_fake_posterior(self):
        P = copy.deepcopy(PM.SEED)
        ev = {"kept": {}, "own": {}, "flags": {}}
        live = {"folders": {"own:21d": {"n": 40, "n_weeks": 8, "good": 0.3, "n_label": "40"}}}
        _new, why = L.propose_params(P, ev, live)
        thr = [w for w in why if w["param"] == "thresholds.green_own"]
        self.assertEqual(len(thr), 1)
        self.assertEqual([w["param"] for w in why], ["thresholds.green_own"])
        prev = {w["param"]: L.param_direction(w) for w in why}
        confirmed = [w for w in why if prev.get(w["param"]) == L.param_direction(w)]
        ok, p, reason = L.challenger_posterior_for_moves(P, _new, confirmed, ev)
        self.assertTrue(ok)
        self.assertIsNone(p)
        self.assertEqual(reason, "thresholds: live-grade gate (no backtest posterior)")
        self.assertNotIn("P=0.50", reason)
        self.assertNotIn("blocked", reason)

    def test_unknown_family_blocks_without_fake_posterior(self):
        cp = copy.deepcopy(PM.SEED)
        confirmed = [{"param": "own.w_fund", "old": 0.45, "new": 0.50, "why": "no"}]
        ok, p, reason = L.challenger_posterior_for_moves(cp, cp, confirmed, {})
        self.assertFalse(ok)
        self.assertIsNone(p)
        self.assertEqual(reason, "no posterior branch for own.w_fund")
        msg = L.format_posterior_block(confirmed, p, reason)
        self.assertIn("blocked: no posterior branch for own.w_fund", msg)
        self.assertNotIn("P=0.50", msg)

    def test_mixed_premium_fail_blocks_whole_challenger(self):
        cp = copy.deepcopy(PM.SEED)
        confirmed = [
            {"param": "premium.w_iv_rv", "old": 0.70, "new": 0.72, "why": "prem"},
            {"param": "thresholds.green_own", "old": 62, "new": 63, "why": "live"},
        ]
        real = L.challenger_posterior_ok

        def fail_prem(*_a, **_k):
            return False, 0.42

        L.challenger_posterior_ok = fail_prem
        try:
            ok, p, reason = L.challenger_posterior_for_moves(cp, cp, confirmed, {})
        finally:
            L.challenger_posterior_ok = real
        self.assertFalse(ok)
        self.assertAlmostEqual(p, 0.42)
        self.assertIn("thresholds: live-grade gate (no backtest posterior)", reason)
        msg = L.format_posterior_block(confirmed, p, reason)
        self.assertIn("blocked: P=0.42", msg)
        self.assertNotIn("P=0.50", msg)

    def _weight_sum(self, prem: dict) -> float:
        return sum(v for v in prem.values() if L._is_weight(v))

    def _premium_evidence(self) -> dict:
        cell = lambda pic: {"ic": pic, "t": 3.0, "pic": pic, "pt": 3.0, "months": 30, "n": 100}
        return {
            "kept": {"iv_rv": cell(0.50), "iv_rank_1y": cell(0.10), "iv30": cell(0.40)},
            "own": {},
            "flags": {},
            "rh": {"n": 0},
        }

    def test_confirmed_premium_matches_proposal_and_sums_to_one(self):
        P = copy.deepcopy(PM.SEED)
        proposed, why = L.propose_params(P, self._premium_evidence(), {"folders": {}})
        prem_why = [w for w in why if w["param"].startswith("premium.")]
        self.assertGreaterEqual(len(prem_why), 2)
        before = copy.deepcopy(P)
        chal, rationale = L.build_confirmed_challenger(P, prem_why)
        self.assertEqual(P, before)
        self.assertAlmostEqual(self._weight_sum(chal["premium"]), 1.0, delta=1e-4)
        for k, v in proposed["premium"].items():
            if L._is_weight(v):
                self.assertAlmostEqual(chal["premium"][k], v, places=4)
            else:
                self.assertEqual(chal["premium"][k], v)
        for w in rationale:
            if w["param"].startswith("premium."):
                k = w["param"].split(".", 1)[1]
                self.assertEqual(w["new"], chal["premium"][k])
        self.assertIs(chal["premium"]["contract_iv_pre_earnings"], False)

    def test_single_premium_move_sums_to_one(self):
        P = copy.deepcopy(PM.SEED)
        confirmed = [{"param": "premium.w_iv_rv", "old": 0.70, "new": 0.72, "why": "nudge"}]
        chal, rationale = L.build_confirmed_challenger(P, confirmed)
        self.assertAlmostEqual(self._weight_sum(chal["premium"]), 1.0, delta=1e-4)
        self.assertEqual(rationale[0]["new"], chal["premium"]["w_iv_rv"])
        self.assertIs(chal["premium"]["contract_iv_pre_earnings"], False)

    def test_champion_premium_scores_identical_when_weights_rescale(self):
        champ = {"w_iv_rv": 0.70, "w_iv_rank": 0.30, "w_iv_level": 0.00}
        scaled = {k: v * 1.02 for k, v in champ.items()}
        for i in range(20):
            t = {"iv_rv": 0.85 + i * 0.03, "iv_rank_1y": (i % 7) / 10, "iv_pct": 25 + i}
            a = L.premium_score(t, champ)
            b = L.premium_score(t, scaled)
            self.assertIsNotNone(a)
            self.assertAlmostEqual(a, b, places=9)


if __name__ == "__main__":
    unittest.main()
