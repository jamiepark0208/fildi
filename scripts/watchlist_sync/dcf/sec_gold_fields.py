"""A318: SEC companyfacts TTM → source_fundamentals (source=sec). Logic home: financials.py."""
from __future__ import annotations

import argparse
import math
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_plan import connect, rows  # noqa: E402

import financials as F  # noqa: E402
from sec_ttm_eps import has_quarterly_eps_facts, ttm_eps_diluted  # noqa: E402

EQ = ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]
ROA_NI_CONCEPTS = (
    ["NetIncomeLossAvailableToCommonStockholdersBasic"],
    ["NetIncomeLoss"],
)


SHARES_MAX_AGE_D = 120   # older cover = stale (buybacks); vendor current count wins instead
SEC_OWNED_FIELDS = ("totalAssets", "sharesOutstanding", "sharesOutstandingPrior", "tangibleBookValuePerShare", "earningsPerShare")   # deleted when not produced this run
INTANG_EX_GW = ["IntangibleAssetsNetExcludingGoodwill"]
INTANG_PARTS = ["FiniteLivedIntangibleAssetsNet", "IndefiniteLivedIntangibleAssetsExcludingGoodwill"]


MAX_PERIOD_AGE_D = 400   # FY filers: newest 10-K/20-F period ≤ ~13 months old


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


PRIOR_WINDOW_D = 45   # same as the L2 truth (stock-db-audit-l2 PRIOR_SHARES_WINDOW)


def _prior_cover(facts: dict, cover: dict) -> dict | None:
    """A329 (11-05): prior-year count on the SAME definition as `cover` (a cover/balance-sheet count ~365 d
    earlier), so shares/prior − 1 is a real YoY change, not cover vs a vendor's basic weighted average."""
    target = date.fromisoformat(cover["end"]) - timedelta(days=365)
    if str(cover.get("concept", "")).startswith("dei:"):
        dei = (facts.get("facts", {}).get("dei", {}) or {}).get("EntityCommonStockSharesOutstanding")
        vals = (dei or {}).get("units", {}).get("shares", [])
        concept = "dei:EntityCommonStockSharesOutstanding"
    else:
        vals = F._units(facts, "CommonStockSharesOutstanding", "shares")
        concept = "CommonStockSharesOutstanding"
    near = [u for u in vals if abs((date.fromisoformat(u["end"]) - target).days) <= PRIOR_WINDOW_D]
    if not near:
        return None
    end = max(u["end"] for u in near)
    on_end = [u for u in near if u["end"] == end]
    filed = max(u["filed"] for u in on_end)
    same = [u for u in on_end if u["filed"] == filed]
    # dei: one row per class on one filing → sum; balance sheet: already the total → latest row
    value = sum(float(u["val"]) for u in same) if concept.startswith("dei:") else float(same[-1]["val"])
    if value <= 0:
        return None
    # Cover counts are never restated for splits (APH 2:1, BKNG 25:1, AMCR 1:5 → fake ±80–2200 %).
    factor = _split_factor(facts, end, cover["end"], filed)
    value *= factor
    lo_hi = (0.67, 1.5) if factor == 1.0 else (0.5, 2.0)
    if not lo_hi[0] <= cover["value"] / value <= lo_hi[1]:
        return None   # big move with no (or an implausible) split → let the vendor prior stand
    return {"value": value, "concept": concept, "end": end, "filed": filed, "split_factor": factor}


def _split_factor(facts: dict, prior_end: str, cur_end: str, prior_filed: str) -> float:
    """Split factor between prior_end and cur_end from SEC's own restatements: a later filing re-reports the
    prior-year basic weighted average split-adjusted; restated ÷ originally-filed = the factor (1.0 = none)."""
    node = (facts.get("facts", {}).get("us-gaap", {}) or {}).get("WeightedAverageNumberOfSharesOutstandingBasic") or {}
    vals = [u for u in node.get("units", {}).get("shares", []) if u.get("start") and u.get("val")]
    lo = date.fromisoformat(prior_end) - timedelta(days=200)
    by_period: dict[tuple, list] = {}
    for u in vals:
        if lo <= date.fromisoformat(u["end"]) <= date.fromisoformat(cur_end):
            by_period.setdefault((u["start"], u["end"]), []).append(u)
    best = 1.0
    for us in by_period.values():
        orig = min(us, key=lambda x: x["filed"])
        rest = max(us, key=lambda x: x["filed"])
        if rest["filed"] <= orig["filed"] or orig["filed"] < prior_filed:   # split before the prior cover = already in it
            continue
        r = float(rest["val"]) / float(orig["val"])
        if (r >= 1.4 or r <= 0.7) and _clean_ratio(r) and abs(math.log(r)) > abs(math.log(best)):
            best = r
    return best


def _clean_ratio(r: float) -> bool:
    """A split is n:m with small m (2:1, 3:2, 25:1, 1:10). Rejects ×1000 unit slips (RGEN, WAT) and
    merger restatements (WTRG 0.696)."""
    q = max(r, 1 / r)
    return any(abs(q / s - 1) <= 0.015 for s in SPLIT_RATIOS)


SPLIT_RATIOS = (1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, 50, 100)


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
    fresh = (facts or {}).get("keep_v", 0) >= F.KEEP_V
    if facts and fresh and (any(c in gaap for c in F.FLOWS["net_income"]) or (facts.get("facts") or {}).get("ifrs-full")):
        return facts
    # 11-11: an unchanged filing returns the trimmed cache — force one refetch when it predates KEEP_V (no Assets kept)
    return F.companyfacts(conn, ticker, force=bool(facts) and not fresh)


def local_total_assets(facts: dict) -> dict | None:
    """11-11: latest Assets in the filer's own currency (IFRS 20-F, or us-gaap in non-USD units: MUFG JPY).
    Written as source 'sec_local'; merge-trusted converts it at today's FX like other local-currency vendors."""
    today = date.today().isoformat()
    best = None
    for tax in ("ifrs-full", "us-gaap"):
        node = ((facts.get("facts") or {}).get(tax) or {}).get("Assets") or {}
        for unit, vals in (node.get("units") or {}).items():
            if unit == "USD" or not (len(unit) == 3 and unit.isalpha() and unit.isupper()):
                continue
            for u in vals:
                if u.get("start") or not u.get("val") or u.get("form") not in ("20-F", "20-F/A", "40-F", "6-K", "10-K", "10-Q"):
                    continue
                if u["end"] <= today and (best is None or (u["end"], u.get("filed", "")) > (best["end"], best["filed"])):
                    best = {"value": float(u["val"]), "end": u["end"], "filed": u.get("filed", u["end"]), "unit": unit}
    if best and F._days(best["end"], today) > 370:
        return None
    return best


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


def _filing_assets_override(conn, t: str, facts: dict | None, out: list[dict]) -> list[dict]:
    """11-11: companyfacts lags some filings (TSM FY25 20-F, C/DUK/PLD Q3 10-Q) → read Assets from the newest filing's
    inline XBRL so every name's total assets is as of its latest report, not whatever date SEC's API reached."""
    import sec_ixbrl
    from sec_staleness import newest_fact_end, newest_report
    sub = rows(conn, """SELECT payload FROM vendor_raw WHERE source = 'sec' AND endpoint = 'submissions' AND key = %s
                        ORDER BY fetched_on DESC LIMIT 1""", (t,))
    rep = newest_report(sub[0]["payload"]) if sub else None
    fe = newest_fact_end(facts or {})
    if not rep or (fe and (date.fromisoformat(rep[2]) - date.fromisoformat(fe)).days <= 45):
        return out
    try:
        f = sec_ixbrl.latest_instant(conn, t, ["Assets"])
    except Exception as e:  # noqa: BLE001
        print(t, "ixbrl error", str(e)[:80], file=sys.stderr)
        return out
    if not f or f["value"] <= 0 or (fe and f["end"] <= fe) or len(f["unit"]) != 3:
        return out
    out = [r for r in out if r["field"] != "totalAssets"]
    out.append({"field": "totalAssets", "value": f["value"], "filed": f["filed"], "period_end": f["end"],
                "source": "sec" if f["unit"] == "USD" else "sec_local"})
    return out


def _augment_lagging(conn, t: str, facts: dict | None) -> dict | None:
    """11-11 #53: companyfacts lags the newest filing by > 45 d (52 filers: C/DUK/PLD Q3 10-Q, TSM FY25 20-F) →
    merge that filing's inline-XBRL facts in, so NI / revenue / OCF TTM, margins and ROA are as of the same report as
    everyone else's, not whatever date SEC's API reached. One EDGAR call; the parsed facts only live in memory."""
    import sec_ixbrl
    from sec_staleness import newest_fact_end, newest_report
    if not facts:
        return facts
    sub = rows(conn, """SELECT payload FROM vendor_raw WHERE source = 'sec' AND endpoint = 'submissions' AND key = %s
                        ORDER BY fetched_on DESC LIMIT 1""", (t,))
    rep = newest_report(sub[0]["payload"]) if sub else None
    fe = newest_fact_end(facts)
    if not rep or (fe and (date.fromisoformat(rep[2]) - date.fromisoformat(fe)).days <= 45):
        return facts
    try:
        got = sec_ixbrl.newest_filing(conn, t)
        parsed = sec_ixbrl.parse_facts(got[0]) if got else []
    except Exception as e:  # noqa: BLE001
        print(t, "ixbrl error", str(e)[:80], file=sys.stderr)
        return facts
    if not parsed or not fe or max(f["end"] for f in parsed) <= fe:
        return facts
    import copy
    aug = copy.deepcopy(facts)
    n = sec_ixbrl.augment(aug, parsed, got[1])
    print(t, f"ixbrl +{n} facts from {got[1]['form']} {got[1]['filed']}", file=sys.stderr)
    return aug


def fields_for_ticker(conn, ticker: str) -> list[dict]:
    t = ticker.upper()
    raw = _load_facts(conn, t)
    facts0 = _augment_lagging(conn, t, raw)
    out = _fields_for_ticker(conn, t, facts0)
    if facts0 is not raw:   # a field the filing can't complete (DUK: 9M diluted EPS untagged) keeps its older dated value
        have = {r["field"] for r in out}
        out += [r for r in _fields_for_ticker(conn, t, raw) if r["field"] not in have]
    if any(r["field"] == "totalAssets" for r in out):
        return out
    return _filing_assets_override(conn, t, facts0, out)   # fallback: Assets only (non-us-gaap filers)


def _fields_for_ticker(conn, ticker: str, facts: dict | None) -> list[dict]:
    t = ticker.upper()
    if not facts:
        return []
    usd_fresh = any(not u.get("start") and F._days(u["end"], date.today().isoformat()) <= 370 for u in F._units(facts, "Assets"))
    loc = None if usd_fresh else local_total_assets(facts)   # TM: us-gaap USD stops 2013, IFRS since
    local_rows = ([{"field": "totalAssets", "value": loc["value"], "filed": str(loc["filed"])[:10],
                    "period_end": str(loc["end"])[:10], "source": "sec_local"}] if loc else [])
    if not (facts.get("facts") or {}).get("us-gaap"):
        return local_rows

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
    # 11-11 #55: gold NI / net margin = NetIncomeLoss (to the parent, before preferred) like every vendor;
    # to-common is ROA's numerator only (GS 16.3 vs vendor 17.2 B, C 13.0 vs 14.3, MET, STT, COF failed the FY check)
    if ni is not None and ni.get("concept") != "NetIncomeLoss":
        nil_ = F.ttm_flow(facts, ["NetIncomeLoss"])
        if nil_ and str(nil_["end"])[:10] >= str(ni["end"])[:10]:
            ni = nil_
    op = F.ttm_flow(facts, F.FLOWS["operating_income"])
    gp = _gross_profit(facts, rev)
    asof = (rev or ocf or ni or {}).get("end") or date.today().isoformat()

    out: list[dict] = list(local_rows)

    def add(field: str, value: float | None, meta: dict | None) -> None:
        if value is None or meta is None:
            return
        if not (value == value):  # NaN
            return
        filed = str(meta.get("filed") or meta.get("end") or asof)[:10]
        period_end = str(meta.get("end") or filed)[:10]
        if field != "sharesOutstandingPrior" and F._days(period_end, date.today().isoformat()) > MAX_PERIOD_AGE_D:
            return   # 11-11 #53: a tag the filer stopped using (PBR NI 2010, TM 2013, DTE revenue 2018) is not today's number
        out.append({"field": field, "value": float(value), "filed": filed, "period_end": period_end})

    if ocf and capex:
        add("freeCashFlow", ocf["value"] - capex["value"], ocf)
    if rev:
        add("totalRevenue", rev["value"], rev)
    if ni:
        add("netIncome", ni["value"], ni)
    # 11-11 #54: same concept's last two FY totals, dated like the TTM row (merge-trusted: definition check vs vendor FY)
    for fld, m in (("totalRevenue", rev), ("netIncome", ni)):
        if m:
            add(f"{fld}Fy", m.get("fy_value"), m)
            add(f"{fld}FyPrev", m.get("fy_prev_value"), m)
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
    if usd_fresh and assets and assets.get("value") and assets["value"] > 0:
        # 11-11: gold total_assets had FMP only (4 names) → 413 nulls; us-gaap USD units only, so never local currency
        add("totalAssets", assets["value"], assets)

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
        prior = _prior_cover(facts, cover)
        if prior:
            add("sharesOutstandingPrior", prior["value"], prior)

    eq_end = (eq or {}).get("end")
    fresh_eq = bool(eq_end) and F._days(eq_end, date.today().isoformat()) <= 200
    parent_eq = _parent_equity(facts, eq_end) if fresh_eq else None
    if parent_eq is not None and cover_ok:
        tbv = tangible_book(facts, parent_eq, eq_end, cover)
        if tbv is not None:
            add("tangibleBookValuePerShare", tbv, eq)

    # TTM diluted EPS (USD filers via USD/shares facts); ADRs skipped like shares.
    eps_adr = F.detect_adr_ratio(facts, conn, t, asof) if conn else None
    if not (eps_adr and eps_adr > 1) and has_quarterly_eps_facts(facts):
        eps = ttm_eps_diluted(facts)
        if eps and eps.get("end") is not None:
            add("earningsPerShare", eps["value"], {"end": eps["end"], "filed": eps["end"]})

    return out


def upsert_rows(conn, ticker: str, field_rows: list[dict]) -> int:
    n = 0
    for r in field_rows:
        conn.execute(
            """INSERT INTO source_fundamentals (ticker, source, field, value, fetched_at)
               VALUES (%s, %s, %s, %s, %s::date)
               ON CONFLICT (ticker, source, field) DO UPDATE
               SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at""",
            (ticker.upper(), r.get("source", "sec"), r["field"], r["value"], r.get("period_end") or r["filed"]),
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
            produced = {r["field"] for r in rows_out if r.get("source", "sec") == "sec"}
            gone = [f for f in SEC_OWNED_FIELDS if f not in produced]
            conn.execute("DELETE FROM source_fundamentals WHERE ticker = %s AND source = 'sec' AND field = ANY(%s)", (t.upper(), gone))
            conn.execute("""DELETE FROM source_fundamentals WHERE ticker = %s AND source = 'sec' AND field <> 'sharesOutstandingPrior'
                            AND fetched_at < now() - make_interval(days => %s)""", (t.upper(), MAX_PERIOD_AGE_D))
            if not any(r.get("source") == "sec_local" for r in rows_out):
                conn.execute("DELETE FROM source_fundamentals WHERE ticker = %s AND source = 'sec_local'", (t.upper(),))
            n = upsert_rows(conn, t, rows_out)
            total += n
            conn.commit()
        if not args.dry_run:
            print(f"sec source_fundamentals: {total} rows for {len(tickers)} tickers")


if __name__ == "__main__":
    main()
