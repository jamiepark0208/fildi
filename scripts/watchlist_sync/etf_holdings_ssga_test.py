"""Unit tests for etf_holdings_ssga (stdlib only)."""
from __future__ import annotations

import unittest
from pathlib import Path

from etf_holdings_ssga import parse_holdings_xlsx


class TestHoldingsParse(unittest.TestCase):
    def test_xlk_fixture_or_skip(self):
        p = Path("/tmp/xlk-hold.xlsx")
        if not p.exists():
            self.skipTest("no /tmp/xlk-hold.xlsx")
        as_of, rows = parse_holdings_xlsx(p.read_bytes())
        self.assertEqual(as_of, "2026-10-15")
        self.assertGreater(len(rows), 50)
        top = rows[0]
        self.assertEqual(top[0], "NVDA")
        self.assertGreater(top[1], 10)
        tickers = {r[0] for r in rows}
        self.assertIn("AAPL", tickers)
        self.assertIn("MSFT", tickers)


if __name__ == "__main__":
    unittest.main()
