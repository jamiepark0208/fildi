"""Stock-universe coverage review (Jamie 10-27: "coverage for the major ones … you need to be managing this").

Major = US-listed ordinary shares / ADRs with market cap ≥ --min-cap (default $10B), from one LSEG screen (~7k datapoints).
Every major name missing from the app universe (ticker_registry active + fetch_fundamentals) is added; the existing nightly
jobs then fill it (enrich-missing-fundamentals 30/day, technicals, option-chain snapshot by IV, LSEG coverage.py).
THEME adds AI build-out names below the cap that trade with semis (data-center power, uranium, rare earths, miners / AI hosting,
networking) — Jamie 10-27. Never deactivates anything; prints the coverage table by cap band.
10-27 audit of the first +370: worth monitoring = listed on a US exchange (no OTC / Pink), ≥ $20M/day traded (3-month avg),
theme names ≥ $2B; ≤ MAX_ADD names per run (the nightly jobs onboard 60/day). Each add gets a peer group from its LSEG TRBC
industry (TRBC_GROUP) so peer-relative scores don't wait on — or trust — the Finnhub-overlap guess (it put JCI/CNH in Space).

    LSEG_PRIORITY=1 .venv/bin/python universe_review.py            # report only
    LSEG_PRIORITY=1 .venv/bin/python universe_review.py --apply    # + add missing names (monthly.py runs this)
"""
from __future__ import annotations

import argparse

from _session import connect_local, lseg_session

THEME = ["VRT", "CEG", "VST", "TLN", "SMR", "NNE", "CCJ", "UUUU", "LEU", "CRML", "TMC", "NB", "ALB", "LAC",
         "APLD", "CIFR", "WULF", "CORZ", "BTDR", "GLXY", "CRDO", "ALAB", "COHR", "CLS", "AMKR", "NVTS", "POWL", "EOSE"]
BANDS = ((100, None), (50, 100), (20, 50), (10, 20), (5, 10))
MIN_DVOL_M = 20.0     # $M/day, 3-month average (ARCC, CNA, EDU … traded < $20M)
THEME_MIN_CAP = 2.0   # $B (BTDR, NB, TMC, LAC, UUUU, CRML, EOSE, NNE were below)
MAX_ADD = 100
# LSEG TRBC industry group → app peer group, only where one group fits the whole industry (ambiguous ones such as
# Software & IT Services or Semiconductors stay with the app classifier).
TRBC_GROUP = {
    "Machinery, Tools, Heavy Vehicles, Trains & Ships": "industrials.industrial_conglomerates_machinery",
    "Heavy Electrical Equipment": "industrials.industrial_conglomerates_machinery",
    "Diversified Industrial Goods Wholesale": "industrials.industrial_conglomerates_machinery",
    "Homebuilding & Construction Supplies": "industrials.homebuilders_building_products",
    "Construction & Engineering": "industrials.construction_engineering_materials",
    "Construction Materials": "industrials.construction_engineering_materials",
    "Containers & Packaging": "materials.containers_packaging",
    "Aerospace & Defense": "industrials.aerospace_defense",
    "Freight & Logistics Services": "industrials.transportation_logistics",
    "Residential & Commercial REITs": "real_estate.reits_diversified",
    "Insurance": "financials.insurance",
    "Banking Services": "financials.banks",
    "Healthcare Equipment & Supplies": "healthcare.medical_devices_equipment",
    "Pharmaceuticals": "healthcare.large_pharma",
    "Electric Utilities & IPPs": "utilities.electric_utilities",
    "Multiline Utilities": "utilities.water_gas_multi_utilities",
    "Natural Gas Utilities": "utilities.water_gas_multi_utilities",
    "Water & Related Utilities": "utilities.water_gas_multi_utilities",
    "Oil & Gas": "energy.integrated_oil_gas",
    "Uranium": "energy.clean_energy_renewables",
    "Renewable Energy": "energy.clean_energy_renewables",
    "Chemicals": "materials.chemicals",
    "Specialty Retailers": "consumer_discretionary.retail_home_general",
    "Diversified Retail": "consumer_discretionary.retail_home_general",
    "Food & Drug Retailing": "consumer_staples.food_grocery_agriculture",
    "Beverages": "consumer_staples.packaged_goods_beverages",
    "Food & Tobacco": "consumer_staples.packaged_goods_beverages",
    "Personal & Household Products & Services": "consumer_staples.packaged_goods_beverages",
    "Automobiles & Auto Parts": "consumer_discretionary.autos_evs",
    "Telecommunications Services": "telecom.telecommunications",
    "Electronic Equipment & Parts": "technology.it_hardware_networking",
    "Computers, Phones & Household Electronics": "technology.it_hardware_networking",
    "Passenger Transportation Services": "consumer_discretionary.travel_leisure_hospitality",
    "Real Estate Operations": "consumer_discretionary.real_estate_platforms",
}


def screen(min_cap_b: float):
    """ticker → (name, cap $B, traded $M/day, TRBC industry, listed on a US exchange)."""
    with lseg_session() as ld:
        df = ld.get_data(f'SCREEN(U(IN(Equity(active,public,primary))),IN(TR.ExchangeCountryCode,"US"),'
                         f'TR.CompanyMarketCap>={int(min_cap_b * 1e9)},CURN=USD)',
                         ["TR.CommonName", "TR.CompanyMarketCap", "TR.TickerSymbol", "TR.InstrumentType", "TR.ExchangeName",
                          "TR.PriceClose", "TR.AvgDailyVolume3M", "TR.TRBCIndustryGroup"])
    df = df[df["Instrument Type"].isin(["Ordinary Shares", "American Depository Receipts", "Fully Paid Ordinary Shares"])]
    df = df.dropna(subset=["Ticker Symbol"])
    df = df[~df["Ticker Symbol"].str.contains(" ", regex=False)]   # "BRK A"-style share classes: the B line is listed separately
    out = {}
    for _, r in df.iterrows():
        t = r["Ticker Symbol"]
        cap = float(r["Company Market Cap"] or 0) / 1e9
        dvol = float(r["Price Close"] or 0) * float(r["Average Daily Volume - 3 Months"] or 0) / 1e6
        exch = str(r["Exchange Name"] or "").upper()
        listed = bool(exch) and not any(k in exch for k in ("OTC", "PINK", "GREY"))
        if t not in out or cap > out[t][1]:
            out[t] = (r["Company Common Name"], cap, dvol, r["TRBC Industry Group Name"] or None, listed)
    return out


def worth(row, min_cap: float) -> bool:
    return row is not None and row[4] and row[2] >= MIN_DVOL_M and row[1] >= min_cap


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--min-cap", type=float, default=10.0, help="market cap floor, $B")
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    major = screen(min(a.min_cap, THEME_MIN_CAP))
    with connect_local() as conn:
        uni = {r[0] for r in conn.execute("SELECT UPPER(ticker) FROM ticker_registry WHERE is_active AND fetch_fundamentals")}
        known = {r[0] for r in conn.execute("SELECT UPPER(ticker) FROM ticker_registry")}
        print("cap band     names  covered  missing (largest first)")
        for lo, hi in BANDS:
            g = sorted(((t, v[1]) for t, v in major.items() if v[1] >= lo and (hi is None or v[1] < hi)), key=lambda x: -x[1])
            miss = [t for t, _ in g if t not in uni]
            print(f"${lo}-{hi or '∞'}B".ljust(12), f"{len(g):5d}  {len(g) - len(miss):7d}  {', '.join(miss[:20])}{' …' if len(miss) > 20 else ''}")
        cand = {t for t, v in major.items() if worth(v, a.min_cap)} | {t for t in THEME if worth(major.get(t), THEME_MIN_CAP)}
        skipped = sorted(t for t in THEME if t not in uni and t not in cand)
        add = sorted(cand - uni, key=lambda t: -major[t][1])[:MAX_ADD]
        print(f"\n{len(add)} names to add (≥ ${a.min_cap:g}B + theme, listed, ≥ ${MIN_DVOL_M:g}M/day, cap {MAX_ADD}): {', '.join(add)}")
        if skipped:
            print(f"theme names below the bar (not added): {', '.join(skipped)}")
        if a.apply and add:
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO ticker_registry (ticker, name, is_active, fetch_fundamentals) VALUES (%s, %s, true, true)
                                   ON CONFLICT (ticker) DO UPDATE SET is_active = true, fetch_fundamentals = true""",
                                [(t, major[t][0]) for t in add])
            conn.commit()
            print(f"added {len(add)} ({len([t for t in add if t not in known])} new rows) → nightly jobs fill fundamentals / technicals / chains")
        if a.apply:
            premap(conn, major)


def premap(conn, major) -> None:
    """Peer group from TRBC industry for universe names that have none (manual overrides untouched)."""
    rows = conn.execute("""SELECT UPPER(r.ticker) FROM ticker_registry r
                           WHERE r.is_active AND r.fetch_fundamentals AND r.primary_peer_group_id IS NULL
                             AND NOT EXISTS (SELECT 1 FROM peer_group_overrides o WHERE UPPER(o.ticker) = UPPER(r.ticker))""").fetchall()
    known = {r[0] for r in conn.execute("SELECT id FROM peer_groups")}
    pairs = [(TRBC_GROUP[major[t][3]], t) for (t,) in rows
             if t in major and TRBC_GROUP.get(major[t][3]) in known]
    with conn.cursor() as cur:
        cur.executemany("UPDATE ticker_registry SET primary_peer_group_id = %s WHERE UPPER(ticker) = %s", pairs)
    conn.commit()
    print(f"peer group from TRBC industry: {len(pairs)} of {len(rows)} unmapped (the rest → app classifier on enrichment)")


if __name__ == "__main__":
    main()
