#!/usr/bin/env python3
"""A359 fix4 resample + deep_otm spread tests."""
from __future__ import annotations

import math
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WATCH))

from bar_resample import hand_resample_2m_segment, resample_bars  # noqa: E402
from build_plan import connect  # noqa: E402
from conditional_engine import SpreadCalibration, load_bars_5m_db  # noqa: E402


def _fixture_1m():
    from zoneinfo import ZoneInfo

    et = ZoneInfo("America/New_York")
    ts0 = datetime(2025, 10, 6, 10, 0, tzinfo=et)
    rows = []
    for i in range(6):
        p = 100 + i * 0.1
        rows.append({"ts": ts0.astimezone(timezone.utc), "o": p, "h": p + 0.05, "l": p - 0.05, "c": p, "v": 1000})
        ts0 = ts0.replace(minute=ts0.minute + 1)
    return pd.DataFrame(rows)


class TestResample(unittest.TestCase):
    def test_2m_matches_hand(self) -> None:
        df = _fixture_1m()
        out = resample_bars(df, "2m")
        self.assertEqual(len(out), 3)
        o, h, l, c, v = hand_resample_2m_segment(
            df["o"].to_numpy(), df["h"].to_numpy(), df["l"].to_numpy(), df["c"].to_numpy(), df["v"].to_numpy(),
            np.array([0, 0, 1, 1, 2, 2]),
        )
        self.assertAlmostEqual(out.iloc[0]["c"], c)

    def test_5m_vs_polygon_max_diff(self) -> None:
        tickers = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]
        with connect() as conn:
            b5 = load_bars_5m_db(conn, tickers)
        from a359_bars_1m import load_parquet_1m, fetch_range_1m  # noqa: E402

        max_diff = 0.0
        with connect() as conn:
            for tk in tickers:
                df1 = load_parquet_1m(tk)
                if df1.empty:
                    df1 = fetch_range_1m(conn, tk, date(2025, 10, 1), date(2025, 10, 8))
                if df1.empty:
                    continue
                r5 = resample_bars(df1, "5m")
                ts = pd.to_datetime(r5["ts"], utc=True)
                r5 = r5.assign(session_date=ts.dt.tz_convert("America/New_York").dt.tz_localize(None).dt.date)
                poly = b5.get(tk)
                if poly is None:
                    continue
                poly = poly[poly["session_date"] <= date(2025, 10, 8)]
                for _, row in r5.head(25).iterrows():
                    m = poly[pd.to_datetime(poly["ts"], utc=True) == pd.to_datetime(row["ts"], utc=True)]
                    if m.empty:
                        continue
                    diff = abs(float(row["c"]) - float(m["c"].iloc[0]))
                    max_diff = max(max_diff, diff)
        print(f"SANITY resample 5m max close diff (5 names × ~5d) = {max_diff:.4f}")
        self.assertLess(max_diff, 0.5, "LSE 1m→5m vs Polygon optlab — report diff; tick-match on 3 bars in smoke gate")


class TestDeepOtmSpread(unittest.TestCase):
    def test_deep_otm_scales_wider_than_neighbour(self) -> None:
        sp = SpreadCalibration(
            buckets={},
            n_obs=0,
            source="test",
            ticker_buckets={("QQQ", "near_otm", "mid"): 0.04},
            ticker_median_mid={("QQQ", "near_otm", "mid"): 2.5},
            global_median_mid={("near_otm", "mid"): 2.5},
        )
        rt_deep = sp.round_trip_frac(500, 430, 30, ticker="QQQ", mid=0.5)
        rt_near = sp.round_trip_frac(500, 485, 30, ticker="QQQ", mid=2.5)
        self.assertGreater(rt_deep, rt_near)


if __name__ == "__main__":
    raise SystemExit(unittest.main())
