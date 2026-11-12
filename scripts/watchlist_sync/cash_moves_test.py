"""A372 § 4 cash_moves fixtures: target is shared; moves are per account."""
import unittest

import book_accounting as BA
import cash_moves as RB
from book_accounting_test import FILDI, FILDI_PUTS, IRA

TGT = {"target": 0.5, "policy_version": "t"}
PUTS = [{"ticker": "IREN", "strike": 16.5, "expiry": "2026-11-20", "qty": 1, "mark": 0.30, "prem": 0.40},
        {"ticker": "IREN", "strike": 18.0, "expiry": "2026-11-13", "qty": 2, "mark": 0.05, "prem": 0.50}]


class Rebalance(unittest.TestCase):
    def test_debt_account_closes_captured_put_then_sells_avoid_first(self):
        acct = BA.accounting(FILDI, [{"strike": p["strike"], "qty": p["qty"]} for p in PUTS])
        stocks = [{"ticker": "HOOY", "qty": 500, "px": 19.6, "folder": "context"},
                  {"ticker": "ONDS", "qty": 1500, "px": 5.75, "folder": "avoid"}]
        r = RB.plan(acct, TGT, PUTS, stocks, {"ONDS": 10}, [], allow_new_puts=False)
        self.assertEqual(r["direction"], "raise cash")
        self.assertEqual(r["steps"][0]["what"], "IREN 18P 2026-11-13")          # 90 % captured → first
        sold = [s for s in r["steps"] if s["action"] == "sell stock"]
        self.assertEqual(sold[0]["what"], "ONDS")                                # Avoid before a bigger non-Avoid
        self.assertLessEqual(sold[0]["qty"], 500)                                # 1,000 of 1,500 locked by 10 short calls
        self.assertIn("still short", r["note"])                                 # $19.6k debt > sellable stock in this fixture

    def test_target_identical_whatever_the_account(self):
        a = RB.plan(BA.accounting(FILDI, FILDI_PUTS), TGT, [], [], {}, [])
        b = RB.plan(BA.accounting(IRA, []), TGT, [], [], {}, [])
        self.assertEqual(a["target"], b["target"])

    def test_excess_cash_sells_engine_puts(self):
        acct = BA.accounting({**IRA, "cash": 20000, "unleveraged_bp": 20000}, [])
        r = RB.plan(acct, TGT, [], [], {}, [{"ticker": "X", "strike": 20, "expiry": "e", "bid": 0.5, "rank": 1}])
        self.assertEqual(r["steps"][0]["action"], "sell put")
        self.assertEqual(r["steps"][0]["qty"], 5)                                 # capped at 5 contracts
        self.assertAlmostEqual(r["steps"][0]["mix_after"], (20000 - 10000 + 250) / (20000 - 10000 + 250 + 10000), 4)

    def test_margin_loan_gets_no_new_puts(self):
        acct = BA.accounting({**IRA, "cash": 20000, "unleveraged_bp": 20000}, [])
        r = RB.plan(acct, TGT, [], [], {}, [{"ticker": "X", "strike": 20, "expiry": "e", "bid": 0.5, "rank": 1}], allow_new_puts=False)
        self.assertEqual(r["steps"], [])
        self.assertIn("margin loan", r["note"])


if __name__ == "__main__":
    unittest.main()
