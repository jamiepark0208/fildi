"""quantcore invariants (Jamie 11-15). Run: .venv/bin/python -m pytest -q tests/test_quantcore.py"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import indicators as legacy  # noqa: E402
from quantcore import bars, bs, causal, ta  # noqa: E402


def _walk(n=600, seed=1, nan_at=(50, 51, 300)):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, n)))
    for i in nan_at:
        c[i] = np.nan
    return c


def test_rsi_matches_tradingview_reference():
    c = _walk()
    a, b = ta.rsi(c, 14), legacy.rsi_tv(c, 14)
    assert np.allclose(np.nan_to_num(a, nan=-1), np.nan_to_num(b, nan=-1), atol=1e-9)


def test_ema_rma_match_tradingview_reference():
    c = _walk()
    for n in (5, 14, 20):
        assert np.allclose(np.nan_to_num(ta.ema(c, n), nan=-1), np.nan_to_num(legacy.ema_tv(c, n), nan=-1))
        assert np.allclose(np.nan_to_num(ta.rma(c, n), nan=-1), np.nan_to_num(legacy.rma_tv(c, n), nan=-1))


def test_panel_equals_columnwise():
    p = np.column_stack([_walk(seed=s) for s in range(5)])
    p[:40, 2] = np.nan                              # late listing
    out = ta.rsi(p, 14)
    for j in range(5):
        assert np.allclose(np.nan_to_num(out[:, j], nan=-1), np.nan_to_num(ta.rsi(p[:, j], 14), nan=-1))


def test_no_cold_start_extreme():
    c = np.r_[np.full(30, np.nan), _walk(100, nan_at=())]   # IPO on bar 30
    r = ta.rsi(c, 14)
    assert np.isnan(r[:44]).all()                   # 14 changes needed: bars 31..44
    assert np.isfinite(r[44])


def test_rsi_pure_rally_is_100_not_nan():
    r = ta.rsi(np.arange(1, 40, dtype=float), 14)
    assert r[-1] == 100.0


def test_sma_no_stand_in():
    assert np.isnan(ta.sma(np.arange(10.0), 5)[:4]).all()


@pytest.mark.parametrize("fn", [
    lambda c: ta.rsi(c, 14), lambda c: ta.ema(c, 20), lambda c: ta.sma(c, 20), lambda c: ta.rma(c, 14),
])
def test_indicators_causal(fn):
    causal.assert_causal(fn, _walk())


def test_causal_detector_catches_lookahead():
    with pytest.raises(causal.LookAheadError):
        causal.assert_causal(lambda c: np.r_[c[1:], np.nan], _walk(nan_at=()))   # next-bar peek


def test_bs_put_call_parity_and_units():
    S, K, v, t = 100.0, 95.0, 0.4, bs.years_from_days(30)
    p = bs.bs_put(spot=S, strike=K, iv=v, years=t)
    c = bs.bs_call(spot=S, strike=K, iv=v, years=t)
    assert abs((c - p) - (S - K)) < 1e-9             # r = q = 0
    assert -0.5 < bs.put_delta(spot=S, strike=K, iv=v, years=t) < 0
    with pytest.raises(ValueError):
        bs.bs_put(spot=S, strike=K, iv=40.0, years=t)  # percent passed as fraction
    with pytest.raises(ValueError):
        bs.check_iv([25.0, 40.0, 5.61])  # percent array
    bs.check_iv(6.26)  # 626 % real penny-stock IV is a fraction, not percent
    bs.check_iv([0.3, 0.45, 5.61])  # one real wing quote above 5 is fine (11-16 band-table crash)
    with pytest.raises(TypeError):
        bs.bs_put(S, K, v, t)                         # positional → refused
    iv = bs.implied_vol(price=p, spot=S, strike=K, years=float(t))
    assert abs(iv - v) < 1e-4


def test_bs_expired_is_intrinsic():
    assert bs.bs_put(spot=90.0, strike=100.0, iv=0.3, years=0.0) == 10.0


def _frame(ts_list):
    return pd.DataFrame({"ts": pd.to_datetime(ts_list, utc=True), "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 1.0})


def test_to_rth_drops_extended_hours_and_dates_in_et():
    # 14:30Z = 09:30 EST (in RTH); 08:00Z = 04:00 ET (pre); 00:30Z next day = 20:30 ET same session day (post)
    df = bars.to_rth(_frame(["2025-11-03 14:30", "2025-11-03 08:00", "2025-11-04 00:30", "2025-11-03 20:55"]))
    assert len(df) == 2
    assert set(df["session_date"]) == {date(2025, 11, 3)}
    bars.check_intraday(df, 5)


def test_check_intraday_rejects_24h_and_utc_dates():
    raw = _frame(["2025-11-03 08:00", "2025-11-03 14:30"])
    with pytest.raises(bars.BarInvariantError):
        bars.check_intraday(raw, 5)
    ok = bars.to_rth(_frame(["2025-11-03 20:55"]))
    ok["session_date"] = date(2025, 11, 4)
    with pytest.raises(bars.BarInvariantError):
        bars.check_intraday(ok, 5)


def test_unexplained_gap_reported_not_adjusted():
    sd = [date(2025, 1, 2), date(2025, 1, 3)]
    gaps = bars.unexplained_gaps(sd, [100, 50], [100, 50], [])
    assert gaps and abs(gaps[0][1] - 0.5) < 1e-9     # −50 % crash: reported, no split applied
    assert bars.unexplained_gaps(sd, [100, 50], [100, 50], [(date(2025, 1, 3), 0.5)]) == []


def test_check_intraday_rejects_wrong_resolution():
    ts = pd.date_range("2025-11-03 14:30", periods=13, freq="30min", tz="UTC")   # 30m bars, 09:30–15:30 EST
    df = bars.to_rth(_frame(list(ts.astype(str))))
    with pytest.raises(bars.BarInvariantError, match="spacing"):
        bars.check_intraday(df, 5)
    bars.check_intraday(df, 30)
