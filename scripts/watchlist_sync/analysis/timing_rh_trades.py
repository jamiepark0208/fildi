"""Does the trader's entry timing work? Sell puts after a drop / near support, calls after a rally.

For every filled sell-to-open option order (Robinhood, deduped by order_id) we measure the setup the day before entry
and the outcome at expiry, then compare with the SAME strike distance on the SAME ticker sold on every other day
(baseline). If timing helps, puts sold after drops should end in the money less often than baseline, and calls sold
after rallies should get run over less often.

  setup (close of the day before entry, no look-ahead): 5-day return, RSI(14), distance above the 20-day low
  outcome: stock at expiry close vs strike (breach = ITM), P&L at expiry per collateral = (premium − intrinsic) / strike
  baseline: for the same ticker, every trading day t in 2026: P(close[t+h] breaches close[t] × (1 ∓ otm)), same h (days)

    .venv/bin/python analysis/timing_rh_trades.py        # writes out/timing/report.md
"""
from __future__ import annotations

import sys
from bisect import bisect_left
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from statistics import mean
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "out" / "timing"
ET = ZoneInfo("America/New_York")
ACCOUNTS = {"772445425": "IRA", "5QU47796": "FILDI"}


def rsi(closes: list[float], n: int = 14) -> float | None:
    if len(closes) <= n:
        return None
    gains = [max(closes[i] - closes[i - 1], 0) for i in range(len(closes) - n, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0) for i in range(len(closes) - n, len(closes))]
    g, l = mean(gains), mean(losses)
    return 100.0 if l == 0 else 100 - 100 / (1 + g / l)


def load(conn):
    orders = rows(conn, """SELECT DISTINCT ON (order_id) order_id, account, symbol, option_side, option_strike, option_expiration,
                                  avg_fill_price, created_at
                           FROM portfolio_orders
                           WHERE is_option AND leg_effect = 'open' AND leg_side = 'sell' AND state = 'filled'
                             AND avg_fill_price > 0 AND option_strike > 0
                           ORDER BY order_id, snapshot_id DESC""")
    tickers = sorted({o["symbol"] for o in orders})
    px: dict[str, list[tuple[date, float, float]]] = defaultdict(list)
    for r in rows(conn, """SELECT ticker, date, low, close FROM prices_historical
                           WHERE ticker = ANY(%s) AND date >= '2025-10-01' ORDER BY ticker, date""", (tickers,)):
        if r["close"]:
            px[r["ticker"]].append((r["date"], float(r["close"]), float(r["low"] or r["close"])))
    return orders, px


def trades(orders, px):
    for o in orders:
        series = px.get(o["symbol"])
        if not series:
            continue
        dates = [d for d, _, _ in series]
        closes = [c for _, c, _ in series]
        d0 = o["created_at"].astimezone(ET).date()
        i = bisect_left(dates, d0)  # index of entry day (or next trading day)
        exp = o["option_expiration"]
        j = bisect_left(dates, exp)
        if i < 21 or j >= len(dates) or dates[j] != exp or i >= len(dates):
            continue  # need history before and a close at expiry
        prev = closes[i - 1]
        k, prem, side = float(o["option_strike"]), float(o["avg_fill_price"]), o["option_side"]
        st = closes[j]
        intrinsic = max(k - st, 0) if side == "put" else max(st - k, 0)
        yield {
            "account": ACCOUNTS.get(o["account"], o["account"]), "side": side, "ticker": o["symbol"], "d0": d0, "i": i, "j": j,
            "ret5": prev / closes[i - 6] - 1, "rsi": rsi(closes[: i]),
            "above_low20": prev / min(l for _, _, l in series[i - 20:i]) - 1,
            "otm": (1 - k / prev) if side == "put" else (k / prev - 1), "h": j - i + 1,
            "breach": intrinsic > 0, "pnl": (prem - intrinsic) / k, "prem": prem / k,
        }


def baseline_breach(px, t: dict) -> float | None:
    """Share of all 2026 entry days on this ticker where the same-distance strike, same holding days, ended ITM."""
    closes = [c for d, c, _ in px[t["ticker"]] if d >= date(2026, 1, 1) - timedelta(days=1)]
    h, otm = t["h"], t["otm"]
    hits = [(closes[s - 1 + h] < closes[s - 1] * (1 - otm)) if t["side"] == "put" else (closes[s - 1 + h] > closes[s - 1] * (1 + otm))
            for s in range(1, len(closes) - h + 1)]
    return mean(hits) if hits else None


def bucket_put(t):
    r = t["ret5"]
    return "dropped ≥8% in 5d" if r <= -0.08 else "dropped 3–8%" if r <= -0.03 else "flat / up (no dip)"


def bucket_call(t):
    r = t["ret5"]
    return "rallied ≥8% in 5d" if r >= 0.08 else "rallied 3–8%" if r >= 0.03 else "flat / down (no rally)"


def bucket_rsi(t):
    v = t["rsi"]
    return "n/a" if v is None else "RSI < 35" if v < 35 else "RSI 35–50" if v < 50 else "RSI 50–65" if v < 65 else "RSI ≥ 65"


def bucket_support(t):
    a = t["above_low20"]
    return "within 3% of 20d low" if a <= 0.03 else "3–10% above" if a <= 0.10 else ">10% above 20d low"


def table(ts, key, title):
    g = defaultdict(list)
    for t in ts:
        g[key(t)].append(t)
    out = [f"### {title}", "", "| setup | trades | median OTM | breach rate | baseline breach (same OTM, random day) | "
           "timing edge | P&L per collateral (mean) | worst |", "|---|---|---|---|---|---|---|---|"]
    for k in sorted(g):
        xs = g[k]
        b = mean(x["base"] for x in xs)
        br = mean(x["breach"] for x in xs)
        otm = sorted(x["otm"] for x in xs)[len(xs) // 2]
        out.append(f"| {k} | {len(xs)} | {otm:.1%} | {br:.1%} | {b:.1%} | {b - br:+.1%} | {mean(x['pnl'] for x in xs):+.2%} | "
                   f"{min(x['pnl'] for x in xs):+.1%} |")
    return out + [""]


def report() -> None:
    with connect() as conn:
        orders, px = load(conn)
    ts = []
    for t in trades(orders, px):
        b = baseline_breach(px, t)
        if b is not None:
            t["base"] = b
            ts.append(t)
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["# Entry timing test: your own Robinhood sell-to-open fills", "",
             f"{len(ts)} expired-or-dated trades with prices on both ends (of {len(orders)} filled orders). "
             "Breach = stock beyond the strike at the expiry close (ignores early closes/rolls, so it's the risk you sold, "
             "not what you kept). Timing edge = baseline breach − your breach (positive = your timing beat a random day).", ""]
    for acct in ("IRA", "FILDI", "all"):
        sub = [t for t in ts if acct == "all" or t["account"] == acct]
        puts = [t for t in sub if t["side"] == "put"]
        calls = [t for t in sub if t["side"] == "call"]
        lines += [f"## {acct}: {len(puts)} puts, {len(calls)} calls", ""]
        lines += table(puts, bucket_put, "Puts by 5-day move before entry")
        lines += table(puts, bucket_rsi, "Puts by RSI(14) the day before")
        lines += table(puts, bucket_support, "Puts by distance above the 20-day low (support proxy)")
        lines += table(calls, bucket_call, "Calls by 5-day move before entry")
        lines += table(calls, bucket_rsi, "Calls by RSI(14) the day before")
    text = "\n".join(lines)
    (OUT / "report.md").write_text(text)
    print(text)


if __name__ == "__main__":
    report()
