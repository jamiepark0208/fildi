"""Same-week simulated-put dates. Historical NYSE sessions supported for 2020–2027.

2026–27 reuse the application's rules calendar. Earlier years add the recurring
closures and Carter's 2025 memorial closure. Early closes remain trading sessions.
Outside this reviewed range no weekly trade is produced.
Calendar reference: https://www.nyse.com/trade/hours-calendars
"""
from datetime import date, timedelta
from functools import lru_cache

import rules

HORIZON_VERSION = "same-week-nyse-v1"


def _nth(year, month, weekday, n):
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))


def _observed(day):
    return day + timedelta(days=-1 if day.weekday() == 5 else 1 if day.weekday() == 6 else 0)


@lru_cache(None)
def _historical_holidays(year):
    # Gregorian Easter (Meeus/Jones/Butcher), then Good Friday.
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    easter = date(year, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)
    new_year = date(year, 1, 1)
    # NYSE does not observe a Saturday New Year on the preceding Friday.
    new_year += timedelta(days=1 if new_year.weekday() == 6 else 0)
    may_last = date(year, 5, 31)
    days = {new_year, _nth(year, 1, 0, 3), _nth(year, 2, 0, 3), easter - timedelta(days=2),
            may_last - timedelta(days=may_last.weekday()), _observed(date(year, 7, 4)),
            _nth(year, 9, 0, 1), _nth(year, 11, 3, 4), _observed(date(year, 12, 25))}
    if year >= 2022:
        days.add(_observed(date(year, 6, 19)))
    if year == 2025:
        days.add(date(2025, 1, 9))
    return days


def weekly_sessions(day: date) -> tuple[date, ...]:
    """Exact first→last sessions within day’s Monday–Friday; unsupported years fail closed."""
    monday = day - timedelta(days=day.weekday())
    weekdays = tuple(monday + timedelta(days=i) for i in range(5))
    if any(d.year < 2020 or d.year > 2027 for d in weekdays):
        return ()
    return tuple(d for d in weekdays if (rules.is_trading_day(d) if d.year >= 2026
                                        else d not in _historical_holidays(d.year)))
