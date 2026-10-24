"""Alignment and A262-bar checks for lab.py signal / s045 signal. No database."""
from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import lab  # noqa: E402
import s045_put_retest as puts  # noqa: E402


class AlignTests(unittest.TestCase):
    def test_join_is_per_ticker_and_uses_latest_on_or_before(self):
        tickers = np.array(["AAA", "BBB", "AAA", "BBB"])
        as_of = np.array(["2024-01-01", "2024-01-01", "2024-01-08", "2024-01-08"])
        series = {
            "AAA": [(date(2024, 1, 1), 1.0), (date(2024, 1, 8), 2.0)],
            "BBB": [(date(2024, 1, 3), 7.0)],
        }
        got = lab.align_asof(tickers, as_of, series)
        self.assertTrue(np.allclose(got, [1.0, np.nan, 2.0, 7.0], equal_nan=True))

    def test_no_lookahead_future_print_stays_off_earlier_rows(self):
        tickers = np.array(["AAA", "AAA", "AAA"])
        as_of = np.array(["2024-01-01", "2024-01-07", "2024-01-08"])
        series = {"AAA": [(date(2024, 1, 8), 5.0)]}
        got = lab.align_asof(tickers, as_of, series)
        self.assertTrue(np.isnan(got[0]) and np.isnan(got[1]))
        self.assertEqual(got[2], 5.0)
        # signal at date d is the value known on d, not the next print
        self.assertTrue(np.isnan(got[0]))

    def test_trailing_net_window_excludes_future_and_older_than_90d(self):
        tickers = np.array(["AAA", "AAA", "BBB", "CCC"])
        as_of = np.array(["2024-01-01", "2024-04-01", "2024-04-01", "2024-04-01"])
        # 2024-01-01 is 91 days before 2024-04-01, so it is outside a 90-day window.
        self.assertEqual((date(2024, 4, 1) - date(2024, 1, 1)).days, 91)
        txns = {
            "AAA": [(date(2024, 1, 1), 10.0), (date(2024, 4, 1), 3.0)],
            "BBB": [(date(2024, 1, 1), 4.0)],
        }
        got = lab.trailing_net(tickers, as_of, txns, window_days=90)
        self.assertEqual(got[0], 10.0)   # future +3 is not included
        self.assertEqual(got[1], 3.0)    # the +10 is 91 days old
        self.assertEqual(got[2], 0.0)    # covered, nothing inside the window
        self.assertTrue(np.isnan(got[3]))

    def test_week_ic_matches_spearman(self):
        rng = np.random.default_rng(1)
        score, rel = rng.normal(size=40), rng.normal(size=40)
        alpha, tech = rng.normal(size=40), rng.normal(size=40)
        met = lab.week_stock(score, rel, alpha, tech)
        manual = float(np.corrcoef(lab.rank01(score), lab.rank01(rel))[0, 1])
        self.assertAlmostEqual(met["ic"], manual, places=12)

    def test_expr_and_module_are_exclusive(self):
        panel = {"as_of": np.array(["2023-01-02"]), "f.iv_rv": np.array([1.5])}
        got = lab.call_signal(panel, "", "D['f.iv_rv'] * 2")
        self.assertEqual(got[0], 3.0)
        with self.assertRaises(SystemExit):
            lab.call_signal(panel, "x.py:f", "D['f.iv_rv']")
        with self.assertRaises(SystemExit):
            lab.call_signal(panel, "", "")

    def test_bar_runs_and_positive_signal_is_not_a_crash(self):
        rng = np.random.default_rng(2)
        n_names, n_weeks = 40, 16
        start = date(2023, 1, 2)
        tickers, as_of, rel, alpha, tech, score = [], [], [], [], [], []
        for w in range(n_weeks):
            day = (start + timedelta(days=7 * w)).isoformat()
            sig = rng.normal(size=n_names)
            for i in range(n_names):
                tickers.append(f"T{i:02d}")
                as_of.append(day)
                rel.append(0.4 * sig[i] + rng.normal())
                alpha.append(rng.normal())
                tech.append(rng.normal())
                score.append(sig[i])
        D = {
            "ticker": np.array(tickers), "as_of": np.array(as_of),
            "o.rel_21": np.array(rel), "f.alpha": np.array(alpha),
            "sm.combined_alpha_rank": np.array(alpha), "tech.ivhist": np.array(tech),
            "v2_total": np.array(tech), "v4p_total": rng.normal(size=len(tickers)),
            "v4c_total": rng.normal(size=len(tickers)),
        }
        text, stats = lab.signal_report(D, np.array(score), seed=7)
        self.assertIn("verdict ", text)
        self.assertGreater(stats["ic"]["mean"], 0)
        self.assertEqual(stats["mondays"], n_weeks)


class PutBarTests(unittest.TestCase):
    def test_q5_minus_q1_positive_when_score_is_pnl(self):
        rng = np.random.default_rng(3)
        n_names, n_weeks = 40, 12
        start = date(2023, 1, 2)
        as_of, pnl, breach, score, edge_q = [], [], [], [], []
        for w in range(n_weeks):
            day = (start + timedelta(days=7 * w)).isoformat()
            py = rng.normal(size=n_names)
            for i in range(n_names):
                as_of.append(day)
                pnl.append(py[i])
                breach.append(1.0 if py[i] < 0 else 0.0)
                score.append(py[i])
                edge_q.append(float((i % 5) + 1))
        E = {
            "as_of": np.array(as_of), "pnl": np.array(pnl), "breach": np.array(breach),
            "put_edge_q": np.array(edge_q),
        }
        text = puts.put_signal_report(E, np.array(score), seed=7)
        self.assertIn("verdict ", text)
        self.assertIn("Q5−Q1 pnl bp", text)
        # High score is high pnl, so the top quintile earns more.
        line = next(ln for ln in text.splitlines() if ln.startswith("| Q5−Q1 pnl bp"))
        self.assertTrue(line.split("|")[2].strip().startswith("+"))


if __name__ == "__main__":
    unittest.main()
