"""Entry setup tag (warn only; user YES 2026-10-06): is this the setup the trader's own record says works?

Evidence (research/studies/S011-rh-entry-timing.md, analysis/timing_rh_trades.py, 1,513 own trades 2026):
  puts sold after a 5-day drop of ≥3% or within 3% of the 20-day low ended in the money ~17% of the time, vs 26.5% without a dip;
  calls sold after a 5-day rally of ≥3% got run over ~10%, vs ~20% without. Same sign in both halves of 2026; P&L difference not yet
  significant. Display only: never filters or re-ranks. Promote to scoring only after the live ledger confirms it (S011 stop rule).
"""
from __future__ import annotations

from build_plan import rows

DIP_5D = -0.03       # puts: 5-day move at or below this
NEAR_LOW_20D = 0.03  # … or close within this of the 20-day low
RALLY_5D = 0.03      # calls: 5-day move at or above this


def context(conn, tickers: list[str]) -> dict[str, dict]:
    """{ticker: {ret5, above_low20}} from the last 21 closes (as of the latest close)."""
    out: dict[str, dict] = {}
    if not tickers:
        return out
    by: dict[str, list] = {}
    for r in rows(conn, """SELECT ticker, date, low::float8 low, close::float8 close FROM prices_historical
                           WHERE ticker = ANY(%s) AND date >= CURRENT_DATE - 40 ORDER BY ticker, date""", (tickers,)):
        if r["close"]:
            by.setdefault(r["ticker"], []).append(r)
    for t, s in by.items():
        if len(s) < 21:
            continue
        last = s[-1]["close"]
        out[t] = {"ret5": last / s[-6]["close"] - 1, "above_low20": last / min(x["low"] or x["close"] for x in s[-20:]) - 1}
    return out


def why_line(side: str, c: dict | None) -> str | None:
    if not c:
        return None
    r5, lo = c["ret5"], c["above_low20"]
    if side == "put":
        if r5 <= DIP_5D or lo <= NEAR_LOW_20D:
            return (f"✓ setup: {r5:+.0%} over 5 days, {lo:.0%} above the 20-day low. Your puts after a dip ended ITM ~17% "
                    "vs 26% without (not yet proven)")
        return (f"⚠ setup: no dip ({r5:+.0%} over 5 days, {lo:.0%} above the 20-day low). Your no-dip puts ended ITM 26% vs ~17% "
                "after a dip: consider waiting for a pullback")
    if r5 >= RALLY_5D:
        return f"✓ setup: rallied {r5:+.0%} over 5 days. Your calls after a rally got run over ~10% vs ~20% without (not yet proven)"
    return (f"⚠ setup: no rally ({r5:+.0%} over 5 days). Your calls without a rally got run over ~20% vs ~10% after one: "
            "consider waiting for a pop")
