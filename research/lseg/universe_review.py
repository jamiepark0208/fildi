"""Stock-universe coverage review (Jamie 10-27: "coverage for the major ones … you need to be managing this").

Major = US-listed ordinary shares / ADRs with market cap ≥ --min-cap (default $10B), from one LSEG screen (~7k datapoints).
Every major name missing from the app universe (ticker_registry active + fetch_fundamentals) is added; the existing nightly
jobs then fill it (enrich-missing-fundamentals 30/day, technicals, option-chain snapshot by IV, LSEG coverage.py).
THEME adds AI build-out names below the cap that trade with semis (data-center power, uranium, rare earths, miners / AI hosting,
networking) — Jamie 10-27. Never deactivates anything; prints the coverage table by cap band.

    LSEG_PRIORITY=1 .venv/bin/python universe_review.py            # report only
    LSEG_PRIORITY=1 .venv/bin/python universe_review.py --apply    # + add missing names (monthly.py runs this)
"""
from __future__ import annotations

import argparse

from _session import connect_local, lseg_session

THEME = ["VRT", "CEG", "VST", "TLN", "SMR", "NNE", "CCJ", "UUUU", "LEU", "CRML", "TMC", "NB", "ALB", "LAC",
         "APLD", "CIFR", "WULF", "CORZ", "BTDR", "GLXY", "CRDO", "ALAB", "COHR", "CLS", "AMKR", "NVTS", "POWL", "EOSE"]
BANDS = ((100, None), (50, 100), (20, 50), (10, 20), (5, 10))


def screen(min_cap_b: float):
    with lseg_session() as ld:
        df = ld.get_data(f'SCREEN(U(IN(Equity(active,public,primary))),IN(TR.ExchangeCountryCode,"US"),'
                         f'TR.CompanyMarketCap>={int(min_cap_b * 1e9)},CURN=USD)',
                         ["TR.CommonName", "TR.CompanyMarketCap", "TR.TickerSymbol", "TR.InstrumentType"])
    df = df[df["Instrument Type"].isin(["Ordinary Shares", "American Depository Receipts", "Fully Paid Ordinary Shares"])]
    df = df.dropna(subset=["Ticker Symbol"])
    df = df[~df["Ticker Symbol"].str.contains(" ", regex=False)]   # "BRK A"-style share classes: the B line is listed separately
    out = {}
    for _, r in df.iterrows():
        t = r["Ticker Symbol"]
        cap = float(r["Company Market Cap"] or 0) / 1e9
        if t not in out or cap > out[t][1]:
            out[t] = (r["Company Common Name"], cap)
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--min-cap", type=float, default=10.0, help="market cap floor, $B")
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    major = screen(min(a.min_cap, 5.0))
    with connect_local() as conn:
        uni = {r[0] for r in conn.execute("SELECT UPPER(ticker) FROM ticker_registry WHERE is_active AND fetch_fundamentals")}
        known = {r[0] for r in conn.execute("SELECT UPPER(ticker) FROM ticker_registry")}
        print("cap band     names  covered  missing (largest first)")
        for lo, hi in BANDS:
            g = sorted(((t, c) for t, (_, c) in major.items() if c >= lo and (hi is None or c < hi)), key=lambda x: -x[1])
            miss = [t for t, _ in g if t not in uni]
            print(f"${lo}-{hi or '∞'}B".ljust(12), f"{len(g):5d}  {len(g) - len(miss):7d}  {', '.join(miss[:20])}{' …' if len(miss) > 20 else ''}")
        add = sorted({t for t, (_, c) in major.items() if c >= a.min_cap and t not in uni} | {t for t in THEME if t not in uni})
        print(f"\n{len(add)} names to add (≥ ${a.min_cap:g}B + theme): {', '.join(add)}")
        if a.apply and add:
            with conn.cursor() as cur:
                cur.executemany("""INSERT INTO ticker_registry (ticker, name, is_active, fetch_fundamentals) VALUES (%s, %s, true, true)
                                   ON CONFLICT (ticker) DO UPDATE SET is_active = true, fetch_fundamentals = true""",
                                [(t, (major.get(t) or (None,))[0]) for t in add])
            conn.commit()
            print(f"added {len(add)} ({len([t for t in add if t not in known])} new rows) → nightly jobs fill fundamentals / technicals / chains")


if __name__ == "__main__":
    main()
