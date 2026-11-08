#!/usr/bin/env python3
"""A192 Part S3 — LSE OPRA 30m trades → per-contract daily IV (2025-10→).

  cd scripts/watchlist_sync && .venv/bin/python analysis/opra_backfill.py --probe
  .venv/bin/python analysis/opra_backfill.py --limit-tickers 5
  nohup .venv/bin/python analysis/opra_backfill.py >> ~/.fildi/logs/opra_backfill.log 2>&1 &
"""
from __future__ import annotations

import argparse
import math
import re
import sys
import time
from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from zoneinfo import ZoneInfo

import option_history as OH  # noqa: E402

HERE = Path(__file__).resolve().parent
SYNC = HERE.parent
ROOT = SYNC.parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SYNC))

from build_plan import connect  # noqa: E402
from lse_client import (  # noqa: E402
    export_options_csv,
    export_stock_csv,
    occ_symbol,
    parse_stock_minute_rows,
)
from s045_put_retest import bs_put, ncdf  # noqa: E402
from s075_skew_calibration import bs_call, delta as bs_delta_fn  # noqa: E402

NY = ZoneInfo("America/New_York")
START = date(2025, 10, 17)
CHAIN_OVERLAP = date(2026, 10, 8)
ROWS_DAILY_CAP = 11_000_000
CALLS_LOG_EVERY = 1000
TARGET_1600 = 16 * 60  # minutes from midnight NY

PROBE_TICKERS = ("AAPL", "HD", "TSLA")
DDL_PATH = SYNC / "migrations" / "optlab_opra_daily_iv.sql"


def ensure_schema(conn) -> None:
    for stmt in [s.strip() for s in DDL_PATH.read_text().split(";") if s.strip()]:
        conn.execute(stmt)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS optlab.bars_5m (
           ticker text NOT NULL, ts timestamptz NOT NULL, o float8, h float8, l float8, c float8, v float8,
           PRIMARY KEY (ticker, ts))"""
    )
    conn.commit()


def _load_tb() -> dict[date, float]:
    p = SYNC / "out" / "opt" / "dtb3.csv"
    out: dict[date, float] = {}
    if not p.is_file():
        return out
    for line in p.read_text().splitlines()[1:]:
        dd, v = line.split(",")
        if v not in ("", "."):
            out[date.fromisoformat(dd)] = float(v) / 100.0
    return out


def _r_at(tb: dict[date, float], d: date) -> float:
    if d in tb:
        return tb[d]
    ds = sorted(tb)
    if not ds:
        return 0.0
    i = bisect_right(ds, d) - 1
    return tb[ds[max(i, 0)]]


def _rows_today(conn) -> int:
    row = conn.execute(
        """SELECT COALESCE(SUM(n_bars), 0)::bigint FROM optlab.opra_fetch_log
           WHERE fetched_at::date = (now() AT TIME ZONE 'UTC')::date"""
    ).fetchone()
    return int(row[0] or 0)


def _implied_iv(side: str, S: float, K: float, T: float, px: float, r: float) -> float | None:
    if T <= 0 or px <= 0 or S <= 0 or K <= 0:
        return None
    lo, hi = 1e-4, 5.0
    for _ in range(48):
        mid = (lo + hi) / 2
        model = (bs_call if side == "call" else bs_put)(S, K, mid, T)
        if model > px:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def parse_options_bars(csv_text: str, *, intraday: bool) -> list[dict]:
    lines = [ln for ln in csv_text.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return []
    header = [h.strip().strip('"').lower() for h in lines[0].split(",")]
    idx = {h: i for i, h in enumerate(header)}
    out: list[dict] = []
    for ln in lines[1:]:
        parts = [p.strip().strip('"') for p in re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', ln)]
        if len(parts) < len(header):
            continue
        ts_raw = None
        for key in ("time", "timestamp", "datetime"):
            if key in idx and parts[idx[key]]:
                ts_raw = parts[idx[key]]
                break
        if not ts_raw and "date" in idx:
            ts_raw = parts[idx["date"]]
        if not ts_raw:
            continue
        try:
            if "T" in ts_raw or " " in ts_raw:
                ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
            else:
                ts = datetime.fromisoformat(ts_raw[:10]).replace(tzinfo=NY)
        except ValueError:
            continue

        def num(name: str) -> float | None:
            if name not in idx:
                return None
            try:
                v = float(parts[idx[name]])
                return v if math.isfinite(v) else None
            except ValueError:
                return None

        vol = num("volume") or 0
        trades = num("trades") or num("trade_count") or num("n_trades") or 0
        close = num("close")
        if close is None or close <= 0:
            continue
        if trades < 1 and vol < 1:
            continue
        out.append(
            {
                "ts": ts,
                "day": ts.astimezone(NY).date(),
                "close": close,
                "volume": int(vol),
                "trades": int(trades) if trades else int(vol > 0),
                "open": num("open"),
                "high": num("high"),
                "low": num("low"),
            }
        )
    if not intraday:
        by_day: dict[date, dict] = {}
        for r in out:
            by_day[r["day"]] = r
        return list(by_day.values())
    by_day: dict[date, list[dict]] = defaultdict(list)
    for r in out:
        by_day[r["day"]].append(r)
    daily: list[dict] = []
    for d, bars in by_day.items():
        best = None
        best_dist = 10**9
        for b in bars:
            local = b["ts"].astimezone(NY)
            mins = local.hour * 60 + local.minute
            if mins > TARGET_1600 + 30:
                continue
            dist = abs(mins - TARGET_1600)
            if dist < best_dist:
                best_dist = dist
                best = {**b, "ts": b["ts"]}
        if best is None:
            bars.sort(key=lambda x: x["ts"])
            best = bars[-1]
        daily.append(best)
    return daily


@dataclass(frozen=True)
class Contract:
    occ: str
    ticker: str
    expiry: date
    side: str
    strike: float


def top_universe(conn, n: int = 300) -> list[str]:
    rows = conn.execute(
        """SELECT ticker FROM option_chain_history
           WHERE as_of >= CURRENT_DATE - INTERVAL '10 days' AND volume > 0
           GROUP BY ticker ORDER BY SUM(volume) DESC NULLS LAST LIMIT %s""",
        (n,),
    ).fetchall()
    return [r[0] for r in rows]


def _spot_iv(conn, ticker: str, d: date) -> tuple[float | None, float | None]:
    row = conn.execute(
        """SELECT close::float8, iv30_call::float8 FROM lseg_research.daily_history
           WHERE ticker = %s AND date = %s AND close > 0""",
        (ticker, d),
    ).fetchone()
    if not row:
        row = conn.execute(
            """SELECT close::float8, iv30::float8 FROM lseg_research.daily_history
               WHERE ticker = %s AND date <= %s AND close > 0 ORDER BY date DESC LIMIT 1""",
            (ticker, d),
        ).fetchone()
    if not row:
        return None, None
    spot, iv = float(row[0]), row[1]
    if iv and iv > 3:
        iv /= 100.0
    return spot, iv


def list_expiries(ticker: str, d0: date, d1: date) -> list[date]:
    """Monthly third-Friday-ish + weekly nearest each Friday's +30d target."""
    exps: set[date] = set()
    d = d0
    while d <= d1:
        if d.weekday() == 4:  # Friday
            target = d + timedelta(days=30)
            exps.add(target.replace(day=min(target.day, 28)))
        d += timedelta(days=1)
    # standard monthlies: 3rd Friday approximation — take Fridays in month
    cur = d0.replace(day=1)
    while cur <= d1:
        fri = [cur + timedelta(days=i) for i in range(31) if (cur + timedelta(days=i)).month == cur.month]
        fris = [x for x in fri if x.weekday() == 4]
        if len(fris) >= 3:
            exps.add(fris[2])
        elif fris:
            exps.add(fris[-1])
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return sorted(e for e in exps if d0 <= e <= d1 + timedelta(days=60))


def strikes_for_expiry(conn, ticker: str, exp: date, ref: date) -> list[tuple[str, float]]:
    spot, iv = _spot_iv(conn, ticker, ref)
    if not spot or not iv:
        return []
    T = max((exp - ref).days, 1) / 365.0
    lo_d, hi_d = 0.05, 0.60
    if exp >= CHAIN_OVERLAP:
        rows = conn.execute(
            """SELECT DISTINCT side, strike::float8, delta::float8 FROM option_chain_history
               WHERE ticker = %s AND expiry = %s AND as_of >= %s AND strike > 0""",
            (ticker, exp, CHAIN_OVERLAP),
        ).fetchall()
        out = []
        for side, k, delt in rows:
            ad = abs(delt) if delt is not None else None
            if ad is not None and lo_d <= ad <= hi_d:
                out.append((str(side).lower(), float(k)))
        if out:
            return out
    listed = OH.chain(conn, ticker, exp, spot)
    out = []
    for c in listed:
        side = c["type"]
        k = float(c["strike"])
        d_abs = abs(bs_delta_fn(spot, k, iv, T, side))
        if lo_d <= d_abs <= hi_d:
            out.append((side, k))
    return out


def build_contracts(conn, tickers: list[str], d1: date) -> list[Contract]:
    out: list[Contract] = []
    seen: set[str] = set()
    for t in tickers:
        exps = conn.execute(
            """SELECT DISTINCT expiry FROM option_chain_history
               WHERE ticker = %s AND expiry >= %s AND expiry <= %s ORDER BY expiry DESC""",
            (t, START, d1),
        ).fetchall()
        if not exps:
            exps = [(e,) for e in list_expiries(t, START, d1)]
        for (exp,) in exps[:24]:
            ref = min(exp - timedelta(days=14), d1)
            for side, strike in strikes_for_expiry(conn, t, exp, ref):
                occ = occ_symbol(t, exp, strike, side)
                if occ in seen:
                    continue
                seen.add(occ)
                out.append(Contract(occ, t.upper(), exp, side, strike))
    out.sort(key=lambda c: (c.expiry, c.ticker), reverse=True)
    return out


def stock_bar_at(conn, ticker: str, ts: datetime) -> float | None:
    d = ts.astimezone(NY).date()
    row = conn.execute(
        """SELECT c::float8 FROM optlab.bars_5m WHERE ticker = %s AND ts = %s""",
        (ticker, ts),
    ).fetchone()
    if row and row[0]:
        return float(row[0])
    row = conn.execute(
        """SELECT c::float8 FROM optlab.bars_5m WHERE ticker = %s AND ts::date = %s
           ORDER BY ABS(EXTRACT(EPOCH FROM (ts - %s))) LIMIT 1""",
        (ticker, d, ts),
    ).fetchone()
    if row and row[0]:
        return float(row[0])
    row = conn.execute(
        """SELECT close::float8 FROM lseg_research.daily_history WHERE ticker = %s AND date = %s""",
        (ticker, d),
    ).fetchone()
    return float(row[0]) if row and row[0] else None


def cache_stock_30m(conn, ticker: str, d0: date, d1: date) -> None:
    status, body = export_stock_csv(conn, ticker, date_from=d0, date_to=d1, timeframe="30m")
    if status != 200 or '"time"' not in body.lstrip()[:80].lower():
        return
    rows = parse_stock_minute_rows(body)
    for r in rows:
        try:
            ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00"))
        except (TypeError, ValueError, KeyError):
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        conn.execute(
            """INSERT INTO optlab.bars_5m (ticker, ts, o, h, l, c, v) VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (ticker, ts) DO NOTHING""",
            (ticker, ts, r.get("open"), r.get("high"), r.get("low"), r.get("close"), r.get("volume")),
        )
    conn.commit()


def fetch_contract(conn, c: Contract, tb: dict[date, float], rows_today: int, calls: int) -> tuple[str, int, int]:
    if rows_today >= ROWS_DAILY_CAP:
        return "rows_cap", rows_today, calls
    done = conn.execute(
        """SELECT status FROM optlab.opra_fetch_log WHERE occ = %s AND date_from = %s AND date_to = %s""",
        (c.occ, START, c.expiry),
    ).fetchone()
    if done and done[0] in ("ok", "no_data", "rows_cap", "rows_exhausted"):
        return done[0], rows_today, calls

    d0 = max(START, c.expiry - timedelta(days=120))
    status, body = export_options_csv(conn, c.occ, date_from=d0, date_to=c.expiry, timeframe="30m")
    calls += 1
    if status == 429 and b"rows-exhausted" in body.encode():
        conn.execute(
            """INSERT INTO optlab.opra_fetch_log VALUES (%s,%s,%s,'rows_exhausted',0,now())
               ON CONFLICT (occ, date_from, date_to) DO UPDATE SET status='rows_exhausted', fetched_at=now()""",
            (c.occ, START, c.expiry),
        )
        conn.commit()
        return "rows_exhausted", rows_today, calls
    if status == 404 or "unavailable" in body.lower():
        conn.execute(
            """INSERT INTO optlab.opra_fetch_log VALUES (%s,%s,%s,'no_data',0,now())
               ON CONFLICT DO NOTHING""",
            (c.occ, START, c.expiry),
        )
        conn.commit()
        return "no_data", rows_today, calls
    if status != 200 or '"time"' not in body.lstrip()[:60].lower():
        conn.execute(
            """INSERT INTO optlab.opra_fetch_log VALUES (%s,%s,%s,%s,0,now()) ON CONFLICT DO NOTHING""",
            (c.occ, START, c.expiry, f"http_{status}"),
        )
        conn.commit()
        return f"http_{status}", rows_today, calls

    bars = parse_options_bars(body, intraday=True)
    rows_today += len(bars)
    if bars:
        d0b, d1b = min(b["day"] for b in bars), max(b["day"] for b in bars)
        cache_stock_30m(conn, c.ticker, d0b, d1b)

    n_ins = 0
    for b in bars:
        S = stock_bar_at(conn, c.ticker, b["ts"])
        if not S:
            continue
        T = max((c.expiry - b["day"]).days, 0) / 365.0
        if T < 1 / 365:
            continue
        r = _r_at(tb, b["day"])
        iv = _implied_iv(c.side, S, c.strike, T, b["close"], r)
        if not iv or not (0.01 <= iv <= 3.0):
            continue
        delt = bs_delta_fn(S, c.strike, iv, T, c.side)
        flags = []
        conn.execute(
            """INSERT INTO optlab.opra_daily_iv
               (occ, ticker, expiry, side, strike, date, bar_ts, opt_px, stock_px, iv, delta, volume, trades, flags)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (occ, date) DO UPDATE SET opt_px=EXCLUDED.opt_px, stock_px=EXCLUDED.stock_px,
                 iv=EXCLUDED.iv, delta=EXCLUDED.delta, volume=EXCLUDED.volume, trades=EXCLUDED.trades, fetched_at=now()""",
            (
                c.occ,
                c.ticker,
                c.expiry,
                c.side,
                c.strike,
                b["day"],
                b["ts"],
                b["close"],
                S,
                iv,
                delt,
                b["volume"],
                b["trades"],
                ",".join(flags) or None,
            ),
        )
        n_ins += 1
    conn.execute(
        """INSERT INTO optlab.opra_fetch_log VALUES (%s,%s,%s,'ok',%s,now())
           ON CONFLICT (occ, date_from, date_to) DO UPDATE SET status='ok', n_bars=EXCLUDED.n_bars, fetched_at=now()""",
        (c.occ, START, c.expiry, n_ins),
    )
    conn.commit()
    return "ok", rows_today, calls


def _listed_strike(conn, ticker: str, exp: date, side: str, strike: float, spot: float | None) -> bool:
    if exp >= CHAIN_OVERLAP:
        row = conn.execute(
            """SELECT 1 FROM option_chain_history
               WHERE ticker=%s AND expiry=%s AND side=%s AND ABS(strike::float8 - %s) < 0.02 LIMIT 1""",
            (ticker, exp, side, strike),
        ).fetchone()
        return row is not None
    listed = OH.chain(conn, ticker, exp, spot)
    return any(c["type"] == side and abs(float(c["strike"]) - strike) < 0.02 for c in listed)


def probe_contract_coverage(conn, tickers: tuple[str, ...]) -> tuple[float, int, int]:
    """Return found/requested ratio for 2 past expiries per ticker."""
    requested = 0
    found = 0
    for t in tickers:
        exps = conn.execute(
            """SELECT DISTINCT expiry FROM option_chain_history
               WHERE ticker = %s AND expiry >= %s AND expiry < CURRENT_DATE
               ORDER BY expiry DESC LIMIT 2""",
            (t, START),
        ).fetchall()
        if len(exps) < 2:
            exps = [(e,) for e in list_expiries(t, START, date.today())[-2:]]
        for (exp,) in exps[:2]:
            ref = exp - timedelta(days=7)
            spot, _ = _spot_iv(conn, t, ref)
            strikes = strikes_for_expiry(conn, t, exp, ref)
            requested += len(strikes)
            for side, strike in strikes:
                if _listed_strike(conn, t, exp, side, strike, spot):
                    found += 1
    ratio = found / requested if requested else 0.0
    return ratio, found, requested


def probe_iv_vs_schwab(conn) -> tuple[float | None, int]:
    diffs: list[float] = []
    rows = conn.execute(
        """SELECT o.ticker, o.expiry, o.side, o.strike, o.date, o.iv, o.delta
           FROM optlab.opra_daily_iv o
           WHERE o.date >= %s AND o.iv > 0 AND ABS(o.delta) BETWEEN 0.15 AND 0.50
           LIMIT 500""",
        (CHAIN_OVERLAP,),
    ).fetchall()
    for t, exp, side, k, d, iv, delt in rows:
        sch = conn.execute(
            """SELECT iv::float8 FROM option_chain_history
               WHERE ticker=%s AND expiry=%s AND side=%s AND as_of=%s
                 AND ABS(strike::float8 - %s) < 0.02 AND iv > 0
               ORDER BY ABS(strike::float8 - %s) LIMIT 1""",
            (t, exp, side, d, k, k),
        ).fetchone()
        if not sch or not sch[0]:
            continue
        sv = float(sch[0])
        if sv > 3:
            sv /= 100.0
        diffs.append(abs(iv - sv) * 100)
    med = median(diffs) if diffs else None
    return med, len(diffs)


def run_probe(conn) -> bool:
    print("SANITY probe: contract coverage + IV vs Schwab (≤2 min slice)", flush=True)
    ratio, found, req = probe_contract_coverage(conn, PROBE_TICKERS)
    print(f"SANITY contracts found/requested={found}/{req} ({ratio:.1%})", flush=True)
    if req and ratio < 0.80:
        print("SANITY FAIL: contract coverage < 80%", flush=True)
        return False

    tb = _load_tb()
    contracts = []
    for t in PROBE_TICKERS:
        exps = conn.execute(
            """SELECT DISTINCT expiry FROM option_chain_history
               WHERE ticker = %s AND expiry >= %s AND expiry < CURRENT_DATE
               ORDER BY expiry DESC LIMIT 2""",
            (t, START),
        ).fetchall()
        for (exp,) in exps[:2]:
            for side, strike in strikes_for_expiry(conn, t, exp, exp - timedelta(days=7))[:4]:
                contracts.append(Contract(occ_symbol(t, exp, strike, side), t, exp, side, strike))

    rows_today = _rows_today(conn)
    calls = 0
    bar_counts: list[int] = []
    for c in contracts[: min(12, len(contracts))]:
        st, rows_today, calls = fetch_contract(conn, c, tb, rows_today, calls)
        n = conn.execute(
            "SELECT COUNT(*) FROM optlab.opra_daily_iv WHERE occ=%s", (c.occ,)
        ).fetchone()[0]
        bar_counts.append(int(n))
        print(f"SANITY fetch {c.ticker} {c.expiry} {c.side} {c.strike}: {st} rows={n}", flush=True)

    med_iv, n_ov = probe_iv_vs_schwab(conn)
    rpc = median(bar_counts) if bar_counts else 0
    uni_n = len(top_universe(conn, 300))
    est_contracts = uni_n * 40  # rough
    api_days = est_contracts / (55 * 60 * 16) if est_contracts else float("nan")  # ~55 calls/min, ~16h/day
    row_days = (est_contracts * max(rpc, 1)) / ROWS_DAILY_CAP if rpc else float("nan")
    proj_days = max(api_days, row_days)
    print(f"SANITY IV med abs diff vs Schwab={med_iv:.2f} vol pt n={n_ov}" if med_iv else f"SANITY IV overlap n={n_ov}", flush=True)
    print(f"SANITY rows/contract median={rpc:.0f} projected_days_300={proj_days:.1f}", flush=True)

    if n_ov >= 3 and med_iv is not None and med_iv > 2.0:
        print("SANITY FAIL: IV vs Schwab > 2 vol pts", flush=True)
        return False
    if req and ratio >= 0.80:
        print("SANITY gate PASS", flush=True)
        return True
    return n_ov >= 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--limit-tickers", type=int, default=0)
    ap.add_argument("--limit-contracts", type=int, default=0)
    args = ap.parse_args()

    with connect() as conn:
        ensure_schema(conn)
        if args.probe:
            ok = run_probe(conn)
            sys.exit(0 if ok else 2)

        tickers = top_universe(conn, args.limit_tickers or 300)
        tb = _load_tb()
        rows_today = _rows_today(conn)
        calls = 0
        planned = 0
        t0 = time.time()
        for t in tickers:
            batch = build_contracts(conn, [t], date.today())
            if args.limit_contracts and planned >= args.limit_contracts:
                break
            for c in batch:
                if args.limit_contracts and planned >= args.limit_contracts:
                    break
                planned += 1
                if rows_today >= ROWS_DAILY_CAP:
                    print(f"STOP rows_cap {rows_today}", flush=True)
                    break
                st, rows_today, calls = fetch_contract(conn, c, tb, rows_today, calls)
                if st == "rows_exhausted":
                    print("STOP rows_exhausted until UTC midnight", flush=True)
                    break
                if calls == 1:
                    print(
                        f"FIRST full-run line: ticker={c.ticker} occ={c.occ} status={st} elapsed={time.time()-t0:.0f}s",
                        flush=True,
                    )
                if calls and calls % CALLS_LOG_EVERY == 0:
                    print(
                        f"meter calls={calls} rows_today={rows_today} occ={c.occ} status={st} elapsed={time.time()-t0:.0f}s",
                        flush=True,
                    )
            if rows_today >= ROWS_DAILY_CAP or (calls and st == "rows_exhausted"):
                break
        print(
            f"done planned={planned} tickers={len(tickers)} calls={calls} rows_today={rows_today} elapsed={time.time()-t0:.0f}s",
            flush=True,
        )


if __name__ == "__main__":
    main()
