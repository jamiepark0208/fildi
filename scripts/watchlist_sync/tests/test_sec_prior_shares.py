"""A329 (11-05): SEC prior shares = same definition as the current cover count, ~1 y earlier."""
import sys
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parents[1] / "dcf")]
import sec_gold_fields as SG  # noqa: E402


def _dei(rows):
    return {"facts": {"dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": rows}}}, "us-gaap": {}}}


def test_dei_prior_sums_classes_on_latest_filing():
    facts = _dei([
        {"end": "2025-10-20", "filed": "2025-10-30", "val": 100},
        {"end": "2025-10-20", "filed": "2025-10-30", "val": 20},   # class B, same filing → summed
        {"end": "2025-10-20", "filed": "2025-09-01", "val": 999},  # older filing, same end → ignored
        {"end": "2026-10-20", "filed": "2026-10-30", "val": 110},
    ])
    p = SG._prior_cover(facts, {"concept": "dei:EntityCommonStockSharesOutstanding", "end": "2026-10-20", "value": 110})
    assert p == {"value": 120.0, "concept": "dei:EntityCommonStockSharesOutstanding", "end": "2025-10-20", "filed": "2025-10-30", "split_factor": 1.0}


def test_no_prior_outside_window():
    facts = _dei([{"end": "2025-07-01", "filed": "2025-07-10", "val": 100}])   # 476 d back > 365 ± 45
    assert SG._prior_cover(facts, {"concept": "dei:EntityCommonStockSharesOutstanding", "end": "2026-10-20", "value": 110}) is None


def test_balance_sheet_cover_uses_balance_sheet_prior():
    facts = {"facts": {"dei": {}, "us-gaap": {"CommonStockSharesOutstanding": {"units": {"shares": [
        {"end": "2025-09-30", "filed": "2025-10-28", "val": 2383, "form": "10-Q"},
        {"end": "2026-09-30", "filed": "2026-10-28", "val": 2409, "form": "10-Q"},
    ]}}}}}
    p = SG._prior_cover(facts, {"concept": "CommonStockSharesOutstanding", "end": "2026-09-30", "value": 2409})
    assert p["value"] == 2383.0 and p["end"] == "2025-09-30"


def _wa(rows):
    return {"WeightedAverageNumberOfSharesOutstandingBasic": {"units": {"shares": rows}}}


def test_split_after_prior_cover_is_applied():   # APH 2:1: cover never restated, WA comparative is
    facts = _dei([{"end": "2025-10-21", "filed": "2025-10-25", "val": 1224}, {"end": "2026-10-27", "filed": "2026-10-30", "val": 2469}])
    facts["facts"]["us-gaap"] = _wa([
        {"start": "2025-07-01", "end": "2025-09-30", "filed": "2025-10-25", "val": 1220, "form": "10-Q"},
        {"start": "2025-07-01", "end": "2025-09-30", "filed": "2026-10-30", "val": 2440, "form": "10-Q"},
    ])
    p = SG._prior_cover(facts, {"concept": "dei:EntityCommonStockSharesOutstanding", "end": "2026-10-27", "value": 2469})
    assert p["value"] == 2448.0 and p["split_factor"] == 2.0


def test_split_before_prior_cover_ignored_and_big_move_dropped():   # BMNR: reverse split pre-dates the prior cover
    facts = _dei([{"end": "2025-07-01", "filed": "2025-07-10", "val": 6}, {"end": "2026-07-09", "filed": "2026-07-15", "val": 603}])
    facts["facts"]["us-gaap"] = _wa([
        {"start": "2025-01-01", "end": "2025-03-31", "filed": "2025-04-20", "val": 100, "form": "10-Q"},
        {"start": "2025-01-01", "end": "2025-03-31", "filed": "2025-08-20", "val": 5, "form": "10-Q"},
    ])
    assert SG._prior_cover(facts, {"concept": "dei:EntityCommonStockSharesOutstanding", "end": "2026-07-09", "value": 603}) is None
