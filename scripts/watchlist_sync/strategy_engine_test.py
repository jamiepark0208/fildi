"""A192 V3 (Codex counterexamples 11-24): unsupported structures, invalid gate inputs, tie-aware ranks. Production fit/rank_key only."""
import math
import unittest

import strategy_engine as SE


def put_gate_input():
    st = SE.ENGINE["strategies"]["sell_put"]
    return next(g for g in st["gates"] if g["input"] == "put_edge_q")


class Registry(unittest.TestCase):
    def test_unknown_structure_not_fit(self):
        ok, why = SE.fit({"ticker": "X", "structure": "made_up_shape"}, {}, {})
        self.assertFalse(ok); self.assertIn("unsupported structure", why[0])

    def test_registered_no_gate_structure_still_buildable(self):
        self.assertEqual(SE.strategy_of("calendar"), "none")
        self.assertEqual(SE.fit({"ticker": "X", "structure": "calendar"}, {}, {}), (True, []))


class InvalidInputs(unittest.TestCase):
    def test_nan_inf_put_edge_never_pass(self):
        g = put_gate_input()
        for bad in (float("nan"), float("inf"), -float("inf")):
            ok, why = SE.fit({"ticker": "X", "structure": "csp", "put_edge_q": bad, "iv_rv": 1.3}, {}, {})
            if g.get("if_known"):
                self.assertNotIn("put-edge invalid", " ".join(why))   # optional → omitted, never a numeric pass/fail
            else:
                self.assertFalse(ok, bad); self.assertTrue(any("invalid" in w for w in why), why)

    def test_finite_controls_unchanged(self):
        g = put_gate_input()
        lo = g.get("min", 1) - 1
        ok, why = SE.fit({"ticker": "X", "structure": "csp", "put_edge_q": lo, "iv_rv": 1.3}, {}, {})
        self.assertIn(g["why"], why)


class Ties(unittest.TestCase):
    def rank(self, vals):
        cs = [{"ticker": f"T{i}", "ret60": v, "arm": 50} for i, v in enumerate(vals)]
        k = SE.rank_key(cs, "long_call")
        return [k[id(c)] for c in cs], cs

    def test_equal_values_equal_scores_any_order(self):
        if not SE.ENGINE["strategies"].get("long_call", {}).get("rank"):
            self.skipTest("long_call has no rank inputs")
        a, _ = self.rank([0.1, 0.1, 0.3])
        b, _ = self.rank([0.3, 0.1, 0.1])
        self.assertAlmostEqual(a[0], a[1]); self.assertAlmostEqual(b[1], b[2]); self.assertAlmostEqual(a[0], b[1])

    def test_avg_rank(self):
        import numpy as np
        np.testing.assert_allclose(SE._avg_rank(np.array([3.0, 1.0, 1.0, 2.0])), [3, 0.5, 0.5, 2])

    def test_unequal_order_preserved(self):
        if not SE.ENGINE["strategies"].get("long_call", {}).get("rank"):
            self.skipTest("long_call has no rank inputs")
        s, _ = self.rank([0.1, 0.2, 0.3])
        w = dict(SE.ENGINE["strategies"]["long_call"]["rank"]).get("ret60", 0)
        if w:
            self.assertEqual(s == sorted(s), w > 0)


if __name__ == "__main__":
    unittest.main()
