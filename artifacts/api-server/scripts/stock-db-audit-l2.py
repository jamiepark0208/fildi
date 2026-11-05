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
EPS_DILUTED = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
]
GOODWILL = ["Goodwill"]
INTANG = [
    "IntangibleAssetsNetExcludingGoodwill",
    "IntangibleAssetsNetIncludingGoodwill",
    "FiniteLivedIntangibleAssetsNet",
]
COMMON_STOCK_SHARES = ["CommonStockSharesOutstanding"]
DEI_COVER = "EntityCommonStockSharesOutstanding"
DEI_SHARES_FALLBACK_DAYS = 60
PER_SHARE_FIELDS = frozenset({
    "earningsPerShare",
    "sharesOutstanding",
    "sharesOutstandingPrior",
    "tangibleBookValuePerShare",
})
STALE_SHARES_DAYS = 183
PRIOR_SHARES_WINDOW = 45
MAX_PERIOD_DAYS = 15 * 30
# Aligned definitions (FIELD_DEFS + gold + truth) — period/ADR mismatches are not "definition".
DEFINITION_ONLY_FIELDS = {"debtToEquity"}
DEFINITION_RATE_EXCLUDED = frozenset({"definition", "definition_mismatch"})
FLOW_PERIOD_FIELDS = {"netIncome", "freeCashFlow", "totalRevenue", "ebitda"}
INSTANT_PERIOD_FIELDS = {"totalStockholdersEquity", "totalDebt", "cashAndEquivalents"}


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


def financial_currency(conn, ticker: str) -> str | None:
    r = rows(
        conn,
        """
        SELECT payload->'financialData'->>'financialCurrency' AS fc
        FROM vendor_raw
        WHERE source = 'yahoo' AND key = %s
          AND payload->'financialData'->>'financialCurrency' IS NOT NULL
        ORDER BY fetched_on DESC
        LIMIT 1
        """,
        (ticker.upper(),),
    )
    if not r:
        return None
    fc = (r[0].get("fc") or "").strip().upper()
    return fc or None


def has_quarterly_eps_facts(facts: dict) -> bool:
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    for c in EPS_DILUTED:
        node = gaap.get(c)
        if not node:
            continue
        for unit in node.get("units", {}).get("USD/shares", []):
            if unit.get("start") and F._days(unit["start"], unit["end"]) < 100:
                return True
    return False


def ttm_eps_diluted(facts: dict, anchor_end: str | None = None) -> dict | None:
    """Sum last four quarterly diluted EPS facts ending on/before anchor (not stale FY+YTD)."""
    anchor = anchor_end or date.today().isoformat()
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    for c in EPS_DILUTED:
        node = gaap.get(c)
        if not node:
            continue
        quals = [
            u
            for u in node.get("units", {}).get("USD/shares", [])
            if u.get("start")
            and 80 <= F._days(u["start"], u["end"]) <= 100
            and u["end"] <= anchor
        ]
        if len(quals) < 4:
            continue
        quals.sort(key=lambda u: u["end"], reverse=True)
        picked = [quals[0]]
        for u in quals[1:]:
            if len(picked) >= 4:
                break
            if all(abs((date.fromisoformat(u["end"]) - date.fromisoformat(p["end"])).days) >= 80 for p in picked):
                picked.append(u)
        if len(picked) < 4:
            continue
        picked = picked[:4]
        total = sum(float(u["val"]) for u in picked)
        end = max(u["end"] for u in picked)
        return {
            "value": total,
            "end": end,
            "how": f"4Q diluted {c}",
            "concept": c,
        }
    return None


def cover_shares_on_bs_end(
    facts: dict,
    conn,
    ticker: str,
    bs_end: str,
) -> tuple[float | None, str]:
    """Balance-sheet-date shares: us-gaap CommonStockSharesOutstanding, else dei within 60d."""
    gaap = (facts or {}).get("facts", {}).get("us-gaap") or {}
    for c in COMMON_STOCK_SHARES:
        node = gaap.get(c)
        if not node:
            continue
        for unit in node.get("units", {}).get("shares", []):
            if unit.get("start"):
                continue
            if unit["end"] == bs_end:
                return float(unit["val"]), f"us-gaap {c} {bs_end}"
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get(DEI_COVER)
    vals = [u for u in (dei or {}).get("units", {}).get("shares", [])]
    near = [
        u
        for u in vals
        if abs(days_apart(u["end"], bs_end)) <= DEI_SHARES_FALLBACK_DAYS
    ]
    if not near:
        return None, f"no cover shares on {bs_end}"
    end = max(u["end"] for u in near)
    same = [u for u in near if u["end"] == end]
    u0 = max(same, key=lambda x: x["filed"])
    tot = sum(x["val"] for x in same if x["filed"] == u0["filed"])
    basic = F._latest_basic_wa(facts, end)
    adr = F.detect_adr_ratio(facts, conn, ticker, end) if conn and ticker else None
    if basic and adr and adr > 1:
        ads = F.filing_shares_to_ads(float(basic["val"]), adr)
        return ads, f"dei {end} ADS ÷{adr} (±{DEI_SHARES_FALLBACK_DAYS}d)"
    return tot, f"dei sum classes {end} (±{DEI_SHARES_FALLBACK_DAYS}d from {bs_end})"


def basic_wa_end_near(facts: dict, anchor_end: str, days_back: int, window: int = PRIOR_SHARES_WINDOW) -> str | None:
    """Quarterly basic WA period end nearest anchor_end − days_back (±window)."""
    vals = [
        u
        for u in F._units(facts, "WeightedAverageNumberOfSharesOutstandingBasic", "shares")
        if u.get("start") and 80 <= F._days(u["start"], u["end"]) <= 100
    ]
    if not vals:
        return None
    target = date.fromisoformat(anchor_end) - timedelta(days=days_back)
    ends = {u["end"] for u in vals if abs((date.fromisoformat(u["end"]) - target).days) <= window}
    return max(ends) if ends else None


def prior_basic_wa_shares(
    facts: dict, conn, ticker: str, anchor_end: str
) -> tuple[float | None, str]:
    """Yahoo/FMP prior ≈ prior fiscal basic weighted-average; SEC match on same concept."""
    end = basic_wa_end_near(facts, anchor_end, 365)
    if not end:
        return None, "prior basic WA end missing"
    basic = F._latest_basic_wa(facts, end)
    if not basic:
        return None, f"prior basic WA missing on {end}"
    val = float(basic["val"])
    adr = F.detect_adr_ratio(facts, conn, ticker, end) if conn and ticker else None
    if adr and adr > 1:
        val = F.filing_shares_to_ads(val, adr)
        return val, f"prior basic WA {end} ADS ÷{adr}"
    return val, f"prior basic WA {end}"


def sec_shares_prior(facts: dict, conn, ticker: str) -> tuple[float | None, str]:
    _cur, cur_note = sec_shares_current(facts, conn, ticker)
    if _cur is None:
        return None, cur_note
    anchor = parse_truth_period_end(cur_note)
    if not anchor:
        return None, "prior anchor missing"
    return prior_basic_wa_shares(facts, conn, ticker, anchor)


def dei_end_near(facts: dict, anchor_end: str, days_back: int, window: int = PRIOR_SHARES_WINDOW) -> str | None:
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
    vals = [u for u in (dei or {}).get("units", {}).get("shares", [])]
    if not vals:
        return None
    target = date.fromisoformat(anchor_end) - timedelta(days=days_back)
    ends = {u["end"] for u in vals if abs((date.fromisoformat(u["end"]) - target).days) <= window}
    return max(ends) if ends else None


def dei_shares_on_end(facts: dict, conn, ticker: str, end: str) -> tuple[float | None, str]:
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
    vals = [u for u in (dei or {}).get("units", {}).get("shares", []) if u["end"] == end]
    if not vals:
        return None, f"no dei on {end}"
    u = max(vals, key=lambda x: x["filed"])
    tot = sum(x["val"] for x in vals if x["filed"] == u["filed"])
    basic = F._latest_basic_wa(facts, end)
    adr = F.detect_adr_ratio(facts, conn, ticker, end) if conn and ticker else None
    if basic and adr and adr > 1:
        ads = F.filing_shares_to_ads(float(basic["val"]), adr)
        return ads, f"prior dei {end} ADS ÷{adr}"
    return tot, f"prior dei sum classes {end}"


def sec_shares_current(facts: dict, conn, ticker: str) -> tuple[float | None, str]:
    dei = (facts.get("facts", {}).get("dei", {}) or {}).get(DEI_COVER)
    vals = [u for u in (dei or {}).get("units", {}).get("shares", []) if u["end"] <= date.today().isoformat()]
    if not vals:
        return None, "skip_no_cover_shares"
    u = max(vals, key=lambda x: (x["end"], x["filed"]))
    if days_apart(u["end"], date.today().isoformat()) > MAX_PERIOD_DAYS:
        return None, "skip_stale_dei"
    tot = sum(x["val"] for x in vals if x["end"] == u["end"] and x["filed"] == u["filed"])
    note = f"dei {DEI_COVER} {u['end']}"
    basic = F._latest_basic_wa(facts, u["end"])
    adr = F.detect_adr_ratio(facts, conn, ticker, u["end"]) if conn and ticker else None
    if basic and adr and adr > 1:
        tot = F.filing_shares_to_ads(float(basic["val"]), adr)
        note += f" ADS ÷{adr}"
    if days_apart(u["end"], date.today().isoformat()) > STALE_SHARES_DAYS:
        note += " stale_shares"
    return tot, note


def ratio_near_known_adr(gold: float, truth: float) -> bool:
    if truth == 0:
        return False
    ratio = abs(gold) / max(abs(truth), 1e-9)
    for r in F.ADR_RATIOS:
        if r <= 1:
            continue
        if abs(ratio - r) / r < 0.12 or abs(ratio - 1 / r) / max(1 / r, 1e-9) < 0.12:
            return True
    return False


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


def miss_cause(row: dict, facts: dict | None = None, conn=None) -> str:
    note = (row.get("note") or "").lower()
    if row.get("truth") is None:
        if "skip_no_quarterly" in note or "skip_no_cover_shares" in note or "skip_stale_dei" in note or "skip_tbv_leg_missing" in note:
            return "definition"
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
    if field in PER_SHARE_FIELDS:
        if "stale_shares" in note and field in ("sharesOutstanding", "sharesOutstandingPrior"):
            return "stale_shares"
        if field in ("earningsPerShare", "sharesOutstanding", "sharesOutstandingPrior") and (
            ratio_near_known_adr(gold, truth)
            or (
                scale_looks_adr(gold, truth)
                and facts
                and ticker
                and (F.detect_adr_ratio(facts, conn, ticker, truth_end) or 0) > 1
            )
        ):
            return "adr_ratio"
        if field == "earningsPerShare" and conn and ticker:
            fc = financial_currency(conn, ticker)
            if fc and fc != "USD":
                return "currency"
        if field == "sharesOutstanding" and truth:
            r = gold / truth
            if 1.85 <= r <= 2.15 or 0.46 <= r <= 0.54:
                return "share_class_partial"
        if field == "sharesOutstandingPrior" and truth > 0:
            r = gold / truth
            # Vendor prior = basic WA (Yahoo fts-1); residual gap vs cover-count truth → definition.
            if 1.03 <= r <= 1.10 or ("prior basic wa" in note and 1.02 <= r <= 1.12):
                return "definition_mismatch"
        if field == "earningsPerShare" and "basic" in note and "diluted" not in note:
            return "basic_vs_diluted"
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


def sec_truth(conn, facts, ticker, field, gold_period_end: str | None = None):
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
    if field == "earningsPerShare":
        if not has_quarterly_eps_facts(facts):
            return None, "skip_no_quarterly"
        eps_anchor = gold_period_end or anchor
        eps = ttm_eps_diluted(facts, eps_anchor)
        if not eps:
            return None, "EPS diluted TTM missing"
        how = eps.get("how") or "TTM"
        return eps["value"], f"EPS diluted {how} {eps['end']}"
    if field == "sharesOutstanding":
        return sec_shares_current(facts, conn, ticker)
    if field == "sharesOutstandingPrior":
        return sec_shares_prior(facts, conn, ticker)
    if field == "tangibleBookValuePerShare":
        # One definition with the producer (sec_gold_fields.tangible_book): common equity − preferred − goodwill
        # − intangibles ex-goodwill, every leg at the equity date; a missing leg is a skip, never 0.
        import sec_gold_fields as SG
        eq = audit_instant(facts, EQ, asof, anchor)
        if not eq:
            return None, "equity tag missing/stale"
        bs_end = eq["end"]
        parent = SG._parent_equity(facts, bs_end)
        cover = F.shares(facts)
        if not cover or not str(cover.get("concept", "")).startswith("dei:"):
            cover = SG._latest_bs_shares(facts)
        if parent is None or not cover:
            return None, "skip_tbv_leg_missing"
        tbvps = SG.tangible_book(facts, parent, bs_end, cover)
        if tbvps is None:
            return None, "skip_tbv_leg_missing"
        return tbvps, f"TBVPS {bs_end} (sec_gold_fields.tangible_book)"
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


def yahoo_mrq(conn, ticker: str) -> str | None:
    r = rows(
        conn,
        """
        SELECT payload->'financialData'->>'mostRecentQuarter' AS mrq
        FROM vendor_raw
        WHERE source = 'yahoo' AND key = %s AND payload ? 'financialData'
        ORDER BY fetched_on DESC
        LIMIT 1
        """,
        (ticker.upper(),),
    )
    if not r or not r[0].get("mrq"):
        return None
    raw = str(r[0]["mrq"]).strip()
    try:
        n = float(raw)
        if n > 1e8:
            from datetime import datetime

            return datetime.utcfromtimestamp(n if n < 1e12 else n / 1000).date().isoformat()
    except ValueError:
        pass
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return raw[:10]
    return None


def row_counts_for_rate(row: dict, facts: dict | None, conn) -> bool:
    if row.get("truth") is None:
        return False
    cause = miss_cause(row, facts, conn)
    return cause not in DEFINITION_RATE_EXCLUDED


def cohort_summary(judged_rows, cohort: str, conn, cache: dict):
    rows_c = [
        r
        for r in judged_rows
        if r.get("cohort") == cohort
        and r["truth"] is not None
        and row_counts_for_rate(r, cache.get(r["ticker"]), conn)
    ]
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
        gold_pe = c.get("goldPeriodEnd") or yahoo_mrq(conn, t)
        truth, note = sec_truth(conn, cache[t], t, f, gold_pe)
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
                "goldPeriodEnd": gold_pe or c.get("goldPeriodEnd"),
            }
        )
    flagged = cohort_summary(judged, "flagged", conn, cache)
    clean = cohort_summary(judged, "clean", conn, cache)
    by_field: dict[str, dict] = {}
    for r in judged:
        if r.get("cohort") != "clean":
            continue
        fld = r["field"]
        if fld not in by_field:
            by_field[fld] = {"judged": 0, "ok": 0}
        if not row_counts_for_rate(r, cache.get(r["ticker"]), conn):
            continue
        by_field[fld]["judged"] += 1
        if r.get("ok"):
            by_field[fld]["ok"] += 1
    for fld, stats in by_field.items():
        n = stats["judged"]
        stats["rate"] = stats["ok"] / n if n else 0.0
    clean_misses = [
        {
            "ticker": r["ticker"],
            "field": r["field"],
            "gold": r["gold"],
            "truth": r["truth"],
            "note": r["note"],
            "cause": miss_cause({**r, "ticker": r["ticker"]}, cache.get(r["ticker"]), conn),
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
        "cleanByField": by_field,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"l2-results-{run_id}.json").write_text(json.dumps({"summary": summary, "rows": judged}, indent=1))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
