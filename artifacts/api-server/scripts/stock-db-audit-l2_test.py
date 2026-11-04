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
    cur = audit_instant(facts, DEBT_CUR, asof, anchor)
    st = audit_instant(facts, DEBT_ST, asof, anchor)
    parts = [p for p in (lt, cur, st) if p is not None]
    if not parts:
        return None, "debt tags missing"
    total = sum(p["value"] for p in parts)
    return total, "debt ex-leases"


def miss_cause(note: str) -> str:
    n = (note or "").lower()
    if "missing" in n or "no us-gaap" in n:
        return "truth_missing"
    if "stale" in n:
        return "stale_period"
    if "not filing" in n:
        return "not_checkable"
    return "band_miss"


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
    assert miss_cause("debt tags missing") == "truth_missing"
    assert miss_cause("stale NI period") == "stale_period"


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
    test_sec_debt_sums_lt_and_st()
    print("ok")
