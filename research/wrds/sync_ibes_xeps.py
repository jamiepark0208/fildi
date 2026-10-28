#!/usr/bin/env python3
"""IBES revenue + EBIT consensus history → wrds_research (academic research only; A283 S116 point-in-time DCF backtest).

  ibes_statsum   measure SAL / EBI, annual FY1–FY3 (fpi 1–3), monthly statpers since --since (ibes.statsum_xepsus)
  ibes_act_x     SAL / EBI annual street actuals (ibes.act_xepsus) → FY0 base for the consensus path

Default names = lseg_research.daily_history tickers; --names sec = every name with stored SEC facts (S116 universe).
Usage: research/wrds/.venv/bin/python research/wrds/sync_ibes_xeps.py [--since 2016-01-01]
"""
from __future__ import annotations

import argparse

import pandas as pd

from _auth import connect
from db import connect_local, execute_values, log_pull, source_key
from sync_ibes import _float, _int, oftic_for_tickers

ACT_DDL = """CREATE TABLE IF NOT EXISTS wrds_research.ibes_act_x (oftic text NOT NULL, measure text NOT NULL, pends date NOT NULL,
             anndats date, value double precision, fetched_at timestamptz DEFAULT now(), PRIMARY KEY (oftic, measure, pends))"""


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--since", default="2016-01-01")
    p.add_argument("--names", choices=("lseg", "sec"), default="lseg", help="lseg = daily_history tickers; sec = names with stored SEC companyfacts")
    a = p.parse_args()
    with connect_local() as local:
        local.execute(ACT_DDL)
        tickers = [r[0] for r in local.execute("SELECT DISTINCT ticker FROM lseg_research.daily_history" if a.names == "lseg" else
                   "SELECT DISTINCT key FROM vendor_raw WHERE source = 'sec' AND endpoint = 'companyfacts'").fetchall()]
        oftics = oftic_for_tickers(local, tickers)
        local.commit()
    tl = ",".join(repr(t) for t in oftics)
    db = connect()
    st = db.raw_sql(f"""SELECT oftic, ticker, measure, fiscalp, fpi, statpers, fpedats, numest, numup, numdown, medest, meanest, stdev, highest, lowest
                        FROM ibes.statsum_xepsus WHERE UPPER(oftic) IN ({tl}) AND measure IN ('SAL', 'EBI') AND fiscalp = 'ANN'
                        AND fpi IN ('1', '2', '3') AND statpers >= '{a.since}'""")
    eps = db.raw_sql(f"""SELECT oftic, ticker, measure, fiscalp, fpi, statpers, fpedats, numest, numup, numdown, medest, meanest, stdev, highest, lowest
                         FROM ibes.statsumu_epsus WHERE UPPER(oftic) IN ({tl}) AND measure = 'EPS' AND fiscalp = 'ANN' AND fpi = '1'
                         AND statpers >= '{a.since}'""")  # unadjusted EPS FY1 (same table as sync_ibes) → earnings-yield comparator
    st = pd.concat([st, eps], ignore_index=True)
    ac = db.raw_sql(f"""SELECT oftic, measure, pends, anndats, value FROM ibes.act_xepsus
                        WHERE UPPER(oftic) IN ({tl}) AND measure IN ('SAL', 'EBI') AND pdicity = 'ANN' AND pends >= '{a.since}'::date - 400""")
    db.close()
    rows = [(source_key(str(r.oftic).upper(), r.measure, r.fiscalp, r.fpi, r.statpers, r.fpedats), str(r.oftic).upper(),
             None if pd.isna(r.ticker) else str(r.ticker), r.measure, r.fiscalp, str(r.fpi), r.statpers,
             None if pd.isna(r.fpedats) else r.fpedats, _int(r.numest), _int(r.numup), _int(r.numdown), _float(r.medest),
             _float(r.meanest), _float(r.stdev), _float(r.highest), _float(r.lowest)) for r in st.itertuples(index=False) if r.oftic]
    arows = [(str(r.oftic).upper(), r.measure, r.pends, None if pd.isna(r.anndats) else r.anndats, _float(r.value))
             for r in ac.itertuples(index=False) if r.oftic and r.pends is not None]
    with connect_local() as local:
        n = execute_values(local, """INSERT INTO wrds_research.ibes_statsum (source_key, oftic, ticker, measure, fiscalp, fpi, statpers, fpedats,
                           numest, numup, numdown, medest, meanest, stdev, highest, lowest, fetched_at)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
                           ON CONFLICT (source_key) DO UPDATE SET numest = EXCLUDED.numest, meanest = EXCLUDED.meanest,
                           highest = EXCLUDED.highest, lowest = EXCLUDED.lowest, stdev = EXCLUDED.stdev, fetched_at = now()""", rows)
        m = execute_values(local, """INSERT INTO wrds_research.ibes_act_x (oftic, measure, pends, anndats, value) VALUES (%s,%s,%s,%s,%s)
                           ON CONFLICT (oftic, measure, pends) DO UPDATE SET value = EXCLUDED.value, anndats = EXCLUDED.anndats""", arows)
        log_pull(local, dataset="ibes_statsum_xeps", status="ok", tickers=oftics, rows=n + m)
        local.commit()
    print(f"ibes SAL/EBI: {n} consensus rows, {m} actuals, {len(oftics)} names")


if __name__ == "__main__":
    main()
