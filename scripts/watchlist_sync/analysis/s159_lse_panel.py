#!/usr/bin/env python3
"""S159 — LSE daily 2003→ panel (split-adjusted) for fast_screen_bars_2003.pkl.

Fetch: scripts/lse_client.export_stock_csv per ticker (≤55/min, vendor_raw + local cache).
Adjust: optlab.splits + jump detect (2:1, 3:1, …) confirmed vs lseg_research.daily_history 2016→.
Self-test: AAPL/NVDA/TSLA have no calendar day with split-adjusted ret < −50 %.

  cd scripts/watchlist_sync && .venv/bin/python analysis/s159_lse_panel.py fetch
  .venv/bin/python analysis/s159_lse_panel.py build
  .venv/bin/python analysis/s159_lse_panel.py self-test
"""
from __future__ import annotations

import argparse
import json
import math
import pickle
import re
import sys
import time
from datetime import date
from fractions import Fraction
from pathlib import Path
from statistics import median

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(REPO / "scripts"))

from build_plan import connect, rows  # noqa: E402
from lse_client import export_stock_csv, parse_stock_minute_rows  # noqa: E402

CACHE = Path.home() / ".fildi" / "cache" / "fast_screen_bars_2003.pkl"
RAW_DIR = Path.home() / ".fildi" / "cache" / "s159_lse_raw"
DATE_FROM = date(2003, 1, 1)
EXTRA = ("SPY", "QQQ", "VIX")
FRACTION_TOL = 0.02
CACHE_VER = 1


def universe(conn) -> list[str]:
    tickers = [r["ticker"] for r in rows(conn, "SELECT DISTINCT UPPER(ticker) AS ticker FROM source_fundamentals ORDER BY 1")]
    for t in EXTRA:
        if t not in tickers:
            tickers.append(t)
    return sorted(set(tickers))


def split_fraction(r: float) -> Fraction | None:
    f = Fraction(r).limit_denominator(20)
    if f.numerator == f.denominator:
        return None
    return f if abs(r / float(f) - 1) <= FRACTION_TOL else None


def load_splits(conn) -> dict[str, list[tuple[date, float]]]:
    out: dict[str, list[tuple[date, float]]] = {}
    for t, ed, fr, to in conn.execute(
        "SELECT UPPER(ticker), exec_date, split_from::float8, split_to::float8 FROM optlab.splits WHERE split_from > 0"
    ).fetchall():
        if fr and to:
            out.setdefault(t, []).append((ed, fr / to))  # multiply pre-split closes by fr/to
    for t in out:
        out[t].sort(key=lambda x: x[0])
    return out


def lseg_closes(conn, ticker: str) -> dict[date, float]:
    return {
        d: float(c)
        for d, c in conn.execute(
            "SELECT date, close::float8 FROM lseg_research.daily_history WHERE ticker = %s AND close > 0",
            (ticker,),
        ).fetchall()
    }


def detect_jump_splits(dates: list[date], closes: np.ndarray) -> list[tuple[date, float]]:
    """Unadjusted series: forward split drops overnight; factor = fr/to applied to all prior."""
    found = []
    for k in range(5, len(closes) - 2):
        if not (closes[k - 1] > 0 and closes[k] > 0):
            continue
        j = closes[k] / closes[k - 1]
        if 0.48 <= j <= 2.05:
            continue
        frac = split_fraction(1 / j) if j < 1 else split_fraction(j)
        if not frac:
            continue
        after = closes[k : k + 5]
        if len(after) >= 3 and np.nanmax(after) / np.nanmin(after) < 1.25:
            found.append((dates[k], float(frac)))
    return found


def confirm_lseg_factor(lseg: dict[date, float], d: date, factor: float, dates: list[date], closes: np.ndarray) -> bool:
    if not lseg:
        return True
    i = dates.index(d)
    pre = [(dd, lseg[dd] / closes[j]) for j, dd in enumerate(dates[max(0, i - 40) : i]) if dd in lseg and closes[j] > 0]
    post = [(dd, lseg[dd] / closes[j]) for j, dd in enumerate(dates[i : i + 15], start=i) if dd in lseg and closes[j] > 0]
    if len(pre) < 5 or len(post) < 3:
        return True
    R = median([r for _, r in pre])
    steady = median([abs(r / R - 1) for _, r in pre])
    post_ok = abs(median([r for _, r in post]) - 1) < 0.02
    return steady < 0.02 and post_ok and abs(R - factor) < 0.03


def adjust_ohlcv(g: pd.DataFrame, factors: list[tuple[date, float]]) -> pd.DataFrame:
    g = g.sort_values("date").reset_index(drop=True)
    for col in ("o", "h", "l", "c", "v"):
        if col in g.columns:
            g[col] = pd.to_numeric(g[col], errors="coerce")
    for split_d, fac in sorted(factors, key=lambda x: x[0]):
        m = g["date"].values < np.datetime64(split_d)
        for col in ("o", "h", "l", "c"):
            g.loc[m, col] = g.loc[m, col] * fac
        if "v" in g.columns:
            g["v"] = g["v"].astype(float)
            g.loc[m, "v"] = g.loc[m, "v"] / fac
    return g


def factors_for_ticker(conn, ticker: str, g: pd.DataFrame, splits: dict, lseg: dict) -> list[tuple[date, float]]:
    facs: list[tuple[date, float]] = list(splits.get(ticker, []))
    dates = [d.date() if hasattr(d, "date") else d for d in g["date"]]
    closes = g["c"].to_numpy(dtype=float)
    for d, fac in detect_jump_splits(dates, closes):
        if any(abs(existing[1] - fac) < 0.01 and abs((existing[0] - d).days) < 3 for existing in facs):
            continue
        if confirm_lseg_factor(lseg, d, fac, dates, closes):
            facs.append((d, fac))
    return sorted(facs, key=lambda x: x[0])


def csv_path(ticker: str) -> Path:
    t = ticker.upper()
    today = RAW_DIR / f"{t}_{DATE_FROM}_{date.today()}_1d.csv"
    if today.is_file():
        return today
    hits = sorted(RAW_DIR.glob(f"{t}_{DATE_FROM}_*_1d.csv"))
    return hits[-1] if hits else today


def fetch_ticker(conn, ticker: str, *, force: bool = False) -> str | None:
    p = csv_path(ticker)
    if p.is_file() and not force:
        return p.read_text(encoding="utf-8", errors="replace")
    status, body = export_stock_csv(conn, ticker, date_from=DATE_FROM, date_to=date.today(), timeframe="1d")
    if status != 200 or '"time"' not in body.lstrip()[:120].lower():
        return None
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")
    return body


def rows_to_frame(csv_text: str) -> pd.DataFrame:
    raw = parse_stock_minute_rows(csv_text)
    if not raw:
        return pd.DataFrame()
    g = pd.DataFrame(raw)
    g["date"] = pd.to_datetime(g["ts"]).dt.normalize()
    g = g.groupby("date", as_index=False).agg(
        o=("open", "last"), h=("high", "max"), l=("low", "min"), c=("close", "last"), v=("volume", "sum")
    )
    return g.dropna(subset=["c"])


def cmd_fetch(args) -> None:
    with connect() as conn:
        tickers = universe(conn)
        done, fail = 0, []
        t0 = time.perf_counter()
        for i, t in enumerate(tickers, 1):
            if csv_path(t).is_file() and not args.force:
                done += 1
                continue
            txt = fetch_ticker(conn, t, force=args.force)
            if txt:
                done += 1
            else:
                fail.append(t)
            if i % 25 == 0 or i == len(tickers):
                el = time.perf_counter() - t0
                print(f"fetch {i}/{len(tickers)} ok={done} fail={len(fail)} {el/60:.1f}m", flush=True)
        print(f"fetch done ok={done} fail={len(fail)}", flush=True)
        if fail:
            print("fail sample:", ",".join(fail[:20]))


def build_pack(conn) -> dict:
    tickers = universe(conn)
    splits = load_splits(conn)
    frames = []
    for t in tickers:
        p = csv_path(t)
        if not p.is_file():
            continue
        g = rows_to_frame(p.read_text(encoding="utf-8", errors="replace"))
        if g.empty:
            continue
        lseg = lseg_closes(conn, t)
        facs = factors_for_ticker(conn, t, g.copy(), splits, lseg)
        g = adjust_ohlcv(g, facs)
        g["ticker"] = t
        frames.append(g)
    if not frames:
        raise SystemExit("no bars — run fetch first")
    df = pd.concat(frames, ignore_index=True)
    pack = {"ver": CACHE_VER, "source": "lse_2003_split_adj", "built": date.today().isoformat()}
    for col in ("o", "h", "l", "c", "v"):
        pack[col] = df.pivot(index="date", columns="ticker", values=col).sort_index()
    vix_rows = rows(
        conn,
        "SELECT date, close::float8 c FROM wrds_research.cboe_daily WHERE index = 'VIX' AND close > 0 ORDER BY date",
    )
    if vix_rows:
        vg = pd.DataFrame(vix_rows)
        vg["date"] = pd.to_datetime(vg["date"])
        vx = vg.set_index("date")["c"].reindex(pack["c"].index)
        for col in pack:
            if col == "ver" or col in ("source", "built"):
                continue
            if "VIX" not in pack[col].columns:
                pack[col]["VIX"] = vx if col == "c" else vx  # level series for OHLC
    return pack


def cmd_build(_args) -> None:
    with connect() as conn:
        pack = build_pack(conn)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open("wb") as f:
        pickle.dump(pack, f, protocol=pickle.HIGHEST_PROTOCOL)
    C = pack["c"]
    print(f"saved {CACHE} {C.index[0].date()}→{C.index[-1].date()} tickers={C.shape[1]} days={len(C)}")


def self_test(pack: dict) -> None:
    C = pack["c"]
    bad = []
    for t in ("AAPL", "NVDA", "TSLA"):
        if t not in C.columns:
            bad.append(f"{t}: missing")
            continue
        r = C[t].pct_change()
        worst = r.min()
        if worst < -0.5:
            worst_d = r.idxmin()
            bad.append(f"{t}: min ret {worst:.2%} on {worst_d.date()}")
        spy03 = C["SPY"].dropna().iloc[0] if "SPY" in C.columns else None
        if spy03 and spy03 < 80:
            bad.append(f"SPY 2003 close {spy03:.1f} looks unadjusted (expect ~90–110 adj)")
    if bad:
        raise SystemExit("self-test FAIL:\n" + "\n".join(bad))
    print("self-test OK: AAPL/NVDA/TSLA no −50% days; SPY level plausible")


def cmd_self_test(_args) -> None:
    if not CACHE.is_file():
        raise SystemExit(f"missing {CACHE}")
    with CACHE.open("rb") as f:
        pack = pickle.load(f)
    self_test(pack)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_f = sub.add_parser("fetch")
    p_f.add_argument("--force", action="store_true")
    sub.add_parser("build")
    sub.add_parser("self-test")
    args = ap.parse_args()
    if args.cmd == "fetch":
        cmd_fetch(args)
    elif args.cmd == "build":
        cmd_build(args)
    else:
        cmd_self_test(args)


if __name__ == "__main__":
    main()
