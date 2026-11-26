"""Codex X5 (A192/A205, 11-24): Live Today credits a source only to the exact contract it names."""
import unittest

from trade_funnel import merge_today


def it(src, tier, k=None, e=None, fam="short_put"):
    return {"ticker": "ORCL", "family": fam, "source": src, "tier": tier, "strike": k, "expiry": e}


class ExactContract(unittest.TestCase):
    def test_engine_not_credited_to_other_strike(self):
        # ORCL 11-24: engine 88P Dec 4 (candidate) vs S054 rule 95P Dec 18 (live) → row = 95P, but 'put engine' is not its source
        b = merge_today([it("put engine", "candidate", 88, "2026-12-04"), it("put_s054", "live", 95, "2026-12-18"),
                         it("put_z50", "paper")])
        row = b[("ORCL", "short_put")]
        self.assertEqual(row["strike"], 95)
        self.assertEqual(row["sources"], ["put_s054"])
        self.assertEqual(row["name_signals"], ["put_z50"])
        self.assertEqual([(a["strike"], a["sources"]) for a in row["alternatives"]], [(88, ["put engine"])])

    def test_same_contract_sources_agree(self):
        b = merge_today([it("put engine", "live", 88, "2026-12-04"), it("strategies board", "board", 88.0, "2026-12-04T00:00")])
        row = b[("ORCL", "short_put")]
        self.assertEqual(row["sources"], ["put engine", "strategies board"])
        self.assertEqual(row["alternatives"], [])


if __name__ == "__main__":
    unittest.main()
