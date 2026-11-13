"""A205 unit 4: put what-if is honest about scope. Run: .venv/bin/python -m unittest tests.test_pm_whatif"""
import contextlib
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import pm_alerts  # noqa: E402


def put(t, k, exp, spot=20.0, iv=1.0, days=5, qty=1):
    return {"account": "X", "ticker": t, "strike": k, "expiry": exp, "qty": qty, "iv": iv, "spot": spot,
            "close_cost": 50.0 * qty, "assign_cash": k * 100 * qty, "days_left": days, "status": "ok"}


def book(positions):
    return {"snapshot_id": 7, "positions": positions, "rules": {"crash_budget": 0.25, "crash_warn": 0.20},
            "accounts": {"X": {"equity": 10_000.0, "cash": 1_500.0, "crash_drop_pct": 0.10}}}


class FakeConn:
    pass


class WhatIf(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(pm_alerts, k) for k in ("connect", "rows", "realized_vol", "_cholesky_L", "_ticker_betas", "_hist_var")}
        pm_alerts.connect = lambda: contextlib.nullcontext(FakeConn())
        pm_alerts.rows = lambda *a, **k: []
        pm_alerts.realized_vol = lambda conn, t: {}
        pm_alerts._cholesky_L = lambda conn, names: None
        pm_alerts._ticker_betas = lambda conn, names: {}
        pm_alerts._hist_var = lambda *a, **k: None

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(pm_alerts, k, v)

    def test_common_draws_identical_sets_zero_delta(self):
        b = book([put("AAA", 19, "2026-11-20"), put("BBB", 18, "2026-11-20")])
        extra = frozenset({"CCC"})
        r1 = pm_alerts.simulate(b, "X", [], {}, random.Random(7), conn=None, extra_names=extra)
        r2 = pm_alerts.simulate(b, "X", [], {}, random.Random(7), conn=None, extra_names=extra)
        self.assertEqual(r1["risk"], r2["risk"])
        self.assertEqual(r1["assign_p90"], r2["assign_p90"])

    def test_adding_same_expiry_put_is_not_noop(self):
        b = book([put("AAA", 19, "2026-11-20")])
        out = pm_alerts.what_if_add_put(b, "X", "BBB", 19, "2026-11-20", 3, 1.0, 20.0, premium=0.5)
        self.assertTrue(out["coverage"]["candidate_in_mc"])
        self.assertIsNotNone(out["risk_delta"])
        self.assertGreater(out["risk_with"], out["risk_base"])

    def test_later_expiry_candidate_is_partial_not_green(self):
        b = book([put("AAA", 15, "2026-11-20", days=5)])
        out = pm_alerts.what_if_add_put(b, "X", "BBB", 10, "2099-01-15", 1, 0.5, 20.0, premium=0.2)
        self.assertFalse(out["coverage"]["candidate_in_mc"])
        self.assertIn("2099-01-15", out["coverage"]["excluded_notional"])
        self.assertNotEqual(out["badge"], "green")
        self.assertTrue(any("crash-week only" in r for r in out["reasons"]))

    def test_missing_sim_and_crash_is_unknown(self):
        saved = (pm_alerts.simulate, pm_alerts._crash_drop)
        pm_alerts.simulate = lambda *a, **k: None
        pm_alerts._crash_drop = lambda *a, **k: None
        try:
            out = pm_alerts.what_if_add_put(book([]), "X", "BBB", 19, "2026-11-20", 1, 1.0, 20.0)
        finally:
            pm_alerts.simulate, pm_alerts._crash_drop = saved
        self.assertEqual(out["badge"], "unknown")
        self.assertIsNone(out["risk_delta"])


if __name__ == "__main__":
    unittest.main()
