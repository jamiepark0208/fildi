"""A129 / A258: forecast ledger helpers + resolve isolation.
Run: .venv/bin/python -m unittest tests.test_forecast_ledger"""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from forecast_ledger import (  # noqa: E402
    _meta_dict, brier, put_otm, reliability, resolve, week_friday, weekly_up_rate,
)


class ForecastLedger(unittest.TestCase):
    def test_brier(self):
        self.assertIsNone(brier([]))
        self.assertAlmostEqual(brier([(1.0, True), (0.0, False)]), 0.0)
        self.assertAlmostEqual(brier([(0.8, True), (0.8, False)]), (0.04 + 0.64) / 2)
        self.assertAlmostEqual(brier([(0.5, True)] * 3), 0.25)

    def test_put_otm_rule_matches_scoreboard(self):
        self.assertTrue(put_otm(10.0, 10.0))   # at strike = not assigned (scoreboard: close < strike = assigned)
        self.assertTrue(put_otm(10.5, 10.0))
        self.assertFalse(put_otm(9.99, 10.0))

    def test_week_friday(self):
        self.assertEqual(week_friday(dt.date(2026, 10, 12)), dt.date(2026, 10, 16))  # Mon
        self.assertEqual(week_friday(dt.date(2026, 10, 16)), dt.date(2026, 10, 16))  # Fri
        self.assertEqual(week_friday(dt.date(2026, 10, 17)), dt.date(2026, 10, 23))  # Sat → next week

    def test_weekly_up_rate_uses_last_close_of_week(self):
        d = dt.date(2026, 9, 7)  # Monday
        closes = [(d, 100), (d + dt.timedelta(4), 101),            # wk1 ends 101
                  (d + dt.timedelta(7), 99), (d + dt.timedelta(11), 103),   # wk2 ends 103 (up)
                  (d + dt.timedelta(14), 104), (d + dt.timedelta(18), 102)]  # wk3 ends 102 (down)
        self.assertEqual(weekly_up_rate(closes), (0.5, 2))
        self.assertEqual(weekly_up_rate([]), (0.5, 0))

    def test_reliability_bins(self):
        b = reliability([(0.9, True), (0.95, False), (0.1, False), (1.0, True)])
        self.assertEqual([x["n"] for x in b], [1, 3])
        self.assertAlmostEqual(b[1]["real"], 2 / 3)

    def test_meta_dict(self):
        self.assertEqual(_meta_dict(None), {})
        self.assertEqual(_meta_dict('{"strike": 10}'), {"strike": 10})
        self.assertEqual(_meta_dict({"strike": 10}), {"strike": 10})


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class FakeConn:
    """Minimal conn for A258 resolve isolation — tracks UPDATEs + SAVEPOINT hygiene."""

    def __init__(self, open_rows):
        self.open_rows = open_rows
        self.updates = []  # (sql, params)
        self.ops = []
        self.committed = False
        self._sp_dead = set()

    def execute(self, sql, params=None):
        s = " ".join(sql.split()).upper()
        if s.startswith("SELECT DISTINCT QUESTION_ID"):
            return FakeResult(self.open_rows)
        if s.startswith("SAVEPOINT "):
            name = sql.split()[1]
            self.ops.append(("sp", name))
            self._sp_dead.discard(name)
            return FakeResult([])
        if s.startswith("RELEASE SAVEPOINT "):
            name = sql.split()[2]
            self.ops.append(("rel", name))
            return FakeResult([])
        if s.startswith("ROLLBACK TO SAVEPOINT "):
            name = sql.split()[3]
            self.ops.append(("rb", name))
            self._sp_dead.add(name)
            return FakeResult([])
        if s.startswith("UPDATE"):
            # After ROLLBACK TO, only the park-error UPDATE should land (outside dead SP).
            self.updates.append((sql, params))
            return FakeResult([])
        raise AssertionError(f"unexpected SQL: {sql}")

    def commit(self):
        self.committed = True


class ResolveIsolation(unittest.TestCase):
    def test_corrupt_meta_does_not_block_siblings(self):
        d = dt.date(2026, 10, 1)
        open_rows = [
            ("q-good-a", "put_otm", "AAA", d, {"strike": 100}),
            ("q-bad", "put_otm", "BBB", d, {}),  # missing strike → KeyError
            ("q-good-b", "put_otm", "CCC", d, {"strike": 50}),
        ]
        conn = FakeConn(open_rows)
        closes = {
            "AAA": (110.0, "lseg", d),
            "BBB": (90.0, "lseg", d),
            "CCC": (55.0, "lseg", d),
        }

        def fake_close(conn_, t, day):
            return closes.get(t)

        with mock.patch("forecast_ledger._close_on_or_before", side_effect=fake_close):
            with mock.patch("forecast_ledger.EXTRA_RESOLVERS", {}):
                n = resolve(conn, now=dt.datetime(2026, 10, 3, 12, 0, tzinfo=dt.timezone.utc))

        self.assertEqual(n, 2)
        self.assertTrue(conn.committed)
        outcomes = [p for _, p in conn.updates if p and len(p) >= 3 and p[0] in (True, False)]
        parks = [p for sql, p in conn.updates if "resolve_error" in str(p)]
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(len(parks), 1)
        self.assertIn("q-bad", parks[0][1])
        # Rerun: parked bad row skipped; good rows already have outcome so open_rows shrinks.
        conn2 = FakeConn([("q-bad", "put_otm", "BBB", d, {"resolve_error": "KeyError: strike"})])
        with mock.patch("forecast_ledger._close_on_or_before", side_effect=fake_close):
            with mock.patch("forecast_ledger.EXTRA_RESOLVERS", {}):
                n2 = resolve(conn2, now=dt.datetime(2026, 10, 3, 12, 0, tzinfo=dt.timezone.utc))
        self.assertEqual(n2, 0)
        self.assertEqual(conn2.updates, [])  # no re-raise, no re-park


if __name__ == "__main__":
    unittest.main()
