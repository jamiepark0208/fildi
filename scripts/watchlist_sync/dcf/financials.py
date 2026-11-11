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
import vendor_gate  # noqa: E402  (A303 shared cross-process budget)
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
    "net_income": [
        "NetIncomeLossAvailableToCommonStockholdersBasic",
        "NetIncomeLossAvailableToCommonStockholdersDiluted",
        "NetIncomeLoss",
        "ProfitLoss",
    ],
}
# 11-11: concepts sec_gold_fields reads outside FLOWS/BALANCES — the trimmed cache dropped them (Assets → no total_assets,
# AssetsCurrent/LiabilitiesCurrent → no current ratio).
EXTRA_KEEP = {"Assets", "AssetsCurrent", "LiabilitiesCurrent", "Liabilities", "Goodwill", "NetIncomeLoss", "ProfitLoss",
              "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "CommonStockSharesOutstanding",
              "IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet",
              "IndefiniteLivedIntangibleAssetsExcludingGoodwill", "PreferredStockValueOutstanding",
              "PreferredStockLiquidationPreferenceValue", "PreferredStockDividendsIncomeStatementImpact",
              "DividendsPreferredStock", "PreferredStockDividendsAndOtherAdjustments", "EarningsPerShareDiluted"}

IFRS_KEEP = {"Assets"}   # 20-F IFRS filers (TSM, ASML): local currency → sec_local source, FX-converted in merge-trusted
KEEP_V = 2              # bump when EXTRA_KEEP / IFRS_KEEP change → sec_gold_fields refetches older caches once

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
    # A288: convertible notes (face) — when ITM, engine treats as equity not debt
    "convert_debt": [
        "ConvertibleNotesPayable", "ConvertibleLongTermNotesPayable", "ConvertibleDebt",
        "ConvertibleDebtNoncurrent", "ConvertibleDebtCurrent", "ConvertibleNotesPayableCurrent",
    ],
}
DILUTION = {  # share counts (unit shares) and option strike (USD/shares), for the treasury-stock method
    "rsu": "ShareBasedCompensationArrangementByShareBasedPaymentAwardEquityInstrumentsOtherThanOptionsNonvestedNumber",
    "options": "ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingNumber",
    "strike": "ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingWeightedAverageExercisePrice",
}
# Dimension-free conversion price (USD per share). Per-instrument dims often missing → skip when absent.
CONVERT_PRICE = "DebtInstrumentConvertibleConversionPrice1"
# Hand-checked from latest 10-Q/10-K notes when XBRL omits a usable conversion price (A288 Claude #4).
# Used only when companyfacts has no vintage-matched DebtInstrumentConvertibleConversionPrice1.
CONVERT_NOTE_OVERRIDES: dict[str, dict] = {
    "NET": {
        "source": "10-Q filed 2026-08-06 (cloud-20260630.htm)",
        "tranches": [
            {"label": "2026 Notes", "px": 191.34, "face_concept": "ConvertibleDebtCurrent"},
            {"label": "2030 Notes", "px": 247.67, "face_concept": "ConvertibleDebtNoncurrent"},
        ],
    },
    "RKLB": {
        "source": "10-Q filed 2026-08-10 (4.250% notes due 2029; $13.4M principal left)",
        "tranches": [{"label": "2029 Notes", "px": 5.13, "face": 13_400_000}],
    },
    "MRVL": {
        "source": "10-Q filed 2026-08-28",
        "tranches": [{"label": "convert notes", "px": 91.84}],
    },
    "AAOI": {
        "source": "10-Q filed 2026-08-06",
        "tranches": [{"label": "convert notes", "px": 43.31}],
    },
    "ONDS": {
        "source": "10-Q filed 2026-08-13",
        "tranches": [{"label": "convert notes", "px": 0.7189}],
    },
}
UNRECOGNIZED = "EmployeeServiceShareBasedCompensationNonvestedAwardsTotalCompensationCostNotYetRecognized"
WEIGHTED = {"diluted": "WeightedAverageNumberOfDilutedSharesOutstanding", "basic": "WeightedAverageNumberOfSharesOutstandingBasic"}


def _get(url: str) -> dict:
    if "sec.gov" in url:
        vendor_gate.wait("EDGAR")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def _submissions_newest_filing(conn, ticker: str, cik: str, *, fetch: bool = True) -> str | None:
    """Cheap change signal: newest filingDate in EDGAR submissions recent block."""
    key = ticker.upper()
    cached = rows(conn, """SELECT payload FROM vendor_raw
                          WHERE source = 'sec' AND endpoint = 'submissions' AND key = %s
                          ORDER BY fetched_on DESC LIMIT 1""", (key,))
    sub = None
    if cached:
        sub = cached[0]["payload"] if isinstance(cached[0]["payload"], dict) else json.loads(cached[0]["payload"])
    elif fetch:
        sub = _get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json")
        body = json.dumps(sub)
        conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                        VALUES ('sec', 'submissions', %s, %s, %s::jsonb, %s)
                        ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET
                          payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha
                        WHERE vendor_raw.payload_sha IS DISTINCT FROM EXCLUDED.payload_sha""",
                     (key, date.today(), body, hashlib.sha256(body.encode()).hexdigest()))
    return _newest_filing_from_sub(sub) if sub else None


def _newest_filing_from_sub(sub: dict) -> str | None:
    dates = (sub.get("filings") or {}).get("recent", {}).get("filingDate") or []
    return max(dates) if dates else None


def _stored_companyfacts_filing_signal(conn, ticker: str) -> str | None:
    r = rows(conn, """SELECT payload FROM vendor_raw WHERE source='sec' AND endpoint='submissions' AND key=%s
                      ORDER BY fetched_on DESC LIMIT 1""", (ticker.upper(),))
    if not r:
        return None
    p = r[0]["payload"] if isinstance(r[0]["payload"], dict) else json.loads(r[0]["payload"])
    return _newest_filing_from_sub(p)


def companyfacts(conn, ticker: str, *, force: bool = False) -> dict | None:
    r = rows(conn, "SELECT cik FROM ticker_cik WHERE ticker = %s", (ticker,))
    if not r:
        return None
    cik = str(r[0]["cik"])
    prior = _stored_companyfacts_filing_signal(conn, ticker) if not force else None
    newest = _submissions_newest_filing(conn, ticker, cik, fetch=True)
    if not force and newest and prior == newest:
        cached = rows(conn, """SELECT payload FROM vendor_raw WHERE source = 'sec' AND endpoint = 'companyfacts' AND key = %s
                               ORDER BY fetched_on DESC LIMIT 1""", (ticker.upper(),))
        if cached:
            return cached[0]["payload"] if isinstance(cached[0]["payload"], dict) else json.loads(cached[0]["payload"])
    facts = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")
    used = ({c for v in (*FLOWS.values(), *BALANCES.values()) for c in v} | set(WEIGHTED.values()) | set(DILUTION.values())
            | {UNRECOGNIZED, CONVERT_PRICE} | EXTRA_KEEP)
    keep = {"cik": facts.get("cik"), "entityName": facts.get("entityName"), "keep_v": KEEP_V, "facts": {
        "us-gaap": {k: v for k, v in (facts.get("facts", {}).get("us-gaap", {}) or {}).items() if k in used},
        "ifrs-full": {k: v for k, v in (facts.get("facts", {}).get("ifrs-full", {}) or {}).items() if k in IFRS_KEEP},
        "dei": (facts.get("facts", {}).get("dei", {}) or {})}}
    body = json.dumps(keep)  # whole fact series for every concept we use (full file is 5–20 MB)
    sha = hashlib.sha256(body.encode()).hexdigest()
    conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
                    VALUES ('sec', 'companyfacts', %s, %s, %s::jsonb, %s)
                    ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload,
                    payload_sha = EXCLUDED.payload_sha
                    WHERE vendor_raw.payload_sha IS DISTINCT FROM EXCLUDED.payload_sha""",
                 (ticker, date.today(), body, sha))
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


ADR_RATIOS = (1, 2, 3, 4, 5, 8, 10)  # ordinary shares per US-listed ADS (BABA 8:1, TSM 5:1, …)


def _latest_basic_wa(facts: dict, near_end: str | None = None) -> dict | None:
    vals = [u for u in _units(facts, "WeightedAverageNumberOfSharesOutstandingBasic", "shares") if u.get("start")]
    if not vals:
        return None
    if near_end:
        same = [u for u in vals if u["end"] == near_end]
        if same:
            return max(same, key=lambda x: (x["filed"], x["start"]))
    return max(vals, key=lambda x: (x["end"], x["filed"], x["start"]))


def filing_shares_to_ads(ordinary_sh: float, adr_ratio: int | None) -> float:
    """Every share count from 20-F / companyfacts (ordinary) → US-listed ADS (price is per ADS)."""
    if not adr_ratio or adr_ratio <= 1:
        return ordinary_sh
    return ordinary_sh / adr_ratio


def adr_ads_shares(*, dei: float, basic: float, fmp_sh: float | None = None) -> tuple[float | None, int | None]:
    """Map 20-F ordinary basic WA → US ADS count (price is per ADS). Returns (ads, adr_ratio)."""
    if dei <= 0 or basic <= 0 or basic / dei < 5:
        return None, None
    best_r, best_ads, best_err = None, None, None
    for ratio in ADR_RATIOS:
        ads = filing_shares_to_ads(basic, ratio)
        err = abs(ads - fmp_sh) / fmp_sh if fmp_sh else abs(ads - dei) / max(ads, 1.0)
        if best_err is None or err < best_err:
            best_r, best_ads, best_err = ratio, ads, err
    if fmp_sh:
        if best_err > 0.05 or abs(dei - fmp_sh) / fmp_sh <= 0.10:
            return None, None
    elif best_err > 0.15:
        return None, None
    return best_ads, best_r


def detect_adr_ratio(
    facts: dict, conn=None, ticker: str | None = None, near_end: str | None = None,
) -> int | None:
    """ADR ordinary→ADS ratio when 20-F dei is mis-scaled vs ordinary basic WA (same rule as shares())."""
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
    # 11-04: drop future-dated covers (AAL filed a cover dated 2027-07-17 → picked as "latest").
    vals = [u for u in (dei or {}).get("units", {}).get("shares", []) if u["end"] <= date.today().isoformat()]
    if not vals:
        return None
    u = max(vals, key=lambda x: (x["end"], x["filed"]))
    tot = sum(x["val"] for x in vals if x["end"] == u["end"] and x["filed"] == u["filed"])
    basic = _latest_basic_wa(facts, near_end or u["end"])
    if not basic:
        return None
    fmp_sh = None
    if conn and ticker:
        r = rows(
            conn,
            "SELECT fmp_shares_outstanding::float8 sh FROM fmp_fundamentals WHERE ticker = %s AND fmp_shares_outstanding > 0",
            (ticker.upper(),),
        )
        fmp_sh = float(r[0]["sh"]) if r else None
    _, ratio = adr_ads_shares(dei=tot, basic=float(basic["val"]), fmp_sh=fmp_sh)
    return ratio


def shares(facts: dict, conn=None, ticker: str | None = None, adr_ratio: int | None = None) -> dict | None:
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
    vals = [u for u in (dei or {}).get("units", {}).get("shares", []) if u["end"] <= date.today().isoformat()]  # 11-04 AAL 2027 cover
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
    raw = {"value": tot, "concept": "dei:EntityCommonStockSharesOutstanding", "end": u["end"], "filed": u["filed"]}
    basic = _latest_basic_wa(facts, raw.get("end"))
    if basic:
        ratio = adr_ratio
        if ratio is None and conn and ticker:
            ratio = detect_adr_ratio(facts, conn, ticker, raw.get("end"))
        if ratio:
            ads = filing_shares_to_ads(float(basic["val"]), ratio)
            fmp_note = ""
            if conn and ticker:
                r = rows(
                    conn,
                    "SELECT fmp_shares_outstanding::float8 sh FROM fmp_fundamentals WHERE ticker = %s AND fmp_shares_outstanding > 0",
                    (ticker.upper(),),
                )
                if r:
                    fmp_note = f" (vendor {float(r[0]['sh'])/1e6:.0f}M)"
            return {
                **raw,
                "value": ads,
                "concept": f"WeightedAverageNumberOfSharesOutstandingBasic/{ratio} ADS",
                "end": basic["end"],
                "filed": basic["filed"],
                "how": f"20-F dei mis-scaled vs ordinary basic; ÷{ratio} for US ADS{fmp_note}",
            }
    return raw


def dilution(facts: dict, asof: str, adr_ratio: int | None = None) -> dict:
    """Unvested RSUs, options outstanding and their weighted strike at the latest instant ≤ asof (stale > 400 d → none)."""
    out = {}
    for k, c in DILUTION.items():
        vals = [u for u in _units(facts, c, "USD/shares" if k == "strike" else "shares") if not u.get("start") and u["end"] <= asof]
        if vals:
            u = max(vals, key=lambda x: (x["end"], x["filed"]))
            if _days(u["end"], asof) <= 400:
                val = filing_shares_to_ads(u["val"], adr_ratio) if k != "strike" else u["val"]
                out[k] = {"value": val, "end": u["end"], "filed": u["filed"]}
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
        gap = max(w["diluted"]["val"] - w["basic"]["val"], 0)
        out["dil_gap"] = {"value": filing_shares_to_ads(gap, adr_ratio), "end": w["diluted"]["end"]}
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
    adr_ratio = detect_adr_ratio(facts, conn, ticker, asof)
    out["shares"] = shares(facts, conn, ticker, adr_ratio=adr_ratio)
    out["dilution"] = dilution(facts, asof, adr_ratio=adr_ratio)
    # A288: conversion price — prefer dimension-free; else per-tranche segments; vintage-match to face end.
    face_end = (out.get("convert_debt") or {}).get("end")
    cp_raw = _units(facts, CONVERT_PRICE, "USD/shares")
    # Also keep segmented rows (companyfacts rarely has them; companyconcept may).
    cp_all = [u for u in cp_raw if not u.get("start") and u.get("end") and u["end"] <= asof and u.get("val") and u["val"] > 0]
    def _vintage_ok(u_end: str) -> bool:
        if face_end and _days(u_end, face_end) <= 548:  # ~18m of face balance date
            return True
        return _days(u_end, asof) <= 400

    free = [u for u in cp_all if not u.get("segments") and _vintage_ok(u["end"])]
    segs = [u for u in cp_all if u.get("segments") and _vintage_ok(u["end"])]
    if free:
        u = max(free, key=lambda x: (x["end"], x["filed"]))
        out["convert_price"] = {"value": float(u["val"]), "concept": CONVERT_PRICE, "end": u["end"], "filed": u["filed"]}
    if segs:
        # Group by segment label → one price per tranche; face split equal when per-tranche face absent.
        by = {}
        for u in segs:
            label = json.dumps(u.get("segments"), sort_keys=True)
            prev = by.get(label)
            if not prev or (u["end"], u["filed"]) > (prev["end"], prev["filed"]):
                by[label] = u
        face = float((out.get("convert_debt") or {}).get("value") or 0)
        n = max(len(by), 1)
        tranches = []
        for u in by.values():
            tranches.append({
                "face": face / n if face else 0.0,
                "px": float(u["val"]),
                "end": u["end"],
                "segments": u.get("segments"),
            })
        out["convert_tranches"] = tranches
        if "convert_price" not in out and len({round(t["px"], 4) for t in tranches}) == 1:
            out["convert_price"] = {"value": tranches[0]["px"], "concept": CONVERT_PRICE, "end": tranches[0]["end"], "filed": "segments"}
    # Note overrides when XBRL has face but no usable cpx (A288 #4/#5)
    if "convert_price" not in out and "convert_tranches" not in out:
        ov = CONVERT_NOTE_OVERRIDES.get(ticker)
        face = float((out.get("convert_debt") or {}).get("value") or 0)
        if ov and (face > 0 or any(tr.get("face") for tr in ov["tranches"])):
            trs = []
            for tr in ov["tranches"]:
                face_i = float(tr["face"]) if tr.get("face") else face
                fc = tr.get("face_concept")
                if fc and not tr.get("face"):
                    bal = balance(facts, [fc], asof)
                    if bal and bal.get("value"):
                        face_i = float(bal["value"])
                elif not tr.get("face") and len(ov["tranches"]) > 1:
                    face_i = face / len(ov["tranches"])
                if face_i <= 0:
                    continue
                trs.append({"face": face_i, "px": float(tr["px"]), "end": asof, "label": tr.get("label")})
            # Ensure convert_debt present when override supplies face (RKLB tags empty)
            if trs and face <= 0:
                tot = sum(t["face"] for t in trs)
                out["convert_debt"] = {"value": tot, "concept": "10Q_note_override", "end": asof, "filed": ov["source"]}
            out["convert_tranches"] = trs
            if len({round(t["px"], 4) for t in trs}) == 1:
                out["convert_price"] = {
                    "value": trs[0]["px"], "concept": "10Q_note_override",
                    "end": asof, "filed": ov["source"],
                }
            else:
                # representative mid for flags; engine uses convert_tranches
                out["convert_price"] = {
                    "value": sum(t["px"] for t in trs) / len(trs), "concept": "10Q_note_override_multi",
                    "end": asof, "filed": ov["source"],
                }
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
