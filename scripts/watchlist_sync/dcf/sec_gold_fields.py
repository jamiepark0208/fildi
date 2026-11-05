"""A318: SEC companyfacts TTM → source_fundamentals (source=sec). Logic home: financials.py."""
from __future__ import annotations

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

import financials as F  # noqa: E402

EQ = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]
ROA_NI_CONCEPTS = (
    ["NetIncomeLossAvailableToCommonStockholdersBasic"],
    ["NetIncomeLoss"],
)


SHARES_MAX_AGE_D = 120   # older cover = stale (buybacks); vendor current count wins instead
SEC_OWNED_FIELDS = ("sharesOutstanding", "tangibleBookValuePerShare")   # deleted when not produced this run
INTANG_EX_GW = ["IntangibleAssetsNetExcludingGoodwill"]
INTANG_PARTS = ["FiniteLivedIntangibleAssetsNet", "IndefiniteLivedIntangibleAssetsExcludingGoodwill"]


def _at(facts: dict, concept: str, end: str) -> tuple[bool, float | None]:
    """(tag ever reported, value at exactly `end`). Never tagged → (False, None) = legitimately 0."""
    vals = [u for u in F._units(facts, concept) if not u.get("start")]
    if not vals:
        return False, None
    hit = [u for u in vals if u["end"] == end]
    if hit:
        return True, float(max(hit, key=lambda x: x["filed"])["val"])
    if max(u["end"] for u in vals) < end and F._days(max(u["end"] for u in vals), end) > 370:
        return False, None   # tag retired over a year before (goodwill written off) → 0
    return True, None


def _recent(facts: dict, concept: str, end: str) -> tuple[bool, float | None]:
    """Like _at, but intangibles (slow-moving, often tagged only in the 10-K: JPM, META) may come from the
    latest balance ≤ end within 370 d. Goodwill and equity stay exact-date."""
    tg, v = _at(facts, concept, end)
    if v is not None or not tg:
        return tg, v
    vals = [u for u in F._units(facts, concept) if not u.get("start") and u["end"] <= end and F._days(u["end"], end) <= 370]
    if not vals:
        return True, None
    return True, float(max(vals, key=lambda x: (x["end"], x["filed"]))["val"])


PREF_TAGS = ["PreferredStockValue", "PreferredStockValueOutstanding", "PreferredStockLiquidationPreferenceValue"]
PREF_DIV_TAGS = ["PreferredStockDividendsIncomeStatementImpact", "DividendsPreferredStock", "PreferredStockDividendsAndOtherAdjustments"]


def _preferred(facts: dict, end: str) -> float | None:
    """Preferred equity at `end`; 0 when the filer has none; None when it pays preferred dividends but the
    amount isn't tagged (BAC custom tag) — missing ≠ 0, or TBVPS would be overstated."""
    for c in PREF_TAGS:
        _, v = _recent(facts, c, end)
        if v is not None:
            return v
    for c in PREF_DIV_TAGS:
        if any(u.get("start") and u["end"] <= end and F._days(u["end"], end) <= 370 and u["val"]
               for u in F._units(facts, c)):
            return None
    return 0.0


def tangible_book(facts: dict, equity: float, eq_end: str, cover: dict) -> float | None:
    """(equity − goodwill − intangibles ex-goodwill) / shares, every leg at eq_end. Missing leg → None, never 0."""
    tagged, gw = _at(facts, "Goodwill", eq_end)
    if tagged and gw is None:
        return None
    tagged_i, intang = _recent(facts, INTANG_EX_GW[0], eq_end)
    if not tagged_i:
        intang = 0.0
        for c in INTANG_PARTS:
            tg, v = _recent(facts, c, eq_end)
            if tg and v is None:
                return None
            intang += v or 0.0
    elif intang is None:
        return None
    _, sh = _at_shares(facts, eq_end)
    if sh is None and abs(F._days(cover["end"], eq_end)) <= 60:
        sh = float(cover["value"])
    if not sh or sh <= 0:
        return None
    pref = _preferred(facts, eq_end)   # per COMMON share: banks carry preferred in equity
    if pref is None:
        return None
    return (equity - (pref or 0.0) - (gw or 0.0) - (intang or 0.0)) / sh


def _parent_equity(facts: dict, end: str) -> float | None:
    """Equity to common at `end`: StockholdersEquity, else incl.-NCI minus MinorityInterest (PG)."""
    tg, v = _at(facts, EQ[0], end)
    if v is not None:
        return v
    _, tot = _at(facts, EQ[1], end)
    if tot is None:
        return None
    tg_m, nci = _at(facts, "MinorityInterest", end)
    if tg_m and nci is None:
        return None
    return tot - (nci or 0.0)


def _latest_bs_shares(facts: dict) -> dict | None:
    today = date.today().isoformat()
    vals = [u for u in F._units(facts, "CommonStockSharesOutstanding", "shares") if u["end"] <= today]
    if not vals:
        return None
    u = max(vals, key=lambda x: (x["end"], x["filed"]))
    return {"value": float(u["val"]), "concept": "CommonStockSharesOutstanding", "end": u["end"], "filed": u["filed"]}


def _at_shares(facts: dict, end: str) -> tuple[bool, float | None]:
    vals = [u for u in F._units(facts, "CommonStockSharesOutstanding", "shares") if u["end"] == end]
    if not vals:
        return False, None
    return True, float(max(vals, key=lambda x: x["filed"])["val"])


def _roa_ni_numerator(facts: dict, rev: dict | None) -> dict | None:
    """Basic NI to common, else NetIncomeLoss; never Diluted. TTM end must be ≥ revenue TTM end."""
    if not rev:
        return None
    rev_end = str(rev["end"])[:10]
    for concepts in ROA_NI_CONCEPTS:
        ni = F.ttm_flow(facts, concepts)
        if ni and str(ni["end"])[:10] >= rev_end:
            return ni
    return None


def _load_facts(conn, ticker: str) -> dict | None:
    """Prefer vendor_raw; refresh from SEC when trimmed cache lacks net_income (ROA/NI)."""
    facts = F.stored_facts(conn, ticker)
    gaap = (facts or {}).get("facts", {}).get("us-gaap", {}) or {}
    if facts and any(c in gaap for c in F.FLOWS["net_income"]) and "Assets" in gaap:
        return facts
    return F.companyfacts(conn, ticker)


def _price(conn, ticker: str) -> float | None:
    r = rows(
        conn,
        "SELECT close FROM prices_historical WHERE ticker=%s ORDER BY date DESC LIMIT 1",
        (ticker.upper(),),
    )
    return float(r[0]["close"]) if r else None


def _gross_profit(facts: dict, rev: dict | None) -> dict | None:
    gp = F.ttm_flow(facts, F.FLOWS["gross_profit"])
    if gp:
        return gp
    if not rev:
        return None
    cogs = F.ttm_flow(facts, F.FLOWS["cost_of_revenue"])
    if not cogs:
        return None
    return {"value": rev["value"] - cogs["value"], "end": cogs["end"], "filed": cogs["filed"], "how": "rev − cogs"}


def fields_for_ticker(conn, ticker: str) -> list[dict]:
    t = ticker.upper()
    facts = _load_facts(conn, t)
    if not facts or not (facts.get("facts") or {}).get("us-gaap"):
        return []

    rev = F.ttm_flow(facts, F.FLOWS["revenue"])
    ocf = F.ttm_flow(facts, F.FLOWS["ocf"])
    capex = F.ttm_flow(facts, F.FLOWS["capex"])
    # 11-03: net income / margin to common too — FLOWS["net_income"] picks the largest tag (ProfitLoss incl. minority: TKO 661 M vs 230 M)
    ni = _roa_ni_numerator(facts, rev)
    if ni is None:   # filer tags only ProfitLoss (AEIS, FLEX, GWRE) or no revenue TTM: fine when there is no minority stake
        nil = F.ttm_flow(facts, ["NetIncomeLoss"])   # attributable to the parent: right with or without a minority stake
        pl = F.ttm_flow(facts, ["ProfitLoss"])
        if nil and (not pl or nil["end"] >= pl["end"]):   # a tag the filer stopped using must not win (AEIS NetIncomeLoss)
            ni = nil
        elif pl:
            nci = F.balance(facts, ["MinorityInterest"], pl["end"])
            ni = pl if not (nci and nci.get("value")) else None
    op = F.ttm_flow(facts, F.FLOWS["operating_income"])
    gp = _gross_profit(facts, rev)
    asof = (rev or ocf or ni or {}).get("end") or date.today().isoformat()

    out: list[dict] = []

    def add(field: str, value: float | None, meta: dict | None) -> None:
        if value is None or meta is None:
            return
        if not (value == value):  # NaN
            return
        filed = str(meta.get("filed") or meta.get("end") or asof)[:10]
        period_end = str(meta.get("end") or filed)[:10]
        out.append({"field": field, "value": float(value), "filed": filed, "period_end": period_end})

    if ocf and capex:
        add("freeCashFlow", ocf["value"] - capex["value"], ocf)
    if rev:
        add("totalRevenue", rev["value"], rev)
    if ni:
        add("netIncome", ni["value"], ni)
    if rev and gp and rev["value"]:
        add("grossMargin", gp["value"] / rev["value"], rev)
    if rev and op and rev["value"]:
        add("operatingMargin", op["value"] / rev["value"], rev)
    if rev and ni and rev["value"]:
        add("netMargin", ni["value"] / rev["value"], rev)

    ni_common = _roa_ni_numerator(facts, rev)
    assets = F.balance(facts, ["Assets"], asof)
    if ni_common and assets and assets.get("value"):
        prior_end = (date.fromisoformat(assets["end"]) - timedelta(days=360)).isoformat()
        assets0 = F.balance(facts, ["Assets"], prior_end)
        avg = (
            (assets["value"] + assets0["value"]) / 2
            if assets0 and assets0.get("value")
            else assets["value"]
        )
        add("returnOnAssets", ni_common["value"] / avg, ni_common)

    ca = F.balance(facts, ["AssetsCurrent"], asof)
    cl = F.balance(facts, ["LiabilitiesCurrent"], asof)
    if ca and cl and cl.get("value"):
        add("currentRatio", ca["value"] / cl["value"], ca)

    eq = F.balance(facts, EQ, asof)
    sh = F.shares(facts)
    px = _price(conn, t)
    if px and eq and sh and eq.get("value"):
        add("priceToBook", px * sh["value"] / eq["value"], eq)

    # A329 seg3 (11-04): shares + TBVPS from one filing, written with their statement date (fetched_at = period_end).
    # Cover shares only (dei, class-summed); never the weighted-average fallback (VG 0.20×, TEAM 0.61×).
    # ADRs skipped: SEC counts ordinary shares, price is per ADS. Non-USD filers drop out via USD units.
    cover = F.shares(facts)
    cover_ok = bool(cover) and str(cover.get("concept", "")).startswith("dei:")
    if not cover_ok:   # per-class filers (GOOGL, PLTR) skip dei; balance-sheet total is the class sum
        cover = _latest_bs_shares(facts)
        cover_ok = cover is not None
    adr = F.detect_adr_ratio(facts, conn, t, cover["end"] if cover else None) if cover_ok else None
    if adr and adr > 1:
        cover_ok = False
    if cover_ok and F._days(cover["end"], date.today().isoformat()) <= SHARES_MAX_AGE_D:
        add("sharesOutstanding", cover["value"], cover)

    eq_end = (eq or {}).get("end")
    fresh_eq = bool(eq_end) and F._days(eq_end, date.today().isoformat()) <= 200
    parent_eq = _parent_equity(facts, eq_end) if fresh_eq else None
    if parent_eq is not None and cover_ok:
        tbv = tangible_book(facts, parent_eq, eq_end, cover)
        if tbv is not None:
            add("tangibleBookValuePerShare", tbv, eq)

    return out


def upsert_rows(conn, ticker: str, field_rows: list[dict]) -> int:
    n = 0
    for r in field_rows:
        conn.execute(
            """INSERT INTO source_fundamentals (ticker, source, field, value, fetched_at)
               VALUES (%s, 'sec', %s, %s, %s::date)
               ON CONFLICT (ticker, source, field) DO UPDATE
               SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at""",
            (ticker.upper(), r["field"], r["value"], r.get("period_end") or r["filed"]),
        )
        n += 1
    return n


def scored_book_tickers(conn) -> list[str]:
    r = rows(
        conn,
        """
        SELECT DISTINCT UPPER(ticker) AS ticker FROM model_recs
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
        UNION
        SELECT DISTINCT UPPER(ticker) AS ticker FROM option_score_snapshots
        WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
        ORDER BY 1
        """,
    )
    return [x["ticker"] for x in r]


def universe_tickers(conn) -> list[str]:
    """Every name merge-trusted sees (A329 r4: scored-book only left ~600 names on vendor TBVPS — OMC +22 vs filing −49)."""
    return [x["ticker"] for x in rows(conn, "SELECT DISTINCT UPPER(ticker) AS ticker FROM source_fundamentals ORDER BY 1")]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("tickers", nargs="*", help="Tickers (default: --scored-book set)")
    p.add_argument("--scored-book", action="store_true")
    p.add_argument("--universe", action="store_true", help="all tickers in source_fundamentals")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    with connect() as conn:
        if args.universe:
            tickers = universe_tickers(conn)
        elif args.scored_book or not args.tickers:
            tickers = scored_book_tickers(conn)
        else:
            tickers = [t.upper() for t in args.tickers]
        total = 0
        for t in tickers:
            try:
                rows_out = fields_for_ticker(conn, t)
            except Exception as e:  # noqa: BLE001
                print(t, "error", str(e)[:80], file=sys.stderr)
                conn.rollback()
                continue
            if args.dry_run:
                if rows_out:
                    print(t, len(rows_out), rows_out[0]["filed"])
                continue
            produced = {r["field"] for r in rows_out}
            gone = [f for f in SEC_OWNED_FIELDS if f not in produced]
            conn.execute("DELETE FROM source_fundamentals WHERE ticker = %s AND source = 'sec' AND field = ANY(%s)", (t.upper(), gone))
            n = upsert_rows(conn, t, rows_out)
            total += n
            conn.commit()
        if not args.dry_run:
            print(f"sec source_fundamentals: {total} rows for {len(tickers)} tickers")


if __name__ == "__main__":
    main()
