"""11-24 V1 (Codex A192 #1–3): long call spec match, CSP numeric checks, pin vs cheap IV, off-spec never primary."""
import unittest
from datetime import date, timedelta

import structures as S

T0 = date(2026, 11, 24)


def row(side, strike, delta, exp, bid=2.0, ask=2.2, iv=0.4, spot=100.0):
    return {"side": side, "strike": strike, "delta": delta, "expiry": exp, "bid": bid, "ask": ask, "iv": iv, "spot": spot}


def chains_for(lc_days, call_delta):
    mo, lc = T0 + timedelta(days=24), T0 + timedelta(days=lc_days)
    ch = {("X", mo): [row("call", 100, 0.5, mo), row("put", 100, -0.5, mo)]}
    ch[("X", lc)] = [row("call", 100, call_delta, lc)]
    return sorted({mo, lc}), ch


def long_call(cands):
    return next(c for c in cands if c["structure"] == "long_call")


class SpecMatch(unittest.TestCase):
    def test_in_spec(self):
        exps, ch = chains_for(52, 0.52)
        c = long_call(S.build_all("X", exps, ch, T0, set()))
        self.assertTrue(c["spec_match"]); self.assertIsNone(c["spec_note"])

    def test_delta_off_spec_labelled(self):
        exps, ch = chains_for(52, 0.70)
        c = long_call(S.build_all("X", exps, ch, T0, set()))
        self.assertFalse(c["spec_match"]); self.assertIn("not the tested S100 spec", c["spec_note"])

    def test_no_35_60_ladder_falls_back_labelled(self):   # Codex: silent 24 DTE fallback under the S100 description
        mo = T0 + timedelta(days=24)
        ch = {("X", mo): [row("call", 100, 0.5, mo), row("put", 100, -0.5, mo)]}
        c = long_call(S.build_all("X", [mo], ch, T0, set()))
        self.assertEqual(c["spec_dte"], 24); self.assertFalse(c["spec_match"])


class CspNumeric(unittest.TestCase):
    def _csp(self, **kw):
        pr = {"strike": 90.0, "expiry": str(T0 + timedelta(days=7)), "iv": 0.4, "bid": 1.0, "ask": 1.1, "spot": 100.0,
              "band": "0.10-0.15", "band_target": 0.12, "why": "x", **kw}
        exps, ch = chains_for(52, 0.5)
        return [c for c in S.build_all("X", exps, ch, T0, set(), None, {"put_rec": pr}) if c["structure"] == "csp"]

    def test_clean(self):
        self.assertEqual(len(self._csp()), 1)

    def test_crossed_nan_zero_dropped(self):
        for bad in ({"ask": 0.9}, {"iv": float("nan")}, {"iv": 0}, {"bid": None}, {"spot": 0}):
            self.assertEqual(self._csp(**bad), [], bad)


class PinVsCheap(unittest.TestCase):
    def c(self, rv5):
        return {"structure": "long_strangle", "legs": [{"iv": 0.10}, {"iv": 0.12}], "rv20": 0.86, "rv5": rv5}

    def test_pin_flagged(self):
        c = self.c(0.05)
        self.assertIn("deal pin", S.iv_suspect(c)); self.assertNotIn("iv_cheap", c)

    def test_moving_stock_is_cheap_not_suspect(self):
        c = self.c(0.80)
        self.assertIsNone(S.iv_suspect(c)); self.assertIn("still moving", c["iv_cheap"])

    def test_solver_blowup(self):
        self.assertIn("solver", S.iv_suspect({"structure": "x", "legs": [{"iv": 2.65}], "rv20": 0.5, "rv5": 0.5}))

    def test_off_spec_never_primary(self):
        self.assertTrue(S._off_spec({"spec_match": False}))
        self.assertTrue(S._off_spec({"iv_cheap": "x"}))
        self.assertFalse(S._off_spec({"spec_match": True}))
        self.assertFalse(S._off_spec({}))


if __name__ == "__main__":
    unittest.main()
