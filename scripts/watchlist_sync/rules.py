"""All thresholds for the Fildi → Robinhood watchlist sync, in one place.

L1 = checks against Fildi's own data (build_plan.py). L2 = checks against live Robinhood quotes (verify_plan.py).
A failed check with severity "block" removes the item; "warn" keeps it but shows the warning.
Tighten here as we learn; every change should be noted in README.md's changelog.
"""
from __future__ import annotations

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# ── L1 (Fildi data) ─────────────────────────────────────────────────────────────
MAX_SNAPSHOT_AGE_TRADING_DAYS = 1      # model_recs must be from the latest (or previous) trading close
PUT_DELTA = (-0.20, -0.05)             # floor 0.08 → 0.05 (10-24: target moved to 0.09, listed strikes land 0.06–0.12). 0.00 deltas = broken greeks (seen 2026-10-01) → blocked. Max 0.20 (S071, 10-20: market-wide real LSEG
                                       # quotes, paired by name-week: > 0.20Δ −10..−12 bp/wk after 2024, farther OTM +9..+13 bp, same sign both
                                       # halves, t ≤ 1.6; pre-registered rule said 0.09 but n.s. and min_income would drop most puts). Picks above are re-struck.
PUT_TARGET_ABS_DELTA = 0.09            # every weekly put re-strikes to the listed strike nearest this |Δ| (was 0.15). S088-vs-ML 10-24
                                       # (holdout 2023→, 34k name-weeks, real-fill): same names at ~0.08Δ vs 0.15Δ = income −0.4/−1.4/−1.7 bp/wk
                                       # (1/2/4w), kept 88 → 93 %, worst-5 % week −244 → −61 bp, max DD −10.4 → −7.2 %. S088 HGB model strike = same
                                       # result (+36.5 vs +36.9 bp/wk) → plain Δ rule, no model.
PUT_NAME_INCOME_ABS_DELTA = 0.15       # min_income judges the NAME at this |Δ| (eligibility as tested), not the farther strike sold
PUT_MIN_RESTRIKE_BID = 0.10            # re-strike only to strikes bidding ≥ this (S088 MIN_CREDIT; nickel bids are not tradable)
PUT_EARNINGS_ABS_DELTA = (0.10, 0.07)  # (10-24: was 0.12/0.10, kept farther than the 0.09 normal target) earnings before expiry: cap, target. Was a block; S066/S069: earnings puts pay more with a fatter
                                       # tail (Jamie 10-20: go further OTM instead). Chain Δ already prices the event, so this is a
                                       # probability target (~90 % OTM), not a fixed distance.
CALL_DELTA = (0.08, 0.35)
DTE = (2, 45)
IV_SANE = (0.05, 3.0)
MIN_WEEKLY_INCOME_PCT = 0.30           # % of collateral per week
MAX_PREMIUM_TO_STRIKE = 0.10           # a 7–45 DTE OTM option worth >10% of strike is a bad quote
MAX_SPOT_DRIFT_PCT = 3.0               # model spot vs latest close
MIN_CREDIT_RANK_PUTS = 20              # StarMine credit (LSEG); missing → warn, not block
MIN_COVERED_SHARES = 100
MAX_ITEMS = 15
MAX_ITEMS_PUTS = 25                    # Jamie 10-26: more sell-put candidates; ranked by the engine (put_recs rank), not option score

# ── L2 (live Robinhood) ─────────────────────────────────────────────────────────
QUOTE_MAX_AGE_MIN_OPEN = 20            # during regular hours
# Spread (user YES 2026-10-06, research/studies S012): yield is already judged at Robinhood's fill-rate price (≈ bid + ¼ of the
# spread), so a wide spread only blocks when there is no real market: in session AND > 75% of mark AND > $0.10 wide.
# 30–75% (or any after-hours quote: spreads widen at the close) is a warning with a suggested limit price. Re-tune from
# analysis/block_audit.py once each group has ≥ 30 graded rows.
MAX_SPREAD_PCT = 75.0                  # block above this (in session) …
MAX_SPREAD_ABS = 0.10                  # … unless ≤ $0.10 wide (a few ticks on cheap options is as tight as it gets)
WARN_SPREAD_PCT = 30.0                 # warn above this
LIMIT_SPREAD_FRACTION = 0.25           # suggested sell limit = bid + 25% of the spread (≈ RH high-fill price, median 23%)
MIN_REALISTIC_TO_MODEL = 0.85          # Robinhood fill-rate sell price ÷ Fildi premium
MIN_OPEN_INTEREST = 100
MIN_VOLUME_IF_LOW_OI = 25
MAX_LIVE_SPOT_DRIFT_PCT = 3.0
MIN_OTM_PCT_LIVE = 2.0                 # sell-side strikes must still be ≥2% OTM at the live price
MAX_IV_DISAGREEMENT = 0.35             # |RH IV / Fildi IV − 1|

# NYSE full-day closures.
HOLIDAYS = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03",
    "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05",
    "2027-09-06", "2027-11-25", "2027-12-24",
}


_hours_cache: dict[str, tuple[bool, int, int]] = {}
_hours_loaded = False


def _schwab_hours(d: date) -> tuple[bool, int, int] | None:
    """Schwab /markets rows (A267). One read per process. None → calendar."""
    global _hours_loaded
    if not _hours_loaded:
        _hours_loaded = True
        try:
            import os
            import psycopg
            url = os.environ.get("DATABASE_URL")
            if url:
                with psycopg.connect(url, connect_timeout=3) as conn:
                    rows = conn.execute(
                        "SELECT session_date::text, is_open, open_min, close_min FROM schwab_market_hours",
                    ).fetchall()
                for session_date, is_open, open_min, close_min in rows:
                    _hours_cache[str(session_date)[:10]] = (
                        bool(is_open),
                        int(open_min if open_min is not None else 9 * 60 + 30),
                        int(close_min if close_min is not None else 16 * 60),
                    )
        except Exception:
            pass
    return _hours_cache.get(d.isoformat())


def is_trading_day(d: date) -> bool:
    hours = _schwab_hours(d)
    if hours is not None:
        return hours[0]
    return d.weekday() < 5 and d.isoformat() not in HOLIDAYS


def market_open(now: datetime | None = None) -> bool:
    n = (now or datetime.now(ET)).astimezone(ET)
    hours = _schwab_hours(n.date())
    if hours is not None:
        if not hours[0]:
            return False
        open_t = time(hours[1] // 60, hours[1] % 60)
        close_t = time(hours[2] // 60, hours[2] % 60)
        return open_t <= n.time() < close_t
    return is_trading_day(n.date()) and time(9, 30) <= n.time() < time(16, 0)


def last_close_date(now: datetime | None = None) -> date:
    """Most recent trading day whose 16:00 ET close has happened."""
    from datetime import timedelta

    n = (now or datetime.now(ET)).astimezone(ET)
    d = n.date()
    if not (is_trading_day(d) and n.time() >= time(16, 0)):
        d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def trading_days_between(a: date, b: date) -> int:
    from datetime import timedelta

    n, d = 0, min(a, b)
    while d < max(a, b):
        d += timedelta(days=1)
        if is_trading_day(d):
            n += 1
    return n
