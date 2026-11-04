"""A329 L2 SEC truth builder — missing≠0, period freshness, debt definition."""

from datetime import date

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
        if "skip_no_quarterly" in note:
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
    print("ok")
