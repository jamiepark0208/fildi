"""DCF v2 phase G (generic assumptions): empirical base rates from Compustat (US, 1990–2025) for the probabilistic DCF.
  Q1 revenue growth persistence: forward 3/5/10-y sales CAGR by trailing 3-y CAGR × size, + exits before year 5
     (acquired / failed / other, comp.company dlrsn)  → growth fade + failure probability
  Q2 operating margin 5 years later by sector × starting margin                      → target-margin distribution
  Q3 ROIC 5 years later by starting ROIC; sales-to-capital (Δsales / Δinvested capital) by sector → reinvestment, ROIC fade
Written need (research/wrds/PLAYBOOK.md caps Compustat at ≤ 20 tickers, latest FY): base rates need the whole history,
so every query aggregates on the WRDS server and only percentile tables come back (3 queries, nothing per firm stored).
Usage: research/wrds/.venv/bin/python research/fair_value/base_rates.py"""
import sys
from pathlib import Path
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect

OUT = Path(__file__).parent / "out"
SECTOR = {"10": "energy", "15": "materials", "20": "industrials", "25": "cons. discretionary", "30": "cons. staples",
          "35": "health care", "40": "financials", "45": "info tech", "50": "comm. services", "55": "utilities", "60": "real estate"}

BASE = """
WITH f AS (
  SELECT a.gvkey, a.fyear, a.sale, a.oiadp, a.gp,
         COALESCE(a.ceq,0) + COALESCE(a.dltt,0) + COALESCE(a.dlc,0) - COALESCE(a.che,0) AS ic,
         c.gsector, c.dlrsn
  FROM comp.funda a JOIN comp.company c ON c.gvkey = a.gvkey
  WHERE a.indfmt='INDL' AND a.datafmt='STD' AND a.popsrc='D' AND a.consol='C' AND a.curcd='USD' AND c.fic='USA'
    AND a.fyear BETWEEN 1985 AND 2025 AND a.sale > 0
), g AS (
  SELECT f.*,
    CASE WHEN LAG(fyear,3) OVER w = fyear-3 THEN LAG(sale,3) OVER w END AS s_m3,
    CASE WHEN LEAD(fyear,3) OVER w = fyear+3 THEN LEAD(sale,3) OVER w END AS s_p3,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(sale,5) OVER w END AS s_p5,
    CASE WHEN LEAD(fyear,10) OVER w = fyear+10 THEN LEAD(sale,10) OVER w END AS s_p10,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(oiadp,5) OVER w END AS oi_p5,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(ic,5) OVER w END AS ic_p5,
    MAX(fyear) OVER (PARTITION BY gvkey) AS last_fy
  FROM f WINDOW w AS (PARTITION BY gvkey ORDER BY fyear)
), b AS (
  SELECT g.*, POWER(sale / s_m3, 1/3.0) - 1 AS g_back,
    CASE WHEN sale < 2000 THEN '1: $0.5-2B' WHEN sale < 10000 THEN '2: $2-10B' WHEN sale < 50000 THEN '3: $10-50B' ELSE '4: >$50B' END AS size,
    oiadp / sale AS margin, gp / sale AS gmargin, CASE WHEN ic > 0 THEN 0.75 * oiadp / ic END AS roic
  FROM g WHERE sale >= 500 AND s_m3 > 0 AND fyear BETWEEN 1990 AND 2020
)
"""

Q1 = BASE + """
SELECT size,
  CASE WHEN g_back < 0 THEN '1: <0%' WHEN g_back < .05 THEN '2: 0-5%' WHEN g_back < .10 THEN '3: 5-10%' WHEN g_back < .20 THEN '4: 10-20%'
       WHEN g_back < .30 THEN '5: 20-30%' WHEN g_back < .50 THEN '6: 30-50%' ELSE '7: >50%' END AS start_growth,
  COUNT(*) n,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY POWER(s_p3/sale,1/3.0)-1) FILTER (WHERE s_p3 > 0) g3,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY POWER(s_p5/sale,1/5.0)-1) FILTER (WHERE s_p5 > 0) g5,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY POWER(s_p10/sale,1/10.0)-1) FILTER (WHERE s_p10 > 0 AND fyear <= 2015) g10,
  AVG(CASE WHEN s_p10 > 0 AND fyear <= 2015 THEN (POWER(s_p10/sale,0.1)-1 > .15)::int END) p_10y_above15,
  AVG((last_fy < fyear+5)::int) FILTER (WHERE fyear <= 2019) exit5,
  AVG((last_fy < fyear+5 AND dlrsn IN ('02','03'))::int) FILTER (WHERE fyear <= 2019) fail5,
  AVG((last_fy < fyear+5 AND dlrsn IN ('01','04','06','09'))::int) FILTER (WHERE fyear <= 2019) acquired5
FROM b GROUP BY 1, 2 ORDER BY 1, 2
"""

Q2 = BASE + """
SELECT gsector,
  CASE WHEN margin < 0 THEN '1: <0%' WHEN margin < .05 THEN '2: 0-5%' WHEN margin < .10 THEN '3: 5-10%' WHEN margin < .20 THEN '4: 10-20%'
       WHEN margin < .30 THEN '5: 20-30%' WHEN margin < .40 THEN '6: 30-40%' WHEN margin < .50 THEN '7: 40-50%' ELSE '8: >50%' END AS start_margin,
  COUNT(*) FILTER (WHERE s_p5 > 0) n,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY oi_p5/s_p5) FILTER (WHERE s_p5 > 0) m5,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY (oi_p5/s_p5) / margin) FILTER (WHERE s_p5 > 0 AND margin > .05) ratio5,
  PERCENTILE_CONT(ARRAY[.25,.5,.75]) WITHIN GROUP (ORDER BY oi_p5/s_p5) FILTER (WHERE s_p5 > 0 AND g_back > .20) m5_fast
FROM b WHERE margin IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2
"""

Q3 = BASE + """
SELECT gsector,
  CASE WHEN roic < 0 THEN '1: <0%' WHEN roic < .05 THEN '2: 0-5%' WHEN roic < .10 THEN '3: 5-10%' WHEN roic < .15 THEN '4: 10-15%'
       WHEN roic < .25 THEN '5: 15-25%' WHEN roic < .40 THEN '6: 25-40%' ELSE '7: >40%' END AS start_roic,
  COUNT(*) FILTER (WHERE ic_p5 > 0) n,
  PERCENTILE_CONT(ARRAY[.25,.5,.75]) WITHIN GROUP (ORDER BY 0.75*oi_p5/ic_p5) FILTER (WHERE ic_p5 > 0) roic5,
  PERCENTILE_CONT(ARRAY[.25,.5,.75]) WITHIN GROUP (ORDER BY (s_p5-sale)/(ic_p5-ic)) FILTER (WHERE ic_p5-ic > 0.05*ic AND ic > 0) sales_to_capital
FROM b WHERE roic IS NOT NULL GROUP BY ROLLUP (1, 2) ORDER BY 1, 2
"""


Q2B = BASE + """
SELECT CASE WHEN margin < 0 THEN '1: <0%' WHEN margin < .10 THEN '2: 0-10%' WHEN margin < .20 THEN '3: 10-20%' ELSE '4: >20%' END AS start_margin,
  CASE WHEN gmargin < .40 THEN '1: GM<40%' WHEN gmargin < .60 THEN '2: GM 40-60%' WHEN gmargin < .75 THEN '3: GM 60-75%' ELSE '4: GM>75%' END AS gross,
  CASE WHEN g_back > .20 THEN 'fast' ELSE 'slow' END AS growth,
  COUNT(*) FILTER (WHERE s_p5 > 0) n,
  PERCENTILE_CONT(ARRAY[.02,.05,.1,.25,.5,.75,.9,.95,.98]) WITHIN GROUP (ORDER BY oi_p5/s_p5) FILTER (WHERE s_p5 > 0) m5
FROM b WHERE margin IS NOT NULL AND gmargin IS NOT NULL AND gsector IN ('45','35','50') GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
"""


def main():
    db = connect()
    OUT.mkdir(exist_ok=True)
    only = sys.argv[1:] or ["growth", "margin", "roic", "margin_gross"]
    for name, q in (("growth", Q1), ("margin", Q2), ("roic", Q3), ("margin_gross", Q2B)):
        if name not in only:
            continue
        df = db.raw_sql(q.replace("%", "%%"))
        df.to_pickle(OUT / f"base_rates_{name}.pkl")
        print(name, len(df), "rows")


if __name__ == "__main__":
    main()
