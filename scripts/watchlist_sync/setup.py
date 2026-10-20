"""Entry setup tag (warn only; user YES 2026-10-06): does the stock just dipped? Market-wide evidence, not the trader's own record
(Jamie 10-20: personal trades are sporadic → never a Model List rule; S011 was 1,513 own trades).

Evidence (S070 follow-up, 10-20): 70k weekly ~1σ puts 2020→ net of fills (S059 harness): after a 5-day drop ≥ 3 % +8.7 bp/wk
(t 2.4) before 2024-07 and +7.8 (t 2.2) after, vs +0.4 / −0.5 without a dip; breach the same (~13 %), worst 1 % ~15 % deeper.
Calls: no market-wide test of "after a rally" (S046: calls on stretched names lose) → no call tag. Display only: never filters.
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
    if side != "put":
        return None
    if r5 <= DIP_5D or lo <= NEAR_LOW_20D:
        return (f"✓ setup: {r5:+.0%} over 5 days, {lo:.0%} above the 20-day low. Market-wide, puts sold after a ≥3% 5-day dip "
                "earned ~0.08%/wk more, same ITM rate, slightly deeper worst case (2020→)")
    return (f"setup: no dip ({r5:+.0%} over 5 days). Market-wide, no-dip puts earned ~0 after fills vs ~0.08%/wk after a dip "
            "(2020→): a pullback entry is better")
