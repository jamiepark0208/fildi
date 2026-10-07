"""Wheel P&L per ticker: option income + stock realized + stock unrealized + dividends (all accounts).

An option win rate says nothing about the stock you got assigned; this is the number that does.
Realized parts come from Robinhood's per-ticker P&L export (portfolio_ticker_earnings, Portfolio page).
Unrealized stock P&L is recomputed from positions so a missing Avg Cost (2026-10-06 export glitch) can't
show a holding's whole market value as profit: cost is carried from the last snapshot with the same share
count, otherwise the ticker is marked cost-unknown and left out of the total.

    .venv/bin/python wheel.py            # table to stdout
"""
from __future__ import annotations

from collections import defaultdict

from build_plan import connect, rows


def _f(v) -> float:
    return float(v) if v is not None else 0.0


def positions_with_cost(conn) -> tuple[dict[str, float], set[str]]:
    """{ticker: unrealized $} from the latest snapshot, plus tickers whose cost is unknown."""
    latest = rows(conn, "SELECT max(snapshot_id) AS id FROM portfolio_positions")[0]["id"]
    if latest is None:
        return {}, set()
    prior = rows(conn, """SELECT max(snapshot_id) AS id FROM portfolio_positions
                          WHERE avg_cost > 0 AND snapshot_id < %s""", (latest,))[0]["id"]
    prev = {(r["account"], r["symbol"]): r for r in rows(conn, """SELECT account, symbol, quantity, avg_cost
              FROM portfolio_positions WHERE snapshot_id = %s AND avg_cost > 0""", (prior,))} if prior else {}
    unreal: dict[str, float] = defaultdict(float)
    unknown: set[str] = set()
    for r in rows(conn, """SELECT account, symbol, quantity, avg_cost, market_value
                           FROM portfolio_positions WHERE snapshot_id = %s""", (latest,)):
        qty, avg, mv = _f(r["quantity"]), _f(r["avg_cost"]), _f(r["market_value"])
        if qty <= 0:
            continue
        if avg <= 0:
            p = prev.get((r["account"], r["symbol"]))
            avg = _f(p["avg_cost"]) if p and _f(p["quantity"]) == qty else 0.0
        if avg <= 0:
            unknown.add(r["symbol"])
            continue
        unreal[r["symbol"]] += mv - qty * avg
    return dict(unreal), unknown


def wheel_pnl(conn) -> dict[str, dict]:
    unreal, unknown = positions_with_cost(conn)
    out: dict[str, dict] = {}
    for r in rows(conn, """SELECT ticker, sum(coalesce(sell_put,0) + coalesce(sell_call,0) + coalesce(long_call,0)
                                  + coalesce(long_put,0)) AS options,
                                  sum(coalesce(stocks_realized,0)) AS stock_realized, sum(coalesce(dividends,0)) AS dividends
                           FROM portfolio_ticker_earnings GROUP BY ticker"""):
        t = r["ticker"]
        o, sr, dv, su = _f(r["options"]), _f(r["stock_realized"]), _f(r["dividends"]), unreal.get(t, 0.0)
        out[t] = {"options": round(o), "stock_realized": round(sr), "stock_unrealized": round(su), "dividends": round(dv),
                  "total": None if t in unknown else round(o + sr + su + dv), "cost_unknown": t in unknown}
    for t in unknown | set(unreal):  # held but never in the P&L export
        out.setdefault(t, {"options": 0, "stock_realized": 0, "stock_unrealized": round(unreal.get(t, 0.0)), "dividends": 0,
                           "total": None if t in unknown else round(unreal.get(t, 0.0)), "cost_unknown": t in unknown})
    return out


def why_line(w: dict | None) -> str | None:
    """One Model List line: options vs stock, so a high option win rate can't hide an underwater holding."""
    if not w:
        return None
    stock = w["stock_realized"] + w["stock_unrealized"]
    if w["total"] is None:
        return f"wheel P&L: options {w['options']:+,} $, stock cost unknown (export missing Avg Cost)"
    mark = "⚠ " if w["total"] < 0 < w["options"] else ""
    return f"{mark}wheel P&L {w['total']:+,} $ = options {w['options']:+,} + stock {stock:+,} + dividends {w['dividends']:+,}"


if __name__ == "__main__":
    with connect() as conn:
        data = wheel_pnl(conn)
    print(f"{'ticker':8}{'options':>10}{'stock':>10}{'div':>8}{'total':>10}")
    for t, w in sorted(data.items(), key=lambda kv: (kv[1]["total"] is None, kv[1]["total"] or 0)):
        stock = w["stock_realized"] + w["stock_unrealized"]
        tot = "unknown" if w["total"] is None else f"{w['total']:,}"
        print(f"{t:8}{w['options']:>10,}{stock:>10,}{w['dividends']:>8,}{tot:>10}")
