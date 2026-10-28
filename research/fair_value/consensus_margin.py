"""S115 — how much of the consensus operating-margin forecast shows up in realized GAAP margins? (A283)
Compustat × IBES (EBI and SAL means, FY+2, ~3 months after fiscal year end), 2003–2019, revenue ≥ $0.3B.
By starting GAAP margin bucket: slope of realized margin change (t → t+2, t → t+5) on the consensus margin change
(street FY+2 margin − street actual margin at t, IBES act_xepsus — same basis), plus decile medians. → out/consensus_margin.csv.
Usage: research/wrds/.venv/bin/python research/fair_value/consensus_margin.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wrds"))
from _auth import connect

OUT = Path(__file__).parent / "out"
Q = """
WITH f AS (
  SELECT a.gvkey, a.fyear, a.datadate, a.sale, a.oiadp, COALESCE(a.stkco, 0) stkco
  FROM comp.funda a JOIN comp.company c ON c.gvkey = a.gvkey
  WHERE a.indfmt='INDL' AND a.datafmt='STD' AND a.popsrc='D' AND a.consol='C' AND a.curcd='USD' AND c.fic='USA'
    AND a.fyear BETWEEN 2003 AND 2025 AND a.sale > 0
), g AS (
  SELECT f.*,
    CASE WHEN LEAD(fyear,2) OVER w = fyear+2 THEN LEAD(oiadp,2) OVER w / NULLIF(LEAD(sale,2) OVER w,0) END m2,
    CASE WHEN LEAD(fyear,5) OVER w = fyear+5 THEN LEAD(oiadp,5) OVER w / NULLIF(LEAD(sale,5) OVER w,0) END m5
  FROM f WINDOW w AS (PARTITION BY gvkey ORDER BY fyear)
), l AS (
  SELECT DISTINCT ON (g.gvkey, g.fyear) g.*, i.ticker
  FROM g JOIN crsp.ccmxpf_lnkhist k ON k.gvkey = g.gvkey AND k.linktype IN ('LU','LC') AND k.linkprim IN ('P','C')
       AND g.datadate BETWEEN k.linkdt AND COALESCE(k.linkenddt, '2099-12-31')
  JOIN wrdsapps.ibcrsphist i ON i.permno = k.lpermno AND g.datadate BETWEEN i.sdate AND i.edate AND i.score <= 2
  WHERE g.sale >= 300 AND g.fyear BETWEEN 2003 AND 2019 AND g.m2 IS NOT NULL
  ORDER BY g.gvkey, g.fyear, i.score
), c AS (
  SELECT l.*, s.sal, e.ebi, s.numest, a.ebi0 / NULLIF(a.sal0, 0) sm0
  FROM l
  JOIN LATERAL (SELECT MAX(value) FILTER (WHERE measure = 'EBI') ebi0, MAX(value) FILTER (WHERE measure = 'SAL') sal0
       FROM ibes.act_xepsus x WHERE x.ticker = l.ticker AND x.pdicity = 'ANN' AND x.measure IN ('EBI', 'SAL')
       AND x.pends BETWEEN l.datadate - 20 AND l.datadate + 20) a ON a.ebi0 IS NOT NULL AND a.sal0 > 0
  JOIN LATERAL (SELECT meanest sal, numest FROM ibes.statsum_xepsus s WHERE s.ticker = l.ticker AND s.measure = 'SAL' AND s.fiscalp = 'ANN'
       AND s.fpedats BETWEEN l.datadate + 700 AND l.datadate + 760 AND s.statpers BETWEEN l.datadate + 60 AND l.datadate + 130
       ORDER BY s.statpers LIMIT 1) s ON TRUE
  JOIN LATERAL (SELECT meanest ebi FROM ibes.statsum_xepsus e WHERE e.ticker = l.ticker AND e.measure = 'EBI' AND e.fiscalp = 'ANN'
       AND e.fpedats BETWEEN l.datadate + 700 AND l.datadate + 760 AND e.statpers BETWEEN l.datadate + 60 AND l.datadate + 130
       ORDER BY e.statpers LIMIT 1) e ON TRUE
), d AS (
  SELECT CASE WHEN oiadp/sale < 0 THEN '1: <0' WHEN oiadp/sale < .10 THEN '2: 0-10' WHEN oiadp/sale < .20 THEN '3: 10-20' ELSE '4: 20+' END mb,
    oiadp/sale m0, ebi/sal - sm0 dc, sm0 - oiadp/sale basis, m2 - oiadp/sale d2, m5 - oiadp/sale d5, stkco/sale sbc
  FROM c WHERE sal > 0 AND ebi/sal BETWEEN -2 AND 1 AND m2 BETWEEN -2 AND 1
)
SELECT mb, COUNT(*) n, COUNT(d5) n5, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY m0) m0, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY sbc) sbc,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY dc) dc_med, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d2) d2_med, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d5) d5_med,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY basis) basis_med, REGR_SLOPE(d2, dc) b2, CORR(d2, dc) rho2, REGR_SLOPE(d5, dc) b5, CORR(d5, dc) rho5
FROM d GROUP BY ROLLUP (1) ORDER BY 1
"""
QD = Q.split("SELECT mb, COUNT(*)")[0] + """
, q AS (SELECT d.*, NTILE(5) OVER (PARTITION BY mb ORDER BY dc) qn FROM d)
SELECT mb, qn, COUNT(*) n, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY dc) dc, PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d2) d2,
  PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY d5) d5 FROM q GROUP BY 1, 2 ORDER BY 1, 2"""

if __name__ == "__main__":
    import pandas as pd
    pd.set_option("display.width", 250)
    db = connect()
    a, b = db.raw_sql(Q), db.raw_sql(QD)
    db.close()
    a.to_csv(OUT / "consensus_margin.csv", index=False)
    b.to_csv(OUT / "consensus_margin_quintiles.csv", index=False)
    print(a.round(3).to_string(index=False)); print(); print(b.round(3).to_string(index=False))
