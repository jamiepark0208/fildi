"""A372 § 1 accounting fixtures (snapshot 37 numbers + mandatory fixtures 1–3)."""
import unittest

import book_accounting as BA

FILDI = {"type": "Individual (Margin)", "total_value": 18573.94, "equity_value": 38236.63, "options_value": -54.00,
         "crypto_value": 0, "cash": -19608.69, "buying_power": 2224.72, "unleveraged_bp": 556.18}
FILDI_PUTS = [{"strike": 16.5, "qty": 1}, {"strike": 16.0, "qty": 1}, {"strike": 18.0, "qty": 2}]
IRA = {"type": "IRA (Cash)", "total_value": 91477.67, "equity_value": 90165.88, "options_value": -177.00,
       "crypto_value": 0, "cash": 1488.79, "buying_power": 257.10, "unleveraged_bp": 257.10}


class Snapshot37(unittest.TestCase):
    def test_nlv_reconciles_cash_carries_debt(self):
        a = BA.accounting(FILDI, FILDI_PUTS)
        self.assertTrue(a["E_reconciled"])
        self.assertAlmostEqual(a["D"], 19608.69)
        self.assertAlmostEqual(a["P"], 6850.0)

    def test_debt_plus_positive_bp_is_not_cash(self):  # fixture 2
        a = BA.accounting(FILDI, FILDI_PUTS)
        self.assertIsNone(a["F"])
        self.assertEqual(a["F_status"], "none")
        self.assertIsNone(a["mix_cash"])

    def test_unreconciled_hold_makes_f_unknown(self):
        a = BA.accounting(IRA, [])
        self.assertEqual(a["F_status"], "unknown")       # cash 1,489 vs broker free 257: 1,232 held
        self.assertEqual(a["F_bounds"], [257.10, 1488.79])
        self.assertIsNone(a["mix_cash"])


class Fixtures(unittest.TestCase):
    def test_no_puts_fully_invested_is_not_ample_reserve(self):  # fixture 1
        acct = {**IRA, "unleveraged_bp": 1488.79}
        a = BA.accounting(acct, [])
        self.assertEqual(a["F_status"], "reconciled")
        self.assertEqual(a["mix_cash"], 1.0)
        self.assertLess(a["cash_of_nlv"], 0.02)
        self.assertTrue(any("does not mean" in n for n in a["notes"]))

    def test_close_releases_reservation_but_spends_cash(self):  # fixture 3
        acct = {"total_value": 50000, "equity_value": 40000, "options_value": -100, "crypto_value": 0,
                "cash": 10100, "buying_power": 5100, "unleveraged_bp": 5100}
        puts = [{"strike": 50, "qty": 1}]
        before = BA.accounting(acct, puts)
        self.assertEqual((before["F"], before["P"]), (5100, 5000))
        after = BA.after_close(acct, puts, 0, buyback=1.0)
        self.assertEqual((after["F"], after["P"], after["C"]), (10000, 0, 10000))  # +5,000 freed − 100 cost
        self.assertTrue(after["E_reconciled"])


if __name__ == "__main__":
    unittest.main()
