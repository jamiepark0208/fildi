#!/usr/bin/env python3
"""A359: LSE 1m stock export → parquet cache + resumable OPRA-window backfill."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
WATCH = HERE.parent
REPO = WATCH.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(WATCH))
sys.path.insert(0, str(REPO / "scripts"))

from build_plan import connect  # noqa: E402
from conditional_engine import OPRA_START, universe_tickers_from_db  # noqa: E402
from lse_client import export_stock_csv, parse_stock_minute_rows  # noqa: E402

CACHE_1M = Path.home() / ".fildi" / "cache" / "a359_bars_1m"
STATE_PATH = CACHE_1M / "_backfill_state.json"


def _month_chunks(d0: date, d1: date) -> list[tuple[date, date]]:
    chunks: list[tuple[date, date]] = []
    y, m = d0.year, d0.month
    while date(y, m, 1) <= d1:
        last = monthrange(y, m)[1]
        ms, me = date(y, m, 1), date(y, m, last)
        a = max(ms, d0)
        b = min(me, d1)
        if a <= b:
            chunks.append((a, b))
        if m == 12:
            y, m = y + 1, 1
        else:
            m += 1
    return chunks


def rows_to_df(rows: list[dict]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v"])
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    rename = {"open": "o", "high": "h", "low": "l", "close": "c", "volume": "v"}
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})
    for col in ("o", "h", "l", "c"):
        if col in df.columns:
            df[col] = df[col].astype(float)
    if "v" not in df.columns:
        df["v"] = 0
    df["v"] = df["v"].fillna(0).astype(float)
    return df.sort_values("ts").reset_index(drop=True)


def load_parquet_1m(ticker: str) -> pd.DataFrame:
    p = CACHE_1M / f"{ticker.upper()}.parquet"
    if not p.is_file():
        return pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v"])
    return pd.read_parquet(p)


def fetch_range_1m(conn, ticker: str, d0: date, d1: date) -> pd.DataFrame:
    """Fetch + merge into parquet (one LSE call per month chunk)."""
    frames: list[pd.DataFrame] = []
    for a, b in _month_chunks(d0, d1):
        _, df, _ = fetch_month(conn, ticker, a, b)
        if not df.empty:
            frames.append(df)
            append_parquet(ticker, df)
        time.sleep(1.05)
    if not frames:
        return pd.DataFrame(columns=["ts", "o", "h", "l", "c", "v"])
    return pd.concat(frames, ignore_index=True).drop_duplicates(subset=["ts"]).sort_values("ts")


def append_parquet(ticker: str, df_new: pd.DataFrame) -> int:
    CACHE_1M.mkdir(parents=True, exist_ok=True)
    p = CACHE_1M / f"{ticker.upper()}.parquet"
    if p.is_file():
        old = pd.read_parquet(p)
        df = pd.concat([old, df_new], ignore_index=True)
        df = df.drop_duplicates(subset=["ts"], keep="last").sort_values("ts")
    else:
        df = df_new.sort_values("ts")
    df.to_parquet(p, index=False)
    return len(df)


def fetch_month(conn, ticker: str, d0: date, d1: date) -> tuple[int, pd.DataFrame, int]:
    status, body = export_stock_csv(conn, ticker, date_from=d0, date_to=d1, timeframe="1m")
    if status != 200:
        return status, pd.DataFrame(), 1
    rows = parse_stock_minute_rows(body)
    return status, rows_to_df(rows), 1


def smoke_spy_one_month() -> dict:
    """ONE ticker, ONE month — rows, bytes, seconds, calls."""
    d1 = date.today()
    d0 = date(d1.year, d1.month, 1) - timedelta(days=1)
    d0 = date(d0.year, d0.month, 1)
    t0 = time.perf_counter()
    with connect() as conn:
        status, df, calls = fetch_month(conn, "SPY", d0, d1)
    wall = time.perf_counter() - t0
    nbytes = int(df.memory_usage(deep=True).sum()) if not df.empty else 0
    return {
        "ticker": "SPY",
        "from": d0.isoformat(),
        "to": d1.isoformat(),
        "http": status,
        "rows": len(df),
        "bytes": nbytes,
        "wall_s": round(wall, 2),
        "calls": calls,
    }


def backfill_ticker(conn, ticker: str, d0: date, d1: date, state: dict) -> int:
    key = ticker.upper()
    done = set(tuple(x) for x in state.get(key, {}).get("chunks", []))
    n_rows = 0
    for a, b in _month_chunks(d0, d1):
        ck = (a.isoformat(), b.isoformat())
        if ck in done:
            continue
        status, df, _ = fetch_month(conn, key, a, b)
        if status != 200:
            # Never mark a failed month done (11-07: quota 429 would have skipped months for good).
            raise RuntimeError(f"{key} {a}..{b}: HTTP {status} — stop; resume after quota reset")
        if df.empty:
            continue
        n_rows += len(df)
        append_parquet(key, df)
        done.add(ck)
        state.setdefault(key, {"chunks": []})["chunks"].append(list(ck))
        # Merge on write: parallel workers on disjoint tickers share this file (Claude 11-07).
        disk = json.loads(STATE_PATH.read_text()) if STATE_PATH.is_file() else {}
        disk[key] = state[key]
        tmp = STATE_PATH.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(disk, indent=2))
        tmp.replace(STATE_PATH)
        time.sleep(1.05)
    return n_rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke-spy", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--tickers", default="")
    ap.add_argument("--from", dest="date_from", default=OPRA_START.isoformat())
    ap.add_argument("--to", dest="date_to", default=date.today().isoformat())
    args = ap.parse_args()

    if args.smoke_spy:
        rep = smoke_spy_one_month()
        print("SANITY SPY 1m month:", json.dumps(rep))
        return 0 if rep["http"] == 200 and rep["rows"] > 1000 else 1

    if args.backfill:
        d0 = date.fromisoformat(args.date_from)
        d1 = date.fromisoformat(args.date_to)
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()] or universe_tickers_from_db()
        state = json.loads(STATE_PATH.read_text()) if STATE_PATH.is_file() else {}
        t0 = time.perf_counter()
        with connect() as conn:
            for i, tk in enumerate(tickers):
                n = backfill_ticker(conn, tk, d0, d1, state)
                print(f"{tk} +{n} rows ({i+1}/{len(tickers)})")
        print(f"wall_s={time.perf_counter()-t0:.0f}")
        return 0

    ap.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
