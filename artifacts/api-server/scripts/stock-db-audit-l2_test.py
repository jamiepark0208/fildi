"""A329 L2 SEC truth builder — missing≠0, period freshness, debt definition."""

from datetime import date

FRACTION = {"grossMargin", "netMargin", "operatingMargin", "returnOnAssets", "dividendYield"}
MAX_PERIOD_DAYS = 15 * 30
DEBT_LT = ["LongTermDebtNoncurrent", "LongTermDebt"]
DEBT_CUR = ["LongTermDebtCurrent"]
DEBT_ST = ["ShortTermBorrowings", "CommercialPaper"]


def ok(v, t, field):
    if v is None or t is None:
        return None
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


def miss_cause(row: dict) -> str:
    note = (row.get("note") or "").lower()
    if row.get("truth") is None:
        if "missing" in note or "no us-gaap" in note:
            return "truth_missing"
        if "stale" in note:
            return "stale_period"
        return "truth_missing"
    field = row["field"]
    if field in ("ebitda", "freeCashFlow", "cashAndEquivalents", "debtToEquity", "netIncome"):
        return "definition"
    gold = float(row["gold"])
    truth = float(row["truth"])
    rel = abs(gold - truth) / max(abs(gold), abs(truth), 1.0)
    if rel > 0.35:
        return "gold_wrong"
    return "truth_builder"


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


if __name__ == "__main__":
    test_ok_margin_hand_check()
    test_audit_instant_missing_not_zero()
    test_period_fresh_15mo()
    test_miss_cause()
    test_sec_debt_cur_only_no_truth()
    test_sec_debt_sums_lt_and_st()
    print("ok")
