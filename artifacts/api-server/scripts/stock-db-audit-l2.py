#!/usr/bin/env python3
"""A329 L2 — SEC companyfacts on L0/L1 flags + 5% clean sample (separate error rates)."""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts/watchlist_sync"))
sys.path.insert(0, str(REPO / "scripts/watchlist_sync/dcf"))
OUT = REPO / "artifacts/api-server/out/audit"

import financials as F  # noqa: E402
from build_plan import connect, rows  # noqa: E402

FRACTION = {"grossMargin", "netMargin", "operatingMargin", "returnOnAssets", "dividendYield"}
NI_COMMON = [
    "NetIncomeLossAvailableToCommonStockholdersBasic",
    "NetIncomeLossAvailableToCommonStockholdersDiluted",
    "NetIncomeLoss",
    "ProfitLoss",
]
REV = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenuesNetOfInterestExpense", "SalesRevenueNet"]
ASSETS = ["Assets"]
EQ = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]
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
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
]
DA = ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization"]
OCF = ["NetCashProvidedByUsedInOperatingActivities"]
CAPEX = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]
MAX_PERIOD_DAYS = 15 * 30
# Aligned definitions (FIELD_DEFS + gold + truth) — period/ADR mismatches are not "definition".
DEFINITION_ONLY_FIELDS = {"debtToEquity"}
FLOW_PERIOD_FIELDS = {"netIncome", "freeCashFlow", "totalRevenue", "ebitda"}
INSTANT_PERIOD_FIELDS = {"totalStockholdersEquity", "totalDebt", "cashAndEquivalents"}


def ok(v, t, field):
    if v is None or t is None:
        return None
    band = max(abs(t) * 0.20, 0.03 if field in FRACTION else 0)
    return abs(v - t) <= band


def fresh_ni(facts, concepts, rev_end=None):
    for c in concepts:
        r = F.ttm_flow(facts, [c])
        if r and (not rev_end or r["end"] >= rev_end):
            return r
    return F.ttm_flow(facts, ["NetIncomeLoss"])


def price(conn, t):
    r = rows(conn, "SELECT close, date FROM prices_historical WHERE ticker=%s ORDER BY date DESC LIMIT 1", (t,))
    return (float(r[0]["close"]), str(r[0]["date"])) if r else (None, None)


def days_apart(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def period_fresh(end: str, anchor: str) -> bool:
    return days_apart(end, anchor) <= MAX_PERIOD_DAYS


def audit_instant(facts: dict, concepts: list[str], asof: str, anchor: str) -> dict | None:
    """Instant tag on/before asof; missing or stale vs anchor → None (never stand-in 0)."""
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
    """LT debt tag required; add current portion + ST borrowings when present (leases excluded)."""
    lt = audit_instant(facts, DEBT_LT, asof, anchor)
    if lt is None:
        return None, "debt LT tag missing"
    cur = audit_instant(facts, DEBT_CUR, asof, anchor)
    st = audit_instant(facts, DEBT_ST, asof, anchor)
    total = lt["value"] + (cur["value"] if cur else 0.0) + (st["value"] if st else 0.0)
    ends = ",".join(sorted({p["end"] for p in (lt, cur, st) if p is not None}))
    return total, f"debt ex-leases ends={ends}"


def filer_de_excluded(conn, ticker: str) -> bool:
    r = rows(
        conn,
        "SELECT sector, industry_group FROM ticker_registry WHERE ticker=%s",
        (ticker.upper(),),
    )
    if not r:
        return False
    sector = (r[0].get("sector") or "").lower()
    industry = (r[0].get("industry_group") or "").lower()
    if "real estate" in sector or "reit" in industry:
        return True
    if "insurance" in sector or "insurance" in industry:
        return True
    return False


def sec_cash_total(facts: dict, asof: str, anchor: str) -> tuple[float | None, str]:
    """Cash + ST investments (net-debt basis; matches FIELD_DEFS cashAndEquivalents)."""
    cash = audit_instant(facts, CASH, asof, anchor)
    if not cash:
        return None, "cash tag missing/stale"
    st = audit_instant(facts, CASH_ST, asof, anchor)
    total = cash["value"] + (st["value"] if st else 0.0)
    ends = cash["end"] if not st else f"{cash['end']}+{st['end']}"
    return total, f"cash+ST {ends}"


def parse_truth_period_end(note: str | None) -> str | None:
    if not note:
        return None
    m = re.search(r"(\d{4}-\d{2}-\d{2})", note)
    return m.group(1) if m else None


def scale_looks_adr(gold: float, truth: float) -> bool:
    if truth == 0:
        return False
    ratio = abs(gold) / max(abs(truth), 1.0)
    return ratio >= 3.5 or ratio <= 0.29


def miss_cause(row: dict, facts: dict | None = None) -> str:
    note = (row.get("note") or "").lower()
    if row.get("truth") is None:
        if "missing" in note or "no us-gaap" in note:
            return "truth_missing"
        if "stale" in note:
            return "stale_period"
        if "not filing" in note or "excluded filer" in note:
            return "definition"
        return "truth_missing"
    gold = float(row["gold"])
    truth = float(row["truth"])
    field = row["field"]
    ticker = row.get("ticker", "")
    truth_end = parse_truth_period_end(row.get("note"))
    gold_end = row.get("goldPeriodEnd")
    if truth_end and gold_end and days_apart(truth_end, gold_end) > MAX_PERIOD_DAYS:
        return "wrong_period"
    if field in FLOW_PERIOD_FIELDS and note.strip() == "fy":
        return "wrong_period"
    if field in ("totalRevenue", "totalStockholdersEquity") and scale_looks_adr(gold, truth):
        if facts and ticker:
            try:
                adr = F.detect_adr_ratio(facts, None, ticker, truth_end)
            except Exception:  # noqa: BLE001
                adr = None
            if adr and adr > 1:
                return "definition"
        return "definition"
    if field in DEFINITION_ONLY_FIELDS or "excluded filer" in note:
        return "definition"
    rel = abs(gold - truth) / max(abs(gold), abs(truth), 1.0)
    if rel > 0.35:
        return "gold_wrong"
    if rel > 0.20:
        return "truth_builder"
    return "gold_wrong"


def sec_truth(conn, facts, ticker, field):
    if not facts or not facts.get("facts", {}).get("us-gaap"):
        return None, "no us-gaap companyfacts"
    today = date.today().isoformat()
    rev = F.ttm_flow(facts, REV)
    if rev and not period_fresh(rev["end"], today):
        rev = None
    anchor = (rev or {}).get("end") or today
    asof = anchor
    ni = fresh_ni(facts, NI_COMMON, (rev or {}).get("end"))
    if field == "returnOnAssets":
        ni_roa = fresh_ni(facts, NI_COMMON[:2] + ["NetIncomeLoss"], (rev or {}).get("end"))
        a = audit_instant(facts, ASSETS, asof, anchor)
        a0_end = (date.fromisoformat(a["end"]) - timedelta(days=360)).isoformat() if a else asof
        a0 = audit_instant(facts, ASSETS, a0_end, anchor) if a else None
        if ni_roa and a and ni_roa.get("end") and period_fresh(ni_roa["end"], anchor):
            avg = (a["value"] + a0["value"]) / 2 if a0 and a0["value"] else a["value"]
            return ni_roa["value"] / avg, f"NI/assets avg {avg/1e6:.0f}M"
    if field in ("grossMargin", "netMargin", "operatingMargin"):
        num = {
            "grossMargin": F.ttm_flow(facts, ["GrossProfit"]),
            "netMargin": ni,
            "operatingMargin": F.ttm_flow(facts, ["OperatingIncomeLoss"]),
        }[field]
        if field == "grossMargin" and not num:
            cogs = F.ttm_flow(facts, ["CostOfGoodsAndServicesSold", "CostOfRevenue"])
            num = {"value": rev["value"] - cogs["value"], "end": cogs["end"]} if cogs and rev else None
        if num and rev and period_fresh(rev["end"], anchor):
            return num["value"] / rev["value"], f"margin TTM {rev['end']}"
    if field == "priceToBook":
        eq, sh = audit_instant(facts, EQ, asof, anchor), F.shares(facts)
        p, _ = price(conn, ticker)
        if eq and sh and p and eq["value"]:
            return p * sh["value"] / eq["value"], "px×sh/eq"
    if field == "returnOnEquity":
        eq = audit_instant(facts, EQ, asof, anchor)
        if ni and eq and eq["value"] and eq["value"] > 0:
            if ni.get("end") and not period_fresh(ni["end"], anchor):
                return None, "stale NI period"
            return ni["value"] / eq["value"], f"NI/ending equity {eq['end']}"
        return None, "missing ROE inputs or non-positive equity"
    if field == "debtToEquity":
        if filer_de_excluded(conn, ticker):
            return None, "D/E excluded filer type (REIT/insurer)"
        debt, dnote = sec_debt_total(facts, asof, anchor)
        eq = audit_instant(facts, EQ, asof, anchor)
        if debt is None or eq is None:
            return None, dnote if debt is None else "equity tag missing/stale"
        if eq["value"] <= 0:
            return None, "non-positive equity"
        return debt / eq["value"], f"{dnote} / eq {eq['end']}"
    if field == "totalDebt":
        debt, dnote = sec_debt_total(facts, asof, anchor)
        if debt is None:
            return None, dnote
        return debt, dnote
    if field == "totalStockholdersEquity":
        eq = audit_instant(facts, EQ, asof, anchor)
        if not eq:
            return None, "equity tag missing/stale"
        return eq["value"], f"equity {eq['concept']} {eq['end']}"
    if field == "cashAndEquivalents":
        total, cnote = sec_cash_total(facts, asof, anchor)
        if total is None:
            return None, cnote
        return total, cnote
    if field == "netIncome":
        if ni and ni.get("end") and period_fresh(ni["end"], anchor):
            return ni["value"], f"NI TTM {ni['end']}"
        return None, "stale NI period" if ni else "NI tag missing"
    if field == "ebitda":
        oi = F.ttm_flow(facts, ["OperatingIncomeLoss"])
        da = F.ttm_flow(facts, DA)
        if oi and da and period_fresh(oi["end"], anchor):
            return oi["value"] + da["value"], f"OI+DA TTM {oi['end']}"
        return None, "EBITDA components missing/stale"
    if field == "freeCashFlow":
        ocf = F.ttm_flow(facts, OCF)
        cap = F.ttm_flow(facts, CAPEX)
        if ocf and cap and period_fresh(ocf["end"], anchor):
            return ocf["value"] - cap["value"], f"OCF-capex TTM {ocf['end']}"
        return None, "FCF components missing/stale"
    if field == "totalRevenue" and rev:
        return rev["value"], rev["how"]
    return None, "not filing-checkable"


def wilson(successes, n, z=1.96):
    if n <= 0:
        return 0.0, 0.0, 0.0
    p = successes / n
    denom = 1 + (z * z) / n
    center = p + (z * z) / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)
    return p, max(0, (center - margin) / denom), min(1, (center + margin) / denom)


def load_cells(run_id: str):
    cells = []
    flags_path = OUT / f"flags-{run_id}.json"
    sample_path = OUT / f"l2-sample-{run_id}.json"
    if flags_path.exists():
        for row in json.loads(flags_path.read_text())["flags"]:
            cells.append({**row, "afterGold": row["gold"], "cohort": row.get("cohort", "flagged")})
    if sample_path.exists():
        for row in json.loads(sample_path.read_text())["sample"]:
            cells.append({**row, "afterGold": row["gold"], "cohort": row.get("cohort", "clean")})
    seen = set()
    out = []
    for c in cells:
        k = (c["ticker"], c["field"], c.get("cohort", "?"))
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def cohort_summary(judged_rows, cohort: str):
    rows_c = [r for r in judged_rows if r.get("cohort") == cohort and r["truth"] is not None]
    ok_n = sum(1 for r in rows_c if r["ok"])
    rate, lo, hi = wilson(ok_n, len(rows_c))
    return {"judged": len(rows_c), "ok": ok_n, "rate": rate, "ci95": [lo, hi]}


def main():
    run_id = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
    cells = load_cells(run_id)
    conn = connect()
    cache = {}
    judged = []
    for c in cells:
        t, f = c["ticker"], c["field"]
        gold = float(c["afterGold"]) if c.get("afterGold") is not None else None
        if t not in cache:
            try:
                cache[t] = F.companyfacts(conn, t)
            except Exception as e:  # noqa: BLE001
                cache[t] = None
                print("fetch fail", t, e, file=sys.stderr)
        truth, note = sec_truth(conn, cache[t], t, f)
        verdict = ok(gold, truth, f) if gold is not None else None
        judged.append(
            {
                "ticker": t,
                "field": f,
                "cohort": c.get("cohort", "flagged"),
                "gold": gold,
                "truth": truth,
                "ok": verdict,
                "note": note,
                "goldPeriodEnd": c.get("goldPeriodEnd"),
            }
        )
    flagged = cohort_summary(judged, "flagged")
    clean = cohort_summary(judged, "clean")
    clean_misses = [
        {
            "ticker": r["ticker"],
            "field": r["field"],
            "gold": r["gold"],
            "truth": r["truth"],
            "note": r["note"],
            "cause": miss_cause({**r, "ticker": r["ticker"]}, cache.get(r["ticker"])),
        }
        for r in judged
        if r.get("cohort") == "clean" and r["truth"] is not None and not r["ok"]
    ]
    by_cause: dict[str, int] = {}
    for m in clean_misses:
        by_cause[m["cause"]] = by_cause.get(m["cause"], 0) + 1
    summary = {
        "runId": run_id,
        "cells": len(cells),
        "flagged": flagged,
        "clean": clean,
        "cleanMisses": clean_misses,
        "cleanMissesByCause": by_cause,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"l2-results-{run_id}.json").write_text(json.dumps({"summary": summary, "rows": judged}, indent=1))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
