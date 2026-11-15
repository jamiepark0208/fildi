"""One home for loading intraday bars (Jamie 11-15: 12 loader copies; the one without an RTH filter
traded 04:00 / 20:00 prints for 8 days — B26).

`load_intraday(conn, tickers, table=...)` always returns:
  ts            tz-aware America/New_York bar START
  session_date  the ET calendar date (never the UTC date)
  o h l c v     floats, RTH only (09:30 ≤ start < 16:00), sorted, one row per (ticker, ts)
and runs `check_intraday` on the result, which raises on any broken invariant. Callers never re-derive
session dates or hours themselves.

Splits: `split_factors(conn, ticker)` reads optlab.splits (the only source of truth). A price-gap heuristic
is NOT used to adjust — a real −50 % crash looks like a 2:1 split. `unexplained_gaps()` lists big gaps
so a study can report them, never silently erase them.
"""
from __future__ import annotations

from datetime import date, time
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ET = ZoneInfo("America/New_York")
RTH_OPEN = time(9, 30)
RTH_CLOSE = time(16, 0)
RTH_MINUTES = 390
INTRADAY_TABLES = {"optlab.bars_5m": 5, "watchlist_sync.intraday_bars_5m": 5, "optlab.bars_30m": 30}

__all__ = [
    "ET", "load_intraday", "to_rth", "check_intraday", "BarInvariantError",
    "split_factors", "continuous_closes", "unexplained_gaps", "check_daily", "write_intraday",
]


class BarInvariantError(AssertionError):
    pass


def to_rth(df: pd.DataFrame, ts_col: str = "ts") -> pd.DataFrame:
    """Any intraday frame → ET timestamps, RTH only, ET session_date, sorted, deduped."""
    if df.empty:
        out = df.copy()
        out["session_date"] = pd.Series(dtype=object)
        return out
    ts = pd.to_datetime(df[ts_col], utc=True).dt.tz_convert(ET)
    t = ts.dt.time
    m = ((t >= RTH_OPEN) & (t < RTH_CLOSE)).to_numpy()
    out = df.loc[m].copy()
    out[ts_col] = ts.loc[m]
    out["session_date"] = out[ts_col].dt.date
    keys = [k for k in ("ticker", ts_col) if k in out.columns]
    out = out.sort_values(keys).drop_duplicates(keys, keep="last").reset_index(drop=True)
    return out


def check_intraday(df: pd.DataFrame, bar_minutes: int, *, ticker: str = "", min_fill: float = 0.5) -> dict:
    """Raise BarInvariantError if the frame is not clean RTH bars. Returns a small stats dict.

    Checks: modal in-session spacing == bar_minutes (11-15: 165 tickers of 30m bars sat in bars_5m); tz-aware ET; every bar starts in RTH; session_date == ET date of ts; no duplicate ts;
    ≤ 390/bar_minutes bars per session; median session ≥ min_fill of a full session (thin data warns
    via the returned stats, it does not raise — half days and halts exist)."""
    if df.empty:
        return {"sessions": 0}
    tag = f"[{ticker}] " if ticker else ""
    ts = df["ts"]
    if getattr(ts.dt, "tz", None) is None:
        raise BarInvariantError(f"{tag}ts is tz-naive; load through quantcore.bars")
    et = ts.dt.tz_convert(ET)
    t = et.dt.time
    bad = ~((t >= RTH_OPEN) & (t < RTH_CLOSE))
    if bad.any():
        raise BarInvariantError(f"{tag}{int(bad.sum())} bars outside RTH (first {et[bad].iloc[0]})")
    if "session_date" in df.columns and (df["session_date"] != et.dt.date).any():
        raise BarInvariantError(f"{tag}session_date ≠ ET date of ts (UTC dating?)")
    keys = ["ticker", "ts"] if "ticker" in df.columns else ["ts"]
    if df.duplicated(keys).any():
        raise BarInvariantError(f"{tag}duplicate bars")
    if len(df) > 1:
        gaps = et.diff().dt.total_seconds().div(60)
        same = (et.dt.date == et.dt.date.shift(1)).to_numpy()
        g = gaps[same]
        if len(g) >= 10 and float(g.mode().iloc[0]) != float(bar_minutes):
            raise BarInvariantError(f"{tag}modal bar spacing {g.mode().iloc[0]:.0f}m ≠ {bar_minutes}m "
                                    f"(wrong-resolution bars in this table?)")
    per = df.groupby(et.dt.date).size()
    cap = RTH_MINUTES // bar_minutes + (1 if RTH_MINUTES % bar_minutes else 0)
    if per.max() > cap:
        raise BarInvariantError(f"{tag}{per.max()} bars in one session > {cap} possible at {bar_minutes}m")
    return {"sessions": int(len(per)), "median_bars": float(per.median()),
            "thin": bool(per.median() < min_fill * cap), "cap": cap}


def load_intraday(conn, tickers: list[str], *, table: str = "optlab.bars_5m",
                  date_from: date | None = None, check: bool = True) -> dict[str, pd.DataFrame]:
    """{ticker: RTH frame}. The only sanctioned reader of the 5m tables."""
    if table not in INTRADAY_TABLES:
        raise ValueError(f"unknown intraday table {table}")
    bm = INTRADAY_TABLES[table]
    sql = f"SELECT ts, o, h, l, c, v FROM {table} WHERE ticker = %s"
    out: dict[str, pd.DataFrame] = {}
    for tk in tickers:
        params: list = [tk]
        q = sql
        if date_from is not None:
            q += " AND ts >= %s"
            params.append(pd.Timestamp(date_from, tz=ET).to_pydatetime())
        rows = conn.execute(q + " ORDER BY ts", params).fetchall()
        if not rows:
            continue
        df = pd.DataFrame(rows, columns=["ts", "o", "h", "l", "c", "v"])
        for col in ("o", "h", "l", "c", "v"):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
        df = to_rth(df)
        if df.empty:
            continue
        if check:
            check_intraday(df, bm, ticker=tk)
        out[tk] = df
    return out


def split_factors(conn, ticker: str) -> list[tuple[date, float]]:
    """[(ex_date, multiplier for PRE-split prices)] from optlab.splits. 2:1 forward → 0.5."""
    rows = conn.execute(
        "SELECT exec_date, split_from::float8, split_to::float8 FROM optlab.splits "
        "WHERE UPPER(ticker) = UPPER(%s) AND split_from > 0 AND split_to > 0 ORDER BY exec_date",
        (ticker,),
    ).fetchall()
    return [(d, float(fr) / float(to)) for d, fr, to in rows]


def continuous_closes(session_dates, closes, factors: list[tuple[date, float]]) -> np.ndarray:
    """Closes rescaled onto the latest share basis (for indicators only; trade at the raw price)."""
    c = np.asarray(closes, dtype=float).copy()
    sd = np.asarray(session_dates)
    for d, mult in factors:
        c[sd < d] *= mult
    return c


def unexplained_gaps(session_dates, opens, closes, factors: list[tuple[date, float]],
                     *, lo: float = 0.6, hi: float = 1.7) -> list[tuple[date, float]]:
    """Session-open / prior-close ratios outside [lo, hi] with no split within 3 days. Report, never adjust."""
    sd = pd.Series(pd.to_datetime(pd.Series(session_dates)).dt.date)
    o = pd.Series(np.asarray(opens, dtype=float))
    c = pd.Series(np.asarray(closes, dtype=float))
    first = o.groupby(sd).first()
    last = c.groupby(sd).last()
    ratio = first / last.shift(1)
    split_days = [d for d, _ in factors]
    out = []
    for d, r in ratio.items():
        if np.isfinite(r) and (r < lo or r > hi) and not any(abs((d - s).days) <= 3 for s in split_days):
            out.append((d, float(r)))
    return out


def check_daily(df: pd.DataFrame, *, date_col: str = "date", ticker: str = "") -> None:
    """Daily frame invariants: unique sorted dates, positive prices, h ≥ max(o,c), l ≤ min(o,c)."""
    tag = f"[{ticker}] " if ticker else ""
    if df.empty:
        return
    if df[date_col].duplicated().any():
        raise BarInvariantError(f"{tag}duplicate daily dates")
    if not df[date_col].is_monotonic_increasing:
        raise BarInvariantError(f"{tag}daily dates not sorted")
    px = df[[c for c in ("o", "h", "l", "c") if c in df.columns]]
    if (px <= 0).any().any():
        raise BarInvariantError(f"{tag}non-positive price")
    if {"o", "h", "l", "c"} <= set(df.columns):
        bad = (df["h"] + 1e-9 < df[["o", "c"]].max(axis=1)) | (df["l"] - 1e-9 > df[["o", "c"]].min(axis=1))
        if bad.mean() > 0.01:
            raise BarInvariantError(f"{tag}{int(bad.sum())} bars with high < body or low > body")


def write_intraday(conn, table: str, ticker: str, df: pd.DataFrame) -> int:
    """The only sanctioned writer for the intraday tables: refuses frames whose resolution ≠ the table's
    (the 11-08 bug: 30m bars appended to bars_5m). Raw extended-hours rows are allowed in the table;
    the spacing check runs on the RTH part."""
    if table not in INTRADAY_TABLES:
        raise ValueError(f"unknown intraday table {table}")
    if df.empty:
        return 0
    rth = to_rth(df.assign(ticker=ticker))
    if len(rth) > 1:
        check_intraday(rth, INTRADAY_TABLES[table], ticker=ticker)
    rows = [(ticker, r.ts, r.o, r.h, r.l, r.c, getattr(r, "v", None)) for r in df.itertuples()]
    with conn.cursor() as cur:
        cur.executemany(
            f"INSERT INTO {table} (ticker, ts, o, h, l, c, v) VALUES (%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (ticker, ts) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, "
            "c = EXCLUDED.c, v = EXCLUDED.v",
            rows,
        )
    return len(rows)


def audit_tables(conn) -> list[str]:
    """Whole-table resolution check (SQL, seconds): tickers whose modal in-session spacing ≠ the table's.
    Run at session start (agent_start 6j) so a wrong-resolution writer is caught the day it lands."""
    out = []
    for table, bm in INTRADAY_TABLES.items():
        rows = conn.execute(f"""
            WITH x AS (
              SELECT ticker, extract(epoch FROM ts - lag(ts) OVER (PARTITION BY ticker ORDER BY ts)) / 60 AS gap,
                     (ts AT TIME ZONE 'America/New_York')::date AS d,
                     lag((ts AT TIME ZONE 'America/New_York')::date) OVER (PARTITION BY ticker ORDER BY ts) AS pd
              FROM {table}
              WHERE ts > now() - interval '120 days'
                AND (ts AT TIME ZONE 'America/New_York')::time >= '09:30'
                AND (ts AT TIME ZONE 'America/New_York')::time < '16:00')
            SELECT ticker, mode() WITHIN GROUP (ORDER BY gap) FROM x WHERE d = pd GROUP BY 1""").fetchall()
        bad = [f"{t}:{int(m)}m" for t, m in rows if m is not None and int(m) != bm]
        if bad:
            out.append(f"{table} expects {bm}m; {len(bad)} tickers differ ({', '.join(bad[:8])})")
    return out


if __name__ == "__main__":
    import os
    import sys

    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"]) as _c:
        msgs = audit_tables(_c)
    print("bars audit: ok" if not msgs else "bars audit: " + " | ".join(msgs))
    sys.exit(1 if msgs else 0)
