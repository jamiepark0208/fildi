#!/usr/bin/env python3
"""A329 L2 — SEC companyfacts on L0/L1 flags + 5% clean sample (separate error rates)."""
from __future__ import annotations

import json
import math
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


def sec_truth(conn, facts, ticker, field):
    if not facts or not facts.get("facts", {}).get("us-gaap"):
        return None, "no us-gaap companyfacts"
    rev = F.ttm_flow(facts, REV)
    asof = (rev or {}).get("end") or date.today().isoformat()
    ni = fresh_ni(facts, NI_COMMON, (rev or {}).get("end"))
    if field == "returnOnAssets":
        ni_roa = fresh_ni(facts, NI_COMMON[:2] + ["NetIncomeLoss"], (rev or {}).get("end"))
        a = F.balance(facts, ASSETS, asof)
        a0 = F.balance(facts, ASSETS, (date.fromisoformat(a["end"]) - timedelta(days=360)).isoformat()) if a else None
        if ni_roa and a:
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
        if num and rev:
            return num["value"] / rev["value"], f"margin TTM {rev['end']}"
    if field == "priceToBook":
        eq, sh = F.balance(facts, EQ, asof), F.shares(facts)
        p, _ = price(conn, ticker)
        if eq and sh and p and eq["value"]:
            return p * sh["value"] / eq["value"], "px×sh/eq"
    if field == "returnOnEquity":
        ni = fresh_ni(facts, NI_COMMON, (rev or {}).get("end"))
        eq = F.balance(facts, EQ, asof)
        if ni and eq and eq["value"]:
            return ni["value"] / eq["value"], f"NI/equity {eq['end']}"
    if field == "debtToEquity":
        debt = F.balance(facts, ["LongTermDebt", "LongTermDebtNoncurrent", "DebtCurrent"], asof)
        eq = F.balance(facts, EQ, asof)
        if debt and eq and eq["value"]:
            return debt["value"] / eq["value"], f"debt/equity {eq['end']}"
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
        }
        for r in judged
        if r.get("cohort") == "clean" and r["truth"] is not None and not r["ok"]
    ]
    summary = {
        "runId": run_id,
        "cells": len(cells),
        "flagged": flagged,
        "clean": clean,
        "cleanMisses": clean_misses,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"l2-results-{run_id}.json").write_text(json.dumps({"summary": summary, "rows": judged}, indent=1))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
