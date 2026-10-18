"""A160: GICS per ticker from WRDS Compustat → research_common.security_class (sector / industry / sub-industry names).

Vendor baseline for our peer groups: openjev_controls.peers_review flags tickers whose GICS sub-industry maps mostly
to a different group than theirs. Run monthly (cheap: one query). Usage: .venv/bin/python sync_gics.py
"""
from __future__ import annotations

import os
import psycopg
from _auth import connect

DDL = """CREATE TABLE IF NOT EXISTS research_common.security_class (
  ticker text PRIMARY KEY, gvkey text, gics_sector text, gics_industry text, gics_sub_industry text,
  source text NOT NULL DEFAULT 'wrds', updated_at timestamptz NOT NULL DEFAULT now())"""
SQL = """select s.tic, c.gvkey, gs.gicdesc sec, gi.gicdesc ind, gu.gicdesc sub
 from comp.security s join comp.company c using (gvkey)
 left join comp.r_giccd gs on gs.giccd = c.gsector and gs.gictype = 'GSECTOR'
 left join comp.r_giccd gi on gi.giccd = c.gind and gi.gictype = 'GIND'
 left join comp.r_giccd gu on gu.giccd = c.gsubind and gu.gictype = 'GSUBIND'
 where s.tic = any(%(t)s) and c.gsubind is not null and s.dldtei is null"""


def main() -> None:
    url = os.environ.get("DATABASE_URL") or "postgresql://localhost/fildi"
    with psycopg.connect(url) as conn:
        tickers = [r[0] for r in conn.execute(
            "SELECT ticker FROM ticker_registry WHERE primary_peer_group_id IS NOT NULL AND coalesce(is_active, true)").fetchall()]
    vt = {t.replace("-", ".").replace("/", "."): t for t in tickers}  # Compustat uses BRK.B
    db = connect()
    df = db.raw_sql(SQL, params={"t": list(vt)})
    db.close()
    df = df.drop_duplicates("tic").astype(object).where(df.drop_duplicates("tic").notna(), None)
    with psycopg.connect(url) as conn:
        conn.execute(DDL)
        for r in df.itertuples():
            conn.execute("""INSERT INTO research_common.security_class (ticker, gvkey, gics_sector, gics_industry, gics_sub_industry)
              VALUES (%s,%s,%s,%s,%s) ON CONFLICT (ticker) DO UPDATE SET gvkey=EXCLUDED.gvkey, gics_sector=EXCLUDED.gics_sector,
              gics_industry=EXCLUDED.gics_industry, gics_sub_industry=EXCLUDED.gics_sub_industry, updated_at=now()""",
                         (vt.get(r.tic, r.tic), r.gvkey, r.sec, r.ind, r.sub))
        conn.commit()
    print(f"security_class: {len(df)}/{len(tickers)} tickers have GICS")


if __name__ == "__main__":
    main()
