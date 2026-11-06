"""A327 stage 1: week clustering, blocked grades, churn guard."""
from __future__ import annotations

import copy
import json
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import learn as L  # noqa: E402
import params as PM  # noqa: E402
from grade_ledger import grade_option_at_expiry  # noqa: E402
from grade_weeks import MIN_LIVE_WEEKS, failed_l1_gates, week_cluster_metrics  # noqa: E402


def _minimal_ev() -> dict:
    return {"kept": {}, "own": {}, "flags": {}, "rh": {}}


def _live_folder(n_weeks: int, n: int = 40) -> dict:
    return {
        "folders": {
            "own:21d": {
                "n": n,
                "n_weeks": n_weeks,
                "n_label": f"{n} trades · {n_weeks} weeks",
                "good": 0.3,
            }
        }
    }


class A327Stage1(unittest.TestCase):
    def test_live_threshold_five_weeks_no_move_six_moves(self):
        cp = copy.deepcopy(PM.SEED)
        _, why5 = L.propose_params(cp, _minimal_ev(), _live_folder(5))
        self.assertFalse(any(w["param"].startswith("thresholds.") for w in why5))
        _, why6 = L.propose_params(cp, _minimal_ev(), _live_folder(MIN_LIVE_WEEKS))
        self.assertTrue(any(w["param"] == "thresholds.green_own" for w in why6))

    def test_blocked_plan_item_grades_per_gate(self):
        gates = failed_l1_gates([{"check": "list_cap", "pass": False, "severity": "block"}])
        self.assertEqual(gates, ["list_cap"])
        run_date = date(2026, 10, 2)
        exp = date(2026, 10, 16)
        px = []
        d = run_date
        while d <= exp:
            px.append((d, 48.0 if d < exp else 45.0))
            d += timedelta(days=1)
        fill = 0.49
        strike = 47.0
        row = grade_option_at_expiry(
            run_id=1,
            folder_key="blocked:list_cap",
            ticker="SLB",
            run_date=run_date,
            opt_type="put",
            strike=strike,
            expiry=exp,
            fill=fill,
            iv=0.33,
            px_series=px,
            spy_series=[],
            er_dates=[],
            today=date(2026, 10, 17),
            done=set(),
            extra_detail={"blocked_gate": "list_cap"},
        )
        self.assertIsNotNone(row)
        intrinsic = max(0.0, strike - 45.0)
        expect_ret = (fill - intrinsic) / strike
        self.assertAlmostEqual(row[5], expect_ret, places=6)
        detail = json.loads(row[9])
        self.assertEqual(detail["blocked_gate"], "list_cap")

    def test_propose_twice_identical_premium_no_drift(self):
        cp = copy.deepcopy(PM.SEED)
        ev = {
            "kept": {
                "iv_rv": {"ic": 0.1, "t": 3, "pic": 0.08, "pt": 3, "months": 30, "n": 1000},
                "iv_rank_1y": {"ic": 0.05, "t": 2, "pic": 0.04, "pt": 2, "months": 30, "n": 1000},
                "iv30": {"ic": 0.02, "t": 1, "pic": 0.01, "pt": 1, "months": 30, "n": 1000},
            },
            "own": {},
            "flags": {},
            "rh": {"n": 0},
        }
        np1, _ = L.propose_params(cp, ev, {})
        np2, _ = L.propose_params(cp, ev, {})
        self.assertEqual(np1["premium"], np2["premium"])
        self.assertGreater(cp["premium"]["w_iv_rv"], 0.55)

    def test_one_cycle_move_no_challenger_confirmation(self):
        why = [{"param": "premium.w_iv_rv", "old": 0.7, "new": 0.72}]
        prev = {}
        confirmed = [w for w in why if prev.get(w["param"]) == L.param_direction(w)]
        self.assertEqual(confirmed, [])

    def test_week_cluster_metrics(self):
        trades = [{"ret": 0.01, "week": (2026, 40), "breach": False} for _ in range(3)]
        trades += [{"ret": -0.02, "week": (2026, 41), "breach": True}]
        m = week_cluster_metrics(trades)
        self.assertEqual(m["n_trades"], 4)
        self.assertEqual(m["n_weeks"], 2)


if __name__ == "__main__":
    unittest.main()
