"""A129 v5: OpenJev local — privacy allowlist, question schema, resolver rules, guard math.
Run: .venv/bin/python -m unittest tests.test_openjev_local"""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import forecast_ledger as fl  # noqa: E402
import openjev_local as oj  # noqa: E402


def clean_state():
    return {"market": {"as_of": "2026-10-15", "spot": 10.0, "sigma_20d_pct": 8.0},
            "scores": {"fund_total": 70.0, "tech_total": 30.0},
            "fair_value": {"fair_value": 12.0},
            "street": {"pt_mean": 14.0, "recent_analyst_actions": ["2026-10-14 MS upgrade Buy PT 15"]}}


class Privacy(unittest.TestCase):
    def test_clean_state_passes(self):
        oj.check_state(clean_state(), ("FILDI", "Traditional IRA"))

    def test_holdings_keys_rejected(self):
        for g, k in [("market", "quantity"), ("market", "cost_basis"), ("scores", "pnl"), ("market", "account"),
                     ("options", "contracts_held"), ("market", "market_value"), ("street", "position")]:
            s = clean_state()
            s.setdefault(g, {})[k] = 1
            with self.assertRaises(oj.PrivacyError, msg=f"{g}.{k}"):
                oj.check_state(s)

    def test_unknown_group_rejected(self):
        s = clean_state()
        s["portfolio"] = {"x": 1}
        with self.assertRaises(oj.PrivacyError):
            oj.check_state(s)

    def test_account_like_values_rejected(self):
        for v in ["Traditional IRA", "open position", "cost basis 4.10", "3 contracts", "200 shares", "unrealized +$40"]:
            s = clean_state()
            s["street"]["recent_analyst_actions"] = [v]
            with self.assertRaises(oj.PrivacyError, msg=v):
                oj.check_state(s)

    def test_account_names_from_book_rejected(self):
        s = clean_state()
        s["scores"]["fit_why"] = ["held in Roth Brokerage"]
        with self.assertRaises(oj.PrivacyError):
            oj.check_state(s, ("Roth Brokerage",))

    def test_allowlist_has_no_holdings_fields(self):
        for g, fields in oj.STATE_ALLOWLIST.items():
            for f in fields:
                self.assertFalse(oj.DENY_KEY.search(f) and f != "fund_top_metrics", f"{g}.{f}")

    def test_render_drops_group_and_never_mentions_accounts(self):
        txt = oj.render_state("ABC", clean_state(), drop="street")
        self.assertNotIn("[street]", txt)
        self.assertIn("[fair_value]", txt)
        self.assertNotRegex(txt.lower(), r"ira|account|quantity|cost basis")


class Questions(unittest.TestCase):
    def test_question_schema(self):
        q = {"oj": {"type": "choice", "instructions": "x", "criteria": {"fund": "a", "tech": "b", "neither": "c"}},
             "ratio_keys": ["fund", "tech"]}
        self.assertAlmostEqual(oj.p_from_answer(q, {"probabilities": {"fund": 0.6, "tech": 0.2, "neither": 0.2}}), 0.75)
        q2 = {"oj": {"type": "noul", "instructions": "x"}}
        self.assertEqual(oj.p_from_answer(q2, {"noul": 0.83}), 0.83)
        q3 = {"oj": {"type": "choice", "instructions": "x", "criteria": {}}, "yes_keys": ["about_right", "too_high"]}
        self.assertAlmostEqual(oj.p_from_answer(q3, {"probabilities": {"too_high": 0.1, "about_right": 0.5,
                                                                       "too_low": 0.4}}), 0.6)

    def test_trading_days(self):
        self.assertEqual(oj.add_trading_days(dt.date(2026, 10, 16), 5), dt.date(2026, 10, 23))  # Fri → Fri
        self.assertEqual(oj.add_trading_days(dt.date(2026, 10, 17), 1), dt.date(2026, 10, 19))  # Sat → Mon

    def test_up_and_drop_rates(self):
        up = [100 + i for i in range(200)]
        self.assertEqual(oj.up_rate(up, 5), 1.0)
        self.assertIsNone(oj.up_rate(up[:30], 5))
        self.assertEqual(oj.drop_rate(up), 0.0)

    def test_ledger_rows_pair_forecaster_and_baseline(self):
        made = dt.datetime(2026, 10, 16, 5, 30, tzinfo=oj.PT)
        q = {"question_id": "dir5:ABC:2026-10-16", "qtype": "direction_5d", "question": "Will ABC close above $10?",
             "oj": {"type": "noul", "instructions": "x"}, "resolves_on": "2026-10-23", "baseline": ("base_rate", 0.55),
             "meta": {"spot": 10.0}, "subject": "ABC"}
        rows = oj.ledger_rows([q], {"q0": {"noul": 0.61}}, made)
        self.assertEqual([r[4] for r in rows], [oj.FORECASTER, "base_rate"])
        self.assertEqual({r[0] for r in rows}, {"dir5:ABC:2026-10-16"})
        self.assertEqual(rows[0][7], dt.date(2026, 10, 16))
        for r in rows:
            self.assertNotRegex(json.dumps(r, default=str).lower(), r"ira|fildi\b")


class Resolvers(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(fl.touched([11, 10.0, 12], 10.0))
        self.assertFalse(fl.touched([11, 10.01], 10.0))
        self.assertTrue(fl.dropped([9.5, 8.0], 8.0))
        self.assertTrue(fl.moved_toward(12.0, 14.0, 13.0))
        self.assertFalse(fl.moved_toward(12.0, 14.0, 15.0))
        self.assertFalse(fl.moved_toward(12.0, 14.0, 10.0))   # overshoot by same distance = not toward

    def test_every_scored_qtype_has_resolver(self):
        for qt in ("strike_touch", "direction_5d", "direction_20d", "drop_2sigma", "score_disagree",
                   "earnings_vs_implied", "fv_vs_pt", "rec_beats_median"):
            self.assertIn(qt, fl.EXTRA_RESOLVERS)


class Guard(unittest.TestCase):
    def test_in_window(self):
        self.assertTrue(oj.in_window(dt.time(5, 30)))
        self.assertTrue(oj.in_window(dt.time(8, 59)))
        self.assertFalse(oj.in_window(dt.time(9, 0)))
        self.assertTrue(oj.in_window(dt.time(22, 0)))
        self.assertFalse(oj.in_window(dt.time(23, 30)))


if __name__ == "__main__":
    unittest.main()
