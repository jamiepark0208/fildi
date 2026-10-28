"""S117 — does a firm's sales-to-capital persist, or revert after a capex build-out? (A283)
Compustat US 1995–2018, revenue ≥ $0.5B: trailing 3-y S2C (Δsales ÷ Δinvested capital) vs the next 5 y, by trailing quintile.
Invested capital = equity + debt − cash (as base_rates.py). Aggregated on WRDS. → out/s2c_persistence.csv
Usage: research/wrds/.venv/bin/python research/fair_value/s2c_persistence.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect

OUT = Path(__file__).parent / "out"
Q = """
WITH f AS (
  SELECT a.gvkey, a.fyear, a.sale, COALESCE(a.ceq,0) + COALESCE(a.dltt,0) + COALESCE(a.dlc,0) - COALESCE(a.che,0) ic, a.capx, a.dp
  FROM comp.funda a JOIN comp.company c ON c.gvkey = a.gvkey
  WHERE a.indfmt='INDL' AND a.datafmt='STD' AND a.popsrc='D' AND a.consol='C' AND a.curcd='USD' AND c.fic='USA'
    AND a.fyear BETWEEN 1990 AND 2025 AND a.sale > 0 AND c.gsector NOT IN ('40', '60')
), g AS (
  SELECT f.*,
    CASE WHEN LAG(fyear,3) OVER w = fyear-3 THEN LAG(sale,3) OVER w END s_m3, CASE WHEN LAG(fyear,3) OVER w = fyear-3 THEN LAG(ic,3) OVER w END ic_m3,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(sale,5) OVER w END s_p5, CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(ic,5) OVER w END ic_p5,
    SUM(capx) OVER (PARTITION BY gvkey ORDER BY fyear ROWS 2 PRECEDING) capx3, SUM(dp) OVER (PARTITION BY gvkey ORDER BY fyear ROWS 2 PRECEDING) dp3
  FROM f WINDOW w AS (PARTITION BY gvkey ORDER BY fyear)
), d AS (
  SELECT (sale - s_m3) / NULLIF(ic - ic_m3, 0) s2c_back, (s_p5 - sale) / NULLIF(ic_p5 - ic, 0) s2c_fwd, capx3 / NULLIF(dp3, 0) capex_dp
  FROM g WHERE sale >= 500 AND fyear BETWEEN 1995 AND 2018 AND ic - ic_m3 > 0.05 * ic AND ic_p5 - ic > 0.05 * ic AND sale > s_m3 AND s_p5 > sale
), q AS (SELECT d.*, NTILE(5) OVER (ORDER BY s2c_back) qb FROM d)
SELECT qb, COUNT(*) n, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY s2c_back) back_med, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY s2c_fwd) fwd_med,
  PERCENTILE_CONT(.25) WITHIN GROUP (ORDER BY s2c_fwd) fwd_p25, PERCENTILE_CONT(.75) WITHIN GROUP (ORDER BY s2c_fwd) fwd_p75,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY capex_dp) capex_dp_med,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY s2c_fwd) FILTER (WHERE capex_dp > 2) fwd_med_buildout
FROM q GROUP BY 1 ORDER BY 1
"""
if __name__ == "__main__":
    db = connect(); df = db.raw_sql(Q); db.close()
    df.to_csv(OUT / "s2c_persistence.csv", index=False)
    print(df.round(2).to_string(index=False))
