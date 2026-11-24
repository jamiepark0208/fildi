"""A192 V3 (Codex D2): shared scenario context — identity, same paths for every candidate, lenses, missing data."""
import unittest
from datetime import date, timedelta

import numpy as np

import structure_context as CX

T0 = date(2026, 11, 24)


def leg(side, k, px, days, qty, iv=0.3):
    return {"side": side, "strike": k, "px": px, "expiry": T0 + timedelta(days=days), "qty": qty, "iv": iv}


def cand(sid, legs, **kw):
    return {"structure": sid, "ticker": "X", "spot": 100.0, "legs": legs, "expiry": min(l["expiry"] for l in legs), **kw}


FLAT = np.log(np.full(400, 100.0)) + 0.001 * np.arange(400)          # pure drift → de-meaned paths are flat at spot
rng = np.random.default_rng(7)
NOISY = np.log(100.0) + np.cumsum(rng.normal(0, 0.02, 505))


class Identity(unittest.TestCase):
    def test_one_scenario_for_every_candidate(self):
        ctx = CX.build("X", T0, 100.0, NOISY, {"rsi": 40})
        cs = [cand("long_call", [leg("call", 100, 3, 45, 1)], capital=3, max_loss=3),
              cand("csp", [leg("put", 95, 1, 7, -1)], capital=95)]
        out = CX.compare(ctx, cs)
        self.assertEqual({c["context"]["scenario_id"] for c in cs}, {out["scenario_id"]})
        for k in ("idea_id", "decision_at", "holding_horizon_at", "role", "technical_state_version", "input_digest",
                  "scenario_id", "policy_version", "quote_snapshot_id"):
            self.assertIn(k, out)
        self.assertNotIn("long_call", str({k: v for k, v in out.items() if k not in ("candidates", "best", "read")}))
        self.assertNotIn("_paths", out)
        self.assertEqual(len({c["spec_hash"] for c in cs}), 2)

    def test_scenario_id_depends_on_paths(self):
        a = CX.build("X", T0, 100.0, NOISY)["scenario_id"]
        b = CX.build("X", T0, 100.0, NOISY + np.r_[np.zeros(504), 0.05])["scenario_id"]
        self.assertNotEqual(a, b)

    def test_demeaned(self):
        lp = CX.paths(NOISY)
        self.assertAlmostEqual(float(np.exp(lp[:, -1]).mean()), 1.0, places=10)   # stock EV = 0 under no view


class Missing(unittest.TestCase):
    def test_short_history_unavailable_not_zero(self):
        cs = [cand("csp", [leg("put", 95, 1, 7, -1)], capital=95)]
        out = CX.compare(CX.build("X", T0, 100.0, NOISY[:60]), cs)
        self.assertEqual(out["status"], "context_unavailable")
        self.assertNotIn("ev", str(cs[0]["context"]))
        self.assertEqual(out["candidates"], [])

    def test_bad_spot(self):
        self.assertEqual(CX.build("X", T0, float("nan"), NOISY)["status"], "context_unavailable")


class KnownAnswer(unittest.TestCase):
    def setUp(self):
        self.ctx = CX.build("X", T0, 100.0, FLAT)

    def test_flat_paths(self):
        lc = cand("long_call", [leg("call", 100, 2, 10, 1)])
        sp = cand("csp", [leg("put", 100, 2, 10, -1)])
        np.testing.assert_allclose(CX.pnl(lc, self.ctx), -2.0)      # expired ATM before horizon → debit lost
        np.testing.assert_allclose(CX.pnl(sp, self.ctx), 2.0)       # credit kept

    def test_alive_leg_marked_at_entry_iv(self):
        lc = cand("long_call", [leg("call", 100, 2, 60, 1, iv=0.3)])
        x = CX.pnl(lc, self.ctx)
        t = 30 / 365; sd = 0.3 * t ** 0.5
        self.assertAlmostEqual(float(x[0]) + 2, 100 * (2 * float(CX._ndtr(sd / 2)) - 1), places=4)

    def test_covered_call_carries_shares(self):
        x = CX.pnl(cand("covered_call", [leg("call", 110, 1, 10, -1)]), self.ctx)
        np.testing.assert_allclose(x, 1.0)


class Lenses(unittest.TestCase):
    def test_matched_downside_hits_budget(self):
        x = np.linspace(-10, 10, 200); w = np.full(200, 1 / 200)
        L = CX.lenses(x, w, 50.0, 10.0, False)
        self.assertAlmostEqual(L["matched_downside"]["units"] * 100 * -L["cvar5"], CX.TAIL_BUDGET, places=0)
        self.assertAlmostEqual(L["cash"]["ret"], L["ev"] / 50.0)

    def test_unlimited_has_no_finite_lens(self):
        L = CX.lenses(np.ones(10), np.full(10, 0.1), 20.0, None, True)
        self.assertIsNone(L["finite_loss"]["ret"]); self.assertEqual(L["finite_loss"]["why"], "unlimited loss")

    def test_baselines_and_read(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        out = CX.compare(ctx, [cand("long_call", [leg("call", 100, 3, 45, 1)], capital=3, max_loss=3)])
        self.assertEqual([r["id"] for r in out["candidates"][:3]], ["no_trade", "cash", "stock"])
        self.assertEqual(set(out["best"]), {"cash", "finite_loss", "matched_downside"})
        self.assertTrue(out["read"].startswith(("all lenses", "lenses disagree")))

    def test_calendar_not_ranked(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        cal = cand("calendar", [leg("call", 100, 1, 7, -1), leg("call", 100, 4, 45, 1)], capital=3)
        out = CX.compare(ctx, [cal])
        self.assertEqual(cal["context"]["status"], "model_limitation")
        self.assertNotIn("calendar", out["best"].values())


if __name__ == "__main__":
    unittest.main()
