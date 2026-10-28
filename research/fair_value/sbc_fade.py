"""S114 — how does stock pay (SBC ÷ revenue) and GAAP margin evolve 5 / 10 years on, by starting SBC share? (A283)
Compustat US 2006–2019 starts (stkco reported), revenue ≥ $0.3B; aggregated on WRDS. → out/sbc_fade.csv.
Usage: research/wrds/.venv/bin/python research/fair_value/sbc_fade.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect

OUT = Path(__file__).parent / "out"
Q = """
WITH f AS (
  SELECT a.gvkey, a.fyear, a.sale, a.oiadp, a.stkco
  FROM comp.funda a JOIN comp.company c ON c.gvkey = a.gvkey
  WHERE a.indfmt='INDL' AND a.datafmt='STD' AND a.popsrc='D' AND a.consol='C' AND a.curcd='USD' AND c.fic='USA'
    AND a.fyear BETWEEN 2006 AND 2025 AND a.sale > 0 AND a.stkco IS NOT NULL
), g AS (
  SELECT f.*,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(stkco,5) OVER w / NULLIF(LEAD(sale,5) OVER w, 0) END AS sbc5,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(oiadp,5) OVER w / NULLIF(LEAD(sale,5) OVER w, 0) END AS m5,
    CASE WHEN LEAD(fyear,10) OVER w = fyear+10 THEN LEAD(stkco,10) OVER w / NULLIF(LEAD(sale,10) OVER w, 0) END AS sbc10
  FROM f WINDOW w AS (PARTITION BY gvkey ORDER BY fyear)
)
SELECT CASE WHEN stkco/sale < .02 THEN '1: <2' WHEN stkco/sale < .05 THEN '2: 2-5' WHEN stkco/sale < .10 THEN '3: 5-10'
            WHEN stkco/sale < .20 THEN '4: 10-20' ELSE '5: >20' END sbc0,
  (oiadp < 0) loss0, COUNT(*) n, COUNT(sbc10) n10,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY stkco/sale) sbc0_med,
  PERCENTILE_CONT(ARRAY[.25,.5,.75]) WITHIN GROUP (ORDER BY sbc5) sbc5_q,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY sbc10) sbc10_med,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY oiadp/sale) m0_med,
  PERCENTILE_CONT(ARRAY[.25,.5,.75]) WITHIN GROUP (ORDER BY m5) m5_q
FROM g WHERE sale >= 300 AND fyear BETWEEN 2006 AND 2019 AND sbc5 IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2
"""

if __name__ == "__main__":
    db = connect()
    df = db.raw_sql(Q)
    db.close()
    df.to_csv(OUT / "sbc_fade.csv", index=False)
    import pandas as pd
    pd.set_option("display.width", 250)
    print(df.round(3).to_string(index=False))
