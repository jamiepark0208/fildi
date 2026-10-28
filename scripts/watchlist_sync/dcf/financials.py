"""DCF v2 §C: one consistent trailing-12-month base per ticker from SEC XBRL companyfacts (A283).
Why: ticker_fundamentals mixes periods (PLTR revenue/EBIT = FY2025 but operating_margin = TTM; MU revenue = FY2025
while FY1 consensus is FY2027), and edgar_statement_history is annual only.
TTM rule for flows: latest 10-K FY if it is the newest period, else FY + YTD − prior-year YTD (same duration).
Balances: latest instant on or before the newest period end. Each value keeps its concept, period end and filed date.
Raw companyfacts JSON is kept whole in vendor_raw. SEC fair-access: ≤ 10 requests/s, declared User-Agent.
Usage: .venv/bin/python dcf/financials.py PLTR MU ...   (prints the TTM base)"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

UA = "TradeDash/1.0 jamiepark0208@gmail.com"  # same declared agent as artifacts/api-server/src/lib/edgar-client.ts
FLOWS = {
    "revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense"],
    "operating_income": ["OperatingIncomeLoss"],
    "gross_profit": ["GrossProfit"],
    "cost_of_revenue": ["CostOfRevenue", "CostOfGoodsAndServicesSold"],
    "pretax_income": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
                      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "tax": ["IncomeTaxExpenseBenefit"],
    "da": ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "sbc": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    "interest_expense": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities"],
}
BALANCES = {
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "st_investments": ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    "lt_investments": ["MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "LongTermInvestments"],
    "debt_lt": ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
    "debt_current": ["LongTermDebtCurrent", "DebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
    "st_borrowings": ["ShortTermBorrowings", "CommercialPaper"],
    "op_leases": ["OperatingLeaseLiability"],
    "equity": ["StockholdersEquity"],
    "minority": ["MinorityInterest"],
    # equity bridge beyond debt/cash (Jamie 10-27: every balance-sheet item, footnotes too)
    "pension_funded": ["DefinedBenefitPlanFundedStatusOfPlan"],          # signed: negative = underfunded
    "preferred": ["PreferredStockValue", "TemporaryEquityCarryingAmountAttributableToParent"],
    "equity_method": ["EquityMethodInvestments"],
    "other_investments": ["EquitySecuritiesFvNi", "OtherLongTermInvestments"],
    "crypto": ["CryptoAssetFairValueNoncurrent", "CryptoAssetFairValueCurrent"],
    "nol_dta": ["DeferredTaxAssetsOperatingLossCarryforwards"],
    "dta_allowance": ["DeferredTaxAssetsValuationAllowance"],
    "litigation": ["LossContingencyAccrualAtCarryingValue"],
    "aro": ["AssetRetirementObligationsNoncurrent", "AssetRetirementObligation"],
    "finance_leases": ["FinanceLeaseLiability"],
}
DILUTION = {  # share counts (unit shares) and option strike (USD/shares), for the treasury-stock method
    "rsu": "ShareBasedCompensationArrangementByShareBasedPaymentAwardEquityInstrumentsOtherThanOptionsNonvestedNumber",
    "options": "ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingNumber",
    "strike": "ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingWeightedAverageExercisePrice",
}
UNRECOGNIZED = "EmployeeServiceShareBasedCompensationNonvestedAwardsTotalCompensationCostNotYetRecognized"
WEIGHTED = {"diluted": "WeightedAverageNumberOfDilutedSharesOutstanding", "basic": "WeightedAverageNumberOfSharesOutstandingBasic"}


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def companyfacts(conn, ticker: str) -> dict | None:
    r = rows(conn, "SELECT cik FROM ticker_cik WHERE ticker = %s", (ticker,))
    if not r:
        return None
    facts = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{r[0]['cik']}.json")
    used = {c for v in (*FLOWS.values(), *BALANCES.values()) for c in v} | set(WEIGHTED.values()) | set(DILUTION.values()) | {UNRECOGNIZED}
    keep = {"cik": facts.get("cik"), "entityName": facts.get("entityName"), "facts": {
        "us-gaap": {k: v for k, v in (facts.get("facts", {}).get("us-gaap", {}) or {}).items() if k in used},
        "dei": (facts.get("facts", {}).get("dei", {}) or {})}}
    body = json.dumps(keep)  # whole fact series for every concept we use (full file is 5–20 MB)
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('sec', 'companyfacts', %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha""", (ticker, date.today(), body, hashlib.sha256(body.encode()).hexdigest()))
    time.sleep(0.15)
    return facts


def _units(facts: dict, concept: str, unit: str = "USD") -> list[dict]:
    node = (facts.get("facts", {}).get("us-gaap", {}) or {}).get(concept)
    if not node:
        return []
    out = [u for u in node.get("units", {}).get(unit, []) if u.get("form") in ("10-K", "10-Q", "10-K/A", "10-Q/A", "20-F", "40-F")]
    # latest filing wins for the same period (restatements)
    best = {}
    for u in out:
        k = (u.get("start"), u["end"])
        if k not in best or u["filed"] > best[k]["filed"]:
            best[k] = u
    return list(best.values())


def _days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def ttm_flow(facts: dict, concepts: list[str]) -> dict | None:
    """Pick the concept with the newest period, then TTM = FY, or FY + YTD − prior YTD."""
    cands = []
    for c in concepts:
        vals = [u for u in _units(facts, c) if u.get("start")]
        if vals:
            cands.append((c, max(u["end"] for u in vals), vals))
    if not cands:
        return None
    # current concepts only (newest end within ~1 quarter of the newest), then the largest annual total: REITs/banks tag
    # small sub-lines with recent periods (ESS, RF picked a $0.1B line)
    top = max(e for _, e, _ in cands)
    cur = [x for x in cands if _days(x[1], top) <= 100]
    fy_size = lambda vals: max((u["val"] for u in vals if 350 <= _days(u["start"], u["end"]) <= 380), default=0)
    best = max(cur, key=lambda x: (fy_size(x[2]), x[1]))
    c, newest, vals = best
    fy = [u for u in vals if 350 <= _days(u["start"], u["end"]) <= 380]
    if not fy:
        return None
    last_fy = max(fy, key=lambda u: u["end"])
    fyv = {"fy_value": last_fy["val"], "fy_end": last_fy["end"]}
    if last_fy["end"] == newest:
        return {"value": last_fy["val"], "concept": c, "end": newest, "filed": last_fy["filed"], "how": "FY", **fyv}
    ytd = [u for u in vals if u["end"] == newest and u["start"] > last_fy["end"][:10] and _days(u["start"], u["end"]) >= 80]
    if not ytd:
        return {"value": last_fy["val"], "concept": c, "end": last_fy["end"], "filed": last_fy["filed"], "how": "FY (no YTD)", **fyv}
    cur = max(ytd, key=lambda u: _days(u["start"], u["end"]))
    dur = _days(cur["start"], cur["end"])
    want_end = date.fromisoformat(cur["end"]) - timedelta(days=365)
    prior = [u for u in vals if abs((date.fromisoformat(u["end"]) - want_end).days) <= 10 and abs(_days(u["start"], u["end"]) - dur) <= 10]
    if not prior:
        return {"value": last_fy["val"], "concept": c, "end": last_fy["end"], "filed": last_fy["filed"], "how": "FY (no prior YTD)", **fyv}
    p = max(prior, key=lambda u: u["filed"])
    return {"value": last_fy["val"] + cur["val"] - p["val"], "concept": c, "end": cur["end"], "filed": cur["filed"],
            "how": f"FY{last_fy['end'][:4]} + {round(dur / 30)}m YTD − prior", **fyv}


def balance(facts: dict, concepts: list[str], asof: str) -> dict | None:
    best = None
    for c in concepts:
        vals = [u for u in _units(facts, c) if not u.get("start") and u["end"] <= asof]
        if vals:
            u = max(vals, key=lambda x: (x["end"], x["filed"]))
            if best is None or u["end"] > best["end"]:
                best = {"value": u["val"], "concept": c, "end": u["end"], "filed": u["filed"]}
    if best and _days(best["end"], asof) > 370:
        return {"value": 0.0, "concept": best["concept"], "end": best["end"], "filed": best["filed"], "how": "stale → 0"}
    return best


def shares(facts: dict) -> dict | None:
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
    vals = [u for u in (dei or {}).get("units", {}).get("shares", [])]
    if not vals:
        # cover-page count missing (PLTR, HOOD report it per class outside dei) → latest diluted weighted average
        dil = _units(facts, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares")
        if not dil:
            return None
        u = max(dil, key=lambda x: (x["end"], x["filed"]))
        return {"value": u["val"], "concept": "WeightedAverageNumberOfDilutedSharesOutstanding", "end": u["end"], "filed": u["filed"]}
    u = max(vals, key=lambda x: (x["end"], x["filed"]))
    # dual-class issuers report one row per class on the same date: sum them
    tot = sum(x["val"] for x in vals if x["end"] == u["end"] and x["filed"] == u["filed"])
    return {"value": tot, "concept": "dei:EntityCommonStockSharesOutstanding", "end": u["end"], "filed": u["filed"]}


def dilution(facts: dict, asof: str) -> dict:
    """Unvested RSUs, options outstanding and their weighted strike at the latest instant ≤ asof (stale > 400 d → none)."""
    out = {}
    for k, c in DILUTION.items():
        vals = [u for u in _units(facts, c, "USD/shares" if k == "strike" else "shares") if not u.get("start") and u["end"] <= asof]
        if vals:
            u = max(vals, key=lambda x: (x["end"], x["filed"]))
            if _days(u["end"], asof) <= 400:
                out[k] = {"value": u["val"], "end": u["end"], "filed": u["filed"]}
    unrec = [u for u in _units(facts, UNRECOGNIZED) if not u.get("start") and u["end"] <= asof]
    if unrec:
        u = max(unrec, key=lambda x: (x["end"], x["filed"]))
        if _days(u["end"], asof) <= 400:
            out["unrecognized_usd"] = {"value": u["val"], "end": u["end"], "filed": u["filed"]}
    # RSUs are usually tagged per award type (dimensions, absent from companyfacts) → diluted − basic weighted average of
    # the latest period as a floor (captures them when the company is profitable)
    w = {}
    for k, c in WEIGHTED.items():
        vals = [u for u in _units(facts, c, "shares") if u.get("start") and u["end"] <= asof]
        if vals:
            w[k] = max(vals, key=lambda x: (x["end"], x["filed"], x["start"]))
    if len(w) == 2 and w["diluted"]["end"] == w["basic"]["end"] and w["diluted"]["start"] == w["basic"]["start"]:
        out["dil_gap"] = {"value": max(w["diluted"]["val"] - w["basic"]["val"], 0), "end": w["diluted"]["end"]}
    return out


def fy_history(facts: dict, concepts: list[str], n: int = 5) -> dict[str, float]:
    """Last n fiscal-year values {fy_end: value}, from the concept with the newest annual period."""
    best = {}
    for c in concepts:
        # 10-K full years only: AMZN's 10-Qs carry trailing-12-month cash-flow lines that look like one-year periods
        fy = {u["end"]: u["val"] for u in _units(facts, c) if u.get("start") and 350 <= _days(u["start"], u["end"]) <= 380
              and u.get("form", "").startswith(("10-K", "20-F", "40-F")) and u.get("fp") == "FY"}
        if fy and (not best or max(fy) > max(best)):
            best = fy
    return dict(sorted(best.items())[-n:])


HIST = ("revenue", "operating_income", "ocf", "capex", "sbc", "interest_expense", "tax", "pretax_income")


def facts_asof(facts: dict, asof: str) -> dict:
    """Point-in-time view (S116 backtest): only facts filed on or before asof."""
    keep = lambda units: {u: [x for x in xs if x.get("filed", "9999") <= asof] for u, xs in units.items()}
    return {**facts, "facts": {ns: {c: {**node, "units": keep(node.get("units", {}))} for c, node in (facts.get("facts", {}).get(ns, {}) or {}).items()}
                               for ns in ("us-gaap", "dei")}}


def stored_facts(conn, ticker: str) -> dict | None:
    """Latest companyfacts kept in vendor_raw (no SEC call)."""
    r = rows(conn, """SELECT payload FROM vendor_raw WHERE source = 'sec' AND endpoint = 'companyfacts' AND key = %s
                      ORDER BY fetched_on DESC LIMIT 1""", (ticker,))
    return r[0]["payload"] if r else None


def ttm_base(conn, ticker: str, facts: dict | None = None) -> dict | None:
    facts = facts or companyfacts(conn, ticker)
    if not facts:
        return None
    out = {k: ttm_flow(facts, v) for k, v in FLOWS.items()}
    asof = (out.get("revenue") or {}).get("end") or date.today().isoformat()
    out.update({k: balance(facts, v, asof) for k, v in BALANCES.items()})
    out["shares"] = shares(facts)
    out["dilution"] = dilution(facts, asof)
    out["history"] = {k: fy_history(facts, FLOWS[k]) for k in HIST}
    return out


DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.dcf_ttm_base (
  ticker text NOT NULL, as_of date NOT NULL, period_end date, base jsonb NOT NULL, PRIMARY KEY (ticker, as_of))"""


def universe(conn) -> None:
    """Every active fundamentals ticker → dcf_ttm_base; prints staleness of ticker_fundamentals revenue vs the SEC TTM."""
    conn.execute(DDL)
    tick = [r["ticker"] for r in rows(conn, "SELECT r.ticker FROM ticker_registry r WHERE COALESCE(r.is_active, true) AND r.fetch_fundamentals ORDER BY 1")]
    done = 0
    for t in tick:
        try:
            b = ttm_base(conn, t)
        except Exception as e:  # one bad filer must not stop the run
            print(t, "error", str(e)[:80]); conn.rollback(); continue
        if b and b.get("revenue"):
            conn.execute("""INSERT INTO watchlist_sync.dcf_ttm_base (ticker, as_of, period_end, base) VALUES (%s, %s, %s, %s)
                            ON CONFLICT (ticker, as_of) DO UPDATE SET period_end = EXCLUDED.period_end, base = EXCLUDED.base""",
                         (t, date.today(), b["revenue"]["end"], json.dumps(b)))
            done += 1
        conn.commit()
    print(f"{done}/{len(tick)} tickers with a TTM base")


if __name__ == "__main__":
    if "--universe" in sys.argv:
        with connect() as conn:
            universe(conn)
        sys.exit(0)
    with connect() as conn:
        for t in sys.argv[1:]:
            b = ttm_base(conn, t.upper())
            conn.commit()
            if not b:
                print(t, "no CIK / facts"); continue
            print(t)
            for k, v in b.items():
                if k == "history":
                    continue
                if v:
                    print(f"  {k:16s} {v['value'] / 1e6:>12,.0f}m  {v['concept'][:48]:48s} end {v['end']} filed {v['filed']} {v.get('how', '')}")
