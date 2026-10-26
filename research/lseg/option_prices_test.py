"""Cache failures must not become missing-contract evidence. No network or database."""
import unittest
from datetime import date
from unittest.mock import Mock

import option_prices as op


class OptionCacheTests(unittest.TestCase):
    def setUp(self):
        self.conn = Mock()
        self.conn.execute.return_value.fetchone.return_value = None
        self.cur = Mock()
        self.conn.cursor.return_value.__enter__ = Mock(return_value=self.cur)
        self.conn.cursor.return_value.__exit__ = Mock(return_value=False)
        self.ld = Mock()
        self.args = (self.conn, "TEST", date(2025, 1, 17), "P", 100)

    def test_operational_errors_do_not_poison_cache(self):
        for message in ("LSEG budget guard: stop", "timeout", "401 unauthorized", "permission denied"):
            with self.subTest(message=message):
                self.ld.get_history.side_effect = RuntimeError(message)
                with self.assertRaisesRegex(RuntimeError, message):
                    op.history(self.ld, *self.args)
                self.cur.execute.assert_not_called()
                self.conn.commit.assert_not_called()

    def test_confirmed_invalid_universe_is_cached(self):
        self.ld.get_history.side_effect = RuntimeError("Universe is not found")
        self.assertIsNone(op.history(self.ld, *self.args))
        self.assertEqual(self.cur.execute.call_args.args[1][1], 0)
        self.conn.commit.assert_called_once()

    def test_cached_history_uses_no_vendor(self):
        rows = [(date(2025, 1, 6), 1, 1.2, 1.1, 1.1, 10, 30)]
        self.conn.execute.return_value.fetchone.return_value = (1, True)
        self.conn.execute.return_value.fetchall.return_value = rows
        self.assertEqual(op.history(self.ld, *self.args), rows)
        self.ld.get_history.assert_not_called()

    def test_cache_only_missing_fails_without_writes(self):
        with self.assertRaisesRegex(RuntimeError, "cache-only"):
            op.history(None, *self.args)
        self.cur.execute.assert_not_called()
        self.conn.commit.assert_not_called()

    def test_cached_miss_uses_no_vendor(self):
        self.conn.execute.return_value.fetchone.return_value = (0, True)
        self.assertIsNone(op.history(self.ld, *self.args))
        self.ld.get_history.assert_not_called()


if __name__ == "__main__":
    unittest.main()
