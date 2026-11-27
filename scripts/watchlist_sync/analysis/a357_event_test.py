"""A364 — two entries on one OCC both survive; a negative edge cannot print holds."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from a357_lse_option_backfill import (  # noqa: E402
    Contract,
    divergence_fails,
    event_key,
    status_is_ok,
    widest_fetch,
)
from a357_regrade import edge_verdict  # noqa: E402


def test_two_entries_and_both_sources_stay():
    exp = date(2025, 12, 19)
    a = Contract("OCC", "AAA", "put", 100, exp, date(2025, 10, 20), 101, "s059")
    b = Contract("OCC", "AAA", "put", 100, exp, date(2025, 11, 3), 99, "s059")
    m = Contract("OCC", "AAA", "put", 100, exp, date(2025, 10, 20), None, "model_recs")
    assert len({event_key(a), event_key(b), event_key(m)}) == 3
    wide = widest_fetch([b, a])
    assert len(wide) == 1 and wide[0].entry == date(2025, 10, 20)


def test_negative_edge_does_not_hold():
    assert edge_verdict(-10, 20, 0.80, False) == "fails"
    assert edge_verdict(4, 20, 0.80, False) == "weakens"
    assert edge_verdict(12, 20, 0.80, False) == "holds"
    assert edge_verdict(12, 20, 0.40, False).startswith("coverage")
    assert edge_verdict(12, 20, 0.80, True) == "underpowered"
    assert "holds" not in edge_verdict(-10, 20, 0.90, False)


def test_intc_sized_divergence_fails_and_zero_rows_do_not_count():
    assert divergence_fails([0.32, 0.32, 0.32]) is True
    assert divergence_fails([0.00, 0.04, 0.02]) is False
    assert status_is_ok("ok_0") is False
    assert status_is_ok("ok_12") is True


if __name__ == "__main__":
    test_two_entries_and_both_sources_stay()
    test_negative_edge_does_not_hold()
    test_intc_sized_divergence_fails_and_zero_rows_do_not_count()
    print("a357 event tests ok")
