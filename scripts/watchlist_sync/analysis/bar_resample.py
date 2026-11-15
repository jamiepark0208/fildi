"""Session-anchored OHLCV resample from 1m bars (RTH 09:30 ET). A359 fix4 one home."""
from __future__ import annotations

import math
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ET = ZoneInfo("America/New_York")

TF_MINUTES: dict[str, int] = {
    "1m": 1,
    "2m": 2,
    "3m": 3,
    "5m": 5,
    "10m": 10,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "4h": 240,
    "1d": 390,
}


def _ensure_et_ts(df: pd.DataFrame) -> pd.Series:
    ts = pd.to_datetime(df["ts"], utc=True).dt.tz_convert(ET)
    return ts


def resample_bars(df_1m: pd.DataFrame, tf: str) -> pd.DataFrame:
    """RTH-only bars grouped into `tf` buckets from 09:30 ET per session."""
    if df_1m.empty:
        return pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v", "session_date"])

    if tf == "1m":
        df = df_1m.copy()
        ts = _ensure_et_ts(df)
        t_et = ts.dt.time
        mask = (t_et >= pd.Timestamp("09:30").time()) & (t_et < pd.Timestamp("16:00").time())
        df = df.loc[mask].copy()
        ts_sub = ts.loc[mask]
        df["ts"] = ts_sub
        df["session_date"] = ts_sub.dt.tz_localize(None).dt.date
        return df.sort_values(["session_date", "ts"]).reset_index(drop=True)

    mins = TF_MINUTES.get(tf)
    if mins is None:
        raise ValueError(f"unknown tf {tf}")

    df = df_1m.copy()
    ts = _ensure_et_ts(df)
    t_et = ts.dt.time
    mask = (t_et >= pd.Timestamp("09:30").time()) & (t_et < pd.Timestamp("16:00").time())
    df = df.loc[mask].copy()
    if df.empty:
        return pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v", "session_date"])
    ts_sub = ts.loc[mask]
    df["_ts"] = ts_sub
    df["session_date"] = ts_sub.dt.tz_localize(None).dt.date

    minutes_from_open = df["_ts"].dt.hour * 60 + df["_ts"].dt.minute - (9 * 60 + 30)
    df["_bucket"] = (minutes_from_open // mins).astype(int)
    rows: list[dict] = []
    for (sess, buck), grp in df.groupby(["session_date", "_bucket"], sort=True):
        grp = grp.sort_values("_ts")
        if tf == "1d" and buck != 0:
            continue
        o = float(grp["o"].iloc[0])
        h = float(grp["h"].max())
        l = float(grp["l"].min())
        c = float(grp["c"].iloc[-1])
        v = float(grp["v"].sum()) if "v" in grp.columns and grp["v"].notna().any() else 0.0
        ts0 = grp["_ts"].iloc[0]
        rows.append({
            "ts": ts0,
            "o": o,
            "h": h,
            "l": l,
            "c": c,
            "v": v,
            "session_date": sess,
        })
    out = pd.DataFrame(rows)
    return out.sort_values(["session_date", "ts"]).reset_index(drop=True)


def hand_resample_2m_segment(o, h, l, c, v, bucket_ids) -> tuple[float, float, float, float, float]:
    """Fixture helper: OHLCV for one 2m bucket from parallel 1m arrays."""
    mask = bucket_ids == bucket_ids[0]
    return (
        float(o[mask][0]),
        float(np.max(h[mask])),
        float(np.min(l[mask])),
        float(c[mask][-1]),
        float(np.sum(v[mask])),
    )
