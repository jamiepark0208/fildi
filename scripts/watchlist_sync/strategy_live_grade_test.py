"""A380 acceptance (b): a planted rule with live = 0 flags drift; n counts expiry weeks, not contracts."""
import unittest
from datetime import date, timedelta

from strategy_live_grade import grade_rule

W0 = date(2026, 1, 5)


def obs(weeks, per_week=1, val=0.0, jitter=5.0):
    return [((w, i), W0 + timedelta(weeks=w), val + (jitter if (w + i) % 2 else -jitter))
            for w in range(weeks) for i in range(per_week)]


class LiveGrade(unittest.TestCase):
    def test_planted_zero_flags_drift(self):
        g = grade_rule(obs(30), claim=77.0)
        self.assertEqual(g["flag"], "drift")
        self.assertEqual(g["n_clusters"], 30)

    def test_on_track_when_near_claim(self):
        self.assertEqual(grade_rule(obs(30, val=70.0), claim=77.0)["flag"], "on track")

    def test_many_contracts_one_week_is_underpowered(self):
        # 11-27: 33 panic puts all expiring 11-20 = one market draw
        g = grade_rule(obs(1, per_week=33), claim=4.05)
        self.assertEqual((g["flag"], g["n_clusters"], g["n_trades"]), ("underpowered", 1, 33))
        self.assertIsNone(g["ci_lo"])

    def test_zero_obs_never_green(self):
        self.assertEqual(grade_rule([], claim=77.0)["flag"], "no data")


if __name__ == "__main__":
    unittest.main()
