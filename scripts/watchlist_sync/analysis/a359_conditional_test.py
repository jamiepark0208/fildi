#!/usr/bin/env python3
"""A359 unit tests — conditional engine invariants."""
from __future__ import annotations

import sys
import unittest
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from conditional_engine import (  # noqa: E402
    ConditionSet,
    ExitRules,
    IndicatorCondition,
    OpenPut,
    PutInstrument,
    SpreadCalibration,
    aggregate_trades,
    daily_entry_cross_mask,
    entry_cross_mask,
    iv_intraday_path,
    nearest_listed_strike,
    prior_business_iv,
    rsi_series,
    simulate_session_puts,
    standard_listed_strikes,
)


class TestEntryCross(unittest.TestCase):
    def test_one_fire_per_edge(self) -> None:
        closes = np.linspace(100, 80, 30)
        entry = ConditionSet("or", [IndicatorCondition("rsi14", "lt", 25.0, "5m")])
        cross = entry_cross_mask(entry, closes)
        idx = np.where(cross)[0]
        self.assertEqual(len(idx), 1)
        for i in range(1, len(idx)):
            self.assertGreater(idx[i], idx[i - 1])


class TestNearestStrike(unittest.TestCase):
    def test_abs_nearest(self) -> None:
        listed = [90.0, 95.0, 100.0, 105.0]
        self.assertAlmostEqual(nearest_listed_strike(99.2, listed), 100.0)
        self.assertAlmostEqual(nearest_listed_strike(92.6, listed), 95.0)


class TestRsiWarmup(unittest.TestCase):
    def test_nan_before_n_bars(self) -> None:
        closes = 100 + np.sin(np.linspace(0, 4, 40))
        r = rsi_series(closes, 14)
        self.assertTrue(np.all(np.isnan(r[:13])))
        self.assertGreater(np.sum(np.isfinite(r[13:])), 10)


class TestIvBetaSign(unittest.TestCase):
    def test_iv_rises_when_spot_falls(self) -> None:
        iv0 = iv_intraday_path(30.0, 100.0, 99.0, -2.0)
        self.assertGreater(iv0, 30.0)


class TestLookAhead(unittest.TestCase):
    def test_fill_after_signal(self) -> None:
        bars = pd.DataFrame({
            "o": [100, 99, 98, 99, 100, 101],
            "h": [100, 99, 98, 99, 100, 101],
            "l": [100, 99, 98, 99, 100, 101],
            "c": [100, 99, 98, 99, 100, 101],
            "session_date": [date(2025, 6, 2)] * 6,
        })
        exits = ExitRules(time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=1,
        )
        self.assertEqual(len(tr), 1)
        self.assertGreater(tr[0]["fill_bar"], tr[0]["signal_bar"])


class TestFillOpenNotClose(unittest.TestCase):
    def test_entry_uses_next_open(self) -> None:
        bars = pd.DataFrame({
            "o": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "h": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "l": [100.0, 88.0, 98.0, 99.0, 100.0, 101.0],
            "c": [100.0, 100.0, 98.0, 99.0, 100.0, 101.0],
            "session_date": [date(2025, 6, 4)] * 6,
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(6, dtype=bool), ExitRules(time_stop="same_day"),
            iv_anchor=25.0, iv_beta=-2.0, instrument=PutInstrument(), spread=sp,
            force_entry_bar=0,
        )
        self.assertEqual(tr[0]["fill_bar"], 1)
        self.assertAlmostEqual(tr[0]["spot_entry"], 88.0)


class TestFirstHitExit(unittest.TestCase):
    def test_tp_beats_later_rules(self) -> None:
        bars = pd.DataFrame({
            "o": [100.0, 100.0, 108.0, 108.0, 108.0],
            "h": [100.0, 100.0, 108.0, 108.0, 108.0],
            "l": [100.0, 100.0, 108.0, 108.0, 108.0],
            "c": [100.0, 100.0, 108.0, 108.0, 108.0],
            "session_date": [date(2025, 6, 3)] * 5,
        })
        exits = ExitRules(take_profit_frac=0.01, stop_loss_mult=50.0, time_stop="same_day")
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars, np.zeros(5, dtype=bool), exits, iv_anchor=40.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertEqual(tr[0]["exit_reason"], "take_profit")


class TestNoSameDayEodIv(unittest.TestCase):
    def test_prior_iv_anchor_not_same_day(self) -> None:
        session = date(2025, 6, 10)
        iv_by_date = {
            session - timedelta(days=1): 22.0,
            session: 99.0,  # same-day EOD must not be used intraday
        }
        anchor = prior_business_iv(iv_by_date, session)
        self.assertEqual(anchor, 22.0)
        self.assertNotEqual(anchor, 99.0)

    def test_simulation_uses_iv_anchor_not_session_eod(self) -> None:
        """Trade record iv_anchor must not equal same-day EOD when only prior exists."""
        session = date(2025, 6, 10)
        bars = pd.DataFrame({
            "o": [100.0, 100.0, 100.0, 101.0, 101.0],
            "c": [100.0, 99.0, 98.0, 99.0, 100.0],
            "session_date": [session] * 5,
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        tr, _ = simulate_session_puts(
            bars,
            np.array([False, True, False, False, False]),
            ExitRules(close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)], time_stop="same_day"),
            iv_anchor=25.0,
            iv_beta=-2.0,
            instrument=PutInstrument(),
            spread=sp,
        )
        self.assertTrue(tr)
        self.assertEqual(tr[0]["iv_anchor"], 25.0)
        self.assertNotEqual(tr[0]["iv_anchor"], 99.0)


class TestDailyIndexEntry(unittest.TestCase):
    def test_one_cross_per_event(self) -> None:
        rsi = np.array([50.0, 40.0, 24.0, 22.0, 30.0, 24.0, 35.0])
        cross = daily_entry_cross_mask(rsi, 25.0)
        self.assertEqual(cross.sum(), 2)
        self.assertTrue(cross[2])
        self.assertTrue(cross[5])

    def test_fill_day_after_signal(self) -> None:
        rsi = np.array([60.0, 50.0, 24.0, 28.0, 40.0])
        cross = daily_entry_cross_mask(rsi, 25.0)
        sig = int(np.where(cross)[0][0])
        fill = sig + 1
        self.assertEqual(sig, 2)
        self.assertEqual(fill, 3)


class TestSpreadLiquidity(unittest.TestCase):
    def test_high_oi_ticker_uses_high_liq_spread(self) -> None:
        buckets = {
            ("near_otm", "short", "low"): 0.72,
            ("near_otm", "short", "high"): 0.06,
            ("near_otm", "short", "mid"): 0.18,
        }
        sp = SpreadCalibration(
            buckets=buckets,
            n_obs=3,
            source="test",
            ticker_liq_bin={"SPY": "high", "ILLIQ": "low"},
        )
        rt_spy = sp.round_trip_frac(100.0, 95.0, 7, ticker="SPY")
        rt_illiq = sp.round_trip_frac(100.0, 95.0, 7, ticker="ILLIQ")
        rt_unknown = sp.round_trip_frac(100.0, 95.0, 7, ticker="", volume=0, open_interest=0)
        self.assertAlmostEqual(rt_spy, 0.06)
        self.assertAlmostEqual(rt_illiq, 0.72)
        self.assertGreater(rt_illiq, rt_spy)
        self.assertAlmostEqual(rt_unknown, 0.18)  # default mid, not vol=0 → low

    def test_deep_otm_neighbour_scaled_wider(self) -> None:
        sp = SpreadCalibration(
            buckets={},
            n_obs=0,
            source="test",
            ticker_buckets={("SPY", "near_otm", "mid"): 0.04},
            ticker_median_mid={("SPY", "near_otm", "mid"): 2.0},
        )
        rt = sp.round_trip_frac(500.0, 420.0, 30, ticker="SPY", mid=0.4)
        self.assertGreater(rt, 0.15)


class TestClusterEff(unittest.TestCase):
    def test_n_eff_distinct_clusters(self) -> None:
        trades = [
            {"session": "2025-06-01", "ticker": "AAPL", "pnl_coll_frac": 0.01, "pnl_coll_frac_cross": 0.01, "win": True, "exit_reason": "tp"},
        ] * 10
        stats = aggregate_trades(trades, {"AAPL": "TECH"})
        self.assertEqual(stats["n"], 10)
        self.assertAlmostEqual(stats["n_eff"], 1.0)


class TestCloseConditionExit(unittest.TestCase):
    def test_rsi_close_exit_fires(self) -> None:
        warmup = np.linspace(100, 70, 20)
        session = np.array([70, 68, 66, 72, 80, 85, 90, 55])
        closes = np.concatenate([warmup, session])
        rsi = rsi_series(closes, 14)
        rsi_sess = rsi[-len(session) :]
        bars = pd.DataFrame({
            "o": session.astype(float),
            "h": session.astype(float) + 1,
            "l": session.astype(float) - 1,
            "c": session.astype(float),
            "session_date": [date(2025, 6, 5)] * len(session),
        })
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(
            close_conditions=[IndicatorCondition("rsi14", "gt", 50.0)],
            take_profit_frac=5.0,
            stop_loss_mult=50.0,
            time_stop="same_day",
        )
        tr, _ = simulate_session_puts(
            bars, np.zeros(len(session), dtype=bool), exits,
            iv_anchor=25.0, iv_beta=-2.0, instrument=PutInstrument(), spread=sp,
            force_entry_bar=0, rsi14=rsi_sess,
        )
        self.assertEqual(tr[0]["exit_reason"], "close_condition")


class TestOvernightCloses(unittest.TestCase):
    """Claude 11-07: tp50_overnight must close next session if TP not hit (was: carried until TP, past expiry)."""
    def test_loser_closes_next_session(self) -> None:
        d1, d2 = date(2025, 6, 2), date(2025, 6, 3)
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(take_profit_frac=0.50, time_stop="overnight")
        day1 = pd.DataFrame({
            "o": [100.0] * 4, "h": [100.0] * 4, "l": [100.0] * 4,
            "c": [100.0, 100.0, 99.0, 98.0], "session_date": [d1] * 4,
        })
        tr, carry = simulate_session_puts(
            day1, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertEqual(tr, [])
        self.assertIsNotNone(carry)
        day2 = pd.DataFrame({
            "o": [90.0] * 4, "h": [92.0] * 4, "l": [89.0] * 4,
            "c": [90.0, 91.0, 99.0, 104.0], "session_date": [d2] * 4,
        })
        tr2, carry2 = simulate_session_puts(
            day2, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, carry=carry,
        )
        self.assertIsNone(carry2)
        self.assertEqual(len(tr2), 1)
        self.assertEqual(tr2[0]["exit_reason"], "time_stop")
        self.assertLess(tr2[0]["pnl_frac"], 0)
        self.assertEqual(tr2[0]["exit_bar"], 0)


class TestCarriedStopBarZero(unittest.TestCase):
    def test_gap_stop_at_open_bar0(self) -> None:
        d1, d2 = date(2025, 6, 2), date(2025, 6, 3)
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(stop_loss_mult=0.1, time_stop="overnight")
        day1 = pd.DataFrame({
            "o": [100.0] * 4, "h": [100.0] * 4, "l": [100.0] * 4,
            "c": [100.0, 100.0, 100.0, 100.0], "session_date": [d1] * 4,
        })
        _, carry = simulate_session_puts(
            day1, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        self.assertIsNotNone(carry)
        day2 = pd.DataFrame({
            "o": [70.0, 71.0, 72.0, 73.0], "h": [71.0, 72.0, 73.0, 74.0],
            "l": [69.0, 70.0, 71.0, 72.0], "c": [70.5, 71.5, 72.5, 73.5],
            "session_date": [d2] * 4,
        })
        tr2, _ = simulate_session_puts(
            day2, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, carry=carry,
        )
        self.assertTrue(tr2)
        self.assertEqual(tr2[0]["exit_bar"], 0)
        self.assertEqual(tr2[0]["exit_reason"], "stop_loss")

    def test_intraday_bar0_low_does_not_lookahead_fill_at_open0(self) -> None:
        """A374 H2: flat open (100) + plunge inside bar 0 (low 65) cannot fill at open[0]=100."""
        d1, d2 = date(2025, 6, 2), date(2025, 6, 3)
        sp = SpreadCalibration(buckets={}, n_obs=0, source="test")
        exits = ExitRules(stop_loss_mult=0.5, time_stop="expiry")
        day1 = pd.DataFrame({
            "o": [100.0] * 4, "h": [100.0] * 4, "l": [100.0] * 4,
            "c": [100.0] * 4, "session_date": [d1] * 4,
        })
        _, carry = simulate_session_puts(
            day1, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, force_entry_bar=0,
        )
        day2 = pd.DataFrame({
            "o": [100.0, 66.0, 66.0, 66.0],
            "h": [100.0, 67.0, 67.0, 67.0],
            "l": [65.0, 65.0, 65.0, 65.0],
            "c": [66.0, 66.0, 66.0, 66.0],
            "session_date": [d2] * 4,
        })
        tr2, _ = simulate_session_puts(
            day2, np.zeros(4, dtype=bool), exits, iv_anchor=25.0, iv_beta=-2.0,
            instrument=PutInstrument(), spread=sp, carry=carry,
        )
        self.assertTrue(tr2)
        self.assertEqual(tr2[0]["exit_reason"], "stop_loss")
        self.assertEqual(tr2[0]["exit_bar"], 1)  # fills at bar-1 open (66), NOT bar-0 open (100)


class TestA374A375EngineFixes(unittest.TestCase):
    def test_session_filter_preserves_rsi_alignment(self) -> None:
        """A374 H1: session_filter must slice RSI to matching dates, not read session-0 RSI."""
        from conditional_engine import ConditionalContext, _intraday_rsi_by_session, run_conditional_strategy

        d1, d2 = date(2025, 9, 29), date(2025, 10, 2)
        # Session 1 crashes into RSI < 20; Session 2 starts already high and rallies steadily (RSI > 70 on every bar).
        s1 = np.linspace(100.0, 75.0, 25)
        s2 = np.linspace(95.0, 120.0, 25)
        df = pd.DataFrame({
            "ts": pd.date_range("2025-09-29 13:30", periods=25, freq="5min", tz="UTC").tolist()
            + pd.date_range("2025-10-02 13:30", periods=25, freq="5min", tz="UTC").tolist(),
            "o": np.concatenate([s1, s2]),
            "h": np.concatenate([s1, s2]) + 0.2,
            "l": np.concatenate([s1, s2]) - 0.2,
            "c": np.concatenate([s1, s2]),
            "session_date": [d1] * 25 + [d2] * 25,
        })
        df_s, rsi_full = _intraday_rsi_by_session(df)
        ctx = ConditionalContext(
            bars_map={"TEST": df_s},
            sectors={"TEST": "TECH"},
            spread=SpreadCalibration(buckets={}, n_obs=0, source="test"),
            betas={"TEST": -2.0},
            iv_maps={"TEST": {date(2025, 9, 26): 30.0, d1: 30.0}},
            default_beta=-2.0,
            rsi_by_ticker={"TEST": rsi_full},
            bar_tf="5m",
            bar_minutes=5,
        )
        entry = ConditionSet("and", [IndicatorCondition("rsi14", "lt", 30.0, "5m")])
        res = run_conditional_strategy(
            ["TEST"], entry, ExitRules(time_stop="same_day"), PutInstrument(),
            session_filter=lambda d: d >= date(2025, 10, 1), ctx=ctx, bar_tf="5m", keep_trades=True,
        )
        # Before fix: d2 read d1's crashing RSI and fired a false trade on d2!
        self.assertEqual(res["conditional"]["n"], 0)

    def test_higher_tf_bar_end_no_lookahead_and_ticker_deep_otm_priority(self) -> None:
        """A375 H3 + M1: forming 1h bar cannot leak into 09:35 entry; ticker deep_otm beats global."""
        from conditional_engine import _align_higher_tf_entry_mask, _scalp_exits, _swing_exits

        df_en = pd.DataFrame({"ts": pd.to_datetime(["2025-10-02T13:35:00Z", "2025-10-02T14:35:00Z"])})
        df_hi = pd.DataFrame({
            "ts": pd.to_datetime(["2025-10-02T13:30:00Z", "2025-10-02T14:30:00Z"]),
            "c": [110.0, 90.0],
        })
        filt = ConditionSet("and", [IndicatorCondition("rsi14", "gt", 50.0, "1h")])
        aligned = _align_higher_tf_entry_mask(
            np.array([True, True]), df_en, df_hi, filt,
            rsi_hi={14: np.array([65.0, 35.0])}, hi_bar_minutes=60,
        )
        # 13:35 entry occurs BEFORE 13:30–14:30 1h bar closes -> False; 14:35 sees completed 13:30–14:30 bar (RSI 65) -> True
        self.assertEqual(aligned.tolist(), [False, True])

        # M1: ticker-specific deep_otm bucket beats global deep_otm bucket
        sp = SpreadCalibration(
            buckets={("deep_otm", "mid", "high"): 0.25},
            n_obs=50,
            source="test",
            ticker_liq_bin={"SPY": "high"},
            ticker_buckets={("SPY", "deep_otm", "mid"): 0.08},
        )
        self.assertAlmostEqual(sp.round_trip_frac(500.0, 420.0, 30, ticker="SPY"), 0.08)

        # M4: max_bars scales by timeframe
        self.assertEqual(dict(_scalp_exits(2))["tstop30m"].max_bars, 15)
        self.assertEqual(dict(_swing_exits(60))["tstop_5d"].max_bars, 32)
        self.assertEqual(dict(_swing_exits(390))["tstop_5d"].max_bars, 5)

    def test_unadjusted_split_no_fake_rsi_or_put_crash(self) -> None:
        """B26 + Claude #2/#3: confirmed 3:1 split (SOXX 465 -> 155 with adj_closes 155 -> 156) adjusts cleanly,
        while a real -50% crash (adj_closes 100 -> 50) is NEVER erased as a 2:1 split."""
        from conditional_engine import _intraday_rsi_by_session, _run_ticker_sessions, detect_session_split_mults

        d1, d2 = date(2026, 11, 3), date(2026, 11, 4)
        s1 = np.linspace(450.0, 465.0, 20)
        s2 = np.linspace(155.0, 156.0, 20)
        df = pd.DataFrame({
            "ts": pd.date_range("2026-11-03 14:30", periods=20, freq="5min", tz="UTC").tolist()
            + pd.date_range("2026-11-04 14:30", periods=20, freq="5min", tz="UTC").tolist(),
            "o": np.concatenate([s1, s2]),
            "h": np.concatenate([s1, s2]) + 0.3,
            "l": np.concatenate([s1, s2]) - 0.3,
            "c": np.concatenate([s1, s2]),
            "session_date": [d1] * 20 + [d2] * 20,
        })
        mults = detect_session_split_mults(df, adj_closes={d1: 155.0, d2: 156.0})
        self.assertAlmostEqual(mults[d2], 1 / 3)
        _, rsi_map = _intraday_rsi_by_session(df, split_mults=mults)
        self.assertTrue(np.all(rsi_map[14][20:] > 60.0))

        entry_any = ConditionSet("and", [IndicatorCondition("rsi14", "gt", 50.0, "5m")])
        ct, _ = _run_ticker_sessions(
            "SOXX", df, entry_any, ExitRules(time_stop="overnight"), PutInstrument(target_delta=-0.15),
            {date(2026, 10, 31): 28.0, d1: 28.0}, -2.0, SpreadCalibration(buckets={}, n_obs=0, source="test"),
            base_every_day=False, split_mults=mults,
        )
        self.assertEqual(len(ct), 1)
        self.assertGreater(ct[0]["pnl_frac"], 0.0)

        # Counterexample (Claude #2): a REAL -50% crash (adj_closes 100 -> 50) must NOT be treated as a 2:1 split!
        c1 = np.linspace(98.0, 100.0, 20)
        c2 = np.linspace(50.0, 49.0, 20)
        df_crash = df.copy()
        df_crash["o"] = np.concatenate([c1, c2])
        df_crash["h"] = np.concatenate([c1, c2]) + 0.2
        df_crash["l"] = np.concatenate([c1, c2]) - 0.2
        df_crash["c"] = np.concatenate([c1, c2])
        crash_mults = detect_session_split_mults(df_crash, adj_closes={d1: 100.0, d2: 49.0})
        self.assertEqual(crash_mults, {})
        ct_crash, _ = _run_ticker_sessions(
            "CRASH", df_crash, entry_any, ExitRules(time_stop="overnight"), PutInstrument(target_delta=-0.15),
            {date(2026, 10, 31): 35.0, d1: 35.0}, -2.0, SpreadCalibration(buckets={}, n_obs=0, source="test"),
            base_every_day=False, split_mults=crash_mults,
        )
        self.assertEqual(len(ct_crash), 1)
        self.assertLess(ct_crash[0]["pnl_frac"], -2.0)  # real crash loss preserved!

    def test_1h_closing_half_bar_available_at_1600_not_1630(self) -> None:
        """B27: 15:30–16:00 ET 1h RTH bar closes at 16:00 ET (21:00 UTC in EST), not 16:30 ET."""
        from conditional_engine import _align_higher_tf_entry_mask

        # Nov 3, 2026 (EST = UTC-5): 15:30 ET = 20:30 UTC; next day 09:30 ET = 14:30 UTC; same day 16:00 = 21:00 UTC
        df_hi = pd.DataFrame({
            "ts": pd.to_datetime(["2026-11-03T19:30:00Z", "2026-11-03T20:30:00Z"]),  # 14:30 ET, 15:30 ET
            "c": [100.0, 105.0],
        })
        df_en = pd.DataFrame({
            "ts": pd.to_datetime(["2026-11-03T20:50:00Z", "2026-11-04T14:30:00Z"]),  # 15:50 ET (inside 15:30 bar), next 09:30 ET
        })
        filt = ConditionSet("and", [IndicatorCondition("rsi14", "gt", 50.0, "1h")])
        # 14:30 bar has RSI=30 (False); 15:30 bar has RSI=65 (True).
        # At 15:50 ET, 15:30 bar hasn't closed -> sees 14:30 bar (False). At next open, sees 15:30 bar (True).
        aligned = _align_higher_tf_entry_mask(
            np.array([True, True]), df_en, df_hi, filt,
            rsi_hi={14: np.array([30.0, 65.0])}, hi_bar_minutes=60,
        )
        self.assertEqual(aligned.tolist(), [False, True])

    def test_multi_week_data_hole_resets_rsi_warmup(self) -> None:
        """B29: >7-day missing-data hole (e.g. W 214d gap 45 -> 82) resets RSI warm-up instead of diffing across 7 months."""
        from conditional_engine import _intraday_rsi_by_session

        d1, d2 = date(2025, 3, 10), date(2025, 10, 17)
        s1 = np.linspace(46.0, 45.0, 20)
        s2 = np.linspace(82.0, 81.5, 20)
        df = pd.DataFrame({
            "ts": pd.date_range("2025-03-10 13:30", periods=20, freq="5min", tz="UTC").tolist()
            + pd.date_range("2025-10-17 13:30", periods=20, freq="5min", tz="UTC").tolist(),
            "o": np.concatenate([s1, s2]),
            "h": np.concatenate([s1, s2]) + 0.1,
            "l": np.concatenate([s1, s2]) - 0.1,
            "c": np.concatenate([s1, s2]),
            "session_date": [d1] * 20 + [d2] * 20,
        })
        _, rsi_map = _intraday_rsi_by_session(df)
        # First 13 bars of d2 after 221-day hole must be NaN warm-up, NOT RSI ~99 from 45->82 jump!
        self.assertTrue(np.all(np.isnan(rsi_map[14][20:33])))
        self.assertLess(rsi_map[14][35], 20.0)  # s2 gently declines 82 -> 81.5, so post-warmup RSI is low, not 99!

    def test_a406_higher_tf_ema_split_and_a370_rsi_boundary(self) -> None:
        """A406: (1) higher-TF EMA20 across a 3:1 split stays True (uptrend) when split_mults threaded;
        (2) a370 indicators() handles pure-rally (RSI=100, rsi_hi=True) and flat (RSI=50) without NaN."""
        from a370_matched_delta import indicators as a370_indicators
        from conditional_engine import _align_higher_tf_entry_mask

        d1, d2 = date(2026, 11, 3), date(2026, 11, 4)
        # 25 × 1h bars: 20 pre-split gently rising 450 -> 465, then 3:1 split overnight -> 5 bars rising 155 -> 158.
        c_pre = np.linspace(450.0, 465.0, 20)
        c_post = np.linspace(155.0, 158.0, 5)
        ts_hi = (
            pd.date_range("2026-10-28 13:30", periods=20, freq="60min", tz="UTC").tolist()
            + pd.date_range("2026-11-04 14:30", periods=5, freq="60min", tz="UTC").tolist()
        )
        df_hi = pd.DataFrame({
            "ts": ts_hi,
            "c": np.concatenate([c_pre, c_post]),
            "session_date": [d1] * 20 + [d2] * 5,
        })
        df_en = pd.DataFrame({"ts": [pd.Timestamp("2026-11-04T19:35:00Z")]})  # after 4th post-split 1h bar closes
        filt = ConditionSet("and", [IndicatorCondition("close_above_ema20", "gt", 0.0, "1h")])
        # Without split_mults (old bug): EMA20 sits ~380 while c=158 -> False! With split_mults={d2: 1/3}: EMA20 ~153 < 158 -> True!
        with_split = _align_higher_tf_entry_mask(
            np.array([True]), df_en, df_hi, filt,
            rsi_hi={14: np.full(25, 60.0)}, hi_bar_minutes=60, split_mults={d2: 1 / 3},
        )
        self.assertEqual(with_split.tolist(), [True])

        # (2) a370 pure rally -> RSI 100 & rsi_hi True; flat -> RSI 50
        rally_df = pd.DataFrame({"c": np.linspace(100.0, 150.0, 220), "h": np.linspace(100.5, 150.5, 220), "l": np.linspace(99.5, 149.5, 220), "v": np.ones(220) * 1000.0})
        out_r = a370_indicators(rally_df)
        self.assertTrue(bool(out_r["rsi_hi"].iloc[-1]))
        self.assertFalse(bool(out_r["rsi_lo"].iloc[-1]))

        flat_df = pd.DataFrame({"c": np.ones(220) * 100.0, "h": np.ones(220) * 100.0, "l": np.ones(220) * 100.0, "v": np.ones(220) * 1000.0})
        out_f = a370_indicators(flat_df)
        self.assertFalse(bool(out_f["rsi_hi"].iloc[-1]))
        self.assertFalse(bool(out_f["rsi_lo"].iloc[-1]))


if __name__ == "__main__":
    unittest.main()
