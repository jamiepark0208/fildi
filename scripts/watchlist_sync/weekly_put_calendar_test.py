"""Invented prices only; no database/network calls or calibration writes."""
import json
import math
import sys
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent / 'analysis'))
import rules
import put_edge
import s045_put_retest as S
import s059_option_factors as S059
from weekly_put_calendar import HORIZON_VERSION, weekly_sessions, _historical_holidays

CASES = [(date(2026, 10, 19), date(2026, 10, 23), 4),
         (date(2026, 9, 8), date(2026, 9, 11), 3),
         (date(2026, 3, 30), date(2026, 4, 2), 3)]


class Connection:
    def __init__(self, quote):
        self.quote, self.writes, self.reads = quote, [], []
    def execute(self, sql, args):
        if sql.lstrip().startswith('SELECT'):
            self.reads.append((sql, args))
        else:
            self.writes.append(args)
        return self
    def fetchone(self):
        return self.quote


class PersistCursor:
    def __init__(self, conn):
        self.conn = conn
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False
    def executemany(self, sql, seq):
        self.conn.sql, self.conn.rows = sql, list(seq)


class PersistConnection:
    """put_edge.persist writes its DDL on the connection and the rows through a cursor."""
    def __init__(self):
        self.sql, self.rows = '', []
    def execute(self, sql, args=None):
        return self
    def cursor(self):
        return PersistCursor(self)


def fixture(entry, expiry):
    days = [entry - timedelta(days=n) for n in range(200, 0, -1)]
    days = [d for d in days if d.weekday() < 5]
    days += list(weekly_sessions(entry))
    days += [expiry + timedelta(days=4)]  # Poison later bar must never be expiry.
    bars = [(d, 101., 99., 100. if d <= expiry else 1., 1000.) for d in days]
    return [('TEST', entry, {'iv30': 30., 'iv_rv': 1.2})], {}, {}, {'TEST': bars}


class WeeklyPutTests(unittest.TestCase):
    def test_week_windows_and_first_session(self):
        for entry, expiry, hold in CASES:
            with self.subTest(entry=entry):
                days = weekly_sessions(entry)
                self.assertEqual((days[0], days[-1], len(days)-1), (entry, expiry, hold))
        self.assertEqual(weekly_sessions(date(2019, 6, 3)), ())
        self.assertEqual(weekly_sessions(date(2028, 6, 5)), ())

    def test_historical_closures_and_known_calendar_parity(self):
        self.assertIn(date(2021, 12, 31), weekly_sessions(date(2021, 12, 27)))
        self.assertIn(date(2021, 6, 18), weekly_sessions(date(2021, 6, 14)))
        self.assertNotIn(date(2022, 6, 20), weekly_sessions(date(2022, 6, 20)))
        self.assertNotIn(date(2025, 1, 9), weekly_sessions(date(2025, 1, 6)))
        self.assertNotIn(date(2024, 3, 29), weekly_sessions(date(2024, 3, 25)))
        for year in (2026, 2027):
            computed = {d.isoformat() for d in _historical_holidays(year) if d.weekday() < 5}
            self.assertEqual(computed, {d for d in rules.HOLIDAYS if d.startswith(str(year))})

    def test_live_exact_quote_horizon_and_close_gate(self):
        for entry, expiry, hold in CASES:
            with self.subTest(entry=entry):
                conn = Connection((entry, 100., 30.))
                now = datetime.combine(entry, datetime.min.time(), rules.ET).replace(hour=17)
                self.assertEqual(put_edge.log_sim(conn, {'TEST': {'quintile': 5, 'breach': .1}}, now), 2)
                metadata = json.loads(conn.writes[0][-1])
                self.assertEqual(conn.writes[0][-2], expiry)
                self.assertEqual(metadata['hold_sessions'], hold)
                self.assertEqual(metadata['strike'], round(100*math.exp(-.3*math.sqrt(hold/252)), 2))
                self.assertFalse(metadata['horizon_revalidated'])
                self.assertEqual(conn.reads[0][1], ('TEST', entry))
                self.assertIn('date = %s', conn.reads[0][0])
                self.assertEqual(put_edge.log_sim(Connection((entry,100.,30.)), {'TEST': {}}, now.replace(hour=10)), 0)

    def test_live_rejects_stale_and_nonentry_day(self):
        entry = CASES[0][0]
        now = datetime(2026, 10, 19, 17, tzinfo=rules.ET)
        conn = Connection((entry-timedelta(days=3), 100., 30.))
        self.assertEqual(put_edge.log_sim(conn, {'TEST': {'quintile':5,'breach':.1}}, now), 0)
        self.assertEqual(conn.writes, [])
        self.assertEqual(put_edge.log_sim(conn, {'TEST': {}}, now+timedelta(days=1)), 0)

    def test_missing_and_nonfinite_quotes_do_not_log(self):
        now = datetime(2026, 10, 19, 17, tzinfo=rules.ET)
        for quote in (None, (now.date(), float('nan'), 30.), (now.date(), 100., float('inf'))):
            conn = Connection(quote)
            self.assertEqual(put_edge.log_sim(conn, {'TEST': {'quintile': 5, 'breach': .1}}, now), 0)
            self.assertEqual(conn.writes, [])

    def test_calibration_matches_exact_live_dates_and_pricing(self):
        old_hold = S.HOLD
        for entry, expiry, hold in CASES:
            with self.subTest(entry=entry), patch.object(S, 'load', return_value=fixture(entry, expiry)), patch.object(S059, 'add_features'):
                event, = S059.aligned_events(None)
                self.assertEqual((event['d'], event['expiry'], event['hold_sessions']), (entry, expiry, hold))
                ratio = math.exp(-.3*math.sqrt(hold/252))
                expected = S.bs_put(1., ratio, .3, hold/252)/ratio
                self.assertAlmostEqual(event['pnl_mid'], expected)
                self.assertAlmostEqual(event['pnl'], expected-put_edge.fill_cost(expected))
        self.assertEqual(S.HOLD, old_hold)

    def test_missing_exact_entry_or_expiry_cannot_spill(self):
        entry, expiry, _ = CASES[2]
        for missing in (entry, expiry, entry+timedelta(days=1)):
            rows, tech, fund, px = fixture(entry, expiry)
            px['TEST'] = [b for b in px['TEST'] if b[0] != missing]
            self.assertEqual(S.build(rows, tech, fund, px, weekly_window=weekly_sessions), [])

    def test_persist_stamps_the_replay_as_of_not_today(self):
        edge = {'TEST': {'quintile': 5, 'pnl_bp': 22., 'breach': .1, 'iv_rv': 1.2, 'vol_of_vol': .05, 'put_tech': .3, 'pct': .9}}
        replay = PersistConnection()
        self.assertEqual(put_edge.persist(replay, edge, date(2026, 10, 20)), 1)
        self.assertNotIn('CURRENT_DATE', replay.sql)
        self.assertEqual(replay.rows[0][:2], (date(2026, 10, 20), 'TEST'))
        live = PersistConnection()
        put_edge.persist(live, edge)
        self.assertEqual(live.rows[0][0], date.today())

    def test_calibration_version_is_explicit_not_silently_promoted(self):
        self.assertFalse(put_edge.calibration_status({})['horizon_revalidated'])
        self.assertTrue(put_edge.calibration_status({'horizon_version': HORIZON_VERSION})['horizon_revalidated'])
        self.assertFalse(put_edge.calibration_status({'horizon_version': 'different'})['horizon_revalidated'])

    def test_default_s045_horizon_unchanged(self):
        entry, expiry, _ = CASES[0]
        ev, = S.build(*fixture(entry, expiry))
        self.assertEqual(ev['hold_sessions'], 5)
        self.assertGreater(ev['expiry'], expiry)


if __name__ == '__main__':
    unittest.main()
