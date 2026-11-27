"""A192 V3 (Codex D2): shared scenario context — identity, same paths for every candidate, lenses, missing data."""
import unittest
from unittest.mock import patch
from datetime import date, timedelta

import numpy as np

import structure_context as CX

T0 = date(2026, 11, 24)


def leg(side, k, px, days, qty, iv=0.3):
    return {"side": side, "strike": k, "px": px, "expiry": T0 + timedelta(days=days), "qty": qty, "iv": iv}


def cand(sid, legs, **kw):
    return {"structure": sid, "ticker": "X", "spot": 100.0, "legs": legs, "expiry": min(l["expiry"] for l in legs), "fit": True, **kw}


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
    def test_board_prices_the_whole_covered_call(self):
        import structures as S
        c = cand("covered_call", [leg("call", 105, 2, 7, -1)], expiry_max=T0 + timedelta(days=7))
        with patch.object(S, "outcome", return_value=(np.array([2., -13.]), np.array([80., 120.]))), patch.object(S, "empirical", return_value=np.array([80., 120.])), patch.object(S, "W", np.array([.5, .5])):
            actual = S.evaluate(c, .3, T0, FLAT)
        self.assertAlmostEqual(actual["ev_rv"], -5.5)
        self.assertAlmostEqual(actual["max_loss"], 98.)
        self.assertAlmostEqual(actual["max_gain"], 7.)
        self.assertAlmostEqual(actual["p_rv"], .5)

    def test_expired_overlay_has_no_post_expiry_stock_exposure(self):
        ctx = CX.build("X", T0, 100.0, FLAT)
        ctx["_paths"] = np.full((3, CX.H_TD + 1), 100.0)
        ctx["_paths"][:, 5] = [120., 120., 80.]
        ctx["_paths"][:, -1] = [150., 0., 150.]
        cc = cand("covered_call", [leg("call", 105, 2, 7, -1)])
        actual = CX.pnl(cc, ctx)
        np.testing.assert_allclose(actual, [7., 7., -18.])
        self.assertTrue(np.all(actual >= -CX.exact_max_loss(cc)))
        collar = cand("collar", [leg("call", 105, 2, 7, -1), leg("put", 95, 2, 7, 1)], stock=True)
        np.testing.assert_allclose(CX.pnl(collar, ctx), [5., 5., -5.])
        self.assertTrue(np.all(CX.pnl(collar, ctx) >= -CX.exact_max_loss(collar)))

    def test_staggered_overlay_is_not_silently_modelled(self):
        ctx = CX.build("X", T0, 100.0, FLAT)
        c = cand("collar", [leg("call", 105, 2, 7, -1), leg("put", 95, 2, 14, 1)], stock=True)
        with self.assertRaisesRegex(ValueError, "assignment lifecycle"):
            CX.pnl(c, ctx)

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
        self.assertEqual(set(out["best"]), {"same_budget", "cash", "finite_loss", "matched_downside"})
        self.assertTrue(out["read"].startswith(("all lenses", "lenses disagree")))

    def test_calendar_not_ranked(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        cal = cand("calendar", [leg("call", 100, 1, 7, -1), leg("call", 100, 4, 45, 1)], capital=3)
        out = CX.compare(ctx, [cal])
        self.assertEqual(cal["context"]["status"], "model_limitation")
        self.assertNotIn("calendar", out["best"].values())


class CodexX(unittest.TestCase):
    """A419/A192 Codex X1–X3 (11-24 afternoon)."""
    def test_x3_exact_max_loss_whole_position(self):
        self.assertAlmostEqual(CX.exact_max_loss(cand("csp", [leg("put", 95, 2, 30, -1)])), 93.0)
        self.assertAlmostEqual(CX.exact_max_loss(cand("covered_call", [leg("call", 105, 2, 30, -1)])), 98.0)
        col = cand("collar", [leg("put", 90, 1.5, 30, 1), leg("call", 110, 1.0, 30, -1)], stock=True)
        self.assertAlmostEqual(CX.exact_max_loss(col), 10.5)            # 100 − 90 + 0.5 net debit
        self.assertIsNone(CX.exact_max_loss(cand("short_strangle", [leg("put", 90, 1, 30, -1), leg("call", 110, 1, 30, -1)])))
        self.assertAlmostEqual(CX.exact_max_loss(cand("bull_call_spread", [leg("call", 100, 3, 30, 1), leg("call", 110, 1, 30, -1)])), 2.0)

    def test_x3_csp_gets_finite_lens(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        c = cand("csp", [leg("put", 95, 2, 30, -1)], capital=95)
        CX.compare(ctx, [c])
        self.assertAlmostEqual(c["context"]["finite_loss"]["max_loss"], 93.0)

    def test_x2_failed_fit_never_best(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        bad = cand("iron_fly", [leg("put", 90, 0.5, 30, 1), leg("put", 100, 4, 30, -1), leg("call", 100, 4, 30, -1),
                                leg("call", 110, 0.5, 30, 1)], capital=2, fit=False, fit_why="trend up")
        out = CX.compare(ctx, [bad])
        self.assertNotIn("iron_fly", out["best"].values())
        row = out["candidates"][-1]
        self.assertFalse(row["eligible"]); self.assertIn("trend up", row["eligibility_why"])
        self.assertTrue(set(out["hypothetical_leaders"].values()) <= {"iron_fly"})


class SameBudget(unittest.TestCase):
    def test_released_principal_and_profit_earn_cash_interest(self):
        out = CX.lenses(np.array([1.]), np.array([1.]), 10., 10., False, 1000., released_days=23)
        self.assertAlmostEqual(out['same_budget']['pnl_usd'], 103.12)
        self.assertAlmostEqual(out['same_budget']['released_cash_interest_usd'], 1100 * CX.RF * 23 / 365, places=4)
        self.assertEqual(out['ev'], 1.)  # standalone trade payoff remains distinct

    def test_loss_and_deficit_are_not_treated_as_full_principal_return(self):
        for payoff in [-5., -12.]:
            out = CX.lenses(np.array([payoff]), np.array([1.]), 10., None, True, 1000., released_days=23)
            expected = 100 * payoff + 100 * (10 + payoff) * CX.RF * 23 / 365
            self.assertAlmostEqual(out['same_budget']['pnl_usd'], round(expected, 2))

    def test_compare_applies_early_expiry_carry_but_not_future_mark_carry(self):
        ctx = CX.build('X', T0, 100., FLAT)
        c = cand('csp', [leg('put', 100, 2, 7, -1)], capital=100.)
        CX.compare(ctx, [c])
        self.assertEqual(c['context']['same_budget']['released_days'], 23)
        self.assertAlmostEqual(c['context']['same_budget']['released_cash_interest_usd'], 10200 * CX.RF * 23 / 365, places=4)
        c = cand('long_call', [leg('call', 100, 2, 45, 1)], capital=2.)
        CX.compare(ctx, [c])
        self.assertEqual(c['context']['same_budget']['released_cash_interest_usd'], 0)

    """X4: one $ budget for every row, whole contracts, idle cash at the T-bill."""
    def test_cash_and_contracts(self):
        ctx = CX.build("X", T0, 100.0, NOISY)
        c = cand("long_call", [leg("call", 100, 3, 45, 1)], capital=3, max_loss=3)
        out = CX.compare(ctx, [c])
        cash = next(r for r in out["candidates"] if r["id"] == "cash")["lenses"]["same_budget"]
        self.assertAlmostEqual(cash["ret"], round(CX.RF * CX.H_CAL / 365, 4))
        sb = c["context"]["same_budget"]
        self.assertEqual(sb["contracts"], 33)                   # floor(10,000 / 300)
        self.assertAlmostEqual(sb["idle_usd"], 100.0)
        self.assertIn("same_budget", out["best"])

    def test_too_big_for_budget(self):
        L = CX.lenses(np.ones(10), np.full(10, 0.1), 200.0, 200.0, False, 10_000.0)
        self.assertIsNone(L["same_budget"]["ret"])


if __name__ == "__main__":
    unittest.main()
