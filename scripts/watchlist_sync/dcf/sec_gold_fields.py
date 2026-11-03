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
# ROA: NI attributable to common only (not consolidated NI with minority interest).
NI_COMMON = [
    "NetIncomeLossAvailableToCommonStockholdersBasic",
    "NetIncomeLossAvailableToCommonStockholdersDiluted",
]


def _load_facts(conn, ticker: str) -> dict | None:
    """Prefer vendor_raw; refresh from SEC when trimmed cache lacks net_income (ROA/NI)."""
    facts = F.stored_facts(conn, ticker)
    gaap = (facts or {}).get("facts", {}).get("us-gaap", {}) or {}
    if facts and any(c in gaap for c in F.FLOWS["net_income"]):
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
    ni = F.ttm_flow(facts, F.FLOWS["net_income"])
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

    ni_common = F.ttm_flow(facts, NI_COMMON)
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


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("tickers", nargs="*", help="Tickers (default: --scored-book set)")
    p.add_argument("--scored-book", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    with connect() as conn:
        tickers = scored_book_tickers(conn) if args.scored_book or not args.tickers else [t.upper() for t in args.tickers]
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
            n = upsert_rows(conn, t, rows_out)
            total += n
            conn.commit()
        if not args.dry_run:
            print(f"sec source_fundamentals: {total} rows for {len(tickers)} tickers")


if __name__ == "__main__":
    main()
