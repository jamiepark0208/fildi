"""A329 L2 SEC truth builder — missing≠0, period freshness, debt definition."""

import importlib.util
from datetime import date
from pathlib import Path

_L2 = Path(__file__).resolve().parent / "stock-db-audit-l2.py"
_spec = importlib.util.spec_from_file_location("stock_db_audit_l2", _L2)
_l2 = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(_l2)
cover_shares_on_bs_end = _l2.cover_shares_on_bs_end
sec_shares_current = _l2.sec_shares_current

FRACTION = {"grossMargin", "netMargin", "operatingMargin", "returnOnAssets", "dividendYield"}
MAX_PERIOD_DAYS = 15 * 30
DEBT_LT = ["LongTermDebtNoncurrent", "LongTermDebt"]
DEBT_CUR = ["LongTermDebtCurrent"]
DEBT_ST = ["ShortTermBorrowings", "CommercialPaper"]
CASH = [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
]
CASH_ST = [
    "ShortTermInvestments",
    "MarketableSecuritiesCurrent",
]
FLOW_PERIOD_FIELDS = {"netIncome", "freeCashFlow", "totalRevenue", "ebitda"}
DEFINITION_ONLY_FIELDS = {"debtToEquity"}
PER_SHARE_FIELDS = {"earningsPerShare", "sharesOutstanding", "sharesOutstandingPrior", "tangibleBookValuePerShare"}


def ok(v, t, field):
    if v is None or t is None:
        return None
    if field == "earningsPerShare":
        band = max(abs(t) * 0.05, 0.01)
    elif field in ("sharesOutstanding", "sharesOutstandingPrior"):
        band = max(abs(t) * 0.03, 1e6)
    elif field == "tangibleBookValuePerShare":
        band = max(abs(t) * 0.05, 0.01)
    else:
        band = max(abs(t) * 0.20, 0.03 if field in FRACTION else 0)
    return abs(v - t) <= band


def days_apart(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def period_fresh(end: str, anchor: str) -> bool:
    return days_apart(end, anchor) <= MAX_PERIOD_DAYS


def audit_instant(facts: dict, concepts: list[str], asof: str, anchor: str) -> dict | None:
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    best = None
    for c in concepts:
        node = gaap.get(c)
        if not node:
            continue
        for unit in node.get("units", {}).get("USD", []):
            if unit.get("start"):
                continue
            if unit["end"] > asof:
                continue
            if best is None or unit["end"] > best["end"]:
                best = {"value": float(unit["val"]), "concept": c, "end": unit["end"]}
    if not best or not period_fresh(best["end"], anchor):
        return None
    return best


def sec_debt_total(facts: dict, asof: str, anchor: str) -> tuple[float | None, str]:
    lt = audit_instant(facts, DEBT_LT, asof, anchor)
    if lt is None:
        return None, "debt LT tag missing"
    cur = audit_instant(facts, DEBT_CUR, asof, anchor)
    st = audit_instant(facts, DEBT_ST, asof, anchor)
    total = lt["value"] + (cur["value"] if cur else 0.0) + (st["value"] if st else 0.0)
    return total, "debt ex-leases"


def sec_cash_total(facts: dict, asof: str, anchor: str) -> tuple[float | None, str]:
    cash = audit_instant(facts, CASH, asof, anchor)
    if not cash:
        return None, "cash tag missing/stale"
    st = audit_instant(facts, CASH_ST, asof, anchor)
    total = cash["value"] + (st["value"] if st else 0.0)
    return total, "cash+ST"


def scale_looks_adr(gold: float, truth: float) -> bool:
    if truth == 0:
        return False
    ratio = abs(gold) / max(abs(truth), 1.0)
    return ratio >= 3.5 or ratio <= 0.29


def miss_cause(row: dict) -> str:
    note = (row.get("note") or "").lower()
    if row.get("truth") is None:
        if "skip_no_quarterly" in note or "skip_no_cover_shares" in note or "skip_stale_dei" in note:
            return "definition"
        if "missing" in note or "no us-gaap" in note:
            return "truth_missing"
        if "stale" in note:
            return "stale_period"
        return "truth_missing"
    gold = float(row["gold"])
    truth = float(row["truth"])
    field = row["field"]
    if field in FLOW_PERIOD_FIELDS and note.strip() == "fy":
        return "wrong_period"
    if field in PER_SHARE_FIELDS and truth and abs(gold / truth - 8) / 8 < 0.12:
        return "adr_ratio"
    if field == "sharesOutstandingPrior" and truth > 0:
        r = gold / truth
        if 1.03 <= r <= 1.10 or ("prior basic wa" in note and 1.02 <= r <= 1.12):
            return "definition_mismatch"
    if field in ("totalRevenue", "totalStockholdersEquity") and scale_looks_adr(gold, truth):
        return "definition"
    if field in DEFINITION_ONLY_FIELDS:
        return "definition"
    rel = abs(gold - truth) / max(abs(gold), abs(truth), 1.0)
    if rel > 0.35:
        return "gold_wrong"
    if rel > 0.20:
        return "truth_builder"
    return "gold_wrong"


def test_ok_margin_hand_check():
    assert ok(0.20, 0.22, "netMargin") is True
    assert ok(0.20, 0.30, "netMargin") is False


def test_audit_instant_missing_not_zero():
    facts = {"facts": {"us-gaap": {}}}
    assert audit_instant(facts, DEBT_LT, "2025-06-30", "2025-06-30") is None


def test_period_fresh_15mo():
    assert period_fresh("2025-01-01", "2025-06-01") is True
    assert period_fresh("2018-01-01", "2025-06-01") is False


def test_miss_cause():
    assert miss_cause({"note": "debt LT tag missing", "truth": None}) == "truth_missing"
    assert miss_cause({"note": "stale NI period", "truth": None}) == "stale_period"
    assert miss_cause({
        "note": "ok",
        "truth": 100.0,
        "gold": 200.0,
        "field": "totalRevenue",
    }) == "gold_wrong"
    assert miss_cause({
        "note": "FY",
        "truth": 100.0,
        "gold": 500.0,
        "field": "totalRevenue",
    }) == "wrong_period"
    assert miss_cause({
        "note": "cash+ST 2025-06-30",
        "truth": 100.0,
        "gold": 500.0,
        "field": "cashAndEquivalents",
    }) == "gold_wrong"


def test_sec_cash_includes_st():
    anchor = "2024-12-31"
    facts = {
        "facts": {
            "us-gaap": {
                "CashAndCashEquivalentsAtCarryingValue": {
                    "units": {"USD": [{"val": 100.0, "end": anchor}]},
                },
                "ShortTermInvestments": {
                    "units": {"USD": [{"val": 40.0, "end": anchor}]},
                },
            }
        }
    }
    total, _note = sec_cash_total(facts, anchor, anchor)
    assert total == 140.0


def test_sec_debt_cur_only_no_truth():
    anchor = "2024-12-31"
    facts = {
        "facts": {
            "us-gaap": {
                "LongTermDebtCurrent": {
                    "units": {"USD": [{"val": 5.0, "end": anchor}]},
                },
            }
        }
    }
    total, note = sec_debt_total(facts, anchor, anchor)
    assert total is None
    assert "LT" in note


def test_sec_debt_sums_lt_and_st():
    anchor = "2024-12-31"
    facts = {
        "facts": {
            "us-gaap": {
                "LongTermDebtNoncurrent": {
                    "units": {"USD": [{"val": 100.0, "end": anchor}]},
                },
                "ShortTermBorrowings": {
                    "units": {"USD": [{"val": 25.0, "end": anchor}]},
                },
            }
        }
    }
    total, _note = sec_debt_total(facts, anchor, anchor)
    assert total == 125.0


def test_ok_eps_and_shares_bands():
    assert ok(5.0, 5.2, "earningsPerShare") is True
    assert ok(5.0, 5.5, "earningsPerShare") is False
    assert ok(1e9, 1.02e9, "sharesOutstanding") is True
    assert ok(1e9, 1.1e9, "sharesOutstanding") is False


def test_miss_cause_per_share_adr():
    assert miss_cause({
        "note": "dei",
        "truth": 1.0,
        "gold": 8.0,
        "field": "earningsPerShare",
        "ticker": "BABA",
    }) == "adr_ratio"


def test_miss_cause_skip_no_quarterly():
    assert miss_cause({"note": "skip_no_quarterly", "truth": None, "field": "earningsPerShare"}) == "definition"
    assert miss_cause({"note": "skip_no_cover_shares", "truth": None, "field": "sharesOutstanding"}) == "definition"


def test_miss_cause_prior_shares_definition():
    assert miss_cause({
        "note": "prior basic WA 2024-09-30",
        "truth": 1e9,
        "gold": 1.05e9,
        "field": "sharesOutstandingPrior",
    }) == "definition_mismatch"


def test_cover_shares_on_bs_end():
    bs_end = "2024-12-31"
    facts = {
        "facts": {
            "us-gaap": {
                "CommonStockSharesOutstanding": {
                    "units": {"shares": [{"val": 500.0, "end": bs_end}]},
                }
            },
            "dei": {},
        }
    }
    val, note = cover_shares_on_bs_end(facts, None, None, bs_end)
    assert val == 500.0
    assert "CommonStockSharesOutstanding" in note


def test_sec_shares_no_diluted_fallback():
    facts = {"facts": {"dei": {}, "us-gaap": {}}}
    truth, note = _l2.sec_shares_current(facts, None, "PLTR")
    assert truth is None
    assert "skip_no_cover_shares" in note


def test_sec_shares_stale_dei_skip_not_miss():
    from datetime import timedelta

    old_end = (date.today() - timedelta(days=MAX_PERIOD_DAYS + 5)).isoformat()
    facts = {
        "facts": {
            "dei": {
                "EntityCommonStockSharesOutstanding": {
                    "units": {"shares": [{"end": old_end, "val": 1e9, "filed": "2020-01-01"}]}
                }
            },
            "us-gaap": {},
        }
    }
    truth, note = sec_shares_current(facts, None, "RYAN")
    assert truth is None
    assert "skip_stale_dei" in note



def _bs(**tags):
    """us-gaap instant facts at one date: tag → (end, val)."""
    g = {}
    for k, (end, val) in tags.items():
        unit = "shares" if k == "CommonStockSharesOutstanding" else "USD"
        g[k] = {"units": {unit: [{"end": end, "val": val, "filed": "2026-10-30", "form": "10-Q"}]}}
    return {"facts": {"us-gaap": g}}


def test_tangible_book_subtracts_preferred_goodwill_intangibles():
    import sec_gold_fields as SG
    e = "2026-09-30"
    f = _bs(Goodwill=(e, 50.0), IntangibleAssetsNetExcludingGoodwill=(e, 10.0), PreferredStockValue=(e, 20.0))
    assert SG.tangible_book(f, 200.0, e, {"value": 10.0, "end": e}) == 12.0   # (200−20−50−10)/10


def test_tangible_book_negative_is_kept():   # PG/AAL: negative TBV is real, P/TBV goes null downstream
    import sec_gold_fields as SG
    e = "2026-09-30"
    f = _bs(Goodwill=(e, 41.0), IntangibleAssetsNetExcludingGoodwill=(e, 21.0))
    assert SG.tangible_book(f, 55.0, e, {"value": 2.0, "end": e}) == -3.5


def test_tangible_book_goodwill_other_date_is_none():   # missing leg ≠ 0
    import sec_gold_fields as SG
    f = _bs(Goodwill=("2026-06-30", 50.0))
    assert SG.tangible_book(f, 200.0, "2026-09-30", {"value": 10.0, "end": "2026-09-30"}) is None


def test_tangible_book_untagged_preferred_dividends_is_none():   # BAC: pays preferred, amount untagged
    import sec_gold_fields as SG
    e = "2026-09-30"
    f = _bs(Goodwill=(e, 50.0))
    f["facts"]["us-gaap"]["PreferredStockDividendsIncomeStatementImpact"] = {
        "units": {"USD": [{"start": "2026-07-01", "end": e, "val": 5.0, "filed": "2026-10-30", "form": "10-Q"}]}}
    assert SG.tangible_book(f, 200.0, e, {"value": 10.0, "end": e}) is None


def test_shares_ignores_future_dated_cover():   # AAL cover dated 2027-07-17
    import financials as F
    f = {"facts": {"dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
        {"end": "2027-07-17", "val": 1.0, "filed": "2026-07-23"},
        {"end": "2026-10-16", "val": 2.0, "filed": "2026-10-23"}]}}}, "us-gaap": {}}}
    assert F.shares(f)["end"] == "2026-10-16"

if __name__ == "__main__":
    test_ok_margin_hand_check()
    test_audit_instant_missing_not_zero()
    test_period_fresh_15mo()
    test_miss_cause()
    test_sec_debt_cur_only_no_truth()
    test_sec_debt_sums_lt_and_st()
    test_sec_cash_includes_st()
    test_ok_eps_and_shares_bands()
    test_miss_cause_per_share_adr()
    test_miss_cause_skip_no_quarterly()
    test_miss_cause_prior_shares_definition()
    test_cover_shares_on_bs_end()
    test_sec_shares_no_diluted_fallback()
    test_sec_shares_stale_dei_skip_not_miss()
    test_tangible_book_subtracts_preferred_goodwill_intangibles()
    test_tangible_book_negative_is_kept()
    test_tangible_book_goodwill_other_date_is_none()
    test_tangible_book_untagged_preferred_dividends_is_none()
    test_shares_ignores_future_dated_cover()
    print("ok")
