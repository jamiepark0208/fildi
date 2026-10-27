"""LSEG IBES consensus by fiscal year → watchlist_sync.consensus_annual (source 'lseg'; A283 fix (a)).

FY0 street actuals plus FY1–FY3 revenue and EBIT mean / high / low / included estimates, with period end dates.
EBIT is the street (pre-SBC, adjusted) basis: the DCF uses the consensus margin *change* from FY0, added to the GAAP
margin, so stock pay stays a cost. Raw frame → vendor_raw. ~27 fields × N names in batches of 50 RICs.

Usage: LSEG_PRIORITY=1 .venv/bin/python sync_consensus.py [--tickers NVDA,MSFT | --universe book|registry]
       (default = the LSEG universe, as sync_signals; daily.py lseg stage)
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date

from _session import add_lseg_universe_args, clean, connect_local, load_ric_map, lseg_session, resolve_lseg_universe

DDL = """CREATE TABLE IF NOT EXISTS watchlist_sync.consensus_annual (
    ticker text NOT NULL, fiscal_end date NOT NULL, as_of date NOT NULL,
    rev_avg double precision, rev_low double precision, rev_high double precision,
    ebit_avg double precision, ebit_low double precision, ebit_high double precision,
    eps_avg double precision, n_rev int, n_eps int, n_ebit int, source text NOT NULL DEFAULT 'fmp', actual boolean NOT NULL DEFAULT false,
    PRIMARY KEY (ticker, fiscal_end, as_of, source))"""

# (column, field) per period; read by position (display names repeat across periods)
ACT = [("fiscal_end", "TR.RevenueActValue(Period=FY0).periodenddate"), ("rev_avg", "TR.RevenueActValue(Period=FY0)"),
       ("ebit_avg", "TR.EBITActValue(Period=FY0)")]
EST = [("rev_avg", "TR.RevenueMean(Period={p})"), ("fiscal_end", "TR.RevenueMean(Period={p}).periodenddate"),
       ("rev_high", "TR.RevenueHigh(Period={p})"), ("rev_low", "TR.RevenueLow(Period={p})"),
       ("n_rev", "TR.RevenueNumIncEstimates(Period={p})"), ("ebit_avg", "TR.EBITMean(Period={p})"),
       ("ebit_high", "TR.EBITHigh(Period={p})"), ("ebit_low", "TR.EBITLow(Period={p})"), ("n_ebit", "TR.EBITNumIncEstimates(Period={p})")]
BLOCKS = [("FY0", ACT)] + [(p, [(c, f.format(p=p)) for c, f in EST]) for p in ("FY1", "FY2", "FY3")]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    add_lseg_universe_args(ap)
    a = ap.parse_args()
    with connect_local() as conn:
        conn.execute(DDL)
        conn.commit()
        tickers = resolve_lseg_universe(a, max_tier=8)
    rics = load_ric_map(tickers)
    by_ric = {r: t for t, r in rics.items()}
    fields = [f for _, blk in BLOCKS for _, f in blk]
    n = 0
    with lseg_session() as ld, connect_local() as conn:
        for i in range(0, len(by_ric), 50):
            chunk = list(by_ric)[i:i + 50]
            df = ld.get_data(chunk, fields)
            raw = df.to_json(orient="split", date_format="iso")
            conn.execute("""INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha) VALUES ('lseg', 'consensus_annual', %s, %s, %s::jsonb, %s)
                            ON CONFLICT (source, endpoint, key, fetched_on) DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha""",
                         (f"batch{i // 50}", date.today(), raw, hashlib.sha256(raw.encode()).hexdigest()))
            for _, row in df.iterrows():
                t = by_ric.get(row.iloc[0])
                vals = list(row.iloc[1:])
                k = 0
                for per, blk in BLOCKS:
                    rec = {c: clean(vals[k + j]) for j, (c, _) in enumerate(blk)}
                    k += len(blk)
                    if not t or not rec.get("fiscal_end") or rec.get("rev_avg") is None:
                        continue
                    cols = list(rec) + ["ticker", "as_of", "source", "actual"]
                    conn.execute(f"""INSERT INTO watchlist_sync.consensus_annual ({", ".join(cols)}) VALUES ({", ".join(["%s"] * len(cols))})
                                     ON CONFLICT (ticker, fiscal_end, as_of, source) DO UPDATE SET {", ".join(f"{c} = EXCLUDED.{c}" for c in rec)}""",
                                 [str(rec["fiscal_end"])[:10] if c == "fiscal_end" else rec[c] for c in rec] + [t, date.today(), "lseg", per == "FY0"])
                    n += 1
            conn.commit()
    print(f"consensus_annual (lseg): {n} rows for {len(by_ric)} names ({len(tickers) - len(by_ric)} without a RIC)")


if __name__ == "__main__":
    main()
