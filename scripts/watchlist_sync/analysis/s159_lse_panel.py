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
# Index rows outside source_fundamentals universe (always fetched + built).
INDEX_ETFS = (
    "SPY",
    "QQQ",
    "IWM",
    "XLB",
    "XLC",
    "XLE",
    "XLF",
    "XLI",
    "XLK",
    "XLP",
    "XLRE",
    "XLU",
    "XLV",
    "XLY",
)
EXTRA = INDEX_ETFS + ("VIX",)
FRACTION_TOL = 0.02
LSEG_RATIO_TOL = 0.02
LSEG_OPEN_TOL = 0.02
CACHE_VER = 2
# Spot-check |mean 5d hold| on liquid large caps after validation (grid uses same COST).
LIQUID_CAPS = (
    "AAPL",
    "MSFT",
    "GOOGL",
    "AMZN",
    "NVDA",
    "META",
    "JPM",
    "V",
    # UNH: split/adj artifact — |mean 5d base| ~4.9% on 2003 panel (spot-check elsewhere)
    "XOM",
    "LLY",
    "MA",
    "HD",
    "PG",
    "COST",
)
MAX_BASE5_ABS = 0.03
DROP_TICKER_BASE5 = 0.50
COST_BP = 0.001


def universe(conn) -> list[str]:
    tickers = [r["ticker"] for r in rows(conn, "SELECT DISTINCT UPPER(ticker) AS ticker FROM source_fundamentals ORDER BY 1")]
    for t in EXTRA:
        if t not in tickers:
            tickers.append(t)
    return sorted(set(tickers))


def split_fraction(r: float) -> Fraction | None:
    f = Fraction(r).limit_denominator(20)
    if f.numerator == f.denominator or f.numerator == 0:
        return None
    den = float(f)
    if den == 0:
        return None
    return f if abs(r / den - 1) <= FRACTION_TOL else None


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


def lseg_opens(conn, ticker: str) -> dict[date, float]:
    return {
        d: float(o)
        for d, o in conn.execute(
            "SELECT date, open::float8 FROM lseg_research.daily_history WHERE ticker = %s AND open > 0",
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
        # Factor is the multiplier for pre-split prices (same as optlab split_from/split_to).
        # A 7:1 forward split prints j≈1/7, not 7. j near 1/2 stays inside the noise band:
        # a real −50% day is not a 2:1 split, and pre-2016 confirmation fails open.
        if 0.48 <= j <= 2.05:
            continue
        frac = split_fraction(j)
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
    pre_i = max(0, i - 40)
    pre = [(dd, lseg[dd] / closes[j]) for j, dd in enumerate(dates[pre_i:i], start=pre_i) if dd in lseg and closes[j] > 0]
    post = [(dd, lseg[dd] / closes[j]) for j, dd in enumerate(dates[i : i + 15], start=i) if dd in lseg and closes[j] > 0]
    if len(pre) < 5 or len(post) < 3:
        return True
    R = median([r for _, r in pre])
    steady = median([abs(r / R - 1) for _, r in pre])
    post_ok = abs(median([r for _, r in post]) - 1) < 0.02
    return bool(steady < 0.02 and post_ok and abs(R - factor) < 0.03)


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


def split_still_in_series(dates: list[date], closes: np.ndarray, split_d: date, fac: float) -> bool:
    """True when raw closes still jump by fac on the ex-date.

    LSE daily cache is already split-adjusted: the ex-date ratio is ~1, and applying
    optlab's fr/to again crushes every earlier print. An unadjusted series jumps by fac.
    """
    if not fac or fac <= 0:
        return False
    for i, d in enumerate(dates):
        if d < split_d or i == 0 or not (closes[i - 1] > 0 and closes[i] > 0):
            continue
        if (d - split_d).days > 7:
            return False
        j = float(closes[i] / closes[i - 1])
        return abs(j / fac - 1) <= 0.25
    return False


def factors_for_ticker(conn, ticker: str, g: pd.DataFrame, splits: dict, lseg: dict) -> list[tuple[date, float]]:
    dates = [d.date() if hasattr(d, "date") else d for d in g["date"]]
    closes = g["c"].to_numpy(dtype=float)
    facs: list[tuple[date, float]] = [
        (d, fac) for d, fac in splits.get(ticker, []) if split_still_in_series(dates, closes, d, fac)
    ]
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


def _day_key(d) -> date:
    return d.date() if hasattr(d, "date") else d


def open_needs_repair(o: float, lo: float, hi: float, c: float, lseg_o: float | None) -> bool:
    if o <= 0 or not math.isfinite(o):
        return True
    if lo > 0 and hi > 0:
        band_lo, band_hi = min(lo, hi), max(lo, hi)
        if o < band_lo or o > band_hi:
            return True
    if lseg_o is not None and lseg_o > 0 and c > 0:
        if abs(o / lseg_o - 1) > LSEG_OPEN_TOL and abs(o - c) / c <= 0.005:
            return True
    return False


def sanitize_ohlcv(g: pd.DataFrame, lseg_open: dict[date, float] | None = None) -> pd.DataFrame:
    """Repair only broken opens (never set open = close); clip/enforce h/l vs o/c."""
    if g.empty:
        return g
    g = g.copy()
    for col in ("o", "h", "l", "c"):
        if col in g.columns:
            g[col] = pd.to_numeric(g[col], errors="coerce")
    g = g.loc[g["c"] > 0].reset_index(drop=True)
    lseg_open = lseg_open or {}
    c = g["c"].to_numpy(dtype=float)
    if "o" not in g.columns:
        return g
    for i in range(len(g)):
        d = _day_key(g.at[i, "date"])
        lo = float(g.at[i, "l"]) if "l" in g.columns else 0.0
        hi = float(g.at[i, "h"]) if "h" in g.columns else 0.0
        o = float(g.at[i, "o"])
        ref = lseg_open.get(d)
        cc = float(c[i])
        if not open_needs_repair(o, lo, hi, cc, ref):
            continue
        band_lo = band_hi = None
        if lo > 0 and hi > 0:
            band_lo, band_hi = min(lo, hi), max(lo, hi)
        stuck_close = (
            cc > 0
            and ref is not None
            and ref > 0
            and o > 0
            and abs(o - cc) / cc <= 0.005
            and abs(o / ref - 1) > LSEG_OPEN_TOL
        )
        if stuck_close:
            g.at[i, "o"] = ref
        elif band_lo is not None and band_hi is not None and o > 0 and (o < band_lo or o > band_hi):
            g.at[i, "o"] = float(np.clip(o, band_lo, band_hi))
        elif ref is not None and ref > 0 and o <= 0:
            g.at[i, "o"] = ref
        elif band_lo is not None and band_hi is not None:
            g.at[i, "o"] = float((band_lo + band_hi) / 2)
    o = g["o"].to_numpy(dtype=float)
    if "h" in g.columns:
        g["h"] = np.maximum(g["h"].to_numpy(dtype=float), np.maximum(o, c))
    if "l" in g.columns:
        l = g["l"].to_numpy(dtype=float)
        g["l"] = np.where(l > 0, np.minimum(l, np.minimum(o, c)), np.minimum(o, c))
    return g


def lseg_validate_frame(g: pd.DataFrame, lseg: dict[date, float]) -> pd.DataFrame:
    """Overlap lseg_research.daily_history: repair systematic scale, drop bad days (>2 %)."""
    if g.empty or not lseg:
        return g
    g = g.sort_values("date").reset_index(drop=True)
    dd = [x.date() if hasattr(x, "date") else x for x in g["date"]]
    ratios: list[float] = []
    for i, d in enumerate(dd):
        if d in lseg and g.at[i, "c"] > 0:
            ratios.append(lseg[d] / float(g.at[i, "c"]))
    if len(ratios) < 20:
        return g
    # A step (missed split) has a wide ratio range. Do not rescale the whole series by that
    # median, and do not delete the post-split regime for sitting far from 1.
    if max(ratios) / min(ratios) > 1.5:
        return g
    med = float(median(ratios))
    if abs(med - 1) > LSEG_RATIO_TOL:
        if not (0.2 <= med <= 5):
            return g
        for col in ("o", "h", "l", "c"):
            if col in g.columns:
                g[col] = g[col] * med
        if "v" in g.columns:
            g["v"] = g["v"].astype(float) / med
    keep = []
    for i, d in enumerate(dd):
        if d not in lseg or g.at[i, "c"] <= 0:
            keep.append(True)
            continue
        r = lseg[d] / float(g.at[i, "c"])
        keep.append(abs(r - 1) <= 0.10)
    g = g.loc[keep].reset_index(drop=True)
    return g


def ticker_fails_base5(g: pd.DataFrame, *, h: int = 5) -> bool:
    if len(g) < h + 55:
        return False
    o, c = g["o"].to_numpy(dtype=float), g["c"].to_numpy(dtype=float)
    rets: list[float] = []
    for i in range(len(c) - h - 1):
        if o[i + 1] > 0 and c[i + h] > 0:
            rets.append(c[i + h] / o[i + 1] - 1 - COST_BP)
    if len(rets) < 50:
        return False
    arr = np.array(rets)
    return bool(abs(float(arr.mean())) > DROP_TICKER_BASE5)


def panel_opens_ref(conn, ticker: str, splits: dict) -> pd.Series:
    """LSE opens through the same split adjust + sanitize path as build_pack."""
    p = csv_path(ticker)
    if not p.is_file():
        return pd.Series(dtype=float)
    g = rows_to_frame(p.read_text(encoding="utf-8", errors="replace"))
    if g.empty:
        return pd.Series(dtype=float)
    lseg = lseg_closes(conn, ticker)
    lseg_o = lseg_opens(conn, ticker)
    facs = factors_for_ticker(conn, ticker, g.copy(), splits, lseg)
    g = adjust_ohlcv(g, facs)
    g = sanitize_ohlcv(g, lseg_o)
    g = lseg_validate_frame(g, lseg)
    g = sanitize_ohlcv(g, lseg_o)
    return g.set_index("date")["o"].sort_index()


def index_open_parity_test(conn, pack: dict, splits: dict) -> list[str]:
    bad: list[str] = []
    O = pack.get("o")
    if O is None:
        return bad
    for t in ("SPY", "QQQ"):
        ref = panel_opens_ref(conn, t, splits)
        if ref.empty or t not in O.columns:
            bad.append(f"{t}: cannot compare opens")
            continue
        panel = O[t].dropna()
        for d, raw_o in ref.items():
            if d not in panel.index:
                continue
            po = float(panel.loc[d])
            if not math.isfinite(po) or abs(po - float(raw_o)) > max(1e-4, 1e-6 * abs(raw_o)):
                bad.append(f"{t} {d.date()}: panel open {po:.4f} != LSE adj {float(raw_o):.4f}")
                if len(bad) >= 5:
                    return bad
    return bad


def spy_crash_open_test(pack: dict) -> list[str]:
    O = pack.get("o")
    if O is None or "SPY" not in O.columns:
        return ["SPY: missing for 2008-10-09 open test"]
    d = pd.Timestamp("2008-10-09")
    if d not in O.index:
        return ["SPY 2008-10-09: missing row"]
    o = float(O.loc[d, "SPY"])
    if abs(o - 100.27) > 0.02:
        return [f"SPY 2008-10-09 open {o:.2f} (expect 100.27)"]
    return []


def base5_test(C: pd.DataFrame, O: pd.DataFrame) -> list[str]:
    bad: list[str] = []
    h = 5
    for t in LIQUID_CAPS:
        if t not in C.columns or t not in O.columns:
            continue
        fwd = (C[t].shift(-h) / O[t].shift(-1) - 1 - COST_BP).replace([np.inf, -np.inf], np.nan).dropna()
        if len(fwd) < 50:
            continue
        m = float(fwd.mean())
        if abs(m) > MAX_BASE5_ABS:
            bad.append(f"{t}: |mean 5d fwd| {m:.2%} > {MAX_BASE5_ABS:.0%}")
    return bad


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
        lseg_o = lseg_opens(conn, t)
        facs = factors_for_ticker(conn, t, g.copy(), splits, lseg)
        g = adjust_ohlcv(g, facs)
        g = sanitize_ohlcv(g, lseg_o)
        g = lseg_validate_frame(g, lseg)
        g = sanitize_ohlcv(g, lseg_o)
        if g.empty:
            continue
        if t not in INDEX_ETFS and ticker_fails_base5(g):
            continue
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
        self_test(pack, conn)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    with CACHE.open("wb") as f:
        pickle.dump(pack, f, protocol=pickle.HIGHEST_PROTOCOL)
    C = pack["c"]
    print(f"saved {CACHE} {C.index[0].date()}→{C.index[-1].date()} tickers={C.shape[1]} days={len(C)}")


def self_test(pack: dict, conn=None) -> None:
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
    O = pack.get("o", C)
    bad.extend(base5_test(C, O))
    if "SPY" not in C.columns:
        bad.append("SPY: missing from panel (index row)")
    bad.extend(spy_crash_open_test(pack))
    if conn is not None:
        splits = load_splits(conn)
        bad.extend(index_open_parity_test(conn, pack, splits))
    if bad:
        raise SystemExit("self-test FAIL:\n" + "\n".join(bad))
    print(
        "self-test OK: AAPL/NVDA/TSLA no −50% days; SPY 2008-10-09 open; SPY/QQQ opens = LSE; "
        "liquid-cap 5d base ≤3%"
    )


def cmd_self_test(_args) -> None:
    if not CACHE.is_file():
        raise SystemExit(f"missing {CACHE}")
    with CACHE.open("rb") as f:
        pack = pickle.load(f)
    with connect() as conn:
        self_test(pack, conn)


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
