"""S155 — indicator signals priced with REAL option trades (Polygon minute bars), not a model (Claude 11-04).

Why: S152/S154 priced options from a once-a-day chain snapshot (stale quotes, OTM-only store, ~25 % spreads).
Here every entry/exit is the first real option print after the signal / exit time on the ATM call and put
(nearest listed expiry >= 2 DTE, strike nearest the 9:35 spot) of that ticker-day.

Comparator: every 5m bar of the SAME ticker-day as an entry (same contracts, same day vol) -> paired lift.
Structures: long straddle, short straddle, long call/put in the signal direction, and the mirror (fade).
Holds: 30m, 60m, close (15:50 ET). P&L = % of entry premium, gross of spread; break-even spread = lift.
Stats: per ticker-day mean lift, t across ticker-days, both calendar halves, Holm over all cells.
Polygon free tier 5 calls/min -> 13 s gap; raw responses stored in vendor_raw (source polygon).

Run: scripts/watchlist_sync/.venv/bin/python research/studies/scripts/s155_real_option_marks.py [--days N] [--smoke]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts" / "watchlist_sync"))
from build_plan import connect  # noqa: E402

NY = ZoneInfo("America/New_York")
INDS = ("ut", "st", "ichimoku", "lsh", "squeeze", "mso")
HOLDS = {"30m": 30, "60m": 60, "close": None}
STRUCTS = ("long_straddle", "short_straddle", "long_dir", "long_fade")
MAX_STALE_S = 600  # first print must be within 10 min of the target time
GAP_S = 13.0
OUT_JSON = ROOT / "research" / "studies" / "out" / "S155" / "cells.json"
OUT_TRADES = ROOT / "research" / "studies" / "out" / "S155" / "trades.json"
CACHE = ROOT / "research" / "cache" / "polygon_options" / "s155"

_last_call = [0.0]


def _key() -> str:
    k = os.environ.get("POLYGON_API_KEY")
    if not k:
        for line in (ROOT / ".env.local").read_text().splitlines():
            if line.startswith("POLYGON_API_KEY="):
                k = line.split("=", 1)[1].strip().strip('"')
    if not k:
        raise SystemExit("POLYGON_API_KEY missing")
    return k


def poly(conn, path: str, cache_name: str) -> dict:
    """GET with file cache + vendor_raw; 13 s gap; retry 429 with backoff; 30 s deadline per call."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{cache_name}.json"
    if f.exists():
        return json.loads(f.read_text())
    url = f"https://api.polygon.io{path}{'&' if '?' in path else '?'}apiKey={_key()}"
    for attempt in range(5):
        wait = GAP_S - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(30 * (attempt + 1))
                continue
            body = {"status": f"HTTP {e.code}", "results": []}
        except Exception as e:  # network
            body = {"status": f"ERR {e}", "results": []}
            time.sleep(10)
            continue
        f.write_text(json.dumps(body))
        payload = json.dumps(body)
        conn.execute(
            "INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha) VALUES (%s,%s,%s,%s,%s,%s)",
            ("polygon", path.split("?")[0], cache_name, date.today(), payload, hashlib.sha1(payload.encode()).hexdigest()),
        )
        conn.commit()
        return body
    return {"status": "gave up", "results": []}


def pick_contracts(conn, tk: str, day: date, spot: float) -> tuple[str, str, float, date] | None:
    exp_lo, exp_hi = day + timedelta(days=2), day + timedelta(days=21)
    path = (f"/v3/reference/options/contracts?underlying_ticker={tk}&as_of={day}&expiration_date.gte={exp_lo}"
            f"&expiration_date.lte={exp_hi}&strike_price.gte={spot * 0.9:.2f}&strike_price.lte={spot * 1.1:.2f}"
            f"&limit=1000&sort=expiration_date&order=asc")
    body = poly(conn, path, f"ref_{tk}_{day}")
    rows = body.get("results") or []
    if not rows:
        return None
    exp = min(date.fromisoformat(r["expiration_date"]) for r in rows)
    same = [r for r in rows if r["expiration_date"] == exp.isoformat()]
    strikes = {}
    for r in same:
        strikes.setdefault(r["strike_price"], {})[r["contract_type"]] = r["ticker"]
    both = [k for k, v in strikes.items() if "call" in v and "put" in v]
    if not both:
        return None
    k = min(both, key=lambda x: abs(x - spot))
    return strikes[k]["call"], strikes[k]["put"], float(k), exp


def minute_prints(conn, contract: str, day: date) -> list[tuple[int, float]]:
    body = poly(conn, f"/v2/aggs/ticker/{contract}/range/1/minute/{day}/{day}?adjusted=true&sort=asc&limit=50000",
                f"min_{contract.replace(':', '_')}_{day}")
    return [(int(r["t"] // 1000), float(r["o"])) for r in (body.get("results") or []) if r.get("o")]


def first_print(prints: list[tuple[int, float]], t: int) -> float | None:
    for ts, px in prints:
        if ts >= t:
            return px if ts - t <= MAX_STALE_S else None
    return None


def et(d: date, hh: int, mm: int) -> int:
    return int(datetime(d.year, d.month, d.day, hh, mm, tzinfo=NY).timestamp())


def trade_pnls(call: list, put: list, t0: int, t1: int, side: str) -> dict[str, float] | None:
    c0, p0, c1, p1 = first_print(call, t0), first_print(put, t0), first_print(call, t1), first_print(put, t1)
    if None in (c0, p0, c1, p1) or c0 < 0.05 or p0 < 0.05:
        return None
    straddle = (c1 + p1 - c0 - p0) / (c0 + p0) * 100.0
    call_r, put_r = (c1 - c0) / c0 * 100.0, (p1 - p0) / p0 * 100.0
    d, f = (call_r, put_r) if side == "buy" else (put_r, call_r)
    return {"long_straddle": straddle, "short_straddle": -straddle, "long_dir": d, "long_fade": f}


def tstat(xs: list[float]) -> tuple[float, float]:
    n = len(xs)
    if n < 3:
        return float("nan"), float("nan")
    m = mean(xs)
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1))
    t = m / (sd / math.sqrt(n)) if sd > 0 else float("nan")
    p = math.erfc(abs(t) / math.sqrt(2)) if math.isfinite(t) else float("nan")
    return t, p


def holm(ps: list[float]) -> list[float]:
    order = sorted(range(len(ps)), key=lambda i: ps[i] if math.isfinite(ps[i]) else 9)
    out, prev, m = [1.0] * len(ps), 0.0, len(ps)
    for rank, i in enumerate(order):
        v = min(1.0, (ps[i] if math.isfinite(ps[i]) else 1.0) * (m - rank))
        prev = max(prev, v)
        out[i] = prev
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=120, help="ticker-days to sample")
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    n_days = 3 if a.smoke else a.days
    conn = connect()
    ev = conn.execute(
        """SELECT indicator_id, ticker, time, side FROM indicator_events
           WHERE tf = '5m' AND side IN ('buy','sell') AND indicator_id = ANY(%s) AND time >= now() - interval '55 days'
           ORDER BY time""", (list(INDS),)).fetchall()
    by_td: dict[tuple[str, date], list] = defaultdict(list)
    for ind, tk, ts, side in ev:
        lt = ts.astimezone(NY)
        if (lt.hour, lt.minute) < (9, 35) or (lt.hour, lt.minute) > (15, 0):
            continue
        by_td[(tk, lt.date())].append((ind, int(ts.timestamp()) + 300, side))  # signal known at bar end
    # deterministic round-robin sample across tickers
    per_tk: dict[str, list] = defaultdict(list)
    for k in sorted(by_td, key=lambda k: hashlib.md5(f"s155|{k[0]}|{k[1]}".encode()).hexdigest()):
        per_tk[k[0]].append(k)
    sample, i = [], 0
    while len(sample) < n_days and any(per_tk.values()):
        for tk in sorted(per_tk):
            if per_tk[tk] and len(sample) < n_days:
                sample.append(per_tk[tk].pop(0))
    print(f"events {len(ev)} ticker-days {len(by_td)} sampled {len(sample)}", flush=True)

    trades = []  # (kind, ind, tk, day, hold, struct, pnl)
    priced_days = 0
    for n, (tk, day) in enumerate(sample, 1):
        b = conn.execute("SELECT c FROM optlab.bars_5m WHERE ticker=%s AND ts >= %s AND ts < %s ORDER BY ts LIMIT 1",
                         (tk, datetime(day.year, day.month, day.day, 9, 35, tzinfo=NY),
                          datetime(day.year, day.month, day.day, 16, 0, tzinfo=NY))).fetchone()
        if not b:
            continue
        spot = float(b[0])
        pc = pick_contracts(conn, tk, day, spot)
        if not pc:
            print(f"[{n}/{len(sample)}] {tk} {day} no contracts", flush=True)
            continue
        cT, pT, K, exp = pc
        call, put = minute_prints(conn, cT, day), minute_prints(conn, pT, day)
        if len(call) < 20 or len(put) < 20:
            print(f"[{n}/{len(sample)}] {tk} {day} thin prints {len(call)}/{len(put)}", flush=True)
            continue
        priced_days += 1
        close_t = et(day, 15, 50)
        grid = [et(day, 9, 40) + 300 * j for j in range(0, 64)]
        grid = [g for g in grid if g <= et(day, 15, 0)]
        for hold, mins in HOLDS.items():
            for g in grid:
                t1 = close_t if mins is None else g + 60 * mins
                if t1 > close_t:
                    continue
                for side in ("buy", "sell"):
                    r = trade_pnls(call, put, g, t1, side)
                    if r:
                        for s, v in r.items():
                            trades.append(("base", side, tk, day.isoformat(), hold, s, v, g))
            for ind, t0, side in by_td[(tk, day)]:
                t1 = close_t if mins is None else t0 + 60 * mins
                if t1 > close_t:
                    continue
                r = trade_pnls(call, put, t0, t1, side)
                if r:
                    for s, v in r.items():
                        trades.append(("sig", ind + "|" + side, tk, day.isoformat(), hold, s, v, t0))
        print(f"[{n}/{len(sample)}] {tk} {day} K={K} exp={exp} prints {len(call)}/{len(put)}", flush=True)

    # paired lift per ticker-day: signal mean - same-day base mean (same side, hold, structure)
    base = defaultdict(list)
    for kind, lab, tk, d, hold, s, v, _ in trades:
        if kind == "base":
            base[(tk, d, hold, s, lab)].append(v)
    cells = defaultdict(lambda: defaultdict(list))
    for kind, lab, tk, d, hold, s, v, _ in trades:
        if kind != "sig":
            continue
        ind, side = lab.split("|")
        bm = base.get((tk, d, hold, s, side))
        if bm:
            cells[(ind, s, hold)][(tk, d)].append((v, v - mean(bm), mean(bm)))
    rows = []
    for (ind, s, hold), per in cells.items():
        day_lift = [mean(x[1] for x in v) for v in per.values()]
        days_sorted = sorted(per)
        mid = days_sorted[len(days_sorted) // 2][1] if days_sorted else None
        h1 = [mean(x[1] for x in v) for k, v in per.items() if k[1] < mid] if mid else []
        h2 = [mean(x[1] for x in v) for k, v in per.items() if k[1] >= mid] if mid else []
        t, p = tstat(day_lift)
        allv = [x for v in per.values() for x in v]
        rows.append({
            "ind": ind, "structure": s, "hold": hold, "n_trades": len(allv), "n_days": len(per),
            "sig_mean": mean(x[0] for x in allv), "base_mean": mean(x[2] for x in allv),
            "lift": mean(day_lift), "t": t, "p": p,
            "h1": mean(h1) if h1 else float("nan"), "h2": mean(h2) if h2 else float("nan"),
        })
    for r, ph in zip(rows, holm([r["p"] for r in rows])):
        r["p_holm"] = ph
        r["pass"] = bool(r["n_days"] >= 30 and ph < 0.05 and r["lift"] > 0
                         and r["h1"] > 0 and r["h2"] > 0)
    rows.sort(key=lambda r: -abs(r["t"]) if math.isfinite(r["t"]) else 0)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(rows, indent=1, default=str))
    OUT_TRADES.write_text(json.dumps(trades[:200000], default=str))
    # base-rate table: what the structures do on any bar (no signal)
    bt = defaultdict(list)
    for kind, lab, tk, d, hold, s, v, _ in trades:
        if kind == "base" and lab == "buy":
            bt[(s, hold)].append(v)
    print(f"priced ticker-days {priced_days}; trades {len(trades)}; cells {len(rows)}; pass {sum(r['pass'] for r in rows)}")
    print("BASE (any bar, gross % of premium): " + "; ".join(
        f"{s} {h} {mean(v):+.1f} (n {len(v)})" for (s, h), v in sorted(bt.items()) if s in ("long_straddle", "long_dir")))
    for r in rows[:12]:
        print(f"{r['ind']:9s} {r['structure']:14s} {r['hold']:5s} days {r['n_days']:3d} n {r['n_trades']:4d} "
              f"sig {r['sig_mean']:+6.1f} base {r['base_mean']:+6.1f} lift {r['lift']:+5.1f} t {r['t']:+.2f} "
              f"h1 {r['h1']:+.1f} h2 {r['h2']:+.1f} holm {r['p_holm']:.3f} {'PASS' if r['pass'] else ''}")


if __name__ == "__main__":
    main()
