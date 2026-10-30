"""Report-day move window — the ONE definition (E2, 10-30). Used by research/lseg/sync_earnings_moves.py (writes
lseg_research.earnings_moves) and scripts/watchlist_sync/earnings_notes.py (notes, fallback before the nightly row exists).
No dependencies, so any pipeline can import it.

    amc (after close) on report day d:  close(d)      → close(next day)
    bmo (before open):                  close(prev)   → close(d)
    unknown:                            close(prev)   → close(next day)   (2-day window)
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import date


def window_idx(days: list[date], d: date, when: str = "unknown") -> tuple[int, int]:
    """(index of the 'before' close, index of the 'after' close) in a sorted list of trading days."""
    i_on = bisect_left(days, d)
    on_day = i_on < len(days) and days[i_on] == d
    i_prev, i_next = i_on - 1, bisect_right(days, d)
    if when == "amc" and on_day:
        i_prev, i_next = i_on, i_on + 1
    elif when == "bmo" and on_day:
        i_next = i_on
    return i_prev, i_next


def window_move(closes: list[tuple[date, float]], d: date, when: str = "unknown") -> float | None:
    i_prev, i_next = window_idx([c[0] for c in closes], d, when)
    if i_prev < 0 or i_next >= len(closes):
        return None
    (d0, p0), (d1, p1) = closes[i_prev], closes[i_next]
    if (d1 - d0).days > 7 or p0 <= 0:  # gap in data → don't trust
        return None
    return (p1 / p0 - 1) * 100
